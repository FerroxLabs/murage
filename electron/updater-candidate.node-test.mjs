import assert from "node:assert/strict";
import { safeWipe } from "../server/testing/safe-wipe.mjs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureUpdateCandidate, assertCandidateManifest, validateUpdateCandidate } from "./updater-candidate.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const digest = (text) => createHash("sha512").update(text).digest("base64");
async function fixture(t, { platform = process.platform, packageArtifact = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "murage-candidate-")));
  t.after(() => safeWipe(directory));
  const file = join(directory, "update.zip");
  await writeFile(file, "candidate A");
  const sha512 = digest("candidate A");
  const info = { version: "2.0.0", files: [{ url: "other.zip", sha512: digest("other") }, { url: "selected.zip", sha512 }] };
  const updater = new EventEmitter();
  updater.on("error", () => {});
  updater.downloadedUpdateHelper = { file, versionInfo: info, fileInfo: { info: info.files[1] } };
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
  return { updater, candidate, info, files, file, directory, installs: () => installs, downloads: () => downloads, checks: () => checks };
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
