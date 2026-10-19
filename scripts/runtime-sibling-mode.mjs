// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The check bundle-server.mjs runs on each runtime sibling it copies next to a bundle (RUNTIME_SIBLINGS). The copy must exist on every
// platform. On macOS and Linux it must also carry its mode (0755 for drivers/murage-exec). NTFS keeps no exec bit, so chmodSync cannot
// set one and statSync reports 0666 whatever was asked; on Windows the check is presence only. Nothing executes the shipped copy:
// server/drivers/murage-exec.ts reads it as text and installMurageExec writes the wrapper Claude runs, which on Windows runs under Git Bash
// (a #! script needs no exec bit there).
import { existsSync, statSync } from "node:fs";

export function checkRuntimeSibling(target, mode, platform = process.platform) {
  const fail = () => new Error(`bundle-server: ${target} was not written with mode ${mode.toString(8)}`);
  if (!existsSync(target)) throw fail();
  if (platform === "win32") return;
  if ((statSync(target).mode & 0o777) !== mode) throw fail();
}
