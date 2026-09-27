import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { integrity, verifyArtifact } from "../scripts/release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [flag, destination] = process.argv.slice(2);
if (
  process.argv.length > 2 &&
  (flag !== "--artifact-dir" || !destination || process.argv.length !== 4)
)
  throw new Error("Usage: package.mjs [--artifact-dir <directory>]");
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
  assert.equal(
    pack.version,
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  );
  for (const path of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
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
  assert.equal(installed.version, pack.version);
  if (destination) {
    const directory = resolve(destination);
    const bytes = readFileSync(join(temp, pack.filename));
    assert.equal(integrity(bytes), pack.integrity);
    mkdirSync(directory, { recursive: true });
    copyFileSync(join(temp, pack.filename), join(directory, pack.filename));
    writeFileSync(
      join(directory, "release-artifact.json"),
      JSON.stringify(
        {
          name: pack.name,
          version: pack.version,
          filename: pack.filename,
          integrity: pack.integrity,
        },
        null,
        2,
      ) + "\n",
    );
    await verifyArtifact(directory, pack.version);
  }
  console.log(
    `Verified ${pack.filename}: ESM, CommonJS, both declaration formats, and package contents.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
