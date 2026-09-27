import { defineConfig } from "tsup";
import { copyFile } from "node:fs/promises";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  clean: true,
  shims: true,
  sourcemap: true,
  dts: {
    banner: '/// <reference lib="esnext.disposable" />',
    // tsup injects baseUrl into declaration builds; TypeScript 6 deprecates it.
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  async onSuccess() {
    await copyFile("src/opus.wasm", "dist/opus.wasm");
    for (const name of ["opus", "emscripten", "musl"])
      await copyFile(`codec/LICENSE.${name}`, `dist/LICENSE.${name}`);
  },
});
