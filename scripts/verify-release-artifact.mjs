import { appendFile } from "node:fs/promises";
import { verifyArtifact } from "./release.mjs";

try {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version)
    throw new Error("Usage: verify-release-artifact.mjs <directory> <version>");
  const artifact = await verifyArtifact(directory, version);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `tarball=${artifact.tarball}\n`,
    );
  console.log(
    `Verified ${artifact.name}@${artifact.version} tarball integrity.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
