# Spatius Server SDK

Node.js server SDK for Spatius avatar sessions. Stream audio over the v2 protobuf
WebSocket protocol and receive animation envelopes, or send output directly to a
LiveKit room or Agora channel.

## Installation

```sh
npm install @spatius/server-sdk
```

Requires **Node.js 22 or later**. Includes TypeScript declarations, ESM imports,
and CommonJS `require()` exports. This is a server-only SDK: never expose your API
key in browser code.

## Quick start

```ts
import { readFile } from "node:fs/promises";
import { newAvatarSession, shutdownTelemetry } from "@spatius/server-sdk";

const pcm = await readFile("speech.pcm"); // Mono, signed 16-bit little-endian, 16 kHz.
let complete!: () => void;
let fail!: (error: Error) => void;
const finished = new Promise<void>((resolve, reject) => {
  complete = resolve;
  fail = reject;
});
// Attach a handler immediately, including for errors that arrive while sending.
void finished.catch(() => {});

const session = newAvatarSession({
  apiKey: process.env.SPATIUS_API_KEY!,
  appId: process.env.SPATIUS_APP_ID!,
  avatarId: process.env.SPATIUS_AVATAR_ID!,
  transportFrames(data, isLast) {
    // Forward the complete binary protobuf envelope to your animation consumer.
    console.log("Animation envelope:", data.byteLength, "bytes");
    if (isLast) complete();
  },
  onError: fail,
  onClose: () => fail(new Error("Session closed before the final frame")),
});

const timeout = setTimeout(
  () => fail(new Error("Animation timed out")),
  60_000,
);
try {
  await session.init(); // Resolve region and exchange API key for a session token.
  console.log("Connected:", await session.start());
  const reqId = await session.sendAudio(pcm, true);
  console.log("Request:", reqId);
  await finished; // Sending the final audio chunk does not mean output has finished.
} finally {
  clearTimeout(timeout);
  await session.close();
  await shutdownTelemetry(); // At application exit, not after every worker session.
}
```

For streaming input, call `await session.sendAudio(chunk)` repeatedly, then
`await session.sendAudio(lastChunk, true)`. Chunks share a request ID until
`end=true`; the next call allocates a new ID. `Buffer` and `Uint8Array` are accepted.
Await each send for transport backpressure; completion means the chunk was written,
not that animation or egress playback has finished.

`close()` is idempotent and invokes `onClose` once. Closed sessions cannot restart.
Create a new session after a disconnect or failed `start()`. `init()` and `start()`
reject on initialization failures; `onError` reports runtime failures. Callbacks
are synchronous; exceptions are isolated from session cleanup. Handle promises
inside a callback yourself if starting asynchronous work there.

`Symbol.asyncDispose` is also supported for cleanup with TypeScript `await using`;
you must still call `init()` and `start()` explicitly.

## Configuration

| Option                        | Default / behavior                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `apiKey`, `appId`, `avatarId` | Required credentials and avatar identifier                                                          |
| `expireAt`                    | `Date`, one hour from construction; sent as Unix seconds                                            |
| `sampleRate`                  | `16000` Hz, mono audio                                                                              |
| `audioFormat`                 | `AudioFormat.PCM_S16LE` (`"pcm_s16le"`)                                                             |
| `bitrate`                     | `0`; set a bitrate when using Opus                                                                  |
| `region`                      | `"auto"`; global bootstrap, five-minute process cache, stale/default `us-west` fallback             |
| `consoleEndpointUrl`          | Optional Console base URL; SDK appends `/session-tokens`                                            |
| `ingressEndpointUrl`          | Optional ingress base URL; SDK appends `/websocket`                                                 |
| `useQueryAuth`                | `false`: `X-App-ID` / `X-Session-Key` headers. `true`: URL query credentials                        |
| `extraParams`                 | String-to-string extension parameters in the handshake                                              |
| `timeoutMs`                   | `10000` per token request, WebSocket upgrade, and protocol handshake; bootstrap uses at most `5000` |
| `transportFrames`             | `(data: Uint8Array, isLast: boolean) => void`; complete raw envelope, WebSocket output only         |
| `onError`, `onClose`          | Runtime error and closure callbacks                                                                 |

A concrete region skips bootstrap. Chinese `cn-*` regions use `spatialwalk.top`;
other regions use `spatius.ai`. Explicit endpoints are preserved. With only one
explicit endpoint and an auto region, the missing endpoint uses `us-west` without
bootstrap. Use TLS (`https:` / `wss:`) outside local development. Query auth can put
credentials into infrastructure logs; prefer the default header authentication.

