// Signing/inventory producer owner: win-sac-sign; release proof/receipt producer owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createGepaManifest } from "../native/gepa/create-manifest.mjs";
import { GEPA_RESOURCE_LICENSES } from "../server/gepa-resource.ts";
import signGepa from "./windows-gepa-signing.mjs";
import { verifyWindowsSacInventory } from "./windows-sac-inventory.mjs";
import { appendPeFixtureCertificate, unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const roots = [], sha = bytes => createHash("sha256").update(bytes).digest("hex");
const publisher = "Ferrox Labs, LLC";
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function root() { const result = fs.mkdtempSync(path.join(os.tmpdir(), "pe-provenance-")); roots.push(result); return result; }
function source(name, bytes, overrides = {}) {
  return { path: name, target: "win32-x64", component: "fixture-vendor", version: "1.0.0", kind: "upstream",
    sourceSha256: sha(bytes), sourceReceiptSha256: sha("reviewed fixture catalogue"), publishers: [publisher], ...overrides };
}
function inventory() {
  const appOutDir = root(); fs.mkdirSync(path.join(appOutDir, "resources"));
  const name = "resources/vendor.dll", bytes = appendPeFixtureCertificate(unsignedPeFixture());
  const file = path.join(appOutDir, name); fs.writeFileSync(file, bytes);
  return { appOutDir, allowlist: [], requiredFiles: [], signedFiles: [file], sources: [], records: [],
    native: { authenticode: async () => ({ status: "Valid", publisher, embedded: true, timestamp: true }) }, report: path.join(root(), "inventory.md"), name, bytes, file };
}
it("RED signedHere cannot admit an omitted upstream source pin even with valid production bytes and a matching forged receipt", async () => {
  const f = inventory();
  f.records.push({ path: f.name, sourceSha256: sha(f.bytes), finalSha256: sha(f.bytes), disposition: "preserved" });
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow();
});
it("RED expected PE paths cannot disappear by omitting them from both traversal and final records", async () => {
  const f = inventory(); fs.unlinkSync(f.file); f.signedFiles = [];
  f.sources.push(source(f.name, f.bytes));
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow();
});
it("RED production signatures and forged receipts cannot substitute a different source version", async () => {
  const f = inventory(); f.sources.push(source(f.name, f.bytes));
  const pin = f.sources[0];
  const sourcePinId = sha(JSON.stringify({ path: pin.path, target: pin.target, component: pin.component, version: pin.version, kind: pin.kind, sourceSha256: pin.sourceSha256, sourceReceiptSha256: pin.sourceReceiptSha256, publishers: pin.publishers }));
  f.records.push({ path: f.name, target: "win32-x64", component: pin.component, sourcePinId, version: "2.0.0", sourceSha256: sha(f.bytes), finalSha256: sha(f.bytes), disposition: "preserved" });
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow();
});
async function gepa(vendor = false, mutation) {
  const projectDir = root(), directory = path.join(projectDir, "dist-native/gepa/win32-x64");
  const unsigned = unsignedPeFixture(), bytes = vendor ? appendPeFixtureCertificate(unsigned) : unsigned;
  const names = ["gepa-worker.exe", "_internal/python313.dll", "_internal/_socket.pyd"];
  for (const name of names) { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o755 }); }
  for (const name of GEPA_RESOURCE_LICENSES) { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture license"); }
  const { manifestSha256 } = createGepaManifest(directory, "win32-x64", path.join(projectDir, "metadata.json"));
  const trust = { authenticode: vi.fn(async file => ({ status: fs.readFileSync(file).readUInt32LE(232) ? "Valid" : "NotSigned", publisher: vendor ? "Python Software Foundation" : publisher, embedded: true, timestamp: true })) };
  const signIf = vi.fn(async file => { const after = appendPeFixtureCertificate(fs.readFileSync(file)); if (mutation) after[mutation] ^= 1; fs.writeFileSync(file, after); return true; });
  const sources = names.map(name => source(`resources/gepa-worker/${name}`, bytes, { component: "gepa", version: "0.1.4", sourceReceiptSha256: manifestSha256, publishers: ["Python Software Foundation"] }));
  const context = { windowsPeSigner: signIf, electronPlatformName: "win32", arch: "x64", outDir: path.join(projectDir, "release"), signingTrust: trust, windowsPeSources: sources,
    packager: { projectDir, signIf, config: { extraMetadata: { murageGepaManifests: { "win32-x64": manifestSha256 } }, win: { extraResources: [] } } } };
  return { context, bytes, sources, directory, signIf };
}
it("RED pinned vendor GEPA DLL/PYD bytes survive unchanged with zero signer calls", async () => {
  const f = await gepa(true), signed = await signGepa(f.context);
  expect(f.signIf).not.toHaveBeenCalled();
  for (const pin of f.sources) expect(fs.readFileSync(path.join(signed.directory, pin.path.replace("resources/gepa-worker/", "")))).toEqual(f.bytes);
});
it.each([600, 1100, 1536])("RED GEPA signer mutation at code/resource/overlay byte %i rejects before publishing final pins", async offset => {
  const f = await gepa(false, offset), before = f.context.packager.config.extraMetadata.murageGepaManifests["win32-x64"];
  await expect(signGepa(f.context)).rejects.toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
  expect(f.context.packager.config.extraMetadata.murageGepaManifests["win32-x64"]).toBe(before);
});
it("RED unpinned upstream GEPA PE rejects before any signing even with production trust", async () => {
  const f = await gepa(); f.context.windowsPeSources.pop();
  await expect(signGepa(f.context)).rejects.toThrow();
  expect(f.signIf).not.toHaveBeenCalled();
});
