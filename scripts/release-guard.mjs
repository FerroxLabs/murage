import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_REPO = "FerroxLabs/murage-releases";

// This release lane ships stable versions. BigInt avoids silently rounding
// large components, and canonical syntax excludes leading zeros and v prefixes.
export function parseVersion(value) {
  if (typeof value !== "string" || value.trim() !== value ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("expected a canonical stable X.Y.Z version");
  }
  return value.split(".").map(BigInt);
}

export function shouldRelease(current, previous) {
  const after = parseVersion(current);
  const before = parseVersion(previous);
  for (let i = 0; i < 3; i++) {
    if (after[i] < before[i]) throw new Error(`${current} is a downgrade from ${previous}`);
    if (after[i] > before[i]) return true;
  }
  return false;
}

export function nextVersion(current, bump, requested) {
  const next = parseVersion(current);
  if (bump === "patch") next[2]++;
  else if (bump === "minor") { next[1]++; next[2] = 0n; }
  else if (bump === "custom") {
    const custom = String(requested ?? "").replace(/^v/, "");
    if (!shouldRelease(custom, current)) throw new Error("next version must be newer");
    return custom;
  } else throw new Error("unknown version bump");
  return next.join(".");
}

const execute = (command, args) => spawnSync(command, args, {
  encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  timeout: args.some(arg => arg.startsWith("https://uploads.github.com/")) ? 10 * 60_000 : 30_000,
});

function checked(command, args, run) {
  const result = run(command, args);
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed; refusing to proceed`);
  return result.stdout;
}

/** Read the HTTP status itself, never interpret arbitrary gh failure as 404. */
export function apiGet(endpoint, { allow404 = false, run = execute } = {}) {
  const result = run("gh", ["api", "--include", "--method", "GET", endpoint]);
  const text = String(result.stdout ?? "");
  const status = Number(text.match(/^HTTP\/\S+ (\d{3})\b/)?.[1]);
  if (!result.error && status === 404 && result.status !== 0 && allow404) return null;
  if (result.error || result.status !== 0 || status !== 200) {
    throw new Error(`GitHub lookup failed (HTTP ${status || "unknown"}); refusing to proceed`);
  }
  const separator = text.match(/\r?\n\r?\n/);
  if (!separator) throw new Error("GitHub lookup returned malformed HTTP output");
  return JSON.parse(text.slice(separator.index + separator[0].length));
}

function releaseRecord(value, version, id) {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 ||
      value.tag_name !== `v${version}` || typeof value.draft !== "boolean" ||
      !Array.isArray(value.assets) || (id !== undefined && value.id !== id)) {
    throw new Error("GitHub returned an invalid or different release");
  }
  return value;
}

export function findRelease(version, run = execute) {
  parseVersion(version);
  // Anonymous/read-only views can omit drafts. Require a repository view
  // proving push access before interpreting a missing release as absence.
  const repo = apiGet(`repos/${RELEASE_REPO}`, { run });
  if (repo?.permissions?.push !== true) throw new Error("release token must have push access to the releases repository");
  const release = apiGet(`repos/${RELEASE_REPO}/releases/tags/v${version}`, { allow404: true, run });
  if (release) return releaseRecord(release, version);
  // The tag endpoint documents published releases. Search authenticated draft
  // listings too; a 404 alone must never cause creation over an existing draft.
  for (let page = 1; page <= 100; page++) {
    const releases = apiGet(`repos/${RELEASE_REPO}/releases?per_page=100&page=${page}`, { run });
    if (!Array.isArray(releases)) throw new Error("invalid release listing");
    const matches = releases.filter(item => item?.tag_name === `v${version}`);
    if (matches.length > 1) throw new Error("multiple releases claim the same version");
    if (matches.length) return releaseRecord(matches[0], version);
    if (releases.length < 100) return null;
  }
  throw new Error("release listing exceeded its bound; refusing to assume absence");
}

export function assertDraft(version, id, run = execute) {
  parseVersion(version);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid release ID");
  const release = releaseRecord(apiGet(`repos/${RELEASE_REPO}/releases/${id}`, { run }), version, id);
  if (!release.draft || release.immutable === true) throw new Error(`v${version} is published or immutable; refusing to mutate it`);
  return release;
}

export function uploadDraft(version, directory, notesFile, run = execute) {
  parseVersion(version);
  const files = readdirSync(directory).sort().map(name => {
    const file = join(directory, name);
    if (!statSync(file).isFile()) throw new Error("release assets must be regular files");
    const bytes = readFileSync(file);
    return { name, file, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  });
  if (!files.length) throw new Error("no release assets staged");
  let release = findRelease(version, run);
  if (!release) {
    checked("gh", ["release", "create", `v${version}`, "--repo", RELEASE_REPO,
      "--draft", "--title", `Murage ${version}`, "--notes-file", notesFile], run);
    release = findRelease(version, run);
    if (!release) throw new Error("created draft could not be confirmed");
  }
  const id = release.id;
  for (const file of files) {
    // Check immediately before EACH mutation, after long builds and any prior
    // upload. The numeric ID also prevents a changed tag targeting another draft.
    const draft = assertDraft(version, id, run);
    const existing = draft.assets.filter(asset => asset.name === file.name);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].state !== "uploaded" ||
          existing[0].size !== file.size || existing[0].digest !== file.digest) {
        throw new Error(`existing asset ${file.name} differs or lacks a verified digest; use a new version or explicitly repair the stopped draft`);
      }
      continue;
    }
    // Never delete or --clobber: a name collision must fail without replacing
    // bytes, even if an external publisher races the draft check.
    checked("gh", ["api", "--method", "POST",
      `https://uploads.github.com/repos/${RELEASE_REPO}/releases/${id}/assets?name=${encodeURIComponent(file.name)}`,
      "--header", "Content-Type: application/octet-stream", "--input", file.file], run);
    assertDraft(version, id, run);
  }
  assertDraft(version, id, run);
  return id;
}

