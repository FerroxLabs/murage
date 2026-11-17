// Builder/signing producer owner: win-sac-sign; trusted receipts/release metadata consumer owner: MAIN.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { normalizeWindowsPeSources, peSha256, readWindowsPeSnapshot, readWindowsPeSourceReceipt, runnerWindowsPeTrust,
  signPinnedWindowsPe, verifyFrozenWindowsPe, verifyWindowsPeRecord } from "./windows-pe-signing.mjs";
import { windowsPeFiles, writeWindowsSacReceipt } from "./windows-sac-inventory.mjs";
import { windowsPackageTree } from "./windows-package-tree.mjs";

import { windowsSigningSession } from "./windows-signing-session.mjs";

const stages = new WeakMap();
const activeStages = new Set();
export async function windowsBuilderSigning(context) {
  const packager = context.packager;
  if (stages.has(packager)) return stages.get(packager);
  const target = `win32-${typeof context.arch === "string" ? context.arch : ({ 1: "x64", 3: "arm64" })[context.arch]}`;
  const sourceRevision = context.windowsPeSourceRevision ?? process.env.MURAGE_BUILD_COMMIT;
  const identity = { target, sourceRevision };
  const sources = normalizeWindowsPeSources(context.windowsPeSources ?? await readWindowsPeSourceReceipt(
    process.env.MURAGE_WINDOWS_PE_SOURCE_RECEIPT, process.env.MURAGE_WINDOWS_PE_SOURCE_RECEIPT_SHA256, identity), identity);
  const session = windowsSigningSession(context);
  const state = { ...identity, sources: sources.filter(pin => !/^(?:artifacts|transient)\//.test(pin.path)), records: [],
    artifactSources: sources.filter(pin => pin.path.startsWith("artifacts/")), artifactRecords: [], artifactFiles: new Map(), appOutDir: path.resolve(context.appOutDir),
    trust: context.signingTrust ?? session.trust ?? await runnerWindowsPeTrust(), sign: session.sign, receipts: session.receipts,
    graph: session.graph, adapters: session.adapters, frozen: false };
  const gepa = packager.config.extraMetadata?.murageWindowsPeGepa;
  if (gepa) {
    for (const record of gepa.records) {
      const source = state.sources.find(pin => pin.path === record.path);
      if (!source || source.sourceReceiptSha256 !== gepa.sourceManifestSha256) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
      state.records.push(record);
    }
  }
  if (session.graph) {
    if (session.state) throw Error("WINDOWS_SIGNING_DUPLICATE_PACKAGE");
    session.state = state;
    for (const pin of state.sources.filter(pin => pin.kind === "build" && !["murage-app", "backup-transport", "gepa"].includes(pin.component))) {
      const output = state.receipts.outputs.find(row => row.path === pin.path);
      if (!output || (await state.receipts.consume(pin.path, output.stage)).sourceSha256 !== pin.sourceSha256) throw Error("WINDOWS_PE_BUILD_RECEIPT_INVALID");
    }
  }
  // Resource copies must preserve the frozen bytes. All signing is dispatched
  // at an explicit stage or builder's final resource-edit/sign boundary.
  packager.createTransformerForExtraFiles = () => null;
  stages.set(packager, state);
  activeStages.add(state);
  return state;
}

export async function dispatchWindowsBuilderSigning(packager, file) {
    const state = stages.get(packager);
    if (!state) throw Error("WINDOWS_SIGNING_STAGE_REQUIRED");
    const identity = { target: state.target, sourceRevision: state.sourceRevision };
    const relative = path.relative(state.appOutDir, path.resolve(file));
    const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const name = inside ? relative.split(path.sep).join("/") : `artifacts/${path.basename(file)}`;
    const old = (inside ? state.records : state.artifactRecords).find(record => record.path === name);
    let pin = (inside ? state.sources : state.artifactSources).find(pin => pin.path === name);
    if (state.receipts && !old) {
      const output = state.receipts.outputs.find(row => row.path === name);
      if (!output) throw Error("WINDOWS_PE_BUILD_RECEIPT_INVALID");
      pin = await state.receipts.consume(name, output.stage);
      const sources = inside ? state.sources : state.artifactSources, index = sources.findIndex(row => row.path === name);
      if (index < 0) sources.push(pin); else sources[index] = pin;
    }
    if (!pin) throw Error(`WINDOWS_PE_SOURCE_PIN_REQUIRED: ${name}`);
    if (old) {
      await verifyFrozenWindowsPe(file, pin, old, state.trust);
      return true;
    }
    if (state.frozen && inside) throw Error("WINDOWS_PE_RECORDS_FROZEN");
    if (inside && name !== "Murage.exe") throw Error("WINDOWS_PE_UNEXPECTED_BUILDER_SIGNING");
    // The main receipt describes the output of builder's completed resource
    // edits; generated installers/uninstallers need declared build receipts too.
    if (pin.kind !== "build") throw Error("WINDOWS_PE_BUILD_RECEIPT_INVALID");
    const record = await signPinnedWindowsPe(file, pin, state.trust, state.sign, { ...identity, path: name });
    (inside ? state.records : state.artifactRecords).push(record);
    if (!inside) state.artifactFiles.set(path.resolve(file), record);
    if (state.adapters && pin.component === "uninstaller") await state.adapters.retainUninstaller(name, file, pin, record);
    if (state.graph && pin.component === "installer") await state.graph.freeze("installer", async () => {
      await verifyFrozenWindowsPe(file, pin, record, state.trust); return { [name]: record.finalSha256 };
    });
    return true;
}

export async function preflightWindowsPackage(state) {
  const discovered = (await windowsPeFiles(state.appOutDir)).map(file => path.relative(state.appOutDir, file).split(path.sep).join("/"));
  const expected = new Set([...state.sources.map(pin => pin.path), ...(state.receipts?.outputs ?? []).filter(output => !/^(?:artifacts|transient)\//.test(output.path)).map(output => output.path)]);
  if (discovered.length !== expected.size || discovered.some(name => !expected.has(name))) throw Error("WINDOWS_PE_SOURCE_SET_MISMATCH");
  // Unknown images fail before any signing. Already frozen GEPA copies must
  // match their records and can never acquire a second signing pass.
  for (const pin of state.sources) {
    const record = state.records.find(record => record.path === pin.path);
    const bytes = (await readWindowsPeSnapshot(path.join(state.appOutDir, pin.path))).bytes;
    if (record) verifyWindowsPeRecord(bytes, pin, record);
    else if (pin.path !== "Murage.exe" && peSha256(bytes) !== pin.sourceSha256) throw Error("WINDOWS_SAC_UPSTREAM_HASH_MISMATCH");
  }
}

export async function signWindowsPackageSource(state, pin) {
  if (state.frozen || state.records.some(record => record.path === pin.path)) throw Error("WINDOWS_PE_RECORDS_FROZEN");
  const record = await signPinnedWindowsPe(path.join(state.appOutDir, pin.path), pin, state.trust, state.sign, { ...state, path: pin.path });
  state.records.push(record);
  return record;
}

export async function freezeWindowsBuilderSigning(context) {
  const state = await windowsBuilderSigning(context);
  const file = process.env.MURAGE_WINDOWS_SAC_RELEASE_METADATA;
  if (!file || !path.isAbsolute(file) || !path.relative(state.appOutDir, file).startsWith(`..${path.sep}`)) throw Error("WINDOWS_PE_RELEASE_METADATA_REQUIRED");
  let digest;
  if (state.graph) await state.graph.freeze("app", async () => {
    digest = await writeWindowsSacReceipt(state.appOutDir, state, { native: state.trust, report: path.join(path.dirname(file), "SAC-INVENTORY.md") });
    return Object.fromEntries(state.records.filter(row => state.graph.scopeFor(row.path) === "app").map(row => [row.path, row.finalSha256]));
  });
  else digest = await writeWindowsSacReceipt(state.appOutDir, state, { native: state.trust, report: path.join(path.dirname(file), "SAC-INVENTORY.md") });
  state.manifestSha256 = digest;
  state.tree = await windowsPackageTree(state.appOutDir);
  state.frozen = true;
  await writeFile(file, JSON.stringify({ schema: 2, target: state.target, sourceRevision: state.sourceRevision, manifestSha256: digest }) + "\n", { flag: "wx" });
  return digest;
}

export async function verifyWindowsArtifactRecords(result) {
  if (process.platform !== "win32") return;
  const file = process.env.MURAGE_WINDOWS_SAC_RELEASE_METADATA;
  if (!file) throw Error("WINDOWS_PE_RELEASE_METADATA_REQUIRED");
  // No artifact hashes are refreshed. Builder's actual signing dispatcher
  // records every generated PE; the release receipt is emitted outside package.
  const state = [...activeStages].find(state => result.artifactPaths.some(file => state.artifactFiles.has(path.resolve(file))));
  if (!state) throw Error("WINDOWS_PE_ARTIFACT_RECORDS_REQUIRED");
  for (const pin of state.artifactSources) {
    if (!state.artifactRecords.some(record => record.path === pin.path)) throw Error("WINDOWS_PE_ARTIFACT_RECORDS_REQUIRED");
  }
  for (const artifact of result.artifactPaths.filter(file => /\.exe$/i.test(file))) {
    const record = state.artifactFiles.get(path.resolve(artifact)), pin = state.artifactSources.find(pin => pin.path === record?.path);
    await verifyFrozenWindowsPe(artifact, pin, record, state.trust);
  }
  const metadata = JSON.parse(await readFile(file, "utf8"));
  await writeFile(`${file}.artifacts.json`, JSON.stringify({ ...metadata, sources: state.artifactSources, files: state.artifactRecords }) + "\n", { flag: "wx" });
  activeStages.delete(state);
}
