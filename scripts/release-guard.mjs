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

export const DRAFT_CONFIRM_ATTEMPTS = 6;
export const DRAFT_CONFIRM_BACKOFF_MS = 2_000;
// Synchronous wait (the guard is synchronous end to end). Test runners pass a
// fake `run` and get a no-op so the suite never sleeps.
function pause(ms, run) {
  if (run !== execute) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function checked(command, args, run) {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    // CLI errors can include response bodies, paths, or credentials. Emit only
    // numeric status and fixed classifications, never the raw stdout/stderr.
    const text = `${String(result.stderr ?? "").slice(0, 65536)}\n${String(result.stdout ?? "").slice(0, 65536)}`;
    const http = text.match(/\bHTTP(?:\/\S+)?\s+([45]\d{2})\b/)?.[1] ?? "unknown";
    const reasons = [
      [/resource not accessible/i, "resource-access-denied"],
      [/bad credentials/i, "invalid-credentials"],
      [/workflow.*scope|scope.*workflow/i, "workflow-scope-required"],
      [/repository is empty/i, "empty-repository"],
      [/validation failed/i, "validation-failed"],
      [/already exists/i, "already-exists"],
      [/could not resolve host|no such host/i, "dns-failure"],
      [/no such file or directory/i, "local-file-missing"],
    ];
    const reason = reasons.find(([pattern]) => pattern.test(text))?.[1] ?? "unclassified";
    const processError = ["ETIMEDOUT", "ENOENT", "EACCES", "ENOBUFS"].includes(result.error?.code)
      ? result.error.code : result.error ? "other" : "none";
    const operation = command === "gh" && args[0] === "release" && args[1] === "create" ? "gh release create" : `${command} ${args[0]}`;
    throw new Error(`${operation} failed (exit=${Number.isInteger(result.status) ? result.status : "none"}, HTTP=${http}, reason=${reason}, process=${processError}); refusing to proceed`);
  }
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

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const digestPending = (asset) => asset?.digest === null || asset?.digest === undefined || asset?.digest === "";

/** sha256 digests of the staged release assets, in GitHub's `sha256:<hex>` form. */
export function stagedDigests(directory) {
  const names = readdirSync(directory).sort();
  if (!names.length) throw new Error("no release assets staged");
  return new Map(names.map(name => {
    const file = join(directory, name);
    if (!statSync(file).isFile()) throw new Error("release assets must be regular files");
    return [name, `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`];
  }));
}

/** Compare one draft metadata view with the staged digests. `unreported` lists
 * assets GitHub has not yet computed a digest for (it does so asynchronously);
 * every other list is a failure that waiting cannot repair. */
export function compareDraftAssets(expected, assets) {
  if (!(expected instanceof Map) || expected.size === 0) throw new Error("no staged release assets to compare");
  if (!Array.isArray(assets)) throw new Error("draft metadata has no asset list");
  const names = assets.map(asset => String(asset?.name));
  return {
    missing: [...expected.keys()].filter(name => !names.includes(name)),
    unexpected: names.filter(name => !expected.has(name)),
    duplicated: [...new Set(names.filter((name, index) => names.indexOf(name) !== index))],
    notUploaded: assets.filter(asset => asset?.state !== "uploaded").map(asset => String(asset?.name)),
    unreported: assets.filter(digestPending).map(asset => String(asset?.name)),
    mismatched: assets.filter(asset => !digestPending(asset) && (typeof asset.digest !== "string" ||
      !SHA256_DIGEST.test(asset.digest) || expected.get(String(asset.name)) !== asset.digest)).map(asset => String(asset?.name)),
  };
}

/** The non-waitable failures of a comparison, or null. */
export function draftAssetFailure(report) {
  const parts = [
    ["missing", report.missing], ["unexpected", report.unexpected], ["duplicated", report.duplicated],
    ["not finished uploading", report.notUploaded], ["digest mismatch", report.mismatched],
  ].filter(([, names]) => names.length).map(([label, names]) => `${label}: ${names.join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}

/** Publication gate: every staged asset is on the draft, uploaded, and carries
 * a GitHub digest equal to the staged bytes. A missing digest holds. */
export function assertCompleteDraftDigests(expected, assets) {
  const report = compareDraftAssets(expected, assets);
  const failure = draftAssetFailure(report);
  if (failure) throw new Error(`draft assets do not match the staged bytes (${failure}); refusing to publish`);
  if (report.unreported.length) {
    throw new Error(`GitHub has not reported a digest for ${report.unreported.length} asset(s): ${report.unreported.join(", ")}; holding publication`);
  }
}

/** Flip a verified draft live. With the staged assets directory the digests are
 * compared to those bytes; without it every asset must at least carry a
 * well-formed GitHub digest. Either way a missing digest holds publication. */
export function publishDraft(version, id, assetsDir, run = execute) {
  const draft = assertDraft(version, id, run);
  if (assetsDir) assertCompleteDraftDigests(stagedDigests(assetsDir), draft.assets);
  else {
    const incomplete = draft.assets.filter(asset => asset?.state !== "uploaded" ||
      typeof asset?.digest !== "string" || !SHA256_DIGEST.test(asset.digest)).map(asset => String(asset?.name));
    if (!draft.assets.length || incomplete.length) {
      throw new Error(`draft assets lack a verified upload digest (${incomplete.join(", ") || "no assets"}); holding publication`);
    }
  }
  checked("gh", ["api", "--method", "PATCH", `repos/${RELEASE_REPO}/releases/${id}`,
    "--field", "draft=false", "--raw-field", "make_latest=true"], run);
  const release = releaseRecord(apiGet(`repos/${RELEASE_REPO}/releases/${id}`, { run }), version, id);
  if (release.draft) throw new Error("publication was not confirmed");
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
    // The draft listing is eventually consistent: run 34655404559 created the
    // draft at 23:11:35Z and the listing one second later did not carry it yet.
    // Re-read with a short backoff before treating the draft as absent; a
    // second `release create` over an unseen draft is exactly what this guard
    // exists to prevent, so absence after the retries is still an error.
    for (let attempt = 0; !release && attempt < DRAFT_CONFIRM_ATTEMPTS; attempt++) {
      if (attempt) pause(DRAFT_CONFIRM_BACKOFF_MS * attempt, run);
      release = findRelease(version, run);
    }
    if (!release) throw new Error("created draft could not be confirmed");
  }
  const id = release.id;
  for (const file of files) {
    // Check immediately before EACH mutation, after long builds and any prior
    // upload. The numeric ID also prevents a changed tag targeting another draft.
    const draft = assertDraft(version, id, run);
    const existing = draft.assets.filter(asset => asset.name === file.name);
    if (existing.length) {
      // A retained upload whose digest GitHub has not computed yet is neither
      // replaced nor trusted here: resuming the job keeps it, and the bounded
      // digest verification that follows holds publication until its digest
      // matches. A digest that is reported must already match.
      if (existing.length !== 1 || existing[0].state !== "uploaded" || existing[0].size !== file.size ||
          (!digestPending(existing[0]) && existing[0].digest !== file.digest)) {
        throw new Error(`existing asset ${file.name} differs from the staged bytes; use a new version or explicitly repair the stopped draft`);
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
    const [version, rawId, assetsDir] = args;
    publishDraft(version, Number(rawId), assetsDir);
  } else throw new Error("unknown release guard command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
}