export function inspectReleaseBranch(version, repository, run = execute) {
  parseVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("invalid source repository");
  const branch = `release/v${version}`;
  const result = run("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
  if (result.error || ![0, 2].includes(result.status)) throw new Error("could not inspect the release branch");
  if (result.status === 2) return { branch_exists: false, pr_url: "" };
  const blob = apiGet(`repos/${repository}/contents/package.json?ref=${encodeURIComponent(branch)}`, { run });
  if (blob?.encoding !== "base64" || typeof blob.content !== "string" ||
      JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")).version !== version) {
    throw new Error("existing release branch does not carry the requested version; inspect it before retrying");
  }
  const prs = JSON.parse(checked("gh", ["pr", "list", "--repo", repository, "--head", branch,
    "--base", "main", "--state", "open", "--json", "url"], run));
  if (!Array.isArray(prs) || prs.length > 1 ||
      (prs.length === 1 && !new RegExp(`^https://github\\.com/${repository.replaceAll(".", "\\.")}/pull/\\d+$`).test(prs[0]?.url))) {
    throw new Error("could not identify a unique open release PR");
  }
  return { branch_exists: true, pr_url: prs[0]?.url ?? "" };
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  for (const [key, value] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main([command, ...args]) {
  if (command === "version") {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    parseVersion(version); console.log(version);
  } else if (command === "should-release") console.log(shouldRelease(...args));
  else if (command === "next-version") console.log(nextVersion(...args));
  else if (command === "absent" || command === "available") {
    const release = findRelease(args[0]);
    if (release && (command === "absent" || !release.draft || release.immutable === true)) {
      throw new Error(`v${args[0]} already exists${release.draft ? " as a draft" : " as a published release"}`);
    }
  } else if (command === "branch") output(inspectReleaseBranch(args[0], process.env.GITHUB_REPOSITORY));
  else if (command === "upload") console.log(uploadDraft(...args));
  else if (command === "publish") {
    const [version, rawId] = args;
    const id = Number(rawId);
    assertDraft(version, id);
    checked("gh", ["api", "--method", "PATCH", `repos/${RELEASE_REPO}/releases/${id}`,
      "--field", "draft=false", "--raw-field", "make_latest=true"], execute);
    const release = releaseRecord(apiGet(`repos/${RELEASE_REPO}/releases/${id}`), version, id);
    if (release.draft) throw new Error("publication was not confirmed");
  } else throw new Error("unknown release guard command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
}
