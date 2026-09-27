# Bundled Opus encoder

The SDK owns the C ABI in `encoder.c` and the TypeScript Ogg framing. The codec
is unmodified Xiph **libopus 1.5.2**, compiled to portable WebAssembly (no SIMD,
threads, native addon, or npm codec wrapper). `src/opus.wasm` is committed and
copied into the package alongside `LICENSE.opus` and the Emscripten/musl notices.
It loads on the first encoded request, not on import or for PCM / pre-encoded
Ogg pass-through.

Rebuild from the repository root with `bash scripts/build-opus.sh` (Docker).
The script pins Emscripten 3.1.74 by image digest and verifies the official
release archive's SHA-256. CI rebuilds and compares the binary and notices. To
update libopus, review its release/security notes, update the source URL and
checksum, regenerate the binary/license, and run the codec and package tests.

Encoding runs on the calling Node.js thread; session sends yield regularly and
apply WebSocket backpressure. Await `sendAudio` calls rather than queueing an
unbounded amount of PCM. The encoder retains one partial frame and one packet;
only `onEncodedAudio` opts into retaining the entire request's encoded output.
FFmpeg with its native libopus decoder is used for independent decoding tests,
never by the SDK at runtime.
