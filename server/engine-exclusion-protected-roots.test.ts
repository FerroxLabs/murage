// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ADDON_VERSION, loadIoMeterAddon } from "./engine-exclusion.ts";
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
  writeFileSync(source, `const f = () => 0; module.exports = { version: () => ${ADDON_VERSION}, lock: f, processes: f, renameNoReplace: f, writers: f, fullSync: f, ioMeterAdd: f, ioMeterTotal: f, ioMeterBytes: f };`);
  vi.stubEnv("MURAGE_ENGINE_EXCLUSION_PATH", source);
  extensions[".node"] = (m, file) => { copies.add(dirname(file)); m._compile(readFileSync(file, "utf8"), file); };
});
afterEach(() => {
  extensions[".node"] = nativeLoader!;
  vi.unstubAllEnvs();
  for (const copy of copies) safeWipeSync(copy, { tmpdir: dirname(copy) });
  copies.clear(); removeTempDirSync(scratch);
});

function checkOutside(root: string, temp: string) {
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temp);
  const loaded = loadIoMeterAddon();
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
