import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Inspect tracked/index paths, not the working tree: ignored private files may
// remain locally, but even a force-added internal file must fail this gate.
// Directory and file-name rules match at any depth, as the unanchored
// .gitignore patterns do; a nested force-added record is no less private.
// Rules for anchored ignore patterns (ijfw/memory|sessions, docs/plans and the
// generated backup qualification receipt directories) stay root-anchored.
export function privateOperationalPath(path) {
  const name = path.replaceAll("\\", "/");
  return /(?:^|\/)\.planning\//.test(name) || /(?:^|\/)\.ijfw\//.test(name)
    || /^ijfw\/(?:memory|sessions)\//.test(name)
    || /^native\/backup-age\/real-main-qualification\/(?:preflight|native)-receipts\//.test(name)
    || /(?:^|\/)(?:HANDOFF[^/]*|[^/]*-EXECUTION)\.md$/i.test(name)
    || (name.startsWith("docs/plans/") && name !== "docs/plans/0153-RELEASE-NOTES.md");
}
export function custodyViolations(paths) { return paths.filter(privateOperationalPath); }

// This repository is public. A tracked file must not carry a maintainer's
// machine paths or private folder names: a home directory, a personal
// operations folder, a private evidence folder, a local volume or a host
// name. Each pattern is assembled from pieces so this file and its test do
// not match themselves, and matching ignores case (a lower-cased volume path
// is still the same volume).
const PRIVATE_CONTENT = [
  ["sean", "donahoe"],
  ["\\.", "sable/"],
  ["murage-", "qualification-private"],
  ["/Volumes/", "Mando"],
  ["sean\\.", "imsc"],
  ["tail0a", "48a4"],
].map(parts => parts.join(""));
export const privateContentPattern = new RegExp(PRIVATE_CONTENT.join("|"), "i");

/** `path:line` for every text line in the index that matches, via git grep over
 * the staged blobs (the same index view the path rule reads). */
export function indexedPrivateContent(options = {}) {
  const result = spawnSync("git", ["grep", "--cached", "-I", "-n", "-i", "-E", PRIVATE_CONTENT.join("|")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr}`);
  // Report the location only; the matching text is what must not be repeated.
  return result.stdout.split("\n").filter(Boolean).map(line => line.split(":").slice(0, 2).join(":"));
}

/** The same two rules over a directory tree instead of the index: every
 * private path, and `path:line` for every matching text line (a file with a
 * NUL byte in its first 8000 bytes counts as binary, as git grep -I does).
 * deploy/cloud-home/build-image.sh runs this on the unpacked `git archive`
 * that becomes /opt/murage in every customer home. Symlinks are listed by
 * path and never followed. */
export function treeCustody(root) {
  const paths = [];
  const content = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) { walk(full); continue; }
      paths.push(rel);
      if (!entry.isFile()) continue;
      const bytes = readFileSync(full);
      if (bytes.subarray(0, 8000).includes(0)) continue;
      bytes.toString("utf8").split("\n").forEach((line, index) => {
        if (privateContentPattern.test(line)) content.push(`${rel}:${index + 1}`);
      });
    }
  };
  walk(root);
  return { violations: custodyViolations(paths), content };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const treeAt = process.argv.indexOf("--tree");
  const tree = treeAt === -1 ? undefined : process.argv[treeAt + 1];
  if (treeAt !== -1 && !tree) {
    process.stderr.write("usage: check-repository-custody.mjs [--tree <directory>]\n");
    process.exit(2);
  }
  let violations;
  let content;
  if (tree) ({ violations, content } = treeCustody(tree));
  else {
    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    violations = custodyViolations(paths);
    content = indexedPrivateContent();
  }
  const where = tree ? `under ${tree}` : "tracked";
  if (violations.length) {
    process.stderr.write(`Private operational files ${where} (${violations.length}):\n${violations.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (content.length) {
    process.stderr.write(`Private machine paths or names in files ${where} (${content.length}); use a neutral example, a flag or an environment variable:\n${content.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (!violations.length && !content.length) process.stdout.write(`Repository custody: no prohibited operational files or private paths ${where}.\n`);
}
