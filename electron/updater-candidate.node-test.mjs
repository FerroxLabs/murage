import assert from "node:assert/strict";
import { safeWipe } from "../server/testing/safe-wipe.mjs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { captureUpdateCandidate, assertCandidateManifest, validateUpdateCandidate } from "./updater-candidate.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const digest = (text) => createHash("sha512").update(text).digest("base64");
async function fixture(t, { platform = process.platform, packageArtifact = false } = {}) {
  // The pinned vendor layout: <cacheDir>/pending/<artifact>.
  const base = await realpath(await mkdtemp(join(tmpdir(), "murage-candidate-")));
  t.after(() => safeWipe(base));
  const cacheDir = join(base, "cache"), directory = join(cacheDir, "pending");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "update.zip");
  await writeFile(file, "candidate A");
  const sha512 = digest("candidate A");
  const info = { version: "2.0.0", files: [{ url: "other.zip", sha512: digest("other") }, { url: "selected.zip", sha512 }] };
  const updater = new EventEmitter();
  updater.on("error", () => {});
  updater.downloadedUpdateHelper = { cacheDir, file, versionInfo: info, fileInfo: { info: info.files[1] } };
  const files = [file];
  if (packageArtifact) {
    const packageFile = join(directory, "package.7z"); await writeFile(packageFile, "package");
    const packageInfo = { sha512: digest("package"), path: "package.7z" };
    info.packages = { [process.arch]: packageInfo };
    Object.assign(updater.downloadedUpdateHelper, { packageFile });
    updater.downloadedUpdateHelper.fileInfo.packageInfo = packageInfo;
    files.push(packageFile);
  }
  let installs = 0, downloads = 0, checks = 0;
  updater.checkForUpdates = async () => { checks++; return { isUpdateAvailable: true, updateInfo: info }; };
  updater.downloadUpdate = async () => { downloads++; updater.emit("update-downloaded", info); return files; };
  updater.quitAndInstall = () => { installs++; };
  const candidate = await captureUpdateCandidate(updater, { platform, downloadedFiles: files });
  return { updater, candidate, info, files, file, directory, base, cacheDir, installs: () => installs, downloads: () => downloads, checks: () => checks };
}

test("identity selects actual helper artifact, is path-free and rejects tampered identity", async (t) => {
  const h = await fixture(t);
  assert.equal(h.candidate.artifacts[0].sha512, h.info.files[1].sha512);
  assert.equal(JSON.stringify(h.candidate).includes(h.directory), false);
  assert.equal(JSON.stringify(h.candidate).includes("url"), false);
  assert.throws(() => validateUpdateCandidate({ ...h.candidate, version: "2.0.1" }), /identity/);
  assert.throws(() => validateUpdateCandidate({ ...h.candidate, path: h.file }), /invalid/);
});

test("Windows selected package is included and actually hashed", async (t) => {
  const h = await fixture(t, { platform: "win32", packageArtifact: true });
  assert.equal(h.candidate.artifacts.length, 2);
  await writeFile(h.files[1], "replaced package");
  await assert.rejects(captureUpdateCandidate(h.updater, { platform: "win32" }), /verification/);
});

for (const change of ["missing", "replaced", "symlink"]) test(`candidate refuses ${change} cache`, async (t) => {
  const h = await fixture(t);
  if (change === "replaced") await writeFile(h.file, "candidate B");
  else {
    await rm(h.file);
    if (change === "symlink") { const target = join(h.directory, "target"); await writeFile(target, "candidate A"); await symlink(target, h.file); }
  }
  await assert.rejects(captureUpdateCandidate(h.updater));
});

