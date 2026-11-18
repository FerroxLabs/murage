import { expect, it } from "vitest";
import { windowsCodeIntegrityBlock } from "./windows-code-integrity.ts";

it.each([
  { code: "ERROR_DLL_INIT" }, { code: "ERROR_DLL_INIT_FAILED" }, { errno: 1114 },
  { message: "LoadLibrary failed: 0x800711C7" }, { errno: 0x800711c7 }, { errno: 0x800711c7 | 0 },
  { message: "0xC0E90002" }, { errno: 0xc0e90002 }, { errno: 0xc0e90002 | 0 },
  { message: "Smart App Control blocked engine-exclusion.node" },
  { message: "Part of this app has been blocked because we can't confirm who published engine-exclusion.node" },
  { message: "Windows cannot verify the digital signature for this file" },
  { code: "ERR_DLOPEN_FAILED", message: "A dynamic link library (DLL) initialization routine failed." },
  { message: "This file was blocked because it did not have a valid digital signature." },
  { errno: 577 }, { errno: 0xc0000428 },
  { cause: { code: "ERROR_DLL_INIT" } },
])("recognizes Windows loader/code-integrity evidence: %j", error => {
  expect(windowsCodeIntegrityBlock(error)).toBe(true);
});

it.each([undefined, null, {}, { code: "MODULE_NOT_FOUND" }, { code: "ERR_DLOPEN_FAILED", message: "The specified module could not be found" }, { message: "NODE_MODULE_VERSION mismatch" }])("keeps unrelated load failures separate: %j", error => {
  expect(windowsCodeIntegrityBlock(error)).toBe(false);
});

it("bounds cyclic loader causes", () => {
  const error: { cause?: unknown } = {}; error.cause = error;
  expect(windowsCodeIntegrityBlock(error)).toBe(false);
});
