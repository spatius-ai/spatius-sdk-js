# Spatius Server SDK

JavaScript and TypeScript server SDK for creating Spatius avatar sessions.

## Installation

```bash
npm install @spatius/server-sdk
```

Requires Node.js 22 or later. Supports ESM and CommonJS, with TypeScript declarations included.

For built-in PCM → Opus encoding, set `audioFormat: "ogg_opus"` and
`oggOpusEncoder: {}`. No native dependencies are needed; see the [example](examples/opus.ts).

## Documentation

See the Spatius documentation at [docs.spatius.ai](https://docs.spatius.ai).

## License

MIT. The bundled libopus codec uses its own BSD-style license.
