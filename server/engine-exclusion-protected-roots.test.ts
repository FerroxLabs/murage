// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, sep, win32 } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ADDON_VERSION, HANDLE_FUNCTIONS, WINDOWS_NATIVE_FUNCTIONS, addonIsUsable, loadIoMeterAddon } from "./engine-exclusion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { safeWipeSync } from "./testing/safe-wipe.mjs";

const extensions = (Module as unknown as { _extensions: Record<string, (m: { _compile(c: string, f: string): void }, f: string) => void> })._extensions;
const nativeLoader = extensions[".node"];
const copies = new Set<string>();
let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "meter-roots-")));
  const home = join(scratch, "home"); mkdirSync(home);
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  for (const key of ["MURAGE_DATA_DIR", "MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH", "MURAGE_PACKAGED"]) vi.stubEnv(key, undefined);
  vi.stubEnv("NODE_ENV", "test");
  const source = join(scratch, "stand-in.node");
  writeFileSync(source, `const f = () => 0; module.exports = { version: () => ${ADDON_VERSION}, lock: f, processes: f, renameNoReplace: f, writers: f, fullSync: f, ioMeterAdd: f, ioMeterTotal: f, ioMeterBytes: f }; for (const name of ${JSON.stringify([...HANDLE_FUNCTIONS, ...WINDOWS_NATIVE_FUNCTIONS])}) module.exports[name] ??= f;`);
  vi.stubEnv("MURAGE_ENGINE_EXCLUSION_PATH", source);
  extensions[".node"] = (m, file) => { if (dirname(file) !== scratch) copies.add(dirname(file)); m._compile(readFileSync(file, "utf8"), file); };
});
afterEach(() => {
  extensions[".node"] = nativeLoader!;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const copy of copies) safeWipeSync(copy, { tmpdir: dirname(copy) });
  copies.clear(); removeTempDirSync(scratch);
});

function checkOutside(root: string, temp: string) {
  expect(loadIoMeterAddon(), "the same stand-in loads before setting a forbidden TEMP").not.toBeNull();
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temp);
  const loaded = loadIoMeterAddon();
  if (process.platform === "win32") {
    expect(loaded, "Windows refuses its sole TEMP when it is protected").toBeNull();
    return;
  }
  expect(loaded, "a safe temporary root remains available").not.toBeNull();
  const rel = relative(realpathSync(root), realpathSync(dirname(loaded!.path)));
  expect(rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel)), "the private copy is outside the physical protected root").toBe(false);
}

it("P5g-default-root: TMPDIR beneath the default data directory is excluded without MURAGE_DATA_DIR", () => {
  expect(process.env.MURAGE_DATA_DIR).toBeUndefined();
  const data = join(homedir(), ".murage"), temp = join(data, "tmp"); mkdirSync(temp, { recursive: true });
  checkOutside(data, temp);
});

