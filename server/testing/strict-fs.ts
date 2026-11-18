// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers for the boot-tolerance rows that run on a real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA; ACCEPTANCE.md T0): a real server
// child, a ballast file that takes the free space down, and the three-part snapshot the pack defines. Nothing here changes what the server does.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, statSync, statfsSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const STRICT = "/strict";
export const MiB = 1024 * 1024;
export const OWNER_COPY = "Your disk is almost full. Chats are read-only. Free some space, then restart Murage.";
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const onStrictMount = (() => { try { return readFileSync("/proc/mounts", "utf8").split("\n").some(line => line.split(" ")[1] === STRICT); } catch { return false; } })();
export const freeBytes = () => { const s = statfsSync(STRICT); return s.bavail * s.bsize; };

export interface Run { child: ChildProcess; out: () => string; exited: () => number | null | undefined }
export function startServer(home: string, port: number, env: Record<string, string> = {}): Run {
  let output = "", code: number | null | undefined;
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", chunk => (output += chunk));
  child.stderr!.on("data", chunk => (output += chunk));
  child.on("exit", c => { code = c; });
  return { child, out: () => output, exited: () => code };
}
export async function healthOk(port: number, run: Run, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (run.exited() !== undefined) return false;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await sleep(50);
  }
  return false;
}
export async function waitExited(run: Run, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (run.exited() !== undefined) return true; await sleep(50); }
  return false;
}
export async function desktopHeaders(port: number): Promise<Record<string, string>> {
  const secret = ((await (await fetch(`http://127.0.0.1:${port}/api/desktop-secret`)).json()) as { secret: string }).secret;
  return { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
}
/** Grows `file` until free space on /strict is at most `targetFree` bytes. */
export function fillTo(file: string, targetFree: number): void {
  const fd = openSync(file, "a"); const buf = Buffer.alloc(MiB, 1);
  try { while (freeBytes() - targetFree > 0) writeSync(fd, buf, 0, Math.min(MiB, freeBytes() - targetFree)); } finally { closeSync(fd); }
}

const jsonOf = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `x${Buffer.from(v).toString("hex")}` : v);
export interface Snapshot { tables: Record<string, string>; inventory: Record<string, number>; json: Record<string, string>; bytes: Record<string, string> }
/** The pack's snapshot: per table the sha256 of all rows ordered by primary key (rowid for a rowid table without one), the data dir's file inventory
 * (-wal/-shm excluded) and the sha256 of every *.json file. `bytes` (MAIN 2026-11-17 Q2, no exclusion list in a read-only snapshot): the sha256 of every
 * file's bytes, so any changed byte of any file (a secondary SQLite file, a raw fs write) differs. Left out: only SQLite's own -wal/-shm, whose content
 * is the database's and is compared through every table's rows. Read by a separate read-only connection: take it with the server stopped. */
export function snapshot(dataDir: string): Snapshot {
  const tables: Record<string, string> = {};
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    const names = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string | null }>);
    for (const { name, sql } of names) {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const keys = (db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string; pk: number }>).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => `"${c.name.replace(/"/g, '""')}"`);
      const order = keys.length ? keys.join(",") : /WITHOUT\s+ROWID/i.test(sql ?? "") ? "1" : "rowid";
      const hash = createHash("sha256");
      // a table that cannot be read fails the snapshot: hashing the error text would make two unreadable states equal and hide changed rows
      // integers are read as bigint: a 64-bit value (a hash column) does not fit a JavaScript number and would otherwise make the table unreadable
      try { const rows = db.prepare(`SELECT * FROM ${quoted} ORDER BY ${order}`); rows.setReadBigInts(true); for (const row of rows.iterate()) hash.update(jsonOf(row)).update("\n"); } catch (error) { throw new Error(`snapshot: table ${name} could not be read: ${String((error as Error).message)}`, { cause: error }); }
      tables[name] = hash.digest("hex");
    }
  } finally { db.close(); }
  const inventory: Record<string, number> = {}, json: Record<string, string> = {}, bytes: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || /-(wal|shm)$/.test(entry.name)) continue;
      const rel = relative(dataDir, path); inventory[rel] = statSync(path).size;
      const sha = createHash("sha256").update(readFileSync(path)).digest("hex"); bytes[rel] = sha;
      if (entry.name.endsWith(".json")) json[rel] = sha;
    }
  };
  walk(dataDir);
  return { tables, inventory, json, bytes };
}
