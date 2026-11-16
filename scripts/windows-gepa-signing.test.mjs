import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { admitBundledGepa, verifyGepaBundle } from "../server/gepa-resource.ts";
import { appendPeFixtureCertificate } from "./fixtures/windows-pe-signing.mjs";
import { fixturePeSource, fixturePeTrust } from "./fixtures/windows-pe-provenance.mjs";
import { verifySignedWindowsPe } from "../shared/windows-signed-pe.mjs";
import { windowsGepaFixture } from "./fixtures/windows-gepa.mjs";
import { verifyWindowsSacInventory, windowsPeFiles } from "./windows-sac-inventory.mjs";

const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
const requireBuilder = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
const asar = requireBuilder("@electron/asar");
const { createTransformer } = requireBuilder("./out/fileTransformer.js");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-gepa-signing-")); roots.push(root);
  const directory = path.join(root, "dist-native/gepa/win32-x64");
  const gepa = windowsGepaFixture(directory, path.join(root, "input-metadata.json"));
  const config = parse(fs.readFileSync("electron-builder.yml", "utf8"));
  config.extraMetadata = { murageGepaManifests: { "win32-x64": gepa.hash } };
  const signIf = vi.fn(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  const sources = gepa.images.map(file => fixturePeSource(`resources/gepa-worker/${path.relative(directory, file).split(path.sep).join("/")}`, fs.readFileSync(file), { component: "gepa", version: "0.1.4", sourceReceiptSha256: gepa.hash }));
  const context = { windowsPeSigner: signIf, windowsPeSources: sources, signingTrust: fixturePeTrust, appOutDir: path.join(root, "package"), electronPlatformName: "win32", arch: 1, outDir: path.join(root, "release"), packager: { projectDir: root, config, signIf } };
  const { default: hook } = await import(pathToFileURL(path.resolve(config.afterExtract)).href);
  return { root, directory, gepa, context, signIf, hook };
}

