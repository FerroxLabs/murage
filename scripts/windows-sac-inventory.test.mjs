import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { appendPeFixtureCertificate, unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";
import { fixturePeSource, fixturePreservedRecord } from "./fixtures/windows-pe-provenance.mjs";
import { windowsGepaFixture, windowsGepaMetadataArchive } from "./fixtures/windows-gepa.mjs";

const checks = vi.hoisted(() => ({ authenticode: vi.fn(async () => ({ status: "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true })) }));
vi.mock("../server/browser-windows-identity.ts", async original => ({ ...await original(), nativeAuthenticodeIn: vi.fn(() => checks) }));
import { nativeAuthenticodeIn } from "../server/browser-windows-identity.ts";
import { loadWindowsSacAllowlist, refreshWindowsSacReceipt, verifyPackagedWindowsSac, verifyWindowsSacInventory, WINDOWS_SAC_REQUIRED, windowsPeFiles, writeWindowsSacReceipt } from "./windows-sac-inventory.mjs";

const dirs = [];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-sac-inventory-")); dirs.push(root);
  const appOutDir = path.join(root, "package"); fs.mkdirSync(path.join(appOutDir, "resources"), { recursive: true });
  const f = { root, appOutDir, report: path.join(root, "SAC-INVENTORY.md"), sources: [], records: [], requiredFiles: [], native: checks };
  Object.defineProperty(f, "allowlist", { set: pins => { f.sources = pins.map(pin => fixturePeSource(pin.path, fs.readFileSync(path.join(appOutDir, pin.path)), { ...pin, sourceSha256: pin.sha256 })); f.records = f.sources.map(fixturePreservedRecord); } });
  return f;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); vi.clearAllMocks(); checks.authenticode.mockReset().mockResolvedValue({ status: "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true }); });

it.each(["unexpected.DLL", "unexpected.ExE", "unexpected.NoDe", "unexpected.PyD", "renamed.dat"])("walks and rejects %s, despite a valid signature", async name => {
  const f = fixture(), file = path.join(f.appOutDir, "resources", name);
  fs.writeFileSync(file, "MZ fixture");
  expect(await windowsPeFiles(f.appOutDir)).toEqual([file]);
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  expect(fs.readFileSync(f.report, "utf8")).toContain(name);
});

it("requires the exact allowlisted path and raw hash; even a signed replacement is rejected", async () => {
  const f = fixture(), file = path.join(f.appOutDir, "resources", "raw.dll");
  fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture()));
  f.allowlist = [{ path: "resources/raw.dll", sha256: sha(appendPeFixtureCertificate(unsignedPeFixture())), reason: "upstream raw pin" }];
  checks.authenticode.mockResolvedValueOnce({ status: "NotSigned", publisher: "" });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): GrokBuild requires Valid trust even for an exact raw hash; an unsigned allowlist entry must fail.
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  expect(fs.readFileSync(f.report, "utf8")).toContain("no valid trusted publisher signature");
  expect((await verifyWindowsSacInventory(f)).counts).toEqual({ pe: 1, signed: 1, vendor: 0, allowlisted: 1, rejected: 0 });
  fs.appendFileSync(file, " changed");
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture())); fs.renameSync(file, path.join(f.appOutDir, "raw.dll"));
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});

it("rejects a new nested addon until both its receipt and embedded signature are present", async () => {
  const f = fixture(), name = "resources/server/node_modules/new-addon/build/Release/addon.node";
  const file = path.join(f.appOutDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unsignedPeFixture());
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  f.allowlist = [{ path: name, sha256: sha(fs.readFileSync(file)), reason: "new addon fixture" }];
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture()));
  f.allowlist = [{ path: name, sha256: sha(fs.readFileSync(file)), reason: "new signed addon fixture" }];
  expect((await verifyWindowsSacInventory(f)).counts.rejected).toBe(0);
  fs.writeFileSync(path.join(path.dirname(file), "second.NoDe"), "malformed addon");
  await expect(verifyWindowsSacInventory(f)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});

it.each([{ status: "NotSigned", publisher: "" }, { status: "Valid", publisher: "Other Publisher" }, { status: "HashMismatch", publisher: "Ferrox Labs, LLC" }])("does not equate signIf success with an authenticated Murage publisher: %j", async result => {
  const f = fixture(), file = path.join(f.appOutDir, "resources", "engine-exclusion.node"); fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture()));
  f.allowlist = [{ path: "resources/engine-exclusion.node", sha256: sha(fs.readFileSync(file)), reason: "reviewed built fixture" }];
  checks.authenticode.mockResolvedValueOnce(result);
  await expect(verifyWindowsSacInventory({ ...f, signedFiles: [file] })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});

it("records every signature and vendor verdict and fails closed on a thrown trust check", async () => {
  const f = fixture(), file = path.join(f.appOutDir, "vendor.dll"); fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture()));
  f.allowlist = [{ path: "vendor.dll", sha256: sha(appendPeFixtureCertificate(unsignedPeFixture())), reason: "reviewed raw pin", publishers: ["Vendor"] }];
  checks.authenticode.mockResolvedValueOnce({ status: "Valid", publisher: "Vendor", embedded: true });
  expect((await verifyWindowsSacInventory(f)).counts).toEqual({ pe: 1, signed: 1, vendor: 1, allowlisted: 1, rejected: 0 });
  checks.authenticode.mockRejectedValueOnce(new Error("trust check failed"));
  await expect(verifyWindowsSacInventory({ ...f, signedFiles: [file] })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});

