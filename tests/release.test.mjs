import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PACKAGE_NAME,
  REPOSITORY,
  validateRelease,
  validateCheckout,
  requireUnpublished,
  setVersion,
  integrity,
  verifyArtifact,
} from "../scripts/release.mjs";

const event = (tag = "v1.2.3", prerelease = false) => ({
  action: "published",
  release: { tag_name: tag, prerelease, draft: false },
  repository: { full_name: REPOSITORY, private: false },
});
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const gitEnv = {
  ...process.env,
  // Git for Windows recognizes /dev/null, not Node's Win32 \\.\nul device path.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function gitAt(root) {
  return (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
}

test("stable and prerelease tags select latest/beta; malformed tags cannot reach npm", () => {
  for (const [tag, pre, distTag] of [
    ["v0.1.0", false, "latest"],
    ["v12.34.56", false, "latest"],
    ["v0.1.0-beta.0", true, "beta"],
    ["v1.0.0-rc.2", true, "beta"],
  ])
    assert.deepEqual(validateRelease(event(tag, pre)), {
      tag,
      version: tag.slice(1),
      distTag,
    });
  for (const tag of [
    "1.2.3",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2",
    "v1.2.3.4",
    "v1.2.3-",
    "v1.2.3-beta..1",
    "v1.2.3-beta.01",
    "v1.2.3+build.1",
    "v1.2.3\n",
    "v1.2.3;echo injected",
    "v9007199254740992.0.0",
    "",
    null,
    123,
  ])
    assert.throws(() => validateRelease(event(tag)), undefined, String(tag));
});

test("drafts, wrong repositories, private releases and channel mismatches fail closed", () => {
  for (const input of [
    undefined,
    { ...event(), action: "created" },
    { ...event(), repository: { full_name: REPOSITORY, private: true } },
    {
      ...event(),
      repository: { full_name: "other/spatius-sdk-js", private: false },
    },
    ...[
      { draft: true },
      { draft: undefined },
      { prerelease: "false" },
      { prerelease: undefined },
      { prerelease: true },
      { tag_name: "v1.2.3-beta.1" },
    ].map((change) => ({
      ...event(),
      release: { ...event().release, ...change },
    })),
  ])
    assert.throws(() => validateRelease(input));
});

test("checkout must match the original tag and be reachable from origin/main", async (t) => {
  const root = await temporary(t),
    git = gitAt(root);
  git("init", "--quiet", "--initial-branch=main");
  git("commit", "--allow-empty", "-m", "base");
  const original = git("rev-parse", "HEAD");
  git("tag", "v1.2.3");
  git("update-ref", "refs/remotes/origin/main", original);
  assert.doesNotThrow(() => validateCheckout(root, "v1.2.3", original));
  assert.throws(
    () => validateCheckout(root, "v1.2.3", original.slice(0, 7)),
    /full/,
  );
  assert.throws(
    () => validateCheckout(root, "v1.2.3", "0".repeat(40)),
    /match/,
  );
  git("commit", "--allow-empty", "-m", "unmerged");
  const next = git("rev-parse", "HEAD");
  git("tag", "v1.2.4");
  assert.throws(() => validateCheckout(root, "v1.2.4", next), /reachable/);
  assert.throws(() => validateCheckout(root, "v1.2.3", next), /match/);
  git("update-ref", "refs/remotes/origin/main", next);
  git("checkout", "--quiet", "--detach", original);
  assert.doesNotThrow(() => validateCheckout(root, "v1.2.3", original));
  git("tag", "--force", "v1.2.3", next);
  assert.throws(() => validateCheckout(root, "v1.2.3", original), /match/);
});

test("only an npm 404 permits publication; duplicates, redirects and network failures stop it", async () => {
  for (const status of [200, 204, 301, 401, 403, 429, 500, 503, 404]) {
    let cancelled = false;
    const pending = requireUnpublished("1.2.3-beta.0", async (url, options) => {
      assert.equal(
        url,
        "https://registry.npmjs.org/%40spatius%2Fserver-sdk/1.2.3-beta.0",
      );
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return {
        status,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      };
    });
    if (status === 404) await pending;
    else
      await assert.rejects(
        pending,
        status === 200 ? /already exists/ : /lookup failed/,
      );
    assert.equal(cancelled, true);
  }
  await assert.rejects(
    requireUnpublished("1.2.3", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});

test("prepare-release stamps manifest and lock only after all preflights pass, with no commits or tags", async (t) => {
  const root = await temporary(t),
    git = gitAt(root);
  await mkdir(join(root, "scripts"));
  for (const name of ["release.mjs", "prepare-release.mjs"])
    await copyFile(
      new URL(`../scripts/${name}`, import.meta.url),
      join(root, "scripts", name),
    );
  const manifest = {
    name: PACKAGE_NAME,
    version: "0.1.0",
    description: "preserve",
  };
  const lock = {
    name: PACKAGE_NAME,
    version: "0.1.0",
    lockfileVersion: 3,
    packages: { "": { ...manifest }, "node_modules/dep": { version: "8.0.0" } },
  };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  const preload = join(root, "fetch.mjs");
  await writeFile(
    preload,
    `globalThis.fetch = async url => {
    if (url !== 'https://registry.npmjs.org/%40spatius%2Fserver-sdk/1.2.3-beta.1') throw new Error('Unexpected URL');
    return new Response(null, {status: Number(process.env.TEST_STATUS)});
  };`,
  );
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "source");
  const sha = git("rev-parse", "HEAD");
  git("tag", "v1.2.3-beta.1");
  git("update-ref", "refs/remotes/origin/main", sha);
  const eventPath = join(root, "event.json"),
    output = join(root, "output");
  await writeFile(eventPath, JSON.stringify(event("v1.2.3-beta.1", true)));
  await writeFile(output, "");
  const run = (status) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        join(root, "scripts/prepare-release.mjs"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...gitEnv,
          NODE_OPTIONS: "",
          GITHUB_EVENT_NAME: "release",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_SHA: sha,
          GITHUB_OUTPUT: output,
          TEST_STATUS: String(status),
        },
      },
    );
  for (const status of [200, 500]) {
    const result = run(status);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(git("diff", "--name-only"), "");
    assert.equal(await readFile(output, "utf8"), "");
  }
  const result = run(404);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, "package.json"))), {
    ...manifest,
    version: "1.2.3-beta.1",
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "package-lock.json"))),
    {
      ...lock,
      version: "1.2.3-beta.1",
      packages: {
        ...lock.packages,
        "": { ...manifest, version: "1.2.3-beta.1" },
      },
    },
  );
  assert.equal(
    await readFile(output, "utf8"),
    "version=1.2.3-beta.1\ndist_tag=beta\n",
  );
  assert.equal(git("rev-parse", "HEAD"), sha);
  assert.equal(git("tag", "--list"), "v1.2.3-beta.1");
  // Validate both input files before touching either one.
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ ...lock, name: "wrong" }),
  );
  await assert.rejects(setVersion(root, "2.0.0"), /Unexpected package/);
  assert.equal(
    JSON.parse(await readFile(join(root, "package.json"))).version,
    "1.2.3-beta.1",
  );
});

test("artifact verification binds the name, version, filename and exact tarball bytes", async (t) => {
  const root = await temporary(t),
    version = "1.2.3-beta.0";
  const filename = `spatius-server-sdk-${version}.tgz`;
  const bytes = Buffer.from("tested tarball");
  const metadata = {
    name: PACKAGE_NAME,
    version,
    filename,
    integrity: integrity(bytes),
  };
  const save = (value) =>
    writeFile(join(root, "release-artifact.json"), JSON.stringify(value));
  await writeFile(join(root, filename), bytes);
  await save(metadata);
  assert.equal(
    (await verifyArtifact(root, version)).tarball,
    join(root, filename),
  );
  for (const change of [
    { name: "wrong" },
    { version: "1.2.3" },
    { filename: "../" + filename },
    { integrity: "sha256-invalid" },
  ]) {
    await save({ ...metadata, ...change });
    await assert.rejects(verifyArtifact(root, version), /metadata/);
  }
  await save(metadata);
  await writeFile(join(root, filename), "tampered");
  await assert.rejects(verifyArtifact(root, version), /integrity/);
  await rm(join(root, filename));
  await assert.rejects(verifyArtifact(root, version), /ENOENT/);
});