// The cache root is resolved once. A link in a folder ABOVE it (macOS /var ->
// /private/var, a home or Caches folder that is a link, a Windows junction) is
// the person's own layout and updates. A link AT the root or below it, a linked
// artifact, or an artifact outside the root is refused.
const dirLink = (target, link) => symlink(target, link, "junction"); // a junction on Windows, a symlink elsewhere
async function scratch(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "murage-candidate-root-")));
  t.after(() => safeWipe(base));
  return base;
}
async function staged(cacheDir, { file = join(cacheDir, "pending", "update.zip"), text = "candidate A" } = {}) {
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, text);
  const info = { version: "2.0.0", files: [{ url: "update.zip", sha512: digest(text) }] };
  const updater = new EventEmitter(); updater.on("error", () => {});
  updater.downloadedUpdateHelper = { cacheDir, file, versionInfo: info, fileInfo: { info: info.files[0] } };
  return { updater, file, info };
}
for (const [kind, skip] of [["symlink", process.platform === "win32"], ["junction", process.platform !== "win32"]]) {
  test(`a cache root reached through a ${kind}ed ancestor folder updates`, { skip }, async (t) => {
    const base = await scratch(t), home = join(base, "real-home");
    await mkdir(home);
    await symlink(home, join(base, "home"), kind === "junction" ? "junction" : "dir");
    const h = await staged(join(base, "home", "Library", "Caches", "murage-updater"));
    const candidate = await captureUpdateCandidate(h.updater, { downloadedFiles: [h.file] });
    assert.equal(candidate.artifacts[0].sha512, h.info.files[0].sha512);
  });
}
test("a cache root that is itself a link is refused", async (t) => {
  const base = await scratch(t), real = join(base, "real-cache");
  const h = await staged(real);
  await dirLink(real, join(base, "cache"));
  Object.assign(h.updater.downloadedUpdateHelper, { cacheDir: join(base, "cache"), file: join(base, "cache", "pending", "update.zip") });
  await assert.rejects(captureUpdateCandidate(h.updater), /without symlinks/);
});
test("a linked folder below the cache root is refused", async (t) => {
  const base = await scratch(t), cacheDir = join(base, "cache");
  const h = await staged(cacheDir, { file: join(base, "elsewhere", "update.zip") });
  await mkdir(cacheDir); await dirLink(join(base, "elsewhere"), join(cacheDir, "pending"));
  h.updater.downloadedUpdateHelper.file = join(cacheDir, "pending", "update.zip");
  await assert.rejects(captureUpdateCandidate(h.updater), /without symlinks/);
});
for (const place of ["sibling", "prefix", "parent"]) test(`an artifact outside the cache root is refused (${place})`, async (t) => {
  const base = await scratch(t), cacheDir = join(base, "cache");
  await mkdir(join(cacheDir, "pending"), { recursive: true });
  const outside = { sibling: join(base, "other", "update.zip"), prefix: join(base, "cache-other", "pending", "update.zip"), parent: join(base, "update.zip") }[place];
  const h = await staged(cacheDir, { file: outside });
  await assert.rejects(captureUpdateCandidate(h.updater), /path is invalid/);
});
test("a missing or relative cache root is refused", async (t) => {
  const h = await staged(join(await scratch(t), "cache"));
  for (const cacheDir of [undefined, "", "cache", 7]) {
    h.updater.downloadedUpdateHelper.cacheDir = cacheDir;
    await assert.rejects(captureUpdateCandidate(h.updater), /path is invalid/);
  }
});
test("an artifact swapped for the same bytes after hashing is refused", async (t) => {
  const h = await fixture(t);
  const fsp = createRequire(import.meta.url)("node:fs/promises"), original = fsp.lstat;
  let seen = 0;
  // The second look at the artifact is the re-check after hashing: replace it
  // there with another file holding the same bytes.
  fsp.lstat = async (path, ...rest) => {
    if (path === h.file && ++seen === 2) { const twin = join(h.base, "twin"); await writeFile(twin, "candidate A"); await rename(twin, h.file); }
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(captureUpdateCandidate(h.updater), /changed or failed verification/); }
  finally { fsp.lstat = original; syncBuiltinESMExports(); }
  assert.equal(seen >= 2, true);
});

