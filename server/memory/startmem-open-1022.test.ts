// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-startmem (MAIN-RULING 2026-11-25T15:37Z): memory that cannot be read or migrated at open never stops the app opening.
// Through the real server (spawned on a data folder): damaged memory tables or a failed memory migration -> the server listens, the
// chat is readable, the health answer names memory as set aside in one plain line, and a raw rescue copy of the data folder exists;
// a healthy folder opens unchanged (no hold, no rescue copy). And a backup is produced when the memory search index is damaged.
// On the base (68ed0def17) every damaged row fails at the listen assertion: the start ends before the port opens.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, copyFileSync, createWriteStream, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { pipeline } from "node:stream/promises";

import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { powerBlockTestEnv } from "../testing/power-block-test.ts";
import { backupFixture } from "../testing/backup-fixture.ts";
import * as encryption from "../installation-backup-encryption.ts";
import { writeEncryptedInstallationBackup } from "../installation-encrypted-backup.ts";
import { watchBootProgress } from "../../electron/boot-progress-watch.mjs";
import * as startupSplash from "../../electron/startup-splash.mjs";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");
const children: ChildProcess[] = [];
const parents: string[] = [];

/** A data folder with one bot, its conversation and one message (backup-fixture.ts), memory tables at this build's version. */
function dataFolder(): { parent: string; data: string } {
  const f = backupFixture();
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); f.db.close();
  parents.push(f.parent);
  return { parent: f.parent, data: f.data };
}
/** Overwrites the first page of a table's b-tree with bytes that are no page at all (a torn write after a power cut). */
function tearTable(data: string, table: string): void {
  const db = new DatabaseSync(join(data, "messages.db"));
  const root = Number((db.prepare("SELECT rootpage FROM sqlite_schema WHERE name=?").get(table) as { rootpage: number }).rootpage);
  const size = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const fd = openSync(join(data, "messages.db"), "r+");
  try { writeSync(fd, Buffer.alloc(size, 0xa5), 0, size, (root - 1) * size); } finally { closeSync(fd); }
}
function strayMemoryObject(data: string): void {
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec("CREATE TABLE memory_stray(x); PRAGMA wal_checkpoint(TRUNCATE);"); db.close();
}
const rescueCopies = (parent: string) => readdirSync(parent).filter(name => name.startsWith("installation-rescue-"));

