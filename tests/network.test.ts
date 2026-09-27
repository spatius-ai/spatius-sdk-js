import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, after } from "node:test";
import nock from "nock";
import { normalizeConfig } from "../src/config.js";
import { resolveEndpoints } from "../src/network.js";
import {
  configureTelemetry,
  newAvatarSession,
  prewarm,
  SessionTokenError,
} from "../src/index.js";
import { server, waitFor } from "./server.js";

configureTelemetry("");
nock.disableNetConnect();
nock.enableNetConnect("127.0.0.1");
after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
const credentials = { apiKey: "key", appId: "app", avatarId: "avatar" };

test("defaults, regional domains, endpoint overrides, and one-hour expiry", async () => {
  const now = Date.now();
  const config = normalizeConfig(credentials);
  assert.equal(config.sampleRate, 16000);
  assert.equal(config.audioFormat, "pcm_s16le");
  assert.equal(config.region, "auto");
  assert.ok(config.expireAt.getTime() >= now + 3_600_000);
  assert.ok(config.expireAt.getTime() <= Date.now() + 3_600_000);
  for (const [region, domain] of [
    ["cn-beijing", "spatialwalk.top"],
    ["eu-central", "spatius.ai"],
  ]) {
    const pinned = normalizeConfig({ ...credentials, region });
    await resolveEndpoints(pinned);
    assert.equal(
      pinned.consoleEndpointUrl,
      `https://console.${region}.${domain}/v1/console`,
    );
    assert.equal(
      pinned.ingressEndpointUrl,
      `wss://api.${region}.${domain}/v2/driveningress`,
    );
  }
  const partial = normalizeConfig({
    ...credentials,
    consoleEndpointUrl: "https://example.com/console",
  });
  await resolveEndpoints(partial);
  assert.equal(partial.consoleEndpointUrl, "https://example.com/console");
  assert.equal(
    partial.ingressEndpointUrl,
    "wss://api.us-west.spatius.ai/v2/driveningress",
  );
  const explicit = normalizeConfig({
    ...credentials,
    consoleEndpointUrl: "https://a",
    ingressEndpointUrl: "wss://b",
  });
  await resolveEndpoints(explicit);
  assert.equal(explicit.region, "auto");
  assert.throws(
    () => normalizeConfig({ ...credentials, audioFormat: "mp3" as "ogg_opus" }),
    /audio format/,
  );
  assert.throws(
    () => normalizeConfig({ ...credentials, expireAt: new Date("invalid") }),
    /expireAt/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        ...credentials,
        livekitEgress: { url: "wss://a", roomName: "r", publisherId: "p" },
        agoraEgress: { channelName: "c" },
      }),
    /both/,
  );
});

test("bootstrap failure fallback, success cache, stale fallback, and invalid regions", async (t) => {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const first = nock("https://global.spatialwalk.top")
    .post("/bootstrap", {
      app_id: "app",
      sdk_version: version,
      region: "auto",
      platform: "node",
    })
    .reply(503, {});
  const fallback = normalizeConfig(credentials);
  await resolveEndpoints(fallback);
  assert.equal(fallback.region, "us-west");
  first.done();
  const success = nock("https://global.spatialwalk.top")
    .post("/bootstrap")
    .reply(200, { region: { current: "eu-central" } });
  const fresh = normalizeConfig(credentials);
  await resolveEndpoints(fresh);
  success.done();
  assert.equal(fresh.region, "eu-central");
  const cached = normalizeConfig(credentials);
  await resolveEndpoints(cached); // Network is blocked unless an expectation exists.
  assert.equal(cached.region, "eu-central");
  const clock = performance.now() + 301_000;
  t.mock.method(performance, "now", () => clock);
  const invalid = nock("https://global.spatialwalk.top")
    .post("/bootstrap")
    .reply(200, { region: { current: "attacker.example/path" } });
  const stale = normalizeConfig(credentials);
  await resolveEndpoints(stale);
  invalid.done();
  assert.equal(stale.region, "eu-central");
  const retry = nock("https://global.spatialwalk.top")
    .post("/bootstrap")
    .reply(200, { region: { current: "cn-beijing" } });
  const recovered = normalizeConfig(credentials);
  await resolveEndpoints(recovered);
  retry.done();
  assert.equal(recovered.region, "cn-beijing");
});

for (const [status, body, code] of [
  [
    401,
    JSON.stringify({
      errors: [
        { status: "401", code: "expired", detail: "session token expired" },
      ],
    }),
    "sessionTokenExpired",
  ],
  [
    200,
    JSON.stringify({ errors: [{ status: "402", detail: "session denied" }] }),
    "billingRequired",
  ],
  [500, "not JSON", "serverError"],
  [200, "not JSON", "protocolError"],
  [200, JSON.stringify({ sessionToken: 123 }), "protocolError"],
  [200, JSON.stringify({ sessionToken: "" }), "protocolError"],
  [200, "null", "protocolError"],
] as const)
  test(`token response ${status} ${body} yields ${code}`, async (t) => {
    const backend = await server(t, {
      http: (_req, res) => {
        res.statusCode = status;
        res.end(body);
      },
    });
    const session = newAvatarSession(backend.config);
    await assert.rejects(session.init(), (error: unknown) => {
      assert.ok(error instanceof SessionTokenError);
      assert.equal(error.code, code);
      assert.equal(error.phase, "session_token");
      assert.equal(error.rawBody, body);
      return true;
    });
  });

test("token timeout is structured; closing during init cannot resurrect the session", async (t) => {
  const backend = await server(t, { http: () => {} });
  const session = newAvatarSession({ ...backend.config, timeoutMs: 100 });
  await assert.rejects(session.init(), {
    code: "connectionFailed",
    phase: "session_token",
  });
  let release: (() => void) | undefined;
  const delayed = await server(t, {
    http: (_req, res) => {
      release = () => res.end('{"sessionToken":"late"}');
    },
  });
  const other = newAvatarSession(delayed.config);
  const rejected = assert.rejects(other.init(), { code: "connectionClosed" });
  await waitFor(() => !!release);
  await other.close();
  release!();
  await rejected;
  await assert.rejects(other.start(), /cannot be restarted/);
});

test("prefetch is opt-in, reuses matching tokens, isolates credentials, and honors expiry margin", async (t) => {
  const backend = await server(t);
  const options = { ...backend.config, prefetchSessionToken: true };
  assert.equal(
    (await prewarm({ ...options, prefetchSessionToken: false }))
      .sessionTokenPrefetched,
    false,
  );
  assert.equal(backend.requests.length, 0);
  assert.equal((await prewarm(options)).sessionTokenPrefetched, true);
  assert.equal(backend.requests.length, 1);
  const session = newAvatarSession(backend.config);
  await session.init();
  await session.close();
  assert.equal(backend.requests.length, 1);
  for (const difference of [
    { apiKey: "other-key" },
    { appId: "other-app" },
    { consoleEndpointUrl: `${backend.url}/different` },
  ]) {
    const isolated = newAvatarSession({ ...backend.config, ...difference });
    await isolated.init();
    await isolated.close();
  }
  assert.equal(backend.requests.length, 4);
  await prewarm({ ...options, sessionExpireAt: new Date(Date.now() + 59_000) });
  const expired = newAvatarSession(backend.config);
  await expired.init();
  await expired.close();
  assert.equal(backend.requests.length, 6);
  assert.equal(
    (await prewarm({ ...options, apiKey: "" })).sessionTokenPrefetched,
    false,
  );
  assert.equal(
    (await prewarm({ ...options, timeoutMs: -1 })).sessionTokenPrefetched,
    false,
  );
});
