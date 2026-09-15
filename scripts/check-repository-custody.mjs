import { execFileSync } from "node:child_process";
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const violations = custodyViolations(paths);
  if (violations.length) {
    process.stderr.write(`Private operational files are tracked (${violations.length}):\n${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Repository custody: no prohibited operational files tracked.\n");
}