test("a folder above the cache root swapped for a link after capture started is refused", async (t) => {
  const base = await scratch(t), home = join(base, "home");
  const h = await staged(join(home, "Library", "Caches", "murage-updater"));
  const fsp = createRequire(import.meta.url)("node:fs/promises"), original = fsp.lstat;
  let seen = 0;
  // Same hook as the swapped-artifact test: at the re-check after hashing, move the real home aside and leave a link to it in its
  // place. The file, its inode and every folder below the root are unchanged; only the resolution of the root's parent differs.
  fsp.lstat = async (path, ...rest) => {
    if (path === h.file && ++seen === 2) { await rename(home, join(base, "home-moved")); await dirLink(join(base, "home-moved"), home); }
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(captureUpdateCandidate(h.updater), /changed or failed verification/); }
  finally { fsp.lstat = original; syncBuiltinESMExports(); }
  assert.equal(seen >= 2, true);
});

for (const change of ["version", "digest", "missing"]) test(`manifest ${change} prevents transfer`, async (t) => {
  const h = await fixture(t);
  if (change === "version") h.info.version = "2.1.0";
  if (change === "digest") h.info.files[0].sha512 = digest("changed manifest");
  if (change === "missing") delete h.info.files;
  assert.throws(() => assertCandidateManifest(h.candidate, h.info));
  const coordinator = createUpdaterCoordinator(h.updater, () => {});
  await assert.rejects(coordinator.resumeInstall(h.candidate, { beforeInstall: () => ({ status: "continue" }) }));
  assert.equal(h.downloads(), 0); assert.equal(h.installs(), 0);
});

test("download A defers without installer and same candidate resumes once in new coordinator", async (t) => {
  const h = await fixture(t); let received;
  const first = createUpdaterCoordinator(h.updater, () => {}, { beforeInstall: (candidate) => { received = candidate; return { status: "deferred" }; } });
  await first.download();
  await first.install(); await first.install(); await first.check(true); await first.download();
  assert.equal(received.candidateId, h.candidate.candidateId);
  assert.equal(h.installs(), 0); assert.equal(h.downloads(), 1); assert.equal(h.checks(), 0);
  // A new process starts with no downloaded helper. Only its ordinary fake
  // download operation restores the helper, as the pinned vendor does.
  const restarted = new EventEmitter();
  restarted.checkForUpdates = h.updater.checkForUpdates;
  restarted.downloadUpdate = async () => {
    restarted.downloadedUpdateHelper = h.updater.downloadedUpdateHelper;
    return h.files;
  };
  restarted.quitAndInstall = h.updater.quitAndInstall;
  const next = createUpdaterCoordinator(restarted, () => {});
  let admissions = 0;
  const options = { beforeInstall: (candidate) => { admissions++; assert.equal(candidate.candidateId, received.candidateId); return { status: "continue" }; } };
  const resumed = next.resumeInstall(received, options);
  assert.equal(next.resumeInstall(received, options), resumed);
  assert.deepEqual(await resumed, { status: "install-requested" });
  assert.equal(h.installs(), 1); assert.equal(admissions, 1);
});

test("resume uses normal download verifier to replace missing cache for same candidate", async (t) => {
  const h = await fixture(t); await rm(h.file);
  h.updater.downloadUpdate = async () => { await writeFile(h.file, "candidate A"); return h.files; };
  const next = createUpdaterCoordinator(h.updater, () => {});
  await next.resumeInstall(h.candidate, { beforeInstall: () => ({ status: "continue" }) });
  assert.equal(h.installs(), 1);
});

test("post-transfer selected digest replacement refuses admission", async (t) => {
  const h = await fixture(t); let admissions = 0;
  h.updater.downloadUpdate = async () => {
    await writeFile(h.file, "other");
    h.updater.downloadedUpdateHelper.fileInfo.info = h.info.files[0];
    return h.files;
  };
  const next = createUpdaterCoordinator(h.updater, () => {});
  await assert.rejects(next.resumeInstall(h.candidate, { beforeInstall: () => { admissions++; return { status: "continue" }; } }), /artifact changed/);
  assert.equal(admissions, 0); assert.equal(h.installs(), 0);
});