### Ogg Opus

Set `audioFormat: AudioFormat.OGG_OPUS` (or `"ogg_opus"`) to send an already-encoded
**continuous mono Ogg Opus stream per request ID**. The SDK passes bytes through;
it does not encode PCM, resample audio, or accept an MP3/WAV file as raw PCM. An
empty final chunk is supported.

### LiveKit and Agora egress

Pass exactly one of these as `livekitEgress` or `agoraEgress` to `newAvatarSession()`:

```ts
const livekitEgress = {
  url: "wss://your-livekit-host",
  apiToken: "your-publisher-token",
  roomName: "room-name",
  publisherId: "avatar-publisher",
  extraAttributes: { role: "avatar" },
  idleTimeout: 60, // Seconds; 0 uses server defaults.
};
```

```ts
const agoraEgress = {
  channelName: "channel-name",
  token: "your-agora-token",
  uid: 123,
  publisherId: "avatar-publisher",
};
```

Deprecated LiveKit `apiKey` / `apiSecret` fields are accepted for compatibility;
prefer `apiToken`. In egress mode, `transportFrames` is not invoked. Keep the
session open until your room/channel consumer finishes playback. Call
`await session.interrupt()` to interrupt the most recent request, even after its
last input chunk. Interruption returns that request ID and resets the next audio
request. It is supported only in egress mode.

## Warm-up

```ts
import { prewarm } from "@spatius/server-sdk";

const result = await prewarm({
  appId: process.env.SPATIUS_APP_ID!,
  apiKey: process.env.SPATIUS_API_KEY!,
  prefetchSessionToken: true, // Off by default; requires reusable session tokens.
});
console.log(result.region, result.sessionTokenPrefetched);
```

Warm-up is best-effort and never throws. Tokens are cached by API key, app ID, and
Console endpoint, and discarded one minute before expiration. Do not enable
prefetch if your deployment makes tokens single-use. Node's shared HTTP agents
reuse connections and TLS sessions; this release does not implement Python's
separate bare-TLS prewarm operation.

## Errors and telemetry

`AvatarSDKError` exposes stable `code` values and structured context (`phase`,
`httpStatus`, `serverCode`, `serverDetail`, `connectionId`, `reqId`, `rawBody`,
`closeCode`, and `closeReason`). Token exchange failures use its subclass
`SessionTokenError`. Avoid logging whole errors or configs: server response bodies
and underlying causes may contain sensitive details.

Like the Python SDK, telemetry is enabled by default and exports OTLP protobuf
traces and duration metrics to `https://t.spatialwalk.top`. It records protocol
timings, region, audio format, egress type, and request IDs, not API keys, audio
bytes, or exception bodies. SDK-owned providers do not replace application OTel
providers or inherit host OTLP authentication headers. Exports are best-effort,
with a five-second timeout and no retries. W3C trace context accompanies only the
first audio chunk of each request.

Configure before using sessions or warm-up:

```ts
import { configureTelemetry, shutdownTelemetry } from "@spatius/server-sdk";

configureTelemetry(""); // Disable telemetry and request trace propagation.
// Or: configureTelemetry("https://your-collector.example");
// At application exit: await shutdownTelemetry();
```

Session cleanup does not wait for exporters. Call `shutdownTelemetry()` at process
exit to flush, or before changing an already-initialized telemetry endpoint.

## Development and publication

```sh
npm ci
npm run check
npm run format:check
npm run test:package
npm run proto:generate # After updating proto/message.proto; commit src/proto.json.
```

The protocol and behavior were ported from
[spatius-sdk-python at 8b7d927](https://github.com/spatius-ai/spatius-sdk-python/commit/8b7d927f1def9e590e34ea5d1488658ee85e779b).
The JavaScript API uses camelCase and promises. It supports the session protocol,
egress, region/token caching, structured errors, and basic telemetry; it is not a
complete Python API port. In particular, native PCM-to-Opus encoding and bare-TLS
prewarm are not included, and telemetry instruments are not a one-to-one port.

CI runs local protocol tests and package-consumer checks without Spatius credentials.
Live-service compatibility still needs a credentialed smoke test before release.

The package is configured as public `@spatius/server-sdk`, initially `0.1.0`.
Nothing publishes automatically. After review and merge, a maintainer with npm
publish access to the `@spatius` scope can run:

```sh
npm ci
npm run check
npm run test:package
npm publish --dry-run
npm publish --access public
```

## License

MIT
