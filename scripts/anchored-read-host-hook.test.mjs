import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Compile the production hook against a tiny SDK shim to exercise its routing
// on non-Windows builders. Real MSVC + packaged Murage.exe remain native gates.
it.skipIf(process.platform === "win32")("Windows delay-load hook resolves only node.exe through the current executable", () => {
  const root = mkdtempSync(join(tmpdir(), "anchored-host-hook-"));
  try {
    writeFileSync(join(root, "windows.h"), `
#pragma once
#include <stddef.h>
#include <strings.h>
#define WINAPI
#define _stricmp strcasecmp
typedef void (*FARPROC)(void);
typedef void *HMODULE;
HMODULE GetModuleHandleW(const void *name);
`);
    writeFileSync(join(root, "delayimp.h"), `
#pragma once
#include <windows.h>
typedef struct { const char *szDll; } DelayLoadInfo, *PDelayLoadInfo;
typedef FARPROC (WINAPI *PfnDliHook)(unsigned, PDelayLoadInfo);
enum { dliStartProcessing, dliNotePreLoadLibrary, dliNotePreGetProcAddress, dliFailLoadLib };
`);
    writeFileSync(join(root, "main.c"), `
#include <assert.h>
#include <delayimp.h>
extern const PfnDliHook __pfnDliNotifyHook2;
static int calls;
static char executable;
HMODULE GetModuleHandleW(const void *name) { assert(name == NULL); calls++; return &executable; }
int main(void) {
  DelayLoadInfo info = { "node.exe" };
  assert(__pfnDliNotifyHook2(dliNotePreLoadLibrary, &info) == (FARPROC)&executable);
  info.szDll = "NODE.EXE";
  assert(__pfnDliNotifyHook2(dliNotePreLoadLibrary, &info) == (FARPROC)&executable);
  assert(calls == 2);
  info.szDll = "kernel32.dll";
  assert(__pfnDliNotifyHook2(dliNotePreLoadLibrary, &info) == NULL);
  info.szDll = "node.exe";
  assert(__pfnDliNotifyHook2(dliStartProcessing, &info) == NULL);
  assert(__pfnDliNotifyHook2(dliNotePreGetProcAddress, &info) == NULL);
  assert(__pfnDliNotifyHook2(dliFailLoadLib, &info) == NULL);
  assert(calls == 2);
}
`);
    const binary = join(root, "hook-test");
    execFileSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", root,
      fileURLToPath(new URL("../native/anchored-read/host-hook.c", import.meta.url)), join(root, "main.c"), "-o", binary], { timeout: 30000 });
    assert.equal(execFileSync(binary, [], { timeout: 5000, encoding: "utf8" }), "");
  } finally { removeTempDirSync(root); }
});
