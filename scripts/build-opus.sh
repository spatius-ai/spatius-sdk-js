#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

# Emscripten 3.1.74, pinned linux/amd64 image. No host compiler is used.
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -v "$root:/sdk" -w /tmp emscripten/emsdk@sha256:af45409f3199d88db4b1b03af0098532c8fb33a375ac257463eeb0a622870d06 bash -euc '
  curl -fsSL https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz -o opus.tar.gz
  echo "65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1  opus.tar.gz" | sha256sum -c -
  tar xf opus.tar.gz
  emcmake cmake -S opus-1.5.2 -B build \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="-O3 -flto" \
    -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF \
    -DOPUS_DISABLE_INTRINSICS=ON -DOPUS_STACK_PROTECTOR=OFF
  cmake --build build --parallel 4
  emcc -O3 -flto /sdk/codec/encoder.c -I opus-1.5.2/include build/libopus.a \
    --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH \
    -sEXPORTED_FUNCTIONS="[\"_encoder_create\",\"_encoder_lookahead\",\"_opus_encode\",\"_opus_encoder_destroy\",\"_malloc\",\"_free\"]" \
    -o /sdk/src/opus.wasm
  cp opus-1.5.2/COPYING /sdk/codec/LICENSE.opus
  cp /emsdk/upstream/emscripten/LICENSE /sdk/codec/LICENSE.emscripten
  cp /emsdk/upstream/emscripten/system/lib/libc/musl/COPYRIGHT /sdk/codec/LICENSE.musl
'