async function boot(parent: string, data: string, extra: { env?: Record<string, string>; onSpawn?: (child: ChildProcess) => void; node?: string[] } = {}): Promise<{ base: string; desktop: Record<string, string>; log: () => string; child: ChildProcess }> {
  const port = await freePortBlock([0, 1]);
  const home = join(parent, "home"); mkdirSync(home, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {} }));
  let out = "";
  const child = spawn(process.execPath, [...(extra.node ?? []), join(SERVER_DIR, "index.ts")], {
    windowsHide: true, cwd: join(SERVER_DIR, ".."),
    env: { ...powerBlockTestEnv(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "", ...extra.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  extra.onSpawn?.(child);
  child.stdout!.on("data", c => (out += c)); child.stderr!.on("data", c => (out += c));
  let exited = false; child.once("exit", () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let listening = false;
  while (!exited && Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) { listening = true; break; } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  // THE behavioural assertion: the server listens (on the base the start ends before the port opens and the app shows recovery)
  expect(listening, `server did not listen (exited=${exited}). log tail:\n${out.slice(-3000)}`).toBe(true);
  const proof = (await fetch(`${base}/api/desktop-secret`).then(r => r.json())) as { secret: string };
  return { base, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }, log: () => out, child };
}
async function readsChat(base: string, desktop: Record<string, string>): Promise<void> {
  const bots = await fetch(`${base}/api/bots?messages=0`, { headers: desktop });
  expect(bots.status).toBe(200);
  expect(((await bots.json()) as { bots: Array<{ id: string }> }).bots.map(bot => bot.id)).toContain("bot");
  const messages = await fetch(`${base}/api/threads/thread/messages?limit=50`, { headers: desktop });
  expect(messages.status).toBe(200);
  expect(((await messages.json()) as { messages: Array<{ text?: string }> }).messages.map(m => m.text)).toContain("WAL-visible transcript");
}
const health = async (base: string) => (await (await fetch(`${base}/api/health`)).json()) as { memoryIntegrity?: { hold: string | null; holdMessage: string | null } };

afterAll(async () => {
  for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
  for (const parent of parents) await removeTempDir(parent);
});

posixOnly("memory that cannot be opened never stops the app opening (real server)", () => {
  const damaged: Array<[string, (data: string) => void]> = [
    ["W-OPEN-TORN-META: the memory meta table's page is torn", data => tearTable(data, "memory_meta")],
    ["W-OPEN-TORN-RECORDS: the memory records table's page is torn", data => tearTable(data, "memory_records")],
    ["W-OPEN-SCHEMA: the memory schema check fails (an object the validator does not know)", data => strayMemoryObject(data)],
  ];
  for (const [name, damage] of damaged) {
    it(`${name} -> listens, chat readable, memory set aside in one line, rescue copy made`, async () => {
      const { parent, data } = dataFolder();
      damage(data);
      const server = await boot(parent, data);
      await readsChat(server.base, server.desktop);
      const state = await health(server.base);
      expect(state.memoryIntegrity?.hold).toBe("MEMORY_UNREADABLE_AT_OPEN");
      expect(state.memoryIntegrity?.holdMessage).toMatch(/memory is set aside for now\. Your chats, bots and files work as usual/);
      expect(server.log()).toMatch(/\[startup\] memory set aside: could not open memory \([A-Z0-9_]+\)/);
      expect(rescueCopies(parent)).toHaveLength(1);
      expect(existsSync(join(parent, rescueCopies(parent)[0]!, "messages.db"))).toBe(true);
      expect(existsSync(join(data, "memory-rescue.json"))).toBe(true);
      // torn meta: the owner's memory page opens, held, reading the stand-in's stored mode "off"; torn records (MAIN-RULING
      // 2026-11-25T18:04Z): the page opens held with the one line, never a 400 "malformed" (W-STATUS-TORN-RECORDS)
      if (name.startsWith("W-OPEN-TORN-META")) {
        const memory = await fetch(`${server.base}/api/memory/status`, { headers: server.desktop });
        expect(`${memory.status} ${(await memory.text()).slice(0, 600)}`).toMatch(/^200 .*"held":true.*"storedMode":"off"/s);
      }
      if (name.startsWith("W-OPEN-TORN-RECORDS")) {
        const memory = await fetch(`${server.base}/api/memory/status`, { headers: server.desktop });
        const page = `${memory.status} ${(await memory.text()).slice(0, 4000)}`;
        expect(page, "W-STATUS-TORN-RECORDS").toMatch(/^200 .*"held":true/s);
        expect(page).toMatch(/"hold":"MEMORY_UNREADABLE_AT_OPEN"/);
      }
      await waitForExit(server.child, { signal: "SIGTERM" });
      // the rescue copy is one-shot: a second start with the same damage makes no second copy and still opens
      const again = await boot(parent, data);
      await readsChat(again.base, again.desktop);
      expect(rescueCopies(parent)).toHaveLength(1);
      await waitForExit(again.child, { signal: "SIGTERM" });
    }, 180_000);
  }

  it("W-OPEN-HEALTHY: a healthy folder opens unchanged (no hold, no rescue copy)", async () => {
    const { parent, data } = dataFolder();
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    expect((await health(server.base)).memoryIntegrity?.hold ?? null).toBeNull();
    expect(server.log()).not.toMatch(/memory set aside/);
    expect(rescueCopies(parent)).toHaveLength(0);
    expect(existsSync(join(data, "memory-rescue.json"))).toBe(false);
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 120_000);
});

/** One encrypted backup of the fixture folder through the real path; only the age process is a pass-through. Never throws: the outcome
 * is returned so the assertion, not the call, is what fails when the backup is refused. */
async function backupOf(parent: string, data: string) {
  const encrypt = vi.spyOn(encryption, "encryptBackupStream").mockImplementation(async (_tool, _recipient, input, output) => { await pipeline(input, createWriteStream(output)); return undefined as never; });
  const decrypt = vi.spyOn(encryption, "decryptBackupFile").mockImplementation(async (_tool, _identity, input, output) => { copyFileSync(input, output); return undefined as never; });
  const archive = join(parent, "backup.age");
  try {
    const result = await writeEncryptedInstallationBackup(data, archive, { ageExecutable: "/nonexistent/age", identity: "AGE-SECRET-KEY-FIXTURE", recipient: "age1fixture", selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } });
    return { archive, result, refusal: null as string | null };
  } catch (error) {
    return { archive, result: null, refusal: `${(error as { code?: string }).code ?? ""} ${error instanceof Error ? `${error.message} ${error.stack?.split("\n").slice(1, 6).join(" ")} cause=${String((error as { cause?: unknown }).cause)}` : String(error)}` };
  } finally { encrypt.mockRestore(); decrypt.mockRestore(); }
}

describe("a backup is produced when memory cannot be read", () => {
  // Staging, every snapshot, the fidelity inventory, the readback and the publish are the real backup path. On the base each damaged
  // row below refuses the backup, and the refusal assertion is the one that fails.
  it("W-BACKUP-INDEX: a damaged memory-index.db is left out (named in the coverage) and the backup file is written", async () => {
    const f = backupFixture(); f.db.close(); parents.push(f.parent);
    writeFileSync(join(f.data, "memory-index.db"), Buffer.alloc(8192, 0xa5));
    const outcome = await backupOf(f.parent, f.data);
    expect(outcome.refusal, "the backup was refused").toBeNull();
    expect(existsSync(outcome.archive)).toBe(true);
    expect(outcome.result!.coverage.components.find(component => component.path === "memory-index.db")?.status).toBe("excluded");
  }, 120_000);

  const damagedMemory: Array<[string, string]> = [
    ["W-BACKUP-MEMORY-PAGES: a memory table's page inside messages.db is torn (integrity_check fails)", "memory_records"],
    ["W-BACKUP-MEMORY-META: the memory meta table's page inside messages.db is torn", "memory_meta"],
  ];
  for (const [name, table] of damagedMemory) {
    it(`${name} -> the backup is written with memory left out and named, messages.db included`, async () => {
      const { parent, data } = dataFolder();
      tearTable(data, table);
      const outcome = await backupOf(parent, data);
      expect(outcome.refusal, "the backup was refused").toBeNull();
      expect(existsSync(outcome.archive)).toBe(true);
      expect(JSON.stringify(outcome.result!.skipped ?? null)).toContain("messages.db/memory/");
      expect(outcome.result!.coverage.components.find(component => component.path === "messages.db")?.status).toBe("included");
    }, 120_000);
  }

  // Astra 512d73496b: the rows above refuse on the base at the schema check (installation-database-snapshot.ts:431), before integrity_check.
  // A torn memory INDEX page leaves every table and the schema text readable, so on the base the refusal is the integrity check itself
  // (DATABASE_INTEGRITY_FAILED, :462); the backup must still be written with memory left out.
  it("W-BACKUP-INTEGRITY: a torn memory index page (schema readable, integrity_check fails) -> the backup is written with memory left out", async () => {
    const { parent, data } = dataFolder();
    const probe = new DatabaseSync(join(data, "messages.db"));
    const index = String((probe.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='memory_records' AND sql IS NOT NULL AND rootpage>0 ORDER BY name LIMIT 1").get() as { name: string }).name);
    probe.close();
    tearTable(data, index);
    const torn = new DatabaseSync(join(data, "messages.db"));
    const integrity = (torn.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>).map(row => Object.values(row)[0]);
    torn.close();
    expect(integrity, "fixture: integrity_check must fail on the torn index").not.toEqual(["ok"]);
    const outcome = await backupOf(parent, data);
    expect(outcome.refusal, "W-BACKUP-INTEGRITY: the backup was refused").toBeNull();
    expect(existsSync(outcome.archive)).toBe(true);
    expect(JSON.stringify(outcome.result!.skipped ?? null)).toContain("messages.db/memory/");
    expect(outcome.result!.coverage.components.find(component => component.path === "messages.db")?.status).toBe("included");
  }, 120_000);

  it("W-BACKUP-OTHER-PAGES (control): a torn page outside memory still refuses the backup", async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "messages");
    const outcome = await backupOf(parent, data);
    expect(outcome.refusal).toMatch(/DATABASE_/);
    expect(existsSync(outcome.archive)).toBe(false);
  }, 120_000);
});

posixOnly("the rescue copy stays small enough to finish before listen (Fable/Opus r2 H3)", () => {
  it("W-RESCUE-SCOPE: top-level files only (no model folder, no upgrade snapshot), marker written as complete", async () => {
    const { parent, data } = dataFolder();
    mkdirSync(join(data, "memory-model"), { recursive: true }); writeFileSync(join(data, "memory-model", "weights.bin"), Buffer.alloc(1024 * 1024, 1));
    writeFileSync(join(data, "messages.pre-memory-v3.db"), Buffer.alloc(64 * 1024, 2));
    tearTable(data, "memory_records");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    expect(rescueCopies(parent)).toHaveLength(1);
    const copy = readdirSync(join(parent, rescueCopies(parent)[0]!));
    expect(copy).toContain("messages.db");
    expect(copy.filter(name => name === "memory-model" || name.startsWith("messages.pre-memory-"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")).state).toBe("complete");
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 120_000);
});

/** Whether this volume clones (copy-on-write): then the rescue copy is a clone and takes no time at all, whatever the size. */
function volumeClones(dir: string): boolean {
  const from = join(dir, "clone-probe"), to = join(dir, "clone-probe-copy");
  writeFileSync(from, "x");
  try { copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE); return true; } catch { return false; } finally { rmSync(from, { force: true }); rmSync(to, { force: true }); }
}
/** Every page of messages.db that belongs to a memory table or index (SQLite's dbstat), read before any damage. */
function memoryPages(data: string): Set<number> {
  const db = new DatabaseSync(join(data, "messages.db"));
  try { return new Set((db.prepare("SELECT pageno FROM dbstat WHERE name LIKE 'memory\\_%' ESCAPE '\\'").all() as Array<{ pageno: number }>).map(row => Number(row.pageno))); }
  finally { db.close(); }
}
/** The page number of every frame in a write-ahead log (32-byte header; each frame a 24-byte header, page number first, then the page). */
function walPages(wal: string): number[] {
  const bytes = readFileSync(wal);
  if (bytes.length < 32) return [];
  const pageSize = bytes.readUInt32BE(8), pages: number[] = [];
  for (let at = 32; at + 24 + pageSize <= bytes.length; at += 24 + pageSize) pages.push(bytes.readUInt32BE(at));
  return pages;
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

posixOnly("the rescue copy of a large folder on a slow disk never stops the start (MAIN-RULING 2026-11-25T18:04Z)", () => {
  // The shell's own watch (electron/boot-progress-watch.mjs) with its step limit lowered from 5 minutes to STALL_MS, against a rescue copy
  // that lasts longer than STALL_MS: the copy must keep the step moving the whole time. On 512d73496b one copyFileSync held one step
  // for the whole copy, and the watch reads stalled (the shell would stop the child and show the recovery window).
  const STALL_MS = 400;
  it("W-RESCUE-WATCHDOG: a 1.5 GiB folder copies (clone, or chunks that move the step) while the shell's watch never reads stalled", async () => {
    const { parent, data } = dataFolder();
    const chunk = Buffer.alloc(64 * 1024 * 1024, 0x5a);
    const fd = openSync(join(data, "large-list.json"), "w");
    try { for (let i = 0; i < 24; i++) writeSync(fd, chunk); } finally { closeSync(fd); }
    const clones = volumeClones(parent);
    const memory = memoryPages(data);
    expect(memory.size, "fixture: memory pages found").toBeGreaterThan(0);
    tearTable(data, "memory_records");
    const before = sha(join(data, "messages.db"));
    let watch: ReturnType<typeof watchBootProgress> | null = null;
    const seen = { stalled: [] as number[], first: 0, last: 0, steps: new Set<string>() };
    // the shell's start-up window (electron/startup-splash.mjs) on a stand-in BrowserWindow that records what the page is told; main.mjs
    // hands every read of the note to it (watchBootProgress onStatus -> showBootStep -> splash.bootStep)
    const shown: string[] = [];
    class Window {
      webContents = { setWindowOpenHandler() {}, on() {}, executeJavaScript: (code: string) => { shown.push(code); return Promise.resolve(); } };
      on() {} loadURL() { return Promise.resolve(); } setSize() {} center() {} setMinimizable() {} setSkipTaskbar() {} show() {} showInactive() {} minimize() {} isDestroyed() { return false; } destroy() {} close() {}
    }
    // main.mjs showBootStep: startupSplash = showBootStep(startupSplash, step, create); this start has no window yet (made on the first copy step)
    let splash: { bootStep(step: string): boolean } | null = null;
    // the window as a failed migration leaves it: an upgrade view up (the copy then runs right after, database.ts migrate catch)
    const create = () => { const made = startupSplash.createStartupSplash({ BrowserWindow: Window, mode: "update", grace: 0, language: "en" }); made.set({ mode: "blocking", title: "Updating your memory", line: "Setting up the new memory format", keepOpen: true }); return made; };
    const show = (startupSplash as { showBootStep?: typeof startupSplash.showBootStep }).showBootStep;
    const server = await boot(parent, data, {
      env: { MURAGE_BOOT_PROGRESS: "1", MURAGE_BOOT_PROGRESS_INTERVAL_MS: "20" },
      onSpawn: child => {
        watch = watchBootProgress({ dataDir: data, pid: () => child.pid, intervalMs: 5, stepStallMs: STALL_MS, onStatus: (status: { step?: string }) => { splash = show?.(splash, status.step, create) ?? splash; }, setTimer: (tick: () => void, ms: number) => setInterval(() => {
          tick();
          const step = watch?.status()?.step ?? "";
          if (!step.startsWith("database.memory-rescue-copy")) return;
          const at = Date.now(); seen.first ||= at; seen.last = at; seen.steps.add(step);
          if (!watch!.fresh()) seen.stalled.push(at - seen.first);
        }, ms) });
      },
    });
    (watch as ReturnType<typeof watchBootProgress> | null)?.stop();
    await readsChat(server.base, server.desktop);
    expect(rescueCopies(parent)).toHaveLength(1);
    const copy = join(parent, rescueCopies(parent)[0]!);
    const marker = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; method?: string };
    expect(marker.state).toBe("complete");
    // the copy is the folder as it was before this start wrote anything (no repair write before the copy completes)
    expect(sha(join(copy, "messages.db")), "W-RESCUE-BEFORE-WRITE").toBe(before);
    // and no frame this start wrote before the copy (they land in the copied write-ahead log, not in messages.db) touches a memory page:
    // the start's own message-table setup may write there, a memory repair never before the copy is complete
    const copiedWal = join(copy, "messages.db-wal");
    const touched = existsSync(copiedWal) ? walPages(copiedWal).filter(page => memory.has(page)) : [];
    expect(touched, "W-RESCUE-BEFORE-WRITE: memory pages written before the copy").toEqual([]);
    expect(statSync(join(copy, "large-list.json")).size).toBe(24 * 64 * 1024 * 1024);
    console.info(`W-RESCUE-WATCHDOG clones=${clones} method=${marker.method} window=${seen.last - seen.first}ms steps=${seen.steps.size} stalled=${seen.stalled.length}`);
    if (clones) { expect(marker.method).toBe("clone"); }
    else {
      // the copy really outlasted the lowered step limit (else this proves nothing), and the watch never read stalled during it
      expect(seen.last - seen.first, `copy window ${seen.last - seen.first} ms, steps ${seen.steps.size}`).toBeGreaterThan(STALL_MS);
      expect(seen.stalled, `W-RESCUE-WATCHDOG stalled at ms ${seen.stalled.slice(0, 5).join(",")} (steps seen ${seen.steps.size})`).toEqual([]);
      expect(marker.method).toBe("bytes");
    }
    // W-START-SCREEN-PROGRESS (MAIN-RULING 18:04Z "shows progress in the recovery/start screen"): the window was told the copy's
    // percent as it moved (on a014cf5170 the watch had no onStatus and the window no bootStep: it was told nothing)
    const percents = shown.map(code => /Making a copy first \((\d+)%\)/.exec(code)?.[1]).filter((n): n is string => n !== undefined).map(Number);
    if (!clones) {
      expect(new Set(percents).size, `W-START-SCREEN-PROGRESS: copy percents shown ${JSON.stringify([...new Set(percents)].slice(0, 8))}`).toBeGreaterThan(2);
      expect(percents).toEqual([...percents].sort((a, b) => a - b));
    }
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 300_000);
});

posixOnly("a rescue copy that never completed is made again (Astra 48413f9803 High)", () => {
  it("W-RESCUE-RETRY: a marker left \"copying\" with a partial folder -> the next start removes that folder and completes a copy", async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "memory_records");
    const partial = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(partial); writeFileSync(join(partial, "messages.db"), "partial");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: partial, at: "2026-01-01T00:00:00.000Z", bytes: 1, state: "copying" }) + "\n");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    const marker = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; path: string; attempt: number };
    expect(marker.state, "W-RESCUE-RETRY: the interrupted copy was made again").toBe("complete");
    // the same folder goes on (Astra 0ebe1908fb: a retry never removes the folder); the file cut off mid-copy (not kept) is made again
    expect(marker.path).toBe(partial);
    expect(readFileSync(join(marker.path, "messages.db")).subarray(0, 15).toString()).toBe("SQLite format 3");
    expect(marker.attempt).toBe(2);
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 120_000);
  it("W-RESCUE-NO-LIMIT: a copy left unfinished by 3 earlier starts is still made at the next (never given up)", async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "memory_records");
    const partial = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(partial); writeFileSync(join(partial, "messages.db"), "partial");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: partial, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 3, state: "copying" }) + "\n");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    const marker = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; attempt: number };
    expect(marker.state, "W-RESCUE-NO-LIMIT: the copy was made at the 4th start").toBe("complete");
    expect(rescueCopies(parent)).toHaveLength(1);
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 120_000);
  it("W-RESCUE-TORN-MARKER: a marker torn by a power cut (empty) is never read as a copy made: the copy is made", async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), "");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    expect(rescueCopies(parent), "W-RESCUE-TORN-MARKER: rescue copies made").toHaveLength(1);
    expect(JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")).state).toBe("complete");
    expect((await health(server.base)).memoryIntegrity?.holdMessage).toMatch(/A copy of your chats and settings is kept beside your data folder\./);
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 120_000);
  // a retry never removes a file of the rescue folder before its replacement is complete (Astra 0ebe1908fb + 902958ec3e Highs), one row per
  // shape an earlier start can leave: the chats kept with their log, the chats kept without one (there was no log then), and a folder
  // whose marker names nothing kept (written by an earlier build) holding a list whose replacement cannot fit
  const earlierCopies: Array<[string, Record<string, unknown>, boolean]> = [
    ["W-RESCUE-KEEPS-CHATS: chats and log kept", { kept: ["messages.db", "messages.db-wal"], leftOut: ["huge-list.json"], state: "partial" }, true],
    ["W-RESCUE-KEEPS-CHATS-NOLOG: chats kept, copied when there was no log", { kept: ["messages.db"], leftOut: ["huge-list.json"], state: "partial" }, false],
    ["W-RESCUE-KEEPS-UNNAMED: nothing named kept, a list whose replacement cannot fit", { state: "partial" }, false],
    // the start was stopped while it published the list: the new one has its name, the earlier one is aside as .old, the marker names nothing
    ["W-RESCUE-KEEPS-PUBLISH-CUT: stopped between moving the earlier list aside and naming the new one kept", { state: "copying" }, false],
    // stopped after publishing new chats and their log over earlier chats copied without one, before naming them kept; the chats then do
    // not fit (Astra 69ac7b7e96): the earlier chats go back alone, never beside the new log
    ["W-RESCUE-KEEPS-PUBLISH-CUT-PAIR: stopped after publishing the chats and a log the earlier copy did not have", { state: "copying" }, false],
  ];
  for (const [name, earlierMarker, withLog] of earlierCopies) {
    it(`${name} -> the next start keeps what the folder holds until a replacement is complete`, async () => {
      const { parent, data } = dataFolder();
      const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
      mkdirSync(folder); copyFileSync(join(data, "messages.db"), join(folder, "messages.db"));
      if (withLog) writeFileSync(join(folder, "messages.db-wal"), "");
      // a publish stopped part-way (1.0.23 layout, Astra 3029be67c8 High): the earlier files wait in <folder>.aside, the journal
      // <folder>.aside.json names the group being published and which names the folder held before
      const aside = `${folder}.aside`;
      if (name.startsWith("W-RESCUE-KEEPS-PUBLISH-CUT-PAIR")) {
        mkdirSync(aside); renameSync(join(folder, "messages.db"), join(aside, "messages.db")); writeFileSync(join(folder, "messages.db"), "new chats, not yet kept");
        writeFileSync(join(folder, "messages.db-wal"), "new log, not yet kept"); writeFileSync(join(folder, "huge-list.json"), "earlier list");
        writeFileSync(`${folder}.aside.json`, JSON.stringify({ group: ["messages.db", "messages.db-wal"], earlier: ["messages.db"] }));
      } else if (name.startsWith("W-RESCUE-KEEPS-PUBLISH-CUT")) {
        mkdirSync(aside); writeFileSync(join(aside, "huge-list.json"), "earlier list"); writeFileSync(join(folder, "huge-list.json"), "new list, not yet kept");
        writeFileSync(`${folder}.aside.json`, JSON.stringify({ group: ["huge-list.json"], earlier: ["huge-list.json"] }));
      }
      else writeFileSync(join(folder, "huge-list.json"), "earlier list");
      const earlier = sha(join(name.startsWith("W-RESCUE-KEEPS-PUBLISH-CUT-PAIR") ? aside : folder, "messages.db"));
      tearTable(data, "memory_records");
      const fs = statfsSync(parent), free = Number(fs.bavail) * Number(fs.bsize);
      const fd = openSync(join(data, "huge-list.json"), "w");
      try { ftruncateSync(fd, Math.min(free * 2 + 1024 ** 3, 8 * 1024 ** 4)); } finally { closeSync(fd); }
      // the chats cannot be copied again either: the live file grows past the free space (sparse, past the pages its header counts)
      if (name.startsWith("W-RESCUE-KEEPS-PUBLISH-CUT-PAIR")) truncateSync(join(data, "messages.db"), Math.min(free * 2 + 1024 ** 3, 8 * 1024 ** 4));
      writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, ...earlierMarker }) + "\n");
      const server = await boot(parent, data);
      await readsChat(server.base, server.desktop);
      if (name.startsWith("W-RESCUE-KEEPS-UNNAMED") || name.startsWith("W-RESCUE-KEEPS-PUBLISH-CUT:")) {
        // the list could not be replaced (no room): the earlier one is still there; the chats were replaced by a complete copy
        expect(existsSync(join(folder, "huge-list.json")) && readFileSync(join(folder, "huge-list.json"), "utf8"), `${name}: the earlier list`).toBe("earlier list");
        expect(readFileSync(join(folder, "messages.db")).subarray(0, 15).toString()).toBe("SQLite format 3");
      } else {
        expect(existsSync(join(folder, "messages.db")) && sha(join(folder, "messages.db")), `${name}: the earlier copy of the chats`).toBe(earlier);
        if (name.startsWith("W-RESCUE-KEEPS-PUBLISH-CUT-PAIR")) expect(existsSync(join(folder, "messages.db-wal")), `${name}: no new log beside the earlier chats`).toBe(false);
      }
      expect(readdirSync(folder).filter(file => file.endsWith(".part") || file.endsWith(".old"))).toEqual([]);
      expect(rescueCopies(parent)).toEqual([basename(folder)]);
      await waitForExit(server.child, { signal: "SIGTERM" });
      rmSync(join(data, "huge-list.json"), { force: true });
    }, 120_000);
  }
  // a data file whose own name ends the way a scratch name of the copy would (Astra 3029be67c8 High): the copy holds it by its own name
  // and a retry never takes it for scratch (never removed, never renamed onto another name)
  it("W-RESCUE-SUFFIX-NAMES: data files named notes.part and notes.old are kept by a retry as the data folder has them", async () => {
    const { parent, data } = dataFolder();
    writeFileSync(join(data, "notes.part"), "data notes part"); writeFileSync(join(data, "notes.old"), "data notes old");
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); copyFileSync(join(data, "messages.db"), join(folder, "messages.db"));
    // an earlier start copied the chats and notes.part (the marker names both kept) and was stopped before notes.old was kept
    writeFileSync(join(folder, "notes.part"), "data notes part"); writeFileSync(join(folder, "notes.old"), "cut off");
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: ["messages.db", "notes.part"], state: "copying" }) + "\n");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    expect(existsSync(join(folder, "notes.part")) && readFileSync(join(folder, "notes.part"), "utf8"), "W-RESCUE-SUFFIX-NAMES: kept notes.part").toBe("data notes part");
    expect(existsSync(join(folder, "notes.old")) && readFileSync(join(folder, "notes.old"), "utf8"), "W-RESCUE-SUFFIX-NAMES: notes.old copied again").toBe("data notes old");
    expect(existsSync(join(folder, "notes")), "W-RESCUE-SUFFIX-NAMES: no file renamed onto a name the data folder does not have").toBe(false);
    expect(JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")).state).toBe("complete");
    await waitForExit(server.child, { signal: "SIGTERM" });
  }, 120_000);
  it("W-RESCUE-LOW-SPACE: the folder does not fit on the disk -> messages.db and its log are still copied; the owner line claims no copy", async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "memory_records");
    // a sparse file that says it is bigger than the whole free disk (no blocks are written): a byte copy of it can never fit
    const fs = statfsSync(parent), free = Number(fs.bavail) * Number(fs.bsize);
    const fd = openSync(join(data, "huge-list.json"), "w");
    try { ftruncateSync(fd, Math.min(free * 2 + 1024 ** 3, 8 * 1024 ** 4)); } finally { closeSync(fd); }
    const clones = volumeClones(parent);
    const before = sha(join(data, "messages.db"));
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    expect(rescueCopies(parent), "W-RESCUE-LOW-SPACE: a rescue copy exists").toHaveLength(1);
    const copy = join(parent, rescueCopies(parent)[0]!);
    expect(existsSync(join(copy, "messages.db")) && sha(join(copy, "messages.db")), "W-RESCUE-LOW-SPACE: messages.db copied as it was").toBe(before);
    const marker = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; leftOut?: string[] };
    const line = (await health(server.base)).memoryIntegrity?.holdMessage ?? "";
    if (clones) { expect(marker.state).toBe("complete"); }
    else {
      expect(marker, "W-RESCUE-LOW-SPACE: partial, made again at the next start").toMatchObject({ state: "partial", leftOut: ["huge-list.json"] });
      expect(line).toMatch(/memory is set aside for now\. Your chats, bots and files work as usual/);
      expect(line, "W-RESCUE-LOW-SPACE: the owner line never claims a copy that is not complete").not.toMatch(/A copy of your chats and settings is kept/);
      // the memory page says the same (integrity-pass.ts holdMessage -> settings.ts memoryOwnerStatus)
      const memory = await fetch(`${server.base}/api/memory/status`, { headers: server.desktop });
      const page = (await memory.json()) as { holdMessage?: string | null };
      expect(page.holdMessage, "W-RESCUE-LOW-SPACE: memory page line").toMatch(/could not finish a copy of your chats and settings yet/);
    }
    await waitForExit(server.child, { signal: "SIGTERM" });
    rmSync(join(data, "huge-list.json"), { force: true });
  }, 120_000);
});

