// SPDX-License-Identifier: AGPL-3.0-or-later
// Behavioural witnesses for WAL seam P1-P5 (walseam-19m). Each one RUNS the production code path the P-item protects: the real startWalMaintenance spawn and its real
// worker, the real loaders, the real worker native-meter loader. The static guard (wal-seam-guard.test.ts) stays as an extra layer; the mutants that kill these are in
// the harness (l19g/mutants.d/B19m-*.patch, list mutants-behav19m.tsv). Stand-in addons are CommonJS files named engine-exclusion.node (see engine-exclusion-meter-copy.test.ts).
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Module from "node:module";
import * as workerThreads from "node:worker_threads";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADDON_VERSION, HANDLE_FUNCTIONS, WINDOWS_NATIVE_FUNCTIONS, addonIsUsable, loadIoMeterAddon, type IoMeterFileId } from "./engine-exclusion.ts";
import { ensureIoMeter, ioMeterNativeId, ioMeterNativePath, resetIoMeterForTest } from "./io-meter.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";


// ---------------------------------------------------------------------------------------------------------------------------------- P5 stand-ins
const standIn = (version: number) => `const f = () => 0; module.exports = { version: () => ${version}, lock: f, processes: f, renameNoReplace: f, writers: f, fullSync: f, ioMeterAdd: f, ioMeterTotal: f, ioMeterBytes: f }; for (const name of ${JSON.stringify([...HANDLE_FUNCTIONS, ...WINDOWS_NATIVE_FUNCTIONS])}) module.exports[name] ??= f;`;
const exts = (Module as unknown as { _extensions: Record<string, (m: { _compile(c: string, f: string): void }, f: string) => void> })._extensions;
const nativeLoader = exts[".node"];
const saved = { ...process.env };
let dir = "";
beforeEach(() => {
  exts[".node"] = (m, f) => m._compile(readFileSync(f, "utf8"), f);
  dir = realpathSync(mkdtempSync(join(tmpdir(), "wal-seam-p5-")));
  for (const k of ["MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH", "MURAGE_PACKAGED", "MURAGE_ENGINE_EXCLUSION_PATH"]) delete process.env[k];
});
afterEach(() => { exts[".node"] = nativeLoader!; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); removeTempDirSync(dir); });

