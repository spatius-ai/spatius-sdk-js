// Release policy follows spatius-ai/spatius-cli, without its Worker deployment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PACKAGE_NAME = "@spatius/server-sdk";
export const REPOSITORY = "spatius-ai/spatius-sdk-js";

export function validateRelease(event) {
  if (
    event?.action !== "published" ||
    event.release?.draft !== false ||
    typeof event.release?.prerelease !== "boolean"
  )
    throw new Error("Expected a published, non-draft GitHub release.");
  if (
    event.repository?.full_name !== REPOSITORY ||
    event.repository?.private !== false
  )
    throw new Error(
      `Release publishing requires the public ${REPOSITORY} repository.`,
    );
  const tag = event.release.tag_name;
  const match =
    typeof tag === "string" &&
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag,
    );
  if (
    !match ||
    match[0] !== tag ||
    tag.length > 256 ||
    match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) ||
    match[4]
      ?.split(".")
      .some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))
  )
    throw new Error(
      "Release tag must be canonical vX.Y.Z[-prerelease], without build metadata.",
    );
  if (Boolean(match[4]) !== event.release.prerelease)
    throw new Error(
      "The GitHub prerelease checkbox must match the release tag.",
    );
  return { tag, version: tag.slice(1), distTag: match[4] ? "beta" : "latest" };
}

export function validateCheckout(root, tag, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("A full release commit SHA is required.");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (
    git("rev-parse", "HEAD") !== sha ||
    git("rev-parse", `refs/tags/${tag}^{commit}`) !== sha
  )
    throw new Error(
      "The checkout and release tag must match the original release commit.",
    );
  try {
    git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  } catch {
    throw new Error("The release commit must be reachable from origin/main.");
  }
}

export async function requireUnpublished(version, fetcher = fetch) {
  const response = await fetcher(
    `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
    {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      headers: { "Cache-Control": "no-cache" },
    },
  );
  await response.body?.cancel();
  if (response.status === 200)
    throw new Error(
      `${PACKAGE_NAME}@${version} already exists on npm. Check the previous run; choose a new version for changes.`,
    );
  if (response.status !== 404)
    throw new Error(
      `npm version lookup failed (HTTP ${response.status}); cannot confirm this version is unpublished.`,
    );
}

/** Called only after release validation and registry preflight; changes the runner, never Git. */
export async function setVersion(root, version) {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  if (
    manifest.name !== PACKAGE_NAME ||
    lock.name !== PACKAGE_NAME ||
    lock.packages?.[""]?.name !== PACKAGE_NAME
  )
    throw new Error("Unexpected package name in manifest or lockfile.");
  manifest.version = lock.version = lock.packages[""].version = version;
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
}

export function integrity(bytes) {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}

export async function verifyArtifact(directory, version) {
  const metadata = JSON.parse(
    await readFile(join(directory, "release-artifact.json"), "utf8"),
  );
  const filename = `spatius-server-sdk-${version}.tgz`;
  if (
    metadata.name !== PACKAGE_NAME ||
    metadata.version !== version ||
    metadata.filename !== filename ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.integrity ?? "")
  )
    throw new Error(
      "Release artifact metadata does not match the requested package/version.",
    );
  const tarball = join(directory, filename);
  if (integrity(await readFile(tarball)) !== metadata.integrity)
    throw new Error("Release tarball integrity check failed.");
  return { ...metadata, tarball };
}
