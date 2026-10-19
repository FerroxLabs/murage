// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-server.mjs copies each runtime sibling (drivers/murage-exec) next to its bundle and checks the copy. The mode
// check holds on macOS and Linux; NTFS keeps no exec bit, so on Windows the check is presence only (the shipped copy is
// only ever read as text by server/drivers/murage-exec.ts, and the installed wrapper runs under Git Bash).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { checkRuntimeSibling } from "./runtime-sibling-mode.mjs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sibling-mode-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("posix: a copy with the wrong mode fails the bundle", () => {
  const target = join(dir, "murage-exec");
  writeFileSync(target, "#!/bin/bash\n");
  chmodSync(target, 0o644);
  if (process.platform === "win32") return; // the file system cannot hold 0644 vs 0755 apart
  expect(() => checkRuntimeSibling(target, 0o755, "linux")).toThrow(/was not written with mode 755/);
  expect(() => checkRuntimeSibling(target, 0o755, "darwin")).toThrow(/was not written with mode 755/);
});

test("posix: a copy with the right mode passes", () => {
  const target = join(dir, "murage-exec");
  writeFileSync(target, "#!/bin/bash\n");
  chmodSync(target, 0o755);
  expect(() => checkRuntimeSibling(target, 0o755, process.platform === "win32" ? "win32" : "linux")).not.toThrow();
});

test("win32: the mode is not checked, since NTFS keeps no exec bit", () => {
  const target = join(dir, "murage-exec");
  writeFileSync(target, "#!/bin/bash\n");
  chmodSync(target, 0o644);
  expect(() => checkRuntimeSibling(target, 0o755, "win32")).not.toThrow();
});

test("every platform: a missing copy fails the bundle", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    expect(() => checkRuntimeSibling(join(dir, "absent"), 0o755, platform)).toThrow(/was not written/);
  }
});
