import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newAvatarSession,
  configureTelemetry,
  AvatarSDKError,
  generateLogId,
} from "../src/index.js";
import { server, encode, waitFor } from "./server.js";

configureTelemetry("");

test("header auth, token expiry, configuration and ordered concurrent audio requests", async (t) => {
  const backend = await server(t);
  const frames: { data: Uint8Array; last: boolean }[] = [];
  let closed = 0;
  const session = newAvatarSession({
    ...backend.config,
    sampleRate: 24000,
    expireAt: new Date("2030-05-06T07:08:09.987Z"),
    extraParams: { quality: "high" },
    transportFrames: (data, last) => {
      frames.push({ data, last });
      throw new Error("application error");
    },
    onClose: () => {
      closed++;
      throw new Error("application error");
    },
  });
  t.after(() => session.close());
  await session.init();
  assert.equal(backend.requests[0]?.url, "/v1/console/session-tokens");
  assert.equal(backend.requests[0]?.headers["x-api-key"], "test-api-key");
  assert.deepEqual(JSON.parse(backend.requests[0]!.body), {
    expireAt: 1904281689,
  });
  assert.equal(await session.start(), "connection-123");
  const upgrade = backend.upgrades[0]!;
  assert.equal(upgrade.headers["x-app-id"], "app & id");
  assert.equal(upgrade.headers["x-session-key"], "session & token");
  const url = new URL(upgrade.url!, backend.url);
  assert.equal(url.pathname, "/v2/driveningress/websocket");
  assert.equal(url.searchParams.get("id"), "avatar/123");
  assert.equal(url.searchParams.get("keep"), "1");
  assert.equal(url.searchParams.has("sessionKey"), false);
  // Proto3 omits zero-valued scalar fields on the wire.
  assert.deepEqual(
    {
      bitrate: 0,
      audioFormat: 0,
      transportCompression: 0,
      egressType: 0,
      ...backend.messages[0]?.clientConfigureSession,
    },
    {
      sampleRate: 24000,
      bitrate: 0,
      audioFormat: 0,
      transportCompression: 0,
      egressType: 0,
      extraParams: { quality: "high" },
    },
  );
  const ids = await Promise.all([
    session.sendAudio(Buffer.from([1, 2]), false),
    session.sendAudio(Buffer.from([3, 4]), true),
    session.sendAudio(Buffer.from([5, 6]), true),
  ]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
  await waitFor(() => backend.messages.length === 4);
  assert.deepEqual(
    backend.messages
      .slice(1)
      .map((m) => [
        m.clientAudioInput.reqId,
        [...m.clientAudioInput.audio],
        m.clientAudioInput.end ?? false,
      ]),
    [
      [ids[0], [1, 2], false],
      [ids[0], [3, 4], true],
      [ids[2], [5, 6], true],
    ],
  );
  assert.ok(
    backend.messages.slice(1).every((m) => !m.clientAudioInput.traceContext),
  );
  // Preserve the entire envelope, including fields this SDK does not know yet.
  const animation = Buffer.concat([
    encode({ type: 5, serverResponseAnimation: { reqId: ids[0], end: true } }),
    Buffer.from([0x98, 0x06, 0x07]),
  ]);
  backend.sockets[0]!.send(animation);
  backend.sockets[0]!.send(animation);
  await waitFor(() => frames.length === 2);
  assert.deepEqual(Buffer.from(frames[0]!.data), animation);
  assert.equal(frames[0]!.last, true);
  await assert.rejects(session.interrupt(), /egress/);
  await Promise.all([session.close(), session.close()]);
  assert.equal(closed, 1);
  await assert.rejects(session.sendAudio(Buffer.alloc(0), true), {
    code: "connectionClosed",
  });
  await assert.rejects(session.start(), /cannot be restarted/);
});

for (const egress of ["livekit", "agora"] as const)
  test(`${egress} egress, query auth, Opus pass-through and interrupt after end`, async (t) => {
    const backend = await server(t);
    let frameCount = 0;
    const config =
      egress === "livekit"
        ? {
            livekitEgress: {
              url: "wss://livekit.example",
              apiToken: "lk-token",
              roomName: "room-1",
              publisherId: "publisher",
              extraAttributes: { role: "avatar" },
              idleTimeout: 25,
            },
          }
        : {
            agoraEgress: {
              channelName: "channel-1",
              token: "agora-token",
              uid: 42,
              publisherId: "publisher",
            },
          };
    const session = newAvatarSession({
      ...backend.config,
      ...config,
      useQueryAuth: true,
      audioFormat: "ogg_opus",
      bitrate: 32000,
      transportFrames: () => frameCount++,
    });
    t.after(() => session.close());
    await session.init();
    await session.start();
    const upgrade = backend.upgrades[0]!;
    const url = new URL(upgrade.url!, backend.url);
    assert.equal(upgrade.headers["x-app-id"], undefined);
    assert.equal(url.searchParams.get("appId"), "app & id");
    assert.equal(url.searchParams.get("sessionKey"), "session & token");
    const handshake = backend.messages[0]!.clientConfigureSession;
    assert.equal(handshake.egressType, egress === "livekit" ? 1 : 2);
    assert.equal(handshake.audioFormat, 1);
    assert.equal(handshake.bitrate, 32000);
    assert.deepEqual(
      handshake[egress === "livekit" ? "livekitEgress" : "agoraEgress"],
      Object.values(config)[0],
    );
    await assert.rejects(session.interrupt(), /No request/);
    const id = await session.sendAudio(Buffer.from("OggS"));
    assert.equal(await session.sendAudio(Buffer.alloc(0), true), id);
    assert.equal(await session.interrupt(), id);
    assert.notEqual(await session.sendAudio(Buffer.from("OggS"), true), id);
    await waitFor(() => backend.messages.length === 5);
    assert.equal(backend.messages[2]!.clientAudioInput.audio?.length ?? 0, 0);
    assert.deepEqual(backend.messages[3], {
      type: 7,
      clientInterrupt: { reqId: id },
    });
    backend.sockets[0]!.send(
      encode({ type: 5, serverResponseAnimation: { reqId: id, end: true } }),
    );
    await session.close();
    assert.equal(frameCount, 0);
  });

for (const [name, reply, expected] of [
  ["text", "not protobuf", "protocolError"],
  ["truncated", Buffer.from([0x1a, 0xff]), "protocolError"],
  [
    "empty confirmation",
    encode({ type: 2, serverConfirmSession: {} }),
    "protocolError",
  ],
  [
    "unexpected type",
    encode({ type: 7, clientInterrupt: { reqId: "x" } }),
    "protocolError",
  ],
  [
    "server rejection",
    encode({
      type: 4,
      serverError: { code: 4001, message: "credits exhausted" },
    }),
    "creditsExhausted",
  ],
] as const)
  test(`handshake rejects ${name} and cleans up`, async (t) => {
    const backend = await server(t, { handshake: (ws) => ws.send(reply) });
    let closed = 0;
    const session = newAvatarSession({
      ...backend.config,
      onClose: () => closed++,
    });
    await session.init();
    await assert.rejects(session.start(), {
      code: expected,
      phase: "websocket_handshake",
    });
    await session.close();
    assert.equal(closed, 1);
    await waitFor(() => backend.sockets[0]?.readyState === 3);
  });

test("upgrade rejection preserves HTTP status and server body", async (t) => {
  const backend = await server(t, { rejectUpgrade: true });
  const session = newAvatarSession(backend.config);
  await session.init();
  await assert.rejects(session.start(), (error: unknown) => {
    assert.ok(error instanceof AvatarSDKError);
    assert.equal(error.code, "sessionTokenExpired");
    assert.equal(error.httpStatus, 401);
    assert.equal(error.phase, "websocket_connect");
    assert.match(error.rawBody!, /session token expired/);
    return true;
  });
});

test("silent handshake times out and explicit close cancels a pending start", async (t) => {
  const backend = await server(t, { handshake: () => {} });
  const session = newAvatarSession({ ...backend.config, timeoutMs: 100 });
  await session.init();
  await assert.rejects(session.start(), {
    code: "connectionFailed",
    phase: "websocket_handshake",
  });
  const second = newAvatarSession(backend.config);
  await second.init();
  const rejected = assert.rejects(second.start(), { code: "connectionClosed" });
  await waitFor(() => backend.messages.length === 2);
  await second.close();
  await rejected;
});

test("runtime errors and malformed frames do not break callbacks; abnormal close is reported", async (t) => {
  const backend = await server(t);
  const errors: AvatarSDKError[] = [];
  let closed = 0;
  const session = newAvatarSession({
    ...backend.config,
    onError: (error) => {
      errors.push(error);
      throw new Error("callback");
    },
    onClose: () => closed++,
  });
  await session.init();
  await session.start();
  backend.sockets[0]!.send(Buffer.from([0xff]));
  backend.sockets[0]!.send(
    encode({
      type: 4,
      serverError: {
        code: 4002,
        message: "limit",
        connectionId: "cid",
        reqId: "rid",
      },
    }),
  );
  await waitFor(() => errors.length === 2);
  assert.equal(errors[0]!.code, "protocolError");
  assert.equal(errors[1]!.code, "sessionDurationExceeded");
  assert.equal(errors[1]!.reqId, "rid");
  backend.sockets[0]!.close(1011, "upstream unavailable");
  await waitFor(() => closed === 1);
  assert.equal(errors[2]!.code, "connectionClosed");
  assert.equal(errors[2]!.closeCode, 1011);
  assert.equal(errors[2]!.closeReason, "upstream unavailable");
  await session.close();
  assert.equal(closed, 1);
});

test("log IDs use UTC timestamp and a 12-character URL-safe random suffix", () => {
  const ids = Array.from({ length: 100 }, generateLogId);
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^\d{14}_[A-Za-z0-9_-]{12}$/);
});
