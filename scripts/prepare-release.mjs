import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  validateRelease,
  validateCheckout,
  requireUnpublished,
  setVersion,
} from "./release.mjs";

try {
  if (
    process.env.GITHUB_EVENT_NAME !== "release" ||
    !process.env.GITHUB_EVENT_PATH
  )
    throw new Error("This command requires a GitHub release event.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const release = validateRelease(
    JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
  );
  validateCheckout(root, release.tag, process.env.GITHUB_SHA);
  await requireUnpublished(release.version);
  await setVersion(root, release.version);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${release.version}\ndist_tag=${release.distTag}\n`,
    );
  console.log(
    `Validated ${PACKAGE_NAME}@${release.version} for ${release.distTag}.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
