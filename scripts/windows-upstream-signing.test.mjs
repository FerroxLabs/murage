import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { appendPeFixtureCertificate, unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";
import { refreshWindowsBackupTransport, signWindowsUpstream, removeForeignWindowsAddons } from "./windows-upstream-signing.mjs";
import { loadWindowsBackupSignedPins } from "../shared/windows-backup-signed-pins.mjs";
import { verifySignedWindowsPe } from "../shared/windows-signed-pe.mjs";
import { fixturePeSource, fixtureRevision } from "./fixtures/windows-pe-provenance.mjs";
import { loadWindowsSacAllowlist, verifyWindowsSacInventory, writeWindowsSacReceipt } from "./windows-sac-inventory.mjs";
import { verifyWindowsBackupTools } from "./prepare-windows-backup-tools.mjs";
import { verifySignedWindowsRestic } from "../electron/backup-restic-attestation.mjs";
vi.mock("../shared/windows-backup-tools.mjs", async () => {
  const { createHash } = await import("node:crypto"), { unsignedPeFixture } = await import("./fixtures/windows-pe-signing.mjs");
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  return { WINDOWS_BACKUP_RAW_SHA256: { age: digest(unsignedPeFixture()), keygen: digest(unsignedPeFixture()), license: digest("fixture license") }, WINDOWS_BACKUP_ARCHIVE: {} };
});
vi.mock("../shared/backup-restic-pin.mjs", async original => {
  const actual = await original(), { createHash } = await import("node:crypto"), { unsignedPeFixture } = await import("./fixtures/windows-pe-signing.mjs");
  return { ...actual, RESTIC_PINS: { ...actual.RESTIC_PINS, "win32-x64": { ...actual.RESTIC_PINS["win32-x64"], originalSha256: createHash("sha256").update(unsignedPeFixture()).digest("hex") } } };
});
const sourceCatalogue = vi.hoisted(() => ({ files: null }));
vi.mock("node:fs/promises", async original => {
  const actual = await original();
  return { ...actual, readFile: (file, ...args) => sourceCatalogue.files && String(file).endsWith("/scripts/windows-sac-allowlist.json")
    ? Promise.resolve(JSON.stringify({ schema: 1, files: sourceCatalogue.files })) : actual.readFile(file, ...args) };
});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const roots = [];
afterEach(() => { sourceCatalogue.files = null; for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-upstream-signing-")); roots.push(root);
  const backup = path.join(root, "resources/backup-tools/x64"); fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, "LICENSE"), "fixture license");
  const allowlist = ["age.exe", "age-keygen.exe", "restic.exe"].map(name => {
    const bytes = unsignedPeFixture(); fs.writeFileSync(path.join(backup, name), bytes);
    return fixturePeSource(`resources/backup-tools/x64/${name}`, bytes, { publishers: [] });
  });
  const native = { authenticode: vi.fn(async file => ({ status: fs.readFileSync(file).readUInt32LE(232) ? "Valid" : "NotSigned", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true })) };
  const signIf = vi.fn(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  return { root, backup, allowlist, native, signIf, run: () => signWindowsUpstream({ appOutDir: root, allowlist, native, signIf }) };
}
it("signs each unsigned PE once, rechecks trust, and freezes final inventory and backup digest pins", async () => {
  const f = fixture(), signed = await f.run();
  expect(signed).toHaveLength(3); expect(f.signIf).toHaveBeenCalledTimes(3); expect(f.native.authenticode).toHaveBeenCalledTimes(6);
  const pins = loadWindowsBackupSignedPins(f.backup);
  for (const pin of Object.values(pins)) {
    const bytes = fs.readFileSync(path.join(f.backup, pin.path));
    expect(pin.sha256).toBe(sha(bytes)); expect(pin.sha256).not.toBe(pin.originalSha256);
    expect(() => verifySignedWindowsPe(bytes, pin.unsigned)).not.toThrow();
  }
  const final = JSON.parse(fs.readFileSync(path.join(f.root, "resources/windows-sac-allowlist.json"), "utf8"));
  // MAIN RULING 1115-WINSAC-C (GrokBuild): schema 2 keeps final records distinct from source pins;
  expect(final.files.map(pin => pin.finalSha256)).toEqual(Object.values(pins).map(pin => pin.sha256));
  verifyWindowsBackupTools(f.backup);
  fs.appendFileSync(path.join(f.backup, "age.exe"), " changed");
  expect(() => verifyWindowsBackupTools(f.backup)).toThrow("WINDOWS_BACKUP_SIGNED_MISMATCH");
});
it.each(["Microsoft Corporation", "OpenJS Foundation", "Google LLC", "Cloudflare, Inc."])("preserves exact bytes for trusted valid publisher %s", async publisher => {
  const f = fixture(); f.allowlist.forEach(pin => {
    const file = path.join(f.root, pin.path), bytes = appendPeFixtureCertificate(fs.readFileSync(file)); fs.writeFileSync(file, bytes);
    pin.publishers = [publisher]; pin.sourceSha256 = sha(bytes); pin.sha256 = sha(bytes);
  });
  f.native.authenticode.mockResolvedValue({ status: "Valid", publisher, embedded: true });
  expect(await f.run()).toEqual([]); expect(f.signIf).not.toHaveBeenCalled();
  expect(loadWindowsBackupSignedPins(f.backup)["age.exe"].sha256).toBe(f.allowlist[0].sha256);
});
it.each(["HashMismatch", "UnknownError", "NotTrusted", "wrong-publisher"])("rejects %s without using the signer", async status => {
  const f = fixture(); f.native.authenticode.mockResolvedValue({ status: status === "wrong-publisher" ? "Valid" : status, publisher: "Unexpected Publisher" });
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_TRUST_FAILED"); expect(f.signIf).not.toHaveBeenCalled();
});
it("refuses a false signer, a changed payload, and signIf success without production trust", async () => {
  const f = fixture(); f.signIf.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_SIGNING_FAILED");
  const changed = fixture(); changed.signIf.mockImplementation(async file => { const bytes = appendPeFixtureCertificate(fs.readFileSync(file)); bytes[300] ^= 1; fs.writeFileSync(file, bytes); return true; });
  await expect(changed.run()).rejects.toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
  const unsigned = fixture(); unsigned.native.authenticode.mockResolvedValue({ status: "NotSigned", publisher: "" });
  await expect(unsigned.run()).rejects.toThrow("valid Ferrox Labs signature");
});
it("rejects a source hash mismatch before asking Windows or signing", async () => {
  const f = fixture(); fs.appendFileSync(path.join(f.backup, "age.exe"), " changed");
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_HASH_MISMATCH"); expect(f.signIf).not.toHaveBeenCalled(); expect(f.native.authenticode).not.toHaveBeenCalled();
});
it("revalidates final per-build pins against the reviewed source payloads and refuses modified final bytes", async () => {
  const f = fixture(), signed = await f.run(); sourceCatalogue.files = f.allowlist;
  const expected = await writeWindowsSacReceipt(f.root, { target: "win32-x64", sources: signed.sources, records: signed.records }, { native: f.native, requiredFiles: [], report: path.join(f.root, "inventory.md") });
  const final = await loadWindowsSacAllowlist(f.root, expected);
  expect(final).toHaveLength(3);
  expect((await verifyWindowsSacInventory({ appOutDir: f.root, expectedManifestSha256: expected, native: f.native, requiredFiles: [], report: path.join(f.root, "inventory.md") })).counts.rejected).toBe(0);
  fs.appendFileSync(path.join(f.backup, "age.exe"), " changed");
  // MAIN RULING 1115-WINSAC-C (GrokBuild): the unified loader verifies source/final records;
  await expect(loadWindowsSacAllowlist(f.root, expected)).rejects.toThrow("WINDOWS_PE_RECORD_MISMATCH");
});
it("removes foreign ONNX .node files from Windows only, preserving win32 images and unrelated resources", async () => {
  const f = fixture();
  const names = ["resources/server/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node", "resources/server/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node", "resources/server/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node", "resources/server/node_modules/another-package/linux/addon.node"];
  for (const name of names) { const file = path.join(f.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); }
  await removeForeignWindowsAddons(f.root);
  expect(names.map(name => fs.existsSync(path.join(f.root, name)))).toEqual([false, false, true, true]);
});
it("rebuilds the native transport with the final age digest before signing and verifying its new packaged copy", async () => {
  const f = fixture(); await f.run();
  const rebuilt = path.join(f.root, "rebuilt-helper.exe"); fs.writeFileSync(rebuilt, unsignedPeFixture());
  const build = vi.fn(() => rebuilt), digest = sha(fs.readFileSync(path.join(f.backup, "age.exe")));
  const helper = path.join(f.backup, "murage-backup-age.exe");
  const sourcePin = fixturePeSource("resources/backup-tools/x64/murage-backup-age.exe", unsignedPeFixture(), { kind: "build", component: "backup-transport", sourceRevision: fixtureRevision,
    inputs: [{ component: "age", sha256: digest }], transformations: ["compile transport with final age digest"] });
  const result = await refreshWindowsBackupTransport({ appOutDir: f.root, projectDir: f.root, native: f.native, signIf: f.signIf, build, sourcePin, sourceRevision: fixtureRevision });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): common signing returns the frozen helper record, rather than a bare true.
  expect(result.record.finalSha256).toBe(sha(fs.readFileSync(helper))); expect(result.record.sourceSha256).toBe(sourcePin.sourceSha256);
  expect(build).toHaveBeenCalledExactlyOnceWith({ root: f.root, ageDigest: digest });
  expect(f.signIf).toHaveBeenLastCalledWith(helper); expect(f.native.authenticode).toHaveBeenLastCalledWith(helper);
  const unsignedDigest = sha(unsignedPeFixture());
  expect(sha(fs.readFileSync(helper))).not.toBe(unsignedDigest);
});
it("runtime restic admission consumes signed digest pins and still requires owning-app identity and native trust", async () => {
  const f = fixture(); await f.run();
  const file = path.join(f.backup, "restic.exe"), currentExecutable = path.join(f.root, "Murage.exe"); fs.writeFileSync(currentExecutable, "owning app fixture");
  const verifySignature = vi.fn(async () => {}), options = { currentExecutable, arch: "x64", originalSha256: f.allowlist[2].sha256, verifySignature };
  const bytes = fs.readFileSync(file);
  expect(await verifySignedWindowsRestic(file, bytes, options)).toBe(true);
  expect(verifySignature).toHaveBeenCalledExactlyOnceWith(file, path.join(f.root, "resources"));
  verifySignature.mockRejectedValueOnce(Error("invalid native signature"));
  expect(await verifySignedWindowsRestic(file, bytes, options)).toBe(false);
  expect(await verifySignedWindowsRestic(file, bytes, { ...options, currentExecutable: file })).toBe(false);
  const changed = Buffer.from(bytes); changed[300] ^= 1;
  expect(await verifySignedWindowsRestic(file, changed, options)).toBe(false);
});
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped, so the package carries the raw
// upstream restic and no signed-byte pins. Its exact raw hash is then the whole trust, still only inside the owning app.
it("runtime restic admission without signed pins accepts only the exact raw upstream bytes inside the owning app", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raw-restic-"))); roots.push(root);
  const backup = path.join(root, "resources/backup-tools/x64"); fs.mkdirSync(backup, { recursive: true });
  const file = path.join(backup, "restic.exe"), currentExecutable = path.join(root, "Murage.exe"), raw = unsignedPeFixture();
  fs.writeFileSync(file, raw); fs.writeFileSync(currentExecutable, "owning app fixture");
  const verifySignature = vi.fn(async () => {}), options = { currentExecutable, arch: "x64", originalSha256: sha(raw), verifySignature };
  expect(loadWindowsBackupSignedPins(backup)).toBeNull();
  expect(await verifySignedWindowsRestic(file, raw, options)).toBe(true);
  // Raw upstream bytes carry no production signature, so none is asked for; nothing but the pinned hash admits them.
  expect(verifySignature).not.toHaveBeenCalled();
  const changed = Buffer.from(raw); changed[300] ^= 1;
  expect(await verifySignedWindowsRestic(file, changed, options)).toBe(false);
  expect(await verifySignedWindowsRestic(file, appendPeFixtureCertificate(raw), options)).toBe(false);
  expect(await verifySignedWindowsRestic(file, raw, { ...options, originalSha256: sha(changed) })).toBe(false);
  expect(await verifySignedWindowsRestic(file, raw, { ...options, currentExecutable: file })).toBe(false);
  expect(await verifySignedWindowsRestic(file, raw, { ...options, arch: "arm64" })).toBe(false);
  const elsewhere = path.join(root, "restic.exe"); fs.writeFileSync(elsewhere, raw);
  expect(await verifySignedWindowsRestic(elsewhere, raw, options)).toBe(false);
  // A present but malformed pin file is never read as "no pins".
  fs.writeFileSync(path.join(backup, "windows-sac-pins.json"), "{}");
  expect(await verifySignedWindowsRestic(file, raw, options)).toBe(false);
});
it("rejects a stale compiled age input receipt before signing the rebuilt helper", async () => {
  const f = fixture(); await f.run(); f.signIf.mockClear();
  const rebuilt = path.join(f.root, "rebuilt-helper.exe"); fs.writeFileSync(rebuilt, unsignedPeFixture());
  const sourcePin = fixturePeSource("resources/backup-tools/x64/murage-backup-age.exe", unsignedPeFixture(), { kind: "build", component: "backup-transport", sourceRevision: fixtureRevision,
    inputs: [{ component: "age", sha256: f.allowlist[0].sourceSha256 }], transformations: ["compile transport"] });
  await expect(refreshWindowsBackupTransport({ appOutDir: f.root, projectDir: f.root, native: f.native, signIf: f.signIf, build: () => rebuilt,
    sourcePin, sourceRevision: fixtureRevision })).rejects.toThrow("WINDOWS_BACKUP_HELPER_BUILD_RECEIPT_REQUIRED");
  expect(f.signIf).not.toHaveBeenCalled();
});
it("a later signer cannot mutate an earlier PE and publish partial upstream records", async () => {
  const f = fixture();
  f.signIf.mockImplementation(async file => {
    fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file)));
    if (file.endsWith("restic.exe")) fs.appendFileSync(path.join(f.backup, "age.exe"), "mutated earlier image");
    return true;
  });
  await expect(f.run()).rejects.toThrow("WINDOWS_PE_RECORD_MISMATCH");
  expect(fs.existsSync(path.join(f.root, "resources/windows-sac-allowlist.json"))).toBe(false);
  expect(fs.existsSync(path.join(f.backup, "windows-sac-pins.json"))).toBe(false);
});