describe("B19m-p5: the real loader chain", () => {
  it("P5b: nativeMeterPath is published only after the SQLite load succeeds (a qualified stand-in that SQLite cannot load publishes nothing)", () => {
    const src = join(dir, "stand-in.node"); writeFileSync(src, standIn(ADDON_VERSION));
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = src; resetIoMeterForTest();
    expect(ensureIoMeter(), "SQLite cannot load a JavaScript stand-in as an extension").toBe(false);
    expect(ioMeterNativePath(), "no path is published for a copy SQLite refused").toBeUndefined();
    expect(ioMeterNativeId(), "no identity is published either").toBeUndefined();
  });
  it("P5a: an addon that fails qualification (wrong version) is never returned by the meter loader", () => {
    const src = join(dir, "stand-in.node"); writeFileSync(src, standIn(ADDON_VERSION + 1));
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = src;
    expect(loadIoMeterAddon()).toBeNull();
    writeFileSync(src, standIn(ADDON_VERSION));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      expect(addonIsUsable(Module.createRequire(import.meta.url)(src), true), "the behavioural stand-in supplies every Windows export").toBe(true);
    } finally { Object.defineProperty(process, "platform", platform); }
    expect(loadIoMeterAddon(), "control: the same file at the right version qualifies").not.toBeNull();
  });
  it("P5c: the override is honoured only under NODE_ENV=test and never when packaged or when a resources root is set", () => {
    const src = join(dir, "stand-in.node"); writeFileSync(src, standIn(ADDON_VERSION));
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = src;
    expect(loadIoMeterAddon(), "control: test gate open").not.toBeNull();
    process.env.NODE_ENV = "production";
    expect(loadIoMeterAddon(), "NODE_ENV is not test").toBeNull();
    process.env.NODE_ENV = "test"; process.env.MURAGE_PACKAGED = "1";
    expect(loadIoMeterAddon(), "packaged").toBeNull();
    delete process.env.MURAGE_PACKAGED; process.env.MURAGE_RESOURCES_PATH = join(dir, "no-such-root");
    expect(loadIoMeterAddon(), "MURAGE_RESOURCES_PATH set").toBeNull();
    delete process.env.MURAGE_RESOURCES_PATH; process.env.OMB_RESOURCES_PATH = join(dir, "no-such-root");
    expect(loadIoMeterAddon(), "OMB_RESOURCES_PATH set").toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- P5 worker loader
function workerSource(): string {
  const file = ts.createSourceFile("wal-maintenance.ts", readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let source: string | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(file) === "WORKER_SOURCE" && node.initializer && ts.isNoSubstitutionTemplateLiteral(node.initializer)) source = node.initializer.text; ts.forEachChild(node, visit); };
  visit(file);
  expect(source, "the production worker source").toBeTypeOf("string");
  return source!;
}
/** Runs the production worker source with the given native meter path and identity; resolves to the first error message or message type. */
function runWorker(p: string | undefined, id: IoMeterFileId | undefined): Promise<string> {
  return new Promise(resolveRun => {
    const w = new workerThreads.Worker(workerSource(), { eval: true, workerData: {
      file: ":memory:", shared: new SharedArrayBuffer(28 * 4), copied: new SharedArrayBuffer(8), admission: new SharedArrayBuffer(32 * 8), admissionSource: checkpointLedger.toString(),
      nativeMeterPath: p, nativeMeterId: id, osPageSize: 65536, stepBytes: 4 * 1024 * 1024, pollMs: 25, dueMs: 250, debtBytes: 8 * 1024 * 1024, debtFd: { debt: -1, index: -1 } } });
    const done = (text: string) => { void w.terminate(); resolveRun(text); };
    w.once("message", (m: { type?: string }) => done("message:" + m.type));
    w.once("error", (e: Error) => done(e.message));
    setTimeout(() => done("NO-RESULT"), 20_000).unref();
  });
}
const idOf = (p: string): IoMeterFileId => { const st = statSync(p); return { dev: st.dev, ino: st.ino, size: st.size, sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }; };
const refused = (why: string) => `wal-worker: native meter refused: ${why}`;

describe("B19m-worker: the real worker refuses a native meter it cannot prove is the parent's private copy, before require", () => {
  let copy = "";
  beforeEach(() => { mkdirSync(join(dir, "c")); copy = join(dir, "c", "engine-exclusion.node"); writeFileSync(copy, "not a real addon: only the refusals are under test"); });
  it("control: an unaltered copy passes every check (it then fails to load as a native library, which is not a refusal)", async () => {
    const msg = await runWorker(copy, idOf(copy));
    expect(msg.startsWith("wal-worker: native meter refused")).toBe(false);
    expect(msg).not.toBe("NO-RESULT");
  });
  it("P5d: a relative path is refused as not absolute", async () => { expect(await runWorker("engine-exclusion.node", idOf(copy))).toBe(refused("the path is not absolute")); });
  it("P5g: changed bytes (same size, same file) are refused by the sha256 check", async () => {
    const id = idOf(copy); const bytes = readFileSync(copy); bytes[0] = bytes[0]! ^ 1; writeFileSync(copy, bytes);
    expect(await runWorker(copy, id)).toBe(refused("the file content changed"));
  });
  it("P5g: the same bytes in a different file (dev/ino) are refused", async () => {
    const id = idOf(copy); renameSync(copy, join(dir, "c", "original.node")); copyFileSync(join(dir, "c", "original.node"), copy);
    expect(await runWorker(copy, id)).toBe(refused("the file identity changed"));
  });
  it.skipIf(process.platform === "win32")("P5g: a symlink in place of the copy is refused as not a regular file", async () => {
    const id = idOf(copy); const old = join(dir, "c", "original.node"); renameSync(copy, old); symlinkSync(old, copy);
    expect(await runWorker(copy, id)).toBe(refused("not a regular file"));
  });
  it.skipIf(process.platform === "win32")("P5g: a path reached through a symlinked directory is refused as not canonical", async () => {
    const id = idOf(copy); symlinkSync(join(dir, "c"), join(dir, "alias"), "dir");
    expect(await runWorker(join(dir, "alias", "engine-exclusion.node"), id)).toBe(refused("the path is not canonical"));
  });
  it("P5g: no identity is refused", async () => { expect(await runWorker(copy, undefined)).toBe(refused("no file identity")); });
});
