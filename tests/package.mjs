import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "spatius-package-"));
const npm = (args, cwd) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: "utf8",
  });

try {
  const [pack] = JSON.parse(
    npm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      root,
    ),
  );
  assert.equal(pack.name, "@spatius/server-sdk");
  for (const path of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
    "dist/opus.wasm",
    "dist/LICENSE.opus",
    "dist/LICENSE.emscripten",
    "dist/LICENSE.musl",
    "LICENSE",
    "README.md",
    "proto/message.proto",
  ])
    assert.ok(
      pack.files.some((file) => file.path === path),
      `Missing ${path}`,
    );
  assert.ok(
    pack.files.every((file) =>
      /^(dist\/|proto\/message.proto$|package.json$|README.md$|LICENSE$)/.test(
        file.path,
      ),
    ),
    "Unexpected package contents",
  );
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temp, pack.filename),
    ],
    temp,
  );
  const sample = `
    sdk.configureTelemetry('');
    const session = sdk.newAvatarSession({ apiKey: 'key', appId: 'app', avatarId: 'avatar', region: 'us-west' });
    if (session.config.sampleRate !== 16000 || !(session instanceof sdk.AvatarSession)) throw new Error('Invalid SDK export');
    if (!session.config.ingressEndpointUrl.includes('api.us-west.spatius.ai')) throw new Error('Invalid endpoint');
    (async () => {
      let completed;
      const encoded = sdk.newAvatarSession({ apiKey: 'key', appId: 'app', avatarId: 'avatar', audioFormat: 'ogg_opus', oggOpusEncoder: {}, onEncodedAudio: (_, bytes) => { completed = Buffer.from(bytes); } });
      // Exercise the installed ESM/CJS asset loader and session integration without network access.
      encoded.state = 'open';
      encoded.socket = { readyState: 1, send: (_, callback) => callback() };
      await encoded.sendAudio(Buffer.alloc(640), true);
      if (!completed || completed.toString('ascii', 0, 4) !== 'OggS' || !completed.includes(Buffer.from('OpusHead'))) throw new Error('Packaged encoder failed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  for (const [filename, prefix] of [
    ["consumer.mjs", "import * as sdk from '@spatius/server-sdk';"],
    ["consumer.cjs", "const sdk = require('@spatius/server-sdk');"],
  ]) {
    writeFileSync(join(temp, filename), prefix + sample);
    execFileSync(process.execPath, [filename], { cwd: temp, stdio: "inherit" });
  }
  for (const filename of ["consumer.mts", "consumer.cts"]) {
    writeFileSync(
      join(temp, filename),
      `import { newAvatarSession, type SessionConfig } from '@spatius/server-sdk';
      const config: SessionConfig = { apiKey: 'key', appId: 'app', avatarId: 'avatar', audioFormat: 'ogg_opus' };
      const session = newAvatarSession(config);
      const pending: Promise<string> = session.sendAudio(new Uint8Array(), true);
      void pending;
    `,
    );
  }
  execFileSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "consumer.mts",
      "consumer.cts",
    ],
    { cwd: temp, stdio: "inherit" },
  );
  const installed = JSON.parse(
    readFileSync(
      join(temp, "node_modules/@spatius/server-sdk/package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.publishConfig.access, "public");
  console.log(
    `Verified ${pack.filename}: ESM, CommonJS, both declaration formats, and package contents.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
