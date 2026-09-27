import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { OggOpusEncoder, oggPage } from "../src/audio-encoder.js";
import {
  configureTelemetry,
  newAvatarSession,
  type SessionConfig,
} from "../src/index.js";
import { server, waitFor, encode } from "./server.js";

configureTelemetry("");

function parse(stream: Buffer) {
  const pages = [];
  for (let offset = 0; offset < stream.length;) {
    assert.equal(stream.toString("ascii", offset, offset + 4), "OggS");
    const lacing = stream.subarray(
      offset + 27,
      offset + 27 + stream[offset + 26]!,
    );
    assert.ok(lacing.at(-1)! < 255, "unterminated packet");
    const end =
      offset + 27 + lacing.length + lacing.reduce((sum, n) => sum + n, 0);
    const raw = Buffer.from(stream.subarray(offset, end));
    const checksum = raw.readUInt32LE(22);
    raw.writeUInt32LE(0, 22);
    // Independent, bitwise CRC implementation (no encoder lookup table).
    let crc = 0;
    for (const byte of raw) {
      crc ^= byte << 24;
      for (let i = 0; i < 8; i++)
        crc = (crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
    }
    assert.equal(crc, checksum);
    pages.push({
      flags: raw[5],
      sequence: raw.readUInt32LE(18),
      serial: raw.readUInt32LE(14),
      granule: Number(raw.readBigUInt64LE(6)),
      packet: raw.subarray(27 + lacing.length),
      lacing,
    });
    offset = end;
    assert.ok(offset <= stream.length);
  }
  return pages;
}

function speech(rate: number, samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const fade = Math.min(1, i / (rate * 0.05), (samples - i) / (rate * 0.05));
    const envelope =
      fade * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)));
    const value =
      envelope *
      (0.5 * Math.sin(2 * Math.PI * 180 * t) +
        0.22 * Math.sin(2 * Math.PI * 360 * t + 0.3) +
        0.08 * Math.sin(2 * Math.PI * 720 * t + 1));
    pcm.writeInt16LE(Math.trunc(value * 32767), i * 2);
  }
  return pcm;
}

test("Ogg lacing terminates exact 255-byte multiples, CRC and 64-bit granules", () => {
  for (const size of [0, 254, 255, 256, 510, 4000]) {
    const packet = Buffer.alloc(size, 73);
    const [page] = parse(oggPage(packet, 2 ** 33 + 17, 0xfedcba98, 42, 4));
    assert.deepEqual(page!.packet, packet);
    assert.equal(page!.lacing.length, Math.floor(size / 255) + 1);
    assert.equal(page!.lacing.at(-1), size % 255);
    assert.equal(page!.granule, 2 ** 33 + 17);
    assert.equal(page!.serial, 0xfedcba98);
    assert.equal(page!.sequence, 42);
  }
});

test("configuration rejects unsupported encoder inputs without restricting pass-through", () => {
  const base: SessionConfig = {
    apiKey: "key",
    appId: "app",
    avatarId: "avatar",
    audioFormat: "ogg_opus",
    oggOpusEncoder: {},
  };
  for (const changes of [
    { audioFormat: "pcm_s16le" },
    { sampleRate: 44100 },
    { sampleRate: NaN },
    { bitrate: -1 },
    { bitrate: 499 },
    { bitrate: 512001 },
    { bitrate: 64000.5 },
    { oggOpusEncoder: { frameDurationMs: 15 } },
    { oggOpusEncoder: { application: "unknown" } },
  ])
    assert.throws(
      () => newAvatarSession({ ...base, ...changes } as SessionConfig),
      TypeError,
    );
  assert.doesNotThrow(() =>
    newAvatarSession({ ...base, sampleRate: 44100, oggOpusEncoder: undefined }),
  );
});

const hasFFmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("FFmpeg is installed when independent decoding is required", () => {
  if (process.env.REQUIRE_FFMPEG) assert.ok(hasFFmpeg);
});