it("the configured hook signs every GEPA image with signIf, then freezes signed hashes before the real metadata transformer and copier run", async () => {
  const f = await fixture();
  await f.hook(f.context);
  const signed = { directory: f.context.packager.config.win.extraResources.find(row => row.to === "gepa-worker").from, ...f.context.packager.config.extraMetadata.murageWindowsPeGepa };
  expect(f.signIf.mock.calls.map(([file]) => file)).toEqual(await windowsPeFiles(signed.directory));
  const hash = f.context.packager.config.extraMetadata.murageGepaManifests["win32-x64"];
  expect(hash).not.toBe(f.gepa.hash);
  expect(() => verifyGepaBundle(signed.directory, "win32-x64", f.gepa.hash)).toThrow("GEPA_RESOURCE_MANIFEST_MISMATCH");
  expect(() => verifyGepaBundle(f.directory, "win32-x64", f.gepa.hash)).not.toThrow();
  const verified = verifyGepaBundle(signed.directory, "win32-x64", hash);
  for (const file of await windowsPeFiles(signed.directory)) {
    const bytes = fs.readFileSync(file);
    // MAIN RULING 1115-WINSAC-C (GrokBuild): positive controls use real PE certificate tables, never appended text.
    const name = `resources/gepa-worker/${path.relative(signed.directory, file).split(path.sep).join("/")}`;
    expect(() => verifySignedWindowsPe(bytes, signed.records.find(record => record.path === name).unsigned)).not.toThrow();
    expect(verified.manifest.files.find(item => item.path === path.relative(signed.directory, file).split(path.sep).join("/")).bytes).toBe(bytes.length);
  }
  const app = path.join(f.root, "app"), resources = path.join(f.root, "package/resources");
  fs.mkdirSync(app); fs.mkdirSync(resources, { recursive: true });
  const packageFile = path.join(app, "package.json");
  fs.writeFileSync(packageFile, JSON.stringify({ name: "fixture", version: "1.0.19" }));
  const transform = createTransformer(app, {}, f.context.packager.config.extraMetadata);
  fs.writeFileSync(packageFile, await transform(packageFile));
  await finished(await asar.createPackage(app, path.join(resources, "app.asar")));
  const metadata = JSON.parse(asar.extractFile(path.join(resources, "app.asar"), "package.json").toString());
  expect(metadata.murageGepaManifests["win32-x64"]).toBe(hash);
  // Windows never hardlinks resources. Run the real copier without Vitest's
  // Linux-only hardlink optimization; retain the runtime's nlink === 1 gate.
  const copy = `
    import { createRequire } from "node:module";
    import path from "node:path";
    const [root, resources, options, builder, sources] = process.argv.slice(1);
    const require = createRequire(builder);
    const { WinPackager } = require("./out/index.js");
    const { FileMatcher, copyFiles } = require("./out/fileMatcher.js");
    const win = JSON.parse(options);
    const matchers = win.extraResources.filter(row => row.to.startsWith("gepa-worker"))
      .map(row => new FileMatcher(path.resolve(root, row.from), path.join(resources, row.to), value => value.replaceAll("\u0024{arch}", "x64"), row.filter));
    const { windowsBuilderSigning } = await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/windows-builder-signing.mjs")).href)});
    const packager = { config: { extraMetadata: {} },
      signIf: async () => { throw Error("Frozen GEPA was signed again by copier"); } };
    await windowsBuilderSigning({ windowsPeSigner: packager.signIf, appOutDir: path.dirname(resources), arch: "x64", windowsPeSources: JSON.parse(sources), signingTrust: { authenticode: async () => { throw Error("Unexpected checker call"); } }, packager });
    const transformer = packager.createTransformerForExtraFiles({ appOutDir: path.dirname(resources) });
    await copyFiles(matchers, transformer, false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", copy, f.root, resources, JSON.stringify(f.context.packager.config.win), fromBuilder.resolve("app-builder-lib/package.json"), JSON.stringify(signed.sources)],
    { env: { ...process.env, VITEST: undefined, USE_HARD_LINKS: "false" }, timeout: 30_000 });
  expect(admitBundledGepa({ resourcesPath: resources, expectedManifestSha256: hash }, "win32", "x64")).toMatchObject({ available: true });
  const inventory = await verifyWindowsSacInventory({ appOutDir: path.dirname(resources), requiredFiles: ["resources/gepa-worker/gepa-worker.exe"], allowlist: [],
    sources: signed.sources, records: signed.records, native: { authenticode: async () => ({ status: "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true }) }, report: path.join(f.root, "inventory.md") });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): GEPA uses the same source/final allowlisted predicate as every PE.
  expect(inventory.counts).toEqual({ pe: f.gepa.images.length, signed: f.gepa.images.length, vendor: 0, allowlisted: f.gepa.images.length, rejected: 0 });
  expect(inventory.rows.every(row => row.signedBeforeFreeze && !row.signedHere)).toBe(true);
  fs.appendFileSync(path.join(resources, "gepa-worker/_internal/_socket.pyd"), " tampered");
  expect(admitBundledGepa({ resourcesPath: resources, expectedManifestSha256: hash }, "win32", "x64")).toEqual({ available: false, reason: "GEPA_RESOURCE_INVENTORY_MISMATCH" });
  await expect(verifyWindowsSacInventory({ appOutDir: path.dirname(resources), sources: signed.sources, records: signed.records, native: { authenticode: vi.fn() }, report: path.join(f.root, "tampered.md") })).rejects.toThrow("GEPA_RESOURCE_INVENTORY_MISMATCH");
});

it.each(["gepa-worker.exe", "python313.dll", "_socket.pyd", "native-image.bin"])("refuses signIf failure for %s without replacing the trusted pin", async name => {
  const f = await fixture();
  f.signIf.mockImplementation(async file => { if (path.basename(file) === name) return false; fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): failures come from the common signing function.
  await expect(f.hook(f.context)).rejects.toThrow("WINDOWS_SAC_UPSTREAM_SIGNING_FAILED");
  expect(f.context.packager.config.extraMetadata.murageGepaManifests["win32-x64"]).toBe(f.gepa.hash);
});

it("refuses tampering before signing and unrelated signer changes before refreezing", async () => {
  const f = await fixture(); fs.appendFileSync(f.gepa.images[0], " altered");
  await expect(f.hook(f.context)).rejects.toThrow("GEPA_RESOURCE_INVENTORY_MISMATCH");
  expect(f.signIf).not.toHaveBeenCalled();
  const fresh = await fixture();
  fresh.signIf.mockImplementation(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); fs.writeFileSync(path.join(path.dirname(file), "unrelated.txt"), " altered"); return true; });
  await expect(fresh.hook(fresh.context)).rejects.toThrow("GEPA_RESOURCE_CHANGED_DURING_SIGNING");
  expect(fresh.context.packager.config.extraMetadata.murageGepaManifests["win32-x64"]).toBe(fresh.gepa.hash);
});
