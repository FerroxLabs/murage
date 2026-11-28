import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const generated = new Set(['.git', '.v101-ref', '.v102-ref', '.vrel-ref', 'node_modules', '.test-tmp',
  'dist', 'dist-native', 'build', '.cache', 'coverage', 'test-results', 'playwright-report']);

export function candidatePaths(checkout) {
  const indexed = existsSync(join(checkout, '.git')) && spawnSync('git', ['ls-files', '-z'], {
    cwd: checkout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (indexed && indexed.status === 0) return indexed.stdout.split('\0').filter(Boolean);
  const manifest = join(checkout, 'server/testing/.git-ls-files.fixture');
  if (existsSync(manifest)) return readFileSync(manifest, 'utf8').split('\0').filter(Boolean);
  // A source export has neither a Git index nor a runner-supplied manifest.
  function walk(dir = '') {
    return readdirSync(join(checkout, dir), { withFileTypes: true }).flatMap(entry => {
      if (generated.has(entry.name)) return [];
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) return [name];
      return existsSync(join(checkout, name, '.git')) ? [] : walk(name);
    });
  }
  return walk();
}

// Inspect tracked/index paths, not the working tree: ignored private files may
// remain locally, but even a force-added internal file must fail this gate.
// Directory and file-name rules match at any depth, as the unanchored
// .gitignore patterns do; a nested force-added record is no less private.
// Rules for anchored ignore patterns (ijfw/memory|sessions, docs/plans and the
// generated backup qualification receipt directories) stay root-anchored.
export function retiredEvidencePath(path) {
  const name = path.replaceAll("\\", "/");
  return /(?:^|\/)(?:evidence|lane-evidence|c2-rule-evidence)\//i.test(name)
    || /^proof\//i.test(name) || /^lanes\/[^/]+\/shots\//i.test(name);
}

export function privateOperationalPath(path) {
  const name = path.replaceAll("\\", "/");
  return retiredEvidencePath(name) || /(?:^|\/)\.planning\//.test(name) || /(?:^|\/)\.ijfw\//.test(name)
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

const WINDOWS_ACCOUNT_SID = /S-1-5-21-[0-9]/i;
const WINDOWS_PROFILE_PREFIX = String.raw`[A-Za-z]:[\\/]+Users[\\/]+`;
// A profile folder name is every character Win32 allows in a file name: only \ / : * ? " < > |
// and control characters end it. Apostrophe, backtick, space, comma and brackets are name
// characters, so they never end the name.
const WINDOWS_PROFILE = new RegExp(WINDOWS_PROFILE_PREFIX + "([^\\\\/:*?\"<>|\\x00-\\x1f]+)", "gi");
const ALLOWED_PROFILES = ["public", "default"];
const SYNTHETIC_PROFILE_FILE = "server/protected-folders.test.ts";

// Allowed only when the whole component is an allowed word, after the trailing spaces and
// periods Win32 strips from a name. The one other allowed form is a path wrapped in quotes:
// the same apostrophe or backtick right before the drive letter and right after the word,
// with no separator after it. Anything else, such as a quote followed by more name
// characters, a second quote or a further path component, is a different folder: fail closed.
function allowedProfile(path, text, match) {
  const words = path === SYNTHETIC_PROFILE_FILE ? [...ALLOWED_PROFILES, "testuser"] : ALLOWED_PROFILES;
  const name = match[1].replace(/[ .]+$/, "").toLowerCase();
  if (words.includes(name)) return true;
  const quote = name.slice(-1);
  if (quote !== "'" && quote !== "`") return false;
  const opened = match.index > 0 && text[match.index - 1] === quote;
  const lastComponent = !/^[\\/]/.test(text.slice(match.index + match[0].length));
  return opened && lastComponent && words.includes(name.slice(0, -1));
}

function addWindowsIdentityFindings(findings, path, line, text) {
  if (WINDOWS_ACCOUNT_SID.test(text)) findings.push(`${path}:${line} Windows account SID`);
  for (const match of text.matchAll(WINDOWS_PROFILE)) {
    if (allowedProfile(path, text, match)) continue;
    findings.push(`${path}:${line} Windows profile path`);
    break;
  }
}

function indexedPrivateWindowsIdentity() {
  const candidates = [WINDOWS_ACCOUNT_SID.source, WINDOWS_PROFILE_PREFIX].join("|");
  const result = spawnSync("git", ["grep", "--cached", "-I", "-n", "-z", "-i", "-E", candidates], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error("git grep failed during Windows identity scan");
  const findings = [];
  for (const [, path, line, text] of result.stdout.matchAll(/([^\0]+)\0(\d+)\0([^\n]*)\n/g)) {
    addWindowsIdentityFindings(findings, path, line, text);
  }
  return findings;
}

async function addedPrivateWindowsIdentity(base) {
  const mergeBase = execFileSync("git", ["merge-base", "--", base, "HEAD"], { encoding: "utf8" }).trim();
  // Use a distinct indicator so an added line beginning with "++ " cannot be a file header.
  const diff = spawn("git", [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--submodule=short",
    "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", "--inter-hunk-context=0",
    "--output-indicator-new=>", mergeBase, "HEAD", "--",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const status = once(diff, "close").then(([code]) => code, () => null);
  const findings = [];
  let path;
  let lineNumber;
  let pending = "";
  for await (const chunk of diff.stdout.setEncoding("utf8")) {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith("+++ ")) path = line.replace(/^\+\+\+ ("?)b\//, "$1").replace(/\t$/, "");
      else if (line.startsWith("@@ ")) lineNumber = Number(/\+(\d+)(?:,\d+)? @@/.exec(line)[1]);
      else if (line.startsWith(">")) addWindowsIdentityFindings(findings, path, lineNumber++, line.slice(1));
    }
  }
  if (await status !== 0) throw new Error("git diff failed during Windows identity scan");
  return findings;
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
  const addedSinceAt = process.argv.indexOf("--added-since");
  const windowsPrivate = process.argv.includes("--windows-private");
  const tree = treeAt === -1 ? undefined : process.argv[treeAt + 1];
  const base = addedSinceAt === -1 ? undefined : process.argv[addedSinceAt + 1];
  if ((treeAt !== -1 && (!tree || windowsPrivate)) || (addedSinceAt !== -1 && (!base || !windowsPrivate))) {
    process.stderr.write("usage: check-repository-custody.mjs [--tree <directory> | --windows-private [--added-since <ref>]]\n");
    process.exit(2);
  }
  let violations;
  let content;
  if (tree) ({ violations, content } = treeCustody(tree));
  else {
    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    violations = custodyViolations(paths);
    content = indexedPrivateContent();
    if (windowsPrivate) content = content.concat(base ? await addedPrivateWindowsIdentity(base) : indexedPrivateWindowsIdentity());
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
