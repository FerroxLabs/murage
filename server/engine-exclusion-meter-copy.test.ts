// SPDX-License-Identifier: AGPL-3.0-or-later
// D6 behaviour witnesses (rev8): W-relative-override and W-same-file. The stand-in "addon" is a CommonJS file named engine-exclusion.node: require() runs an unknown
// extension as JavaScript, so the loader's real code path (candidates, privateCopy, usable, require of the copy) runs unmodified.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname, relative, isAbsolute } from "node:path";
import Module from "node:module";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ADDON_VERSION, HANDLE_FUNCTIONS, WINDOWS_NATIVE_FUNCTIONS, addonIsUsable, loadIoMeterAddon, overrideAllowed } from "./engine-exclusion.ts";
import { safeWipeSync } from "./testing/safe-wipe.mjs";

const standIn = (hooks: boolean) => `const f = () => 0; module.exports = { version: () => ${ADDON_VERSION}, lock: f, processes: f, renameNoReplace: f, writers: f, fullSync: f, ioMeterAdd: f, ioMeterTotal: f, ioMeterBytes: f${hooks ? ", anchorTestStall: f" : ""} }; for (const name of ${JSON.stringify([...HANDLE_FUNCTIONS, ...WINDOWS_NATIVE_FUNCTIONS])}) module.exports[name] ??= f;`;
const saved = { ...process.env }, cwd = process.cwd();
let dir = "";
const copies = new Set<string>();
const exts = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown; _compile(c: string, f: string): void }, f: string) => void> })._extensions;
const nativeLoader = exts[".node"];
// the stand-ins are JavaScript: the test lets the loader treat a .node file as JavaScript for its own duration only
beforeEach(() => { exts[".node"] = (m, f) => { if (dirname(f) !== dir) copies.add(dirname(f)); m._compile(readFileSync(f, "utf8"), f); }; dir = realpathSync(mkdtempSync(join(tmpdir(), "meter-copy-"))); delete process.env.MURAGE_RESOURCES_PATH; delete process.env.OMB_RESOURCES_PATH; delete process.env.MURAGE_PACKAGED; process.env.NODE_ENV = "test"; });
afterEach(() => { exts[".node"] = nativeLoader!; process.chdir(cwd); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); for (const copy of copies) safeWipeSync(copy, { tmpdir: dirname(copy) }); copies.clear(); safeWipeSync(dir, { tmpdir: dirname(dir) }); });

it("W-relative-override: a relative override path under the test gate is resolved, loads, and keeps its exemption", () => {
  expect(overrideAllowed()).toBe(true);
  writeFileSync(join(dir, "stand-in.node"), standIn(true));
  process.chdir(dir); process.env.MURAGE_ENGINE_EXCLUSION_PATH = "  ./stand-in.node  ";
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(addonIsUsable(Module.createRequire(import.meta.url)(join(dir, "stand-in.node")), true), "the copy fixture supplies every Windows export").toBe(true);
    const loaded = loadIoMeterAddon();
    expect(loaded, "the relative override resolved against cwd, loaded, and kept the test-hook exemption").not.toBeNull();
    expect(basename(loaded!.path)).toBe("engine-exclusion.node");
  } finally { Object.defineProperty(process, "platform", platform); }
});
it("W-relative-override: the same hook-bearing file from any non-override location is refused", () => {
  writeFileSync(join(dir, "engine-exclusion.node"), standIn(true));
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = join(dir, "engine-exclusion.node");
  expect(loadIoMeterAddon(), "the same hook-bearing file loads through the test override").not.toBeNull();
  process.env.MURAGE_RESOURCES_PATH = dir; delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;
  expect(loadIoMeterAddon()).toBeNull();
});
it("W-same-file: the parent publishes the sha256 and dev/ino of the private 0600 copy", () => {
  const src = join(dir, "stand-in.node"); writeFileSync(src, standIn(false));
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = src;
  const loaded = loadIoMeterAddon()!;
  expect(loaded).not.toBeNull();
  const { path, id } = loaded;
  expect(path, "the copy, never the candidate").not.toBe(src);
  expect(id.sha256).toBe(createHash("sha256").update(readFileSync(src)).digest("hex"));
  expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(id.sha256);
  const st = statSync(path);
  expect([st.dev, st.ino, st.size]).toEqual([id.dev, id.ino, id.size]);
  if (process.platform !== "win32") { expect(st.mode & 0o777).toBe(0o600); expect(statSync(dirname(path)).mode & 0o777).toBe(0o700); }
  expect(realpathSync(path)).toBe(path);
  expect(dirname(path).startsWith(dir), "outside the candidate's directory").toBe(false);
});
it("W-same-file: a file symlink (POSIX) or directory junction (Windows) candidate is skipped, never followed", () => {
  const realDir = join(dir, "real"); mkdirSync(realDir);
  const real = join(realDir, "stand-in.node"); writeFileSync(real, standIn(false));
  let link = join(dir, "link.node");
  if (process.platform === "win32") {
    const alias = join(dir, "junction"); symlinkSync(realDir, alias, "junction"); link = join(alias, "stand-in.node");
  } else symlinkSync(real, link);
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = real;
  expect(loadIoMeterAddon(), "the same file by its plain path loads before alias refusal").not.toBeNull();
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = link;
  expect(loadIoMeterAddon()).toBeNull();
});
it("W-same-file: a candidate reached through a symlinked directory or Windows junction is skipped, never followed", () => {
  const realDir = join(dir, "real-dir"); mkdirSync(realDir); writeFileSync(join(realDir, "stand-in.node"), standIn(false));
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = join(realDir, "stand-in.node");
  expect(loadIoMeterAddon(), "the same file by its real path loads").not.toBeNull();
  symlinkSync(realDir, join(dir, "link-dir"), process.platform === "win32" ? "junction" : "dir");
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = join(dir, "link-dir", "stand-in.node");
  expect(loadIoMeterAddon(), "the same file through a symlinked directory is refused").toBeNull();
});
it.skipIf(process.platform === "win32")("P5g: TMPDIR inside the data folder still yields a private copy outside every protected directory", () => {
  const data = join(dir, "data"); mkdirSync(join(data, "tmp"), { recursive: true });
  const src = join(dir, "stand-in.node"); writeFileSync(src, standIn(false));
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = src;
  process.env.MURAGE_DATA_DIR = realpathSync(data);
  process.env.TMPDIR = realpathSync(join(data, "tmp"));
  const loaded = loadIoMeterAddon();
  expect(loaded, "a TMPDIR inside the data folder must not refuse the meter: the copy goes to another temporary folder").not.toBeNull();
  const copyDir = realpathSync(dirname(loaded!.path));
  const protectedRoots = [process.cwd(), realpathSync(data), join(process.cwd(), "server")];
  for (const root of protectedRoots) {
    const rel = relative(root, copyDir);
    expect(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)), `the copy directory ${copyDir} sits outside ${root}`).toBe(false);
  }
  expect(copyDir.startsWith(realpathSync(join(data, "tmp")))).toBe(false);
  expect(statSync(loaded!.path).mode & 0o777).toBe(0o600);
});
