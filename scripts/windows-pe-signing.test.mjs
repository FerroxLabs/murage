import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { appendPeFixtureCertificate, unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";
import { fixturePeSha, fixturePeSource, fixturePeTrust, fixtureRevision } from "./fixtures/windows-pe-provenance.mjs";
import { normalizeWindowsPeSources, readWindowsPeSourceReceipt, signPinnedWindowsPe, verifyWindowsPeRecord } from "./windows-pe-signing.mjs";
import { refreshWindowsSacReceipt, verifyWindowsSacInventory, verifyPackagedWindowsSac, writeWindowsSacReceipt } from "./windows-sac-inventory.mjs";
import { dispatchWindowsBuilderSigning, windowsBuilderSigning, preflightWindowsPackage } from "./windows-builder-signing.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture(signed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "common-pe-signing-")); roots.push(root);
  fs.mkdirSync(path.join(root, "resources"));
  const file = path.join(root, "resources/vendor.dll"), bytes = signed ? appendPeFixtureCertificate(unsignedPeFixture()) : unsignedPeFixture();
  fs.writeFileSync(file, bytes);
  const pin = fixturePeSource("resources/vendor.dll", bytes), trust = { authenticode: vi.fn(fixturePeTrust.authenticode) };
  const sign = vi.fn(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  return { root, file, bytes, pin, trust, sign, run: () => signPinnedWindowsPe(file, pin, trust, sign, { target: "win32-x64", path: pin.path }) };
}
it("positive: unsigned pinned bytes change only allowed signature fields, then inventory rechecks the same payload", async () => {
  const f = fixture(), record = await f.run();
  expect(f.sign).toHaveBeenCalledTimes(1); expect(record.disposition).toBe("signed");
  expect(record.sourceSha256).toBe(fixturePeSha(f.bytes)); expect(record.finalSha256).toBe(fixturePeSha(fs.readFileSync(f.file)));
  expect(() => verifyWindowsPeRecord(fs.readFileSync(f.file), f.pin, record)).not.toThrow();
  const state = { sources: [f.pin], records: [record], target: "win32-x64" }, report = path.join(f.root, "inventory.md");
  const expectedManifestSha256 = await writeWindowsSacReceipt(f.root, state, { requiredFiles: [], native: f.trust, report });
  await expect(verifyPackagedWindowsSac(f.root, report)).rejects.toThrow("WINDOWS_SAC_EXPECTED_MANIFEST_DIGEST_REQUIRED");
  await expect(verifyWindowsSacInventory({ appOutDir: f.root, expectedManifestSha256, native: f.trust, requiredFiles: [], report })).resolves.toBeDefined();
  await expect(verifyWindowsSacInventory({ appOutDir: f.root, expectedManifestSha256: "b".repeat(64), native: f.trust, requiredFiles: [], report })).rejects.toThrow("WINDOWS_SAC_MANIFEST_DIGEST_MISMATCH");
  fs.appendFileSync(f.file, "mutation");
  await expect(refreshWindowsSacReceipt(f.root, { ...state, native: f.trust, requiredFiles: [], report })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});
it("positive: valid approved embedded vendor bytes are preserved in full without a signer call", async () => {
  const f = fixture(true); f.pin.publishers = ["Fixture Vendor"];
  f.trust.authenticode.mockResolvedValue({ status: "Valid", publisher: "Fixture Vendor", embedded: true });
  const record = await f.run();
  expect(record.disposition).toBe("preserved"); expect(record.sourceSha256).toBe(record.finalSha256);
  expect(f.sign).not.toHaveBeenCalled(); expect(fs.readFileSync(f.file)).toEqual(f.bytes);
});
it.each(["NotTrusted", "UnknownError", "HashMismatch", "CheckFailed"])("rejects %s trust without repairing by signing", async status => {
  const f = fixture(); f.trust.authenticode.mockResolvedValue({ status });
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_TRUST_FAILED"); expect(f.sign).not.toHaveBeenCalled();
});
it.each([{ status: "Valid", embedded: false, publisher: "Ferrox Labs, LLC" }, { status: "Valid", embedded: true, publisher: "Unexpected" }])("rejects catalog-only trust and wrong publishers: %j", async verdict => {
  const f = fixture(true); f.trust.authenticode.mockResolvedValue(verdict);
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_TRUST_FAILED"); expect(f.sign).not.toHaveBeenCalled();
});
it("rejects NotSigned with an existing certificate table, malformed PE, and an unavailable checker", async () => {
  const f = fixture(true); f.trust.authenticode.mockResolvedValue({ status: "NotSigned" });
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_TRUST_FAILED"); expect(f.sign).not.toHaveBeenCalled();
  const bad = fixture(); fs.writeFileSync(bad.file, "MZ malformed"); bad.pin.sourceSha256 = fixturePeSha("MZ malformed");
  await expect(bad.run()).rejects.toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
  await expect(signPinnedWindowsPe(f.file, f.pin, null, f.sign)).rejects.toThrow("WINDOWS_PE_TRUST_CHECKER_UNAVAILABLE");
});
it.each([600, 1100, 1536])("rejects code/resource/overlay change at %i despite structurally valid certificates and Valid trust", async offset => {
  const f = fixture(); f.sign.mockImplementation(async file => { const signed = appendPeFixtureCertificate(fs.readFileSync(file)); signed[offset] ^= 1; fs.writeFileSync(file, signed); return true; });
  await expect(f.run()).rejects.toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
});
it.each(["embedded", "timestamp"])("requires %s on newly signed output", async field => {
  const f = fixture(); f.trust.authenticode.mockResolvedValueOnce({ status: "NotSigned" }).mockResolvedValueOnce({ status: "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true, [field]: false });
  await expect(f.run()).rejects.toThrow("WINDOWS_PE_EMBEDDED_TIMESTAMP_REQUIRED");
});
it("rejects source substitution before any trust/sign call and file replacement during signing", async () => {
  const f = fixture(); fs.appendFileSync(f.file, "other version");
  await expect(f.run()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_HASH_MISMATCH"); expect(f.trust.authenticode).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  const changed = fixture(); changed.sign.mockImplementation(async file => { fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, appendPeFixtureCertificate(changed.bytes)); return true; });
  await expect(changed.run()).rejects.toThrow("WINDOWS_PE_FILE_REPLACED");
});
it("rejects duplicate/case-colliding paths, wrong target, missing version, and upstream reclassification", () => {
  const f = fixture();
  expect(() => normalizeWindowsPeSources([f.pin, { ...f.pin, path: f.pin.path.toUpperCase() }])).toThrow("WINDOWS_PE_DUPLICATE_PATH");
  for (const overrides of [{ target: "win32-arm64" }, { version: "" }, { kind: "build", sourceRevision: fixtureRevision }]) {
    expect(() => normalizeWindowsPeSources([{ ...f.pin, ...overrides }], { sourceRevision: fixtureRevision })).toThrow();
  }
});
it("requires externally selected receipt digest/revision/target and rejects a receipt from another source revision", async () => {
  const f = fixture(), file = path.join(f.root, "source-receipt.json"), text = JSON.stringify({ schema: 2, target: "win32-x64", sourceRevision: fixtureRevision, sources: [f.pin] });
  fs.writeFileSync(file, text);
  await expect(readWindowsPeSourceReceipt(file, fixturePeSha(text), { target: "win32-x64", sourceRevision: fixtureRevision })).resolves.toHaveLength(1);
  await expect(readWindowsPeSourceReceipt(file, fixturePeSha(text), { target: "win32-x64", sourceRevision: "b".repeat(40) })).rejects.toThrow("WINDOWS_PE_SOURCE_IDENTITY_INVALID");
  await expect(readWindowsPeSourceReceipt(file, "b".repeat(64), { target: "win32-x64", sourceRevision: fixtureRevision })).rejects.toThrow("WINDOWS_PE_SOURCE_RECEIPT_HASH_MISMATCH");
});
it("builder final boundary signs main once, refuses post-freeze main mutation and verifies repeated copy calls", async () => {
  const f = fixture(); fs.renameSync(f.file, path.join(f.root, "Murage.exe"));
  const main = path.join(f.root, "Murage.exe"), pin = fixturePeSource("Murage.exe", f.bytes, { kind: "build", component: "murage-app", sourceRevision: fixtureRevision,
    inputs: [{ component: "electron", sha256: fixturePeSha("pinned input") }], transformations: ["builder resource edit"] });
  const context = { windowsPeSigner: f.sign, appOutDir: f.root, arch: "x64", windowsPeSources: [pin], windowsPeSourceRevision: fixtureRevision, signingTrust: f.trust,
    packager: { signIf: f.sign, config: { extraMetadata: {} } } };
  context.packager.signIf = file => dispatchWindowsBuilderSigning(context.packager, file);
  const state = await windowsBuilderSigning(context); await preflightWindowsPackage(state);
  await context.packager.signIf(main); await context.packager.signIf(main); expect(f.sign).toHaveBeenCalledTimes(1);
  state.frozen = true; fs.appendFileSync(main, "builder mutation");
  await expect(context.packager.signIf(main)).rejects.toThrow("WINDOWS_PE_RECORD_MISMATCH");
});