it("P5g-physical-root: a data directory reached through a symlinked parent is excluded", () => {
  const parent = join(scratch, "physical"), alias = join(scratch, "alias"), data = join(parent, "data"), temp = join(data, "tmp");
  mkdirSync(temp, { recursive: true }); symlinkSync(parent, alias, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("MURAGE_DATA_DIR", join(alias, "data"));
  checkOutside(data, temp);
});

it("P5g-child-name: a child whose name starts with two dots is still beneath the protected root", () => {
  const data = join(scratch, "data"), temp = join(data, "..cache"); mkdirSync(temp, { recursive: true });
  vi.stubEnv("MURAGE_DATA_DIR", data);
  checkOutside(data, temp);
});

it("W-stand-in-win32: the stand-in is usable and its private copy loads under Windows checks", () => {
  const source = process.env.MURAGE_ENGINE_EXCLUSION_PATH!;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const standIn = Module.createRequire(import.meta.url)(source);
    expect(addonIsUsable(standIn), "the fixture supplies every required Windows export").toBe(true);
    expect(addonIsUsable({ ...standIn, openFile: undefined }), "incomplete Windows addons remain refused").toBe(false);
    expect(loadIoMeterAddon(), "the same usable stand-in loads through the private copy").not.toBeNull();
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("P5g-root-cwd: a launch from the filesystem root loads while data-directory TEMP stays excluded", () => {
  const cwd = process.cwd(), data = join(scratch, "data"), temp = join(data, "tmp");
  mkdirSync(temp, { recursive: true }); vi.stubEnv("MURAGE_DATA_DIR", data);
  try { process.chdir(parse(cwd).root); checkOutside(data, temp); }
  finally { process.chdir(cwd); }
});

it("P5g-bad-root: an unresolvable data entry does not poison the meter", () => {
  const bad = join(scratch, "file"); writeFileSync(bad, "not a directory");
  vi.stubEnv("MURAGE_DATA_DIR", join(bad, "child"));
  expect(loadIoMeterAddon(), "one unresolvable entry must not switch the meter off").not.toBeNull();
});

it("P5g-bad-cwd: an unresolvable cwd does not poison the data protection", () => {
  const data = join(scratch, "data"), temp = join(data, "tmp"); mkdirSync(temp, { recursive: true });
  vi.stubEnv("MURAGE_DATA_DIR", data);
  vi.spyOn(process, "cwd").mockReturnValue(`${scratch}${sep}unresolvable${sep}..${sep}data`);
  checkOutside(data, temp);
});

// Run the unchanged loader against a Windows filesystem model; JS realpath keeps an 8.3 alias, native realpath expands it.
function windowsMeter({ cwd = "C:\\", temp = "C:\\Temp", nativeTemp = temp, data = "C:\\Data", resources }: { cwd?: string; temp?: string; nativeTemp?: string; data?: string; resources?: string } = {}) {
  const fixture = Module.createRequire(import.meta.url)(process.env.MURAGE_ENGINE_EXCLUSION_PATH!);
  const bytes = Buffer.from("fixture"), visited: string[] = [];
  const stat = { isFile: () => true, dev: 1, ino: 2, size: bytes.length };
  const env = { NODE_ENV: "test", MURAGE_DATA_DIR: data, MURAGE_ENGINE_EXCLUSION_PATH: "C:\\Fixture\\stand-in.node", MURAGE_RESOURCES_PATH: resources };
  const dependencies: Record<string, unknown> = {
    "node:path": win32, "node:crypto": { createHash }, "node:os": { homedir: () => "C:\\Home", tmpdir: () => temp },
    "node:url": { fileURLToPath: () => "C:\\App\\server\\engine-exclusion.ts" },
    "node:module": { createRequire: () => () => fixture },
    "node:worker_threads": { isMainThread: true },
    "./windows-code-integrity.ts": { windowsCodeIntegrityBlock: () => false }, // the loader's diagnostic only (never admission)
    "./meter-copy-cleanup.ts": { realCleanupHost: () => ({}), removeOwnCopyDir: () => false, sweepStaleMeterCopies: () => [], writeCopyMarker: () => {} },
    "./data-dir-lease.ts": { dataDirLeasePaths: (root: string) => {
      const canonical = win32.resolve(cwd, root).toLowerCase();
      if (canonical === win32.parse(canonical).root || root.includes("unresolvable")) throw new Error("INVALID_DATA_DIR");
      return { canonicalDataDir: canonical };
    } },
    "node:fs": {
      constants: fsConstants, existsSync: (file: string) => !file.includes("unresolvable"), lstatSync: () => stat, fstatSync: () => stat,
      realpathSync: Object.assign((file: string) => file, { native: (file: string) => { visited.push(file); return file === temp ? nativeTemp : win32.resolve(cwd, file); } }),
      openSync: () => 1, closeSync: () => {}, fsyncSync: () => {}, writeSync: () => bytes.length,
      readSync: (_fd: number, buffer: Buffer, offset: number, length: number, position: number) => bytes.copy(buffer, offset, position, position + length),
      mkdtempSync: (prefix: string) => prefix + "copy",
    },
  };
  const source = readFileSync(new URL("./engine-exclusion.ts", import.meta.url), "utf8").replaceAll("import.meta.url", '"file:///C:/App/server/engine-exclusion.ts"');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {} as { loadIoMeterAddon: typeof loadIoMeterAddon };
  runInNewContext(compiled, { exports, require: (id: string) => { if (!(id in dependencies)) throw new Error(`unexpected dependency ${id}`); return dependencies[id]; }, process: { platform: "win32", arch: "x64", env, cwd: () => cwd, once: () => {} }, Buffer });
  return { loaded: exports.loadIoMeterAddon(), visited };
}

it("P5g-win32-root-cwd: C:\\ does not poison the meter or data/resources protections", () => {
  expect(windowsMeter().loaded, "a drive-root launch loads the meter").not.toBeNull();
  for (const options of [{ temp: "C:\\DATA\\tmp" }, { temp: "C:\\Resources\\tmp", resources: "C:\\Resources" }]) {
    const result = windowsMeter(options);
    expect(result.loaded?.path.toLowerCase().startsWith(options.temp.toLowerCase() + "\\") ?? false, "protected TEMP is never selected").toBe(false);
  }
});

it.each(["data", "resources"] as const)("P5g-win32-bad-root: an unresolvable %s does not poison the meter", key => {
  expect(windowsMeter({ [key]: "C:\\unresolvable\\child" }).loaded).not.toBeNull();
});

it("P5g-win32-short-temp: native realpath expands an 8.3 TEMP before protected-root comparison", () => {
  const temp = "C:\\DATALO~1\\TEMP";
  const result = windowsMeter({ data: "C:\\Data Long", temp, nativeTemp: "C:\\DATA LONG\\Temp" });
  expect(result.visited, "the temp candidate is resolved by native realpath").toContain(temp);
  expect(result.loaded?.path.toLowerCase().startsWith(temp.toLowerCase() + "\\") ?? false, "an 8.3 alias inside the data directory is refused").toBe(false);
  expect(result.loaded?.path.toLowerCase().startsWith("c:\\data long\\") ?? false).toBe(false);
});

it("P5g-win32-case-fold: temp candidates use the protected roots' case folding", () => {
  const data = join(scratch, "MixedData"), temp = join(data, "tmp"); mkdirSync(temp, { recursive: true });
  vi.stubEnv("MURAGE_DATA_DIR", data);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    checkOutside(data, temp);
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("P5g-win32-fallbacks: a forbidden Windows TEMP never tries current-drive POSIX fallbacks", () => {
  const result = windowsMeter({ temp: "C:\\Data\\tmp" });
  expect(result.loaded, "a forbidden sole Windows temp root refuses the meter").toBeNull();
  expect([...new Set(result.visited)], "only the OS Windows temporary directory is considered").toEqual(["C:\\Data\\tmp"]);
  expect(windowsMeter().loaded, "a safe Windows TEMP still loads").not.toBeNull();
});