for (const result of [false, true, null, { status: "unknown" }]) test(`ordinary fulfilled ${JSON.stringify(result)} refuses installation`, async (t) => {
  const h = await fixture(t);
  const coordinator = createUpdaterCoordinator(h.updater, () => {}, { beforeInstall: () => result });
  await coordinator.download(); await coordinator.install(); assert.equal(h.installs(), 0);
});

test("offline resume and legacy undefined resume refuse installer", async (t) => {
  const h = await fixture(t);
  let next = createUpdaterCoordinator(h.updater, () => {});
  await assert.rejects(next.resumeInstall(h.candidate, { beforeInstall: () => undefined }), /explicitly admitted/);
  h.updater.checkForUpdates = async () => { throw new Error("offline"); };
  next = createUpdaterCoordinator(h.updater, () => {});
  await assert.rejects(next.resumeInstall(h.candidate, { beforeInstall: () => ({ status: "continue" }) }), /offline/);
  assert.equal(h.installs(), 0);
});

test("busy resume admission and an unknown installer result never launch again", async (t) => {
  const h = await fixture(t);
  const next = createUpdaterCoordinator(h.updater, () => {});
  await assert.rejects(next.resumeInstall(h.candidate, { beforeInstall: () => { throw new Error("busy"); } }), /busy/);
  assert.equal(h.installs(), 0);
  h.updater.quitAndInstall = () => { throw new Error("unknown installer outcome"); };
  await assert.rejects(next.resumeInstall(h.candidate, { beforeInstall: () => ({ status: "continue" }) }), /unknown installer/);
  await assert.rejects(next.resumeInstall(h.candidate, { beforeInstall: () => ({ status: "continue" }) }), /already requested/);
});

import { createDeferredStartup } from './deferred-startup.mjs';
import { resumeBackedUpInstall } from './preupgrade-continuation.mjs';
for (const outcome of ['late-error', 'no-exit']) test(`A2: real resumed installer ${outcome} delivers startup failure`, async t => {
  const h = await fixture(t), failures = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const registry = createDeferredStartup({ failure: e => failures.push(e), record() {} });
  const op = registry.begin({ deadlineMs: 300_000 });
  const updater = createUpdaterCoordinator(h.updater, () => {});
  op.observe(resumeBackedUpInstall({ operation: op, updater, currentVersion: '1', cleanup: async () => {}, backup: {
    pendingUpgrade: () => ({ phase: 'return-pending', candidate: h.candidate }), verifyUpgrade: async () => {}, markUpgradeInstallRequested: async () => {},
  } }));
  // Hashing the real private fixture is asynchronous.
  while (h.installs() === 0 && failures.length === 0) await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(registry.size, 1); assert.equal(h.installs(), 1);
  if (outcome === 'late-error') h.updater.emit('error', Error('late')); else t.mock.timers.tick(120_000);
  assert.equal(failures.length, 1); assert.equal(registry.size, 0);
});
test('A3: pending real checkForUpdates is fenced before download or install', async t => {
  const h = await fixture(t); let resolve, timeout; const failures = [];
  h.updater.checkForUpdates = () => new Promise(yes => { resolve = yes; });
  const registry = createDeferredStartup({ failure: e => failures.push(e), record() {}, setTimer: fn => { timeout = fn; }, clearTimer() {} });
  const op = registry.begin(), updater = createUpdaterCoordinator(h.updater, () => {});
  const work = updater.resumeInstall(h.candidate, { assertActive: () => op.assertActive(), beforeInstall: () => ({ status: 'continue' }) });
  op.observe(work); await new Promise(setImmediate); timeout(); resolve({ isUpdateAvailable: true, updateInfo: h.info });
  await assert.rejects(work, /STARTUP_SUPERSEDED/); assert.equal(h.downloads(), 0); assert.equal(h.installs(), 0); assert.equal(failures.length, 1);
});
