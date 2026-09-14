import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalUpdateDescriptor, parseUpdateCandidate } from "../shared/update-candidate.mjs";

export function validateUpdateCandidate(value) {
  const candidate = parseUpdateCandidate(value);
  const id = `update-${createHash("sha256").update(canonicalUpdateDescriptor(candidate)).digest("hex")}`;
  if (candidate.candidateId !== id) throw new Error("Update candidate identity does not match its metadata.");
  return candidate;
}

function manifestDigests(info) {
  const files = info?.files;
  const packages = info?.packages == null ? [] : Object.values(info.packages);
  if (!Array.isArray(files) || files.length < 1 || files.length + packages.length > 64) throw new Error("Update manifest is missing or ambiguous.");
  const digests = [...files, ...packages].map((item) => item?.sha512);
  if (digests.some((digest) => typeof digest !== "string" || !/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(digest))) throw new Error("Update manifest digest is missing or invalid.");
  return [...new Set(digests)].sort();
}

export function assertCandidateManifest(value, info, { platform = process.platform, arch = process.arch } = {}) {
  const candidate = validateUpdateCandidate(value);
  if (candidate.platform !== platform || candidate.arch !== arch || candidate.version !== info?.version
    || JSON.stringify(candidate.manifestDigests) !== JSON.stringify(manifestDigests(info))) {
    throw new Error("The update candidate has changed. Review the pending installation.");
  }
  return candidate;
}

async function regularPath(file) {
  if (typeof file !== "string" || !file || resolve(file) !== file) throw new Error("Update cache path is invalid.");
  for (let current = file;; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory())) throw new Error("Update cache must contain regular files without symlinks.");
    if (dirname(current) === current) break;
  }
}

async function verifyFile(file, expected) {
  await regularPath(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Update cache is not a regular file.");
    const hash = createHash("sha512");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    await regularPath(file);
    const pathStat = await lstat(file);
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || hash.digest("base64") !== expected) throw new Error("The downloaded update file changed or failed verification.");
  } finally { await handle.close(); }
}

// Pinned electron-updater 6.8.9 publishes these helper fields only after its
// ordinary checksum/signature download path finishes. Never seed vendor state.
export async function captureUpdateCandidate(updater, { platform = process.platform, arch = process.arch, downloadedFiles } = {}) {
  const helper = updater.downloadedUpdateHelper;
  if (!helper?.fileInfo?.info || !helper.versionInfo || !helper.file) throw new Error("Downloaded update metadata is unavailable.");
  const artifacts = [{ kind: "primary", sha512: helper.fileInfo.info.sha512 }];
  const paths = [helper.file];
  if (helper.packageFile || helper.fileInfo.packageInfo) {
    if (platform !== "win32" || !helper.packageFile || !helper.fileInfo.packageInfo) throw new Error("Downloaded update package metadata is ambiguous.");
    artifacts.push({ kind: "package", sha512: helper.fileInfo.packageInfo.sha512 });
    paths.push(helper.packageFile);
  }
  if (downloadedFiles && (downloadedFiles.length !== paths.length || paths.some((file) => !downloadedFiles.includes(file)))) throw new Error("Downloaded update paths do not match the selected artifacts.");
  const descriptor = { schemaVersion: 1, candidateId: `update-${"0".repeat(64)}`, version: helper.versionInfo.version,
    platform, arch, artifacts, manifestDigests: manifestDigests(helper.versionInfo) };
  descriptor.candidateId = `update-${createHash("sha256").update(canonicalUpdateDescriptor(descriptor)).digest("hex")}`;
  const candidate = validateUpdateCandidate(descriptor);
  for (let index = 0; index < paths.length; index++) await verifyFile(paths[index], artifacts[index].sha512);
  return candidate;
}
