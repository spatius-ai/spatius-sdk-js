import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  clean: true,
  sourcemap: true,
  dts: { banner: '/// <reference lib="esnext.disposable" />' },
});
