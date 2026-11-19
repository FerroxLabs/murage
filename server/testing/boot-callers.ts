// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers for the boot-caller rows (D5, E1): one scenario of testing/boot-callers-child.ts on a directory of the small filesystem.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { STRICT } from "./strict-fs.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "boot-callers-child.ts");
/** One scenario of the child; its single JSON line. */
export function bootCallersChild(scenario: string, dir: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD, scenario, join(dir, "ballast")], {
    encoding: "utf8", timeout: 150_000,
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: dir, USERPROFILE: dir, MURAGE_DATA_DIR: join(dir, ".murage"), BOOT_CALLERS_CHILD: "1" },
  });
  const line = result.stdout.split("\n").find(l => l.startsWith("BCRESULT "));
  expect(line, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-4000)}`).toBeDefined();
  return JSON.parse(line!.slice("BCRESULT ".length)) as Record<string, unknown>;
}
export function inStrict(name: string, body: (dir: string) => void): void {
  const dir = join(STRICT, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  try { body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