test(
  "all rates, durations and applications decode with exact sample count and correct headers",
  { skip: !hasFFmpeg },
  async () => {
    for (const rate of [8000, 12000, 16000, 24000, 48000]) {
      for (const frameDurationMs of [10, 20, 40, 60] as const) {
        for (const application of [
          "voip",
          "audio",
          "restricted_lowdelay",
        ] as const) {
          // Alternate exact/partial frames; use >1 frames to test delay flushing and EOS.
          const samples =
            ((rate * frameDurationMs) / 1000) * 2 +
            (application === "voip" ? 0 : 7);
          const pcm = speech(rate, samples);
          const encoder = await OggOpusEncoder.create(
            rate,
            32000,
            { frameDurationMs, application },
            true,
          );
          try {
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < pcm.length; offset += 118)
              chunks.push(
                ...encoder.encode(pcm.subarray(offset, offset + 118), false),
              );
            chunks.push(...encoder.encode(Buffer.alloc(0), true));
            const ogg = Buffer.concat(chunks);
            assert.deepEqual(encoder.completedStream(), ogg);
            const pages = parse(ogg);
            assert.equal(pages[0]!.flags, 2);
            assert.equal(pages.at(-1)!.flags, 4);
            assert.ok(pages.slice(1, -1).every((p) => p.flags === 0));
            assert.ok(
              pages.every(
                (p, i) => p.sequence === i && p.serial === pages[0]!.serial,
              ),
            );
            const head = pages[0]!.packet;
            assert.equal(head.toString("ascii", 0, 8), "OpusHead");
            assert.equal(head[9], 1);
            assert.equal(head.readUInt32LE(12), rate);
            assert.equal(
              head.readUInt16LE(10),
              application === "restricted_lowdelay" ? 120 : 312,
            );
            assert.equal(pages[1]!.packet.toString("ascii", 0, 8), "OpusTags");
            assert.equal(
              pages.at(-1)!.granule - head.readUInt16LE(10),
              samples * (48000 / rate),
            );
            const decoded = execFileSync(
              "ffmpeg",
              [
                "-v",
                "error",
                "-c:a",
                "libopus",
                "-i",
                "pipe:0",
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "48000",
                "pipe:1",
              ],
              { input: ogg },
            );
            assert.equal(
              decoded.length,
              pcm.length * (48000 / rate),
              `${rate}/${frameDurationMs}/${application}`,
            );
          } finally {
            encoder.destroy();
          }
        }
      }
    }
  },
);

test(
  "Python quality baseline: 24 kHz, audio, 64 kbps, cosine >= 0.99",
  { skip: !hasFFmpeg },
  async (t) => {
    const pcm = speech(24000, 72000);
    const encoder = await OggOpusEncoder.create(24000, 64000, {
      application: "audio",
    });
    try {
      const started = performance.now();
      const chunks: Buffer[] = [];
      // Deliberately split in the middle of frames and pass offset views.
      for (let offset = 0; offset < pcm.length; offset += 322)
        chunks.push(
          ...encoder.encode(pcm.subarray(offset, offset + 322), false),
        );
      chunks.push(...encoder.encode(Buffer.alloc(0), true));
      const ogg = Buffer.concat(chunks);
      t.diagnostic(
        `Encoded 3 s PCM in ${(performance.now() - started).toFixed(1)} ms; ${ogg.length} bytes`,
      );
      const decoded = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-c:a",
          "libopus",
          "-i",
          "pipe:0",
          "-f",
          "s16le",
          "-ar",
          "24000",
          "pipe:1",
        ],
        { input: ogg },
      );
      assert.equal(decoded.length, pcm.length);
      let dot = 0,
        a2 = 0,
        b2 = 0;
      for (let i = 0; i < pcm.length; i += 2) {
        const a = pcm.readInt16LE(i),
          b = decoded.readInt16LE(i);
        dot += a * b;
        a2 += a * a;
        b2 += b * b;
      }
      const cosine = dot / Math.sqrt(a2 * b2);
      t.diagnostic(`Decoded cosine: ${cosine}`);
      assert.ok(cosine >= 0.99, `cosine ${cosine}`);
    } finally {
      encoder.destroy();
    }
  },
);

test("empty requests, single-sample tail, unaligned PCM, bounded retention and reusable WASM allocations", async () => {
  const encoder = await OggOpusEncoder.create(16000, 0, {});
  // Inspect internal allocation ownership rather than unreliable process RSS.
  const internals = encoder as unknown as {
    codec: { memory: WebAssembly.Memory };
    frame: Buffer;
    pending?: Buffer;
    collected?: Buffer[];
  };
  try {
    assert.throws(() => [...encoder.encode(Buffer.alloc(1), false)], /aligned/);
    for (let i = 0; i < 6000; i++)
      [...encoder.encode(Buffer.alloc(640), false)];
    assert.equal(internals.frame.length, 640);
    assert.ok(internals.pending!.length <= 4000);
    assert.equal(internals.collected, undefined);
    [...encoder.encode(Buffer.alloc(0), true)];
    assert.equal(encoder.completedStream(), undefined);
    assert.throws(() => [...encoder.encode(Buffer.alloc(0), true)], /closed/);
  } finally {
    encoder.destroy();
    encoder.destroy();
  }
  const memorySize = internals.codec.memory.buffer.byteLength;
  for (let i = 0; i < 500; i++) {
    const next = await OggOpusEncoder.create(16000, 0, {});
    try {
      const pages = [...next.encode(Buffer.alloc(i % 2 ? 2 : 0), true)];
      assert.equal(pages.length, i % 2 ? 3 : 0);
      if (pages.length)
        assert.equal(parse(Buffer.concat(pages)).at(-1)!.granule, 315);
    } finally {
      next.destroy();
    }
  }
  assert.equal(
    internals.codec.memory.buffer.byteLength,
    memorySize,
    "WASM allocations leaked",
  );
});