it("refuses links instead of silently skipping linked package content", async () => {
  const f = fixture(); fs.symlinkSync(f.root, path.join(f.appOutDir, "linked"), "junction");
  await expect(windowsPeFiles(f.appOutDir)).rejects.toThrow("WINDOWS_SAC_INVENTORY_LINK");
});

// MAIN RULING 1115-WINSAC-C (GrokBuild): DESIGN-WIN-SAC-C removes the main-EXE re-freeze exception.
it("rechecks frozen output and refuses any later main EXE change without refreshing hashes", async () => {
  const f = fixture(), resources = path.join(f.appOutDir, "resources");
  const gepa = windowsGepaFixture(path.join(resources, "gepa-worker"), path.join(f.root, "gepa-metadata.json"), { signed: true });
  windowsGepaMetadataArchive(resources, gepa.hash);
  for (const name of WINDOWS_SAC_REQUIRED) {
    const file = path.join(f.appOutDir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture()));
  }
  const files = [...WINDOWS_SAC_REQUIRED.filter(name => !name.startsWith("resources/gepa-worker/")), ...gepa.images.map(file => path.relative(f.appOutDir, file).split(path.sep).join("/"))];
  f.sources = files.map(name => fixturePeSource(name, fs.readFileSync(path.join(f.appOutDir, name)))); f.records = f.sources.map(fixturePreservedRecord);
  const expected = await writeWindowsSacReceipt(f.appOutDir, { target: "win32-x64", sources: f.sources, records: f.records }, { native: checks, report: f.report });
  await expect(verifyPackagedWindowsSac(f.appOutDir, f.report, expected, { native: checks })).resolves.toBeDefined();
  const receipt = fs.readFileSync(path.join(resources, "windows-sac-signing.json"));
  fs.appendFileSync(path.join(f.appOutDir, "Murage.exe"), "builder mutation");
  await expect(verifyPackagedWindowsSac(f.appOutDir, f.report, expected, { native: checks })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  await expect(refreshWindowsSacReceipt(f.appOutDir, { expectedManifestSha256: expected, native: checks, report: f.report })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  expect(fs.readFileSync(path.join(resources, "windows-sac-signing.json"))).toEqual(receipt);
  fs.writeFileSync(path.join(f.appOutDir, "Murage.exe"), appendPeFixtureCertificate(unsignedPeFixture()));
  fs.appendFileSync(path.join(resources, "engine-exclusion.node"), "tamper");
  await expect(refreshWindowsSacReceipt(f.appOutDir, { expectedManifestSha256: expected, native: checks, report: f.report })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});

it("checked-in raw exceptions all name an exact path, reason and SHA-256", async () => {
  const files = await loadWindowsSacAllowlist();
  expect(files.length).toBeGreaterThan(0);
  expect(files.some(x => x.path.endsWith("engine-exclusion.node"))).toBe(false);
  for (const file of files) { expect(file.path).not.toMatch(/[*?]/); expect(file.sha256).toMatch(/^[a-f0-9]{64}$/); expect(file.reason).toBeTruthy(); }
});


it("refuses a final tree missing a required signed addon", async () => {
  const f = fixture();
  await expect(verifyWindowsSacInventory({ ...f, requiredFiles: WINDOWS_SAC_REQUIRED })).rejects.toThrow("required signed component: resources/presence-guard.node");
});

it("standalone inventory authenticates the packaged checker with pinned runner trust before loading it", async () => {
  const f = fixture(), name = "resources/engine-exclusion.node", file = path.join(f.appOutDir, name);
  fs.writeFileSync(file, appendPeFixtureCertificate(unsignedPeFixture()));
  f.allowlist = [{ path: name, sha256: sha(fs.readFileSync(file)), reason: "pinned checker fixture" }];
  const bootstrapTrust = { authenticode: vi.fn(async () => ({ status: "Valid", embedded: true, publisher: "Ferrox Labs, LLC" })) };
  await verifyWindowsSacInventory({ ...f, native: undefined, bootstrapTrust });
  expect(nativeAuthenticodeIn).toHaveBeenCalledTimes(1);
  expect(nativeAuthenticodeIn.mock.invocationCallOrder[0]).toBeGreaterThan(bootstrapTrust.authenticode.mock.invocationCallOrder[0]);
  vi.clearAllMocks(); bootstrapTrust.authenticode.mockResolvedValueOnce({ status: "NotSigned", embedded: false, publisher: "" });
  await expect(verifyWindowsSacInventory({ ...f, native: undefined, bootstrapTrust })).rejects.toThrow("no valid trusted publisher signature");
  expect(nativeAuthenticodeIn).not.toHaveBeenCalled();
});

it.each(["Murage.exe", "resources/engine-exclusion.node", "resources/anchored-read.node", "resources/presence-guard.node"])("standalone rejects substituted %s before loading any packaged checker", async name => {
  const f = fixture();
  const names = ["Murage.exe", "resources/engine-exclusion.node", "resources/anchored-read.node", "resources/presence-guard.node"];
  for (const item of names) fs.writeFileSync(path.join(f.appOutDir, item), appendPeFixtureCertificate(unsignedPeFixture()));
  f.allowlist = names.map(item => ({ path: item, sha256: sha(fs.readFileSync(path.join(f.appOutDir, item))), reason: "pinned fixture" }));
  const bootstrapTrust = { authenticode: vi.fn(async () => ({ status: "Valid", embedded: true, publisher: "Ferrox Labs, LLC" })) };
  const file = path.join(f.appOutDir, name), bytes = fs.readFileSync(file); bytes[600] ^= 1; fs.writeFileSync(file, bytes);
  await expect(verifyWindowsSacInventory({ ...f, native: undefined, bootstrapTrust })).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
  expect(nativeAuthenticodeIn).not.toHaveBeenCalled();
});
