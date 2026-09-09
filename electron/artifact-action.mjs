import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Revalidate the server-owned saved snapshot before any native OS action. */
export function verifiedArtifactNativePath(record, dataDir) {
  if (!record || typeof record.path !== "string" || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Saved file identity is unavailable.");
  const root = join(realpathSync(dataDir), "artifact-files");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || dirname(record.path) !== root) throw new Error("Saved file location is unavailable.");
  const before = lstatSync(record.path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 25 * 1024 * 1024) throw new Error("Saved file could not be verified.");
  const fd = openSync(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.nlink !== 1) throw new Error("Saved file changed. Refresh Files.");
    if (createHash("sha256").update(readFileSync(fd)).digest("hex") !== record.sha256) throw new Error("Saved file changed. Refresh Files.");
  } finally { closeSync(fd); }
  return record.path;
}