/** Starts the real server under the stop preload; resolves with whether it was stopped (SIGKILL) at the cut. */
const CUT_PRELOAD = join(SERVER_DIR, "memory", "testing", "rescue-cut-preload.mjs");
async function bootCut(parent: string, data: string, cut: string, log: string): Promise<boolean> {
  const home = join(parent, "home"); mkdirSync(home, { recursive: true });
  const port = await freePortBlock([0, 1]);
  const child = spawn(process.execPath, ["--import", CUT_PRELOAD, join(SERVER_DIR, "index.ts")], {
    windowsHide: true, cwd: join(SERVER_DIR, ".."),
    env: { ...powerBlockTestEnv(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "", RESCUE_CUT: cut, RESCUE_CUT_LOG: log },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  let signal: NodeJS.Signals | null = null, exited = false;
  child.once("exit", (_code, sig) => { exited = true; signal = sig; });
  // not stopped: the start runs to the end and listens (then it is ended here)
  for (const deadline = Date.now() + 60_000; !exited && Date.now() < deadline;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!exited) await waitForExit(child, { signal: "SIGTERM" });
  return signal === "SIGKILL";
}

posixOnly("a start stopped anywhere while it publishes or puts back the chats (Astra 3029be67c8 High, real stops)", () => {
  // the earlier copy of the chats was made without a log; a start publishes new chats and their log over it and is stopped before the
  // marker names them kept; the next start (the live chats no longer fit) puts the earlier chats back and is stopped at EVERY step it
  // takes in the rescue folder in turn; a last start runs to the end. The folder must then hold the earlier chats alone: never the
  // earlier messages.db beside the new log, never a lost copy.
  it("W-RESCUE-DOUBLE-CUT: for every stop point of the putting back, the folder ends with the earlier chats and no new log", async () => {
    const outcomes: string[] = [];
    // the putting back takes at most 5 steps in the folder (new files out, earlier files back, journal, scratch); 8 covers every one of
    // them and the first steps of the copy after it
    for (let at = 1; at <= 8; at++) {
      const { parent, data } = dataFolder();
      const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
      mkdirSync(folder); copyFileSync(join(data, "messages.db"), join(folder, "messages.db"));
      const earlier = sha(join(folder, "messages.db"));
      tearTable(data, "memory_records");
      writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: [], state: "copying" }) + "\n");
      const log = join(parent, "cut.log");
      // first stop: the new chats and log are published, the marker naming them kept is not (its 2nd write of this start)
      expect(await bootCut(parent, data, "marker:2", log), `publish stop reached (log:\n${existsSync(log) ? readFileSync(log, "utf8") : ""})`).toBe(true);
      expect(existsSync(join(folder, "messages.db-wal")), "the new log was published before the stop").toBe(true);
      // the chats no longer fit (sparse, past the pages its header counts): the putting back is what the next starts do. The log the
      // stopped start left is folded in first: a checkpoint of a whole log cuts the file back to its pages, which would make it fit again
      const live = new DatabaseSync(join(data, "messages.db")); live.exec("PRAGMA wal_checkpoint(TRUNCATE)"); live.close();
      const fs = statfsSync(parent), free = Number(fs.bavail) * Number(fs.bsize);
      truncateSync(join(data, "messages.db"), Math.min(free * 2 + 1024 ** 3, 8 * 1024 ** 4));
      writeFileSync(log, "");
      const stopped = await bootCut(parent, data, `folder:${at}`, log);
      const server = await boot(parent, data);
      await readsChat(server.base, server.desktop);
      await waitForExit(server.child, { signal: "SIGTERM" });
      outcomes.push(`stop at folder step ${at} (${stopped ? "stopped" : "not reached"}): chats ${existsSync(join(folder, "messages.db")) && sha(join(folder, "messages.db")) === earlier ? "earlier" : "NOT earlier"}, log ${existsSync(join(folder, "messages.db-wal")) ? "NEW LOG" : "none"}`);
      rmSync(join(data, "messages.db"), { force: true });
      if (!stopped) break;
    }
    expect(outcomes.filter(line => / NOT earlier|NEW LOG/.test(line)), `W-RESCUE-DOUBLE-CUT:\n${outcomes.join("\n")}`).toEqual([]);
  }, 600_000);

  // a marker left saying complete whose copy is not all there (its own flush failed and so did its putting back; Astra 3826359de9
  // High): the next start checks the copy, makes what is missing, and only then says a copy is kept
  it("W-RESCUE-COMPLETE-CHECKED: a complete marker naming files the folder does not hold -> the next start makes the copy again", async () => {
    const { parent, data } = dataFolder();
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); writeFileSync(join(folder, "config.json"), "{}");
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: ["messages.db", "messages.db-wal", "config.json"], state: "complete" }) + "\n");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    await waitForExit(server.child, { signal: "SIGTERM" });
    const chats = existsSync(join(folder, "messages.db")) ? readFileSync(join(folder, "messages.db")).subarray(0, 15).toString() : "MISSING";
    expect(chats, "W-RESCUE-COMPLETE-CHECKED: the chats copy").toBe("SQLite format 3");
  }, 120_000);

  // a complete copy that lost only the log of the chats (the chats file survives): the next start makes the chats copy again whole and
  // never marks the half pair complete (Astra ccbf425c1d High, open-set-aside.ts:237)
  it("W-RESCUE-WAL-LOST: a complete marker, the chats file there and only its log gone -> the next start copies the chats again", async () => {
    const { parent, data } = dataFolder();
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); writeFileSync(join(folder, "config.json"), "{}");
    writeFileSync(join(folder, "messages.db"), "STALE CHATS COPY WITHOUT ITS LOG");
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: ["messages.db", "messages.db-wal", "config.json"], state: "complete" }) + "\n");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    await waitForExit(server.child, { signal: "SIGTERM" });
    const chats = readFileSync(join(folder, "messages.db")).subarray(0, 15).toString();
    expect(chats, "W-RESCUE-WAL-LOST: the chats copy is made again, not the stale file the marker named").toBe("SQLite format 3");
    const marker = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; kept: string[] };
    expect(marker.state).toBe("complete");
    expect(new Set(marker.kept).size, "no name is kept twice").toBe(marker.kept.length);
  }, 120_000);

  // the completed copy holds the log: a commit that lives only in the chats' -wal is in the rescue folder (Astra 5f9b4611a9 High: the earlier
  // witnesses read the copy's header only, a copy that dropped the log still passed)
  it("W-RESCUE-WAL-CONTENT: a complete marker that lost only the chats' log, a commit only in the live -wal -> the finished rescue holds that commit", async () => {
    const { parent, data } = dataFolder();
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); writeFileSync(join(folder, "config.json"), "{}");
    writeFileSync(join(folder, "messages.db"), "STALE CHATS COPY WITHOUT ITS LOG");
    tearTable(data, "memory_records");
    // a commit that exists only in messages.db-wal at the time of the copy: an open reader that began before the commit keeps every checkpoint
    // (the server's own open included) from moving the frame into the chats file, so only the log holds it
    const reader = new DatabaseSync(join(data, "messages.db"));
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
    const live = new DatabaseSync(join(data, "messages.db"));
    live.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE walonly_probe(v TEXT); INSERT INTO walonly_probe VALUES ('only-in-the-log');");
    expect(statSync(join(data, "messages.db-wal")).size, "the fixture holds the commit in the log").toBeGreaterThan(0);
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: ["messages.db", "messages.db-wal", "config.json"], state: "complete" }) + "\n");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    await waitForExit(server.child, { signal: "SIGTERM" });
    live.close(); reader.exec("ROLLBACK"); reader.close();
    expect(existsSync(join(folder, "messages.db-wal")), "W-RESCUE-WAL-CONTENT: the finished rescue holds the chats' log").toBe(true);
    const probeDir = join(parent, "probe"); mkdirSync(probeDir);
    copyFileSync(join(folder, "messages.db"), join(probeDir, "messages.db")); copyFileSync(join(folder, "messages.db-wal"), join(probeDir, "messages.db-wal"));
    const copy = new DatabaseSync(join(probeDir, "messages.db"));
    try {
      expect((() => { try { return (copy.prepare("SELECT v FROM walonly_probe").get() as { v: string } | undefined)?.v; } catch { return "table missing"; } })(), "W-RESCUE-WAL-CONTENT: the commit that lived only in the log").toBe("only-in-the-log");
    } finally { copy.close(); }
  }, 120_000);

  // the same copy, the start stopped right after it writes its first marker (before it makes any file): the marker must still name the lost
  // log, so the next start does not read the short copy as whole (Astra 403a0734c8 High, open-set-aside.ts:213-230)
  it("W-RESCUE-WAL-LOST-CUT: the start is stopped after its first marker -> the marker still names the lost log and the next start copies the chats again", async () => {
    const { parent, data } = dataFolder();
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); writeFileSync(join(folder, "config.json"), "{}");
    writeFileSync(join(folder, "messages.db"), "STALE CHATS COPY WITHOUT ITS LOG");
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: ["messages.db", "messages.db-wal", "config.json"], state: "complete" }) + "\n");
    const log = join(parent, "cut.log");
    expect(await bootCut(parent, data, "after-marker:1", log), `stop reached (log:\n${existsSync(log) ? readFileSync(log, "utf8") : ""})`).toBe(true);
    const stopped = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; kept: string[] };
    expect(stopped.state).toBe("copying");
    expect(stopped.kept, "W-RESCUE-WAL-LOST-CUT: the marker still names the lost log").toContain("messages.db-wal");
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    await waitForExit(server.child, { signal: "SIGTERM" });
    expect(readFileSync(join(folder, "messages.db")).subarray(0, 15).toString(), "W-RESCUE-WAL-LOST-CUT: the chats copy is made again").toBe("SQLite format 3");
  }, 120_000);

  // a start stopped after the marker names the new chats kept, before the earlier files set aside are removed: the next start keeps
  // the NEW pair (never renames the earlier messages.db back beside the kept new log; Opus self-review bb86046213 High)
  it("W-RESCUE-KEPT-CUT: stopped after the marker names the published chats kept -> the next start keeps the new pair, the earlier goes", async () => {
    const { parent, data } = dataFolder();
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); copyFileSync(join(data, "messages.db"), join(folder, "messages.db"));
    const earlier = sha(join(folder, "messages.db"));
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: [], state: "copying" }) + "\n");
    const log = join(parent, "cut.log");
    expect(await bootCut(parent, data, "after-marker:2", log), `kept stop reached (log:\n${existsSync(log) ? readFileSync(log, "utf8") : ""})`).toBe(true);
    const kept = (JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { kept: string[] }).kept;
    expect(kept).toEqual(expect.arrayContaining(["messages.db", "messages.db-wal"]));
    const published = sha(join(folder, "messages.db"));
    const server = await boot(parent, data);
    await readsChat(server.base, server.desktop);
    await waitForExit(server.child, { signal: "SIGTERM" });
    const chats = existsSync(join(folder, "messages.db")) ? sha(join(folder, "messages.db")) : "missing";
    expect(`${chats === published ? "new" : chats === earlier ? "EARLIER" : chats} chats, log ${existsSync(join(folder, "messages.db-wal")) ? "kept" : "MISSING"}`, "W-RESCUE-KEPT-CUT").toBe("new chats, log kept");
    expect(rescueCopies(parent)).toEqual([basename(folder)]);
  }, 180_000);

  // an earlier copy set aside during a publish: the aside folder's entry is on the disk (made, then the parent flushed) before any earlier
  // file moves into it, and the aside and rescue folders are flushed before a new file takes an earlier one's name (Astra 16f2449f12 High)
  it("W-RESCUE-ASIDE-DURABLE: the aside folder is made and its parent flushed before an earlier file moves in; both flushed before the publish", async () => {
    const { parent, data } = dataFolder();
    const folder = join(parent, "installation-rescue-2026-01-01T00-00-00-000Z");
    mkdirSync(folder); copyFileSync(join(data, "messages.db"), join(folder, "messages.db"));
    tearTable(data, "memory_records");
    writeFileSync(join(data, "memory-rescue.json"), JSON.stringify({ path: folder, at: "2026-01-01T00:00:00.000Z", bytes: 1, attempt: 1, kept: [], state: "copying" }) + "\n");
    const log = join(parent, "cut.log");
    const server = await boot(parent, data, { node: ["--import", CUT_PRELOAD], env: { RESCUE_CUT_LOG: log } });
    await waitForExit(server.child, { signal: "SIGTERM" });
    const steps = readFileSync(log, "utf8").trim().split("\n");
    const name = basename(folder).slice(basename(folder).indexOf("-rescue-"));
    const first = (test: (step: string) => boolean, from = 0) => { const at = steps.slice(from).findIndex(test); return at < 0 ? -1 : at + from; };
    const made = first(step => step === `mkdir ${name}.aside`);
    const moved = first(step => step.startsWith("folder:") && step.includes(` ${name}/messages.db ${name}.aside/messages.db`));
    const published = first(step => step.startsWith("folder:") && step.includes(`${name}.stage/messages.db ${name}/messages.db`));
    const order = {
      made: made >= 0, moved: moved > made, published: published > moved,
      parentFlushedBeforeMove: first(step => step === `fsync-dir ${parent}`, made) > made && first(step => step === `fsync-dir ${parent}`, made) < moved,
      asideFlushedBeforePublish: first(step => step === `fsync ${name}.aside`, moved) > moved && first(step => step === `fsync ${name}.aside`, moved) < published,
      folderFlushedBeforePublish: first(step => step === `fsync ${name}`, moved) > moved && first(step => step === `fsync ${name}`, moved) < published,
    };
    expect(order, `W-RESCUE-ASIDE-DURABLE steps:\n${steps.join("\n")}`).toEqual({ made: true, moved: true, published: true, parentFlushedBeforeMove: true, asideFlushedBeforePublish: true, folderFlushedBeforePublish: true });
  }, 120_000);

  // what a marker names kept is durable first (Astra 3029be67c8 High): every file of the group flushed, then (after its last rename into
  // the folder) the folder itself flushed, before the marker that names the group moves
  it("W-RESCUE-DURABLE: before each marker naming a group kept, its files and the rescue folder were flushed", async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "memory_records");
    // an empty list: a byte copy of it writes no chunk, so only the group's own file flush makes it durable (and a read-only one: a
    // clone keeps the mode, the flush must not need write access)
    writeFileSync(join(data, "empty-list.json"), ""); writeFileSync(join(data, "read-only-list.json"), "[]", { mode: 0o400 });
    const log = join(parent, "cut.log");
    const server = await boot(parent, data, { node: ["--import", CUT_PRELOAD], env: { RESCUE_CUT_LOG: log } });
    await waitForExit(server.child, { signal: "SIGTERM" });
    const steps = readFileSync(log, "utf8").trim().split("\n");
    const marker = JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) as { state: string; path: string };
    expect(marker.state).toBe("complete");
    const folder = marker.path.slice(marker.path.lastIndexOf("-rescue-"));
    const gaps: string[] = [];
    let from = 0, groups = 0;
    steps.forEach((step, index) => {
      if (!/^marker:\d+ /.test(step)) return;
      const window = steps.slice(from, index); from = index + 1;
      // a file published into the folder: renamed in from outside it (its scratch), not back from the earlier files set aside
      const published = window.map((line, at) => ({ line, at, words: line.split(" ") })).filter(({ words }) => words[1] === "renameSync"
        && words[3]!.startsWith(`${folder}/`) && !words[3]!.slice(folder.length + 1).includes("/") && !words[3]!.endsWith(".old")
        && !words[2]!.startsWith(`${folder}.aside/`) && words[2] !== words[3]);
      if (!published.length) return;
      groups++;
      for (const { line } of published) {
        const staged = line.split(" ")[2]!;
        if (staged.endsWith(".old")) continue;
        if (!window.some(other => other === `fsync ${staged}`)) gaps.push(`${staged} not flushed before marker ${step}`);
      }
      const last = published[published.length - 1]!.at;
      if (!window.slice(last + 1).includes(`fsync ${folder}`)) gaps.push(`folder not flushed after its last rename, before marker ${step}`);
    });
    expect(groups, `published groups seen:\n${steps.join("\n")}`).toBeGreaterThan(0);
    expect(gaps, "W-RESCUE-DURABLE").toEqual([]);
  }, 120_000);

  // a flush of the rescue folder that FAILS (EIO from the disk) is never passed over (Astra bb86046213 High): the marker never says
  // complete on renames that may not be on the disk, the owner line claims no copy, and the next start makes the copy
  for (const site of ["folder", "data", "data-complete"]) it(`W-RESCUE-FLUSH-EIO (${site}): the ${site === "folder" ? "rescue folder's" : site === "data" ? "data folder's (marker)" : "data folder's (complete marker)"} flush fails with EIO -> no complete marker, no copy claimed; the next start completes it`, async () => {
    const { parent, data } = dataFolder();
    tearTable(data, "memory_records");
    const failing = await boot(parent, data, { node: ["--import", CUT_PRELOAD], env: { RESCUE_FSYNC_EIO: site } });
    await readsChat(failing.base, failing.desktop);
    const marker = (existsSync(join(data, "memory-rescue.json")) ? JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")) : { state: "none" }) as { state: string };
    const line = (await health(failing.base)).memoryIntegrity?.holdMessage ?? "";
    await waitForExit(failing.child, { signal: "SIGTERM" });
    expect(marker.state, "W-RESCUE-FLUSH-EIO: marker after a failed folder flush").not.toBe("complete");
    expect(line).not.toMatch(/A copy of your chats and settings is kept/);
    const again = await boot(parent, data);
    await readsChat(again.base, again.desktop);
    expect(JSON.parse(readFileSync(join(data, "memory-rescue.json"), "utf8")).state).toBe("complete");
    expect(rescueCopies(parent).filter(name => !/\.(stage|aside)(\.json)?$/.test(name))).toHaveLength(1);
    await waitForExit(again.child, { signal: "SIGTERM" });
  }, 120_000);
});
