// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs a boot-tolerance child (server/testing/*-child.ts) on a data dir and returns its one JSON result line. HEADLESS ONLY: throwaway data dir.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTING = dirname(fileURLToPath(import.meta.url));
export function runChild(script: string, guard: string, tag: string, args: string[], dataRoot: string, env: Record<string, string> = {}, timeout = 150_000): Record<string, unknown> {
  const result = spawnSync(process.execPath, [join(TESTING, script), ...args], {
    encoding: "utf8", timeout,
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: dataRoot, USERPROFILE: dataRoot, MURAGE_DATA_DIR: join(dataRoot, ".murage"), [guard]: "1", ...env },
  });
  const line = result.stdout.split("\n").find(l => l.startsWith(`${tag} `));
  if (!line) throw new Error(`no ${tag} line (exit ${result.status})\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-4000)}`);
  return JSON.parse(line.slice(tag.length + 1)) as Record<string, unknown>;
}
/** Runs a child that is expected to die at a named point: its exit status and the point it printed (`REACHED <point>`). */
export function runDying(script: string, guard: string, args: string[], dataRoot: string, timeout = 150_000): { status: number | null; reached: string | undefined } {
  const result = spawnSync(process.execPath, [join(TESTING, script), ...args], {
    encoding: "utf8", timeout,
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: dataRoot, USERPROFILE: dataRoot, MURAGE_DATA_DIR: join(dataRoot, ".murage"), [guard]: "1" },
  });
  const line = result.stdout.split("\n").find(l => l.startsWith("REACHED "));
  if (!line && result.status !== 9) throw new Error(`child neither reached a point nor died (exit ${result.status})\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-4000)}`);
  return { status: result.status, reached: line?.slice("REACHED ".length) };
}