test("session encodes ordered concurrent chunks, empty ends, isolated callbacks and distinct streams", async (t) => {
  const backend = await server(t);
  const completed = new Map<string, Buffer>();
  const session = newAvatarSession({
    ...backend.config,
    audioFormat: "ogg_opus",
    oggOpusEncoder: {},
    onEncodedAudio: (id, data) => {
      completed.set(id, Buffer.from(data));
      throw new Error("callback");
    },
  });
  t.after(() => session.close());
  await session.init();
  await session.start();
  const id = await session.sendAudio(Buffer.alloc(2));
  assert.equal(
    backend.messages.length,
    1,
    "partial PCM must not send an empty first packet",
  );
  await assert.rejects(session.sendAudio(Buffer.alloc(1)), /aligned/);
  const ids = await Promise.all([
    session.sendAudio(Buffer.alloc(638)),
    session.sendAudio(Buffer.alloc(0), true),
    session.sendAudio(Buffer.alloc(962), true),
  ]);
  assert.equal(ids[0], id);
  assert.equal(ids[1], id);
  assert.notEqual(ids[2], id);
  const empty = await session.sendAudio(Buffer.alloc(0), true);
  await waitFor(() =>
    backend.messages.some((m) => m.clientAudioInput?.reqId === empty),
  );
  assert.equal(completed.size, 2);
  const audio = backend.messages.slice(1).map((m) => m.clientAudioInput);
  for (const requestId of [id, ids[2]!]) {
    const messages = audio.filter((m) => m.reqId === requestId);
    assert.equal(messages.filter((m) => m.end).length, 1);
    assert.equal(messages.at(-1).audio?.length ?? 0, 0);
    assert.deepEqual(
      Buffer.concat(messages.map((m) => m.audio ?? Buffer.alloc(0))),
      completed.get(requestId),
    );
  }
  assert.notEqual(
    parse(completed.get(id)!)[0]!.serial,
    parse(completed.get(ids[2]!)!)[0]!.serial,
  );
});

test("interrupt, server failure and close discard encoders; long sends yield to the event loop", async (t) => {
  const backend = await server(t);
  let callbacks = 0;
  const session = newAvatarSession({
    ...backend.config,
    audioFormat: "ogg_opus",
    oggOpusEncoder: {},
    agoraEgress: { channelName: "test" },
    onEncodedAudio: () => callbacks++,
  });
  t.after(() => session.close());
  await session.init();
  await session.start();
  const first = await session.sendAudio(Buffer.alloc(640));
  const requests = (
    session as unknown as {
      requests: Map<string, { encoder?: OggOpusEncoder }>;
    }
  ).requests;
  const old = requests.get(first)!.encoder!;
  await session.interrupt();
  assert.throws(() => [...old.encode(Buffer.alloc(0), true)], /closed/);
  const second = await session.sendAudio(Buffer.alloc(640));
  backend.sockets[0]!.send(
    encode({
      type: 4,
      serverError: { code: 4002, reqId: second, message: "stop" },
    }),
  );
  await waitFor(() => !requests.has(second));
  assert.notEqual(await session.sendAudio(Buffer.alloc(2)), second);
  const pending = session.sendAudio(Buffer.alloc(16000 * 2 * 60), true);
  const rejected = assert.rejects(pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await session.close();
  await rejected;
  assert.equal(callbacks, 0);
  assert.equal(requests.size, 0);
});

test("WebSocket send failures free the encoder and allow a fresh request", async (t) => {
  const backend = await server(t);
  const session = newAvatarSession({
    ...backend.config,
    audioFormat: "ogg_opus",
    oggOpusEncoder: {},
  });
  t.after(() => session.close());
  await session.init();
  await session.start();
  const id = await session.sendAudio(Buffer.alloc(2));
  const internal = session as unknown as {
    socket: import("ws").default;
    requests: Map<string, { encoder?: OggOpusEncoder }>;
  };
  const encoder = internal.requests.get(id)!.encoder!;
  const send = t.mock.method(
    internal.socket,
    "send",
    (_data: unknown, callback: (error?: Error) => void) =>
      callback(new Error("send failed")),
  );
  await assert.rejects(session.sendAudio(Buffer.alloc(638)), {
    code: "connectionFailed",
  });
  assert.equal(internal.requests.has(id), false);
  assert.throws(() => [...encoder.encode(Buffer.alloc(0), true)], /closed/);
  send.mock.restore();
  assert.notEqual(await session.sendAudio(Buffer.alloc(640), true), id);
});
