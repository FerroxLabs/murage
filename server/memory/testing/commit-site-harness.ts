// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W, W-COMMIT run-time half: one test per transaction-ending call site of commit-sites.txt, driven through the site's own
// production entry point on the real main connection (database()). The bus's observer is told by the connection (isTransaction before and
// after each call), so what can differ between sites is whether the site's own end statement is the call that reports the end: the commit
// tap (setWakeCommitTapForTest) runs on the committing stack and the witness reads that stack, so each report is attributed to the
// `file:line` that made it. Per committing site the witness asserts, through the real entry:
//   - the observer reports an end from exactly that file:line exactly `times` times (once per commit of that site);
//   - the wake marked by the transaction's write runs its subscriber exactly once, off the committing stack, with no timer of the bus;
//   - when every table the transaction writes refuses the write (the mark trigger's body raises ABORT right after marking), the same
//     entry rolls back: the ROLLBACK reports with the wake marked, no end is reported from the committing line, the subscriber never
//     runs, and no transaction is left open.
// The marking is the bus's own form: a TEMP AFTER trigger on every main table (present when the driver's setup is done) inserts the
// TEMP wake row and calls the mark function the installer registers, so a site that writes only its own table still owes a wake.
// A site on a connection other than the main handle (a worker thread, an attached snapshot, an index file) is driven too, with `conn:
// "own"`: its proof is that it ran through its real entry and reported nothing to the main observer; the wake it would owe is classified by
// W-WRITERS (wake-writers.test.ts: no worker write set holds a wake table).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase, database } from "../../database.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { onWake, resetWakeForTest, setWakeCommitTapForTest, wakeInstalled, wakeStats } from "../wake.ts";

/** One site of commit-sites.txt (the static list, checked against the parser by wake-commit-sites.test.ts). Read from the list, not from the
 *  source, so a mutant of a site's own line still finds the site it targets. */
interface ListedSite { file: string; line: number; col: number; fn: string; k: number; kind: string }
const LISTED: ListedSite[] = readFileSync(join(import.meta.dirname, "commit-sites.txt"), "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => {
  const match = /^(\S+):(\d+):(\d+) (\S+)#(\d+) (\w+)$/.exec(line);
  if (!match) throw new Error(`commit-sites.txt: unreadable line ${line}`);
  return { file: match[1]!, line: Number(match[2]), col: Number(match[3]), fn: match[4]!, k: Number(match[5]), kind: match[6]! };
});
const listedId = (site: ListedSite) => `${site.file} ${site.fn}#${site.k}`;

export const SERVER_DIR = join(import.meta.dirname, "..", "..");
type Db = DatabaseSync;
export interface MainDriver {
  conn: "main";
  /** Bring the database to the state the entry needs (old schema, pending rows, ...); runs before the marks are installed. */
  setup?: (db: Db) => unknown | Promise<unknown>;
  /** Call the production entry point so that the site commits. */
  commit: (db: Db) => unknown | Promise<unknown>;
  /** Commits of this site per commit() call (default 1). */
  times?: number;
  /** Set (with the reason) when the site's transaction writes no table present at setup time (DDL only), so no wake is marked. */
  noMark?: string;
  /** The rollback drive (default: commit() again with every write refused), or the reason it has none. */
  rollback?: ((db: Db) => unknown | Promise<unknown>) | string;
  /** The site id of the ROLLBACK that undoes this transaction when it is not in the same file (a shared helper's, io-budget's own). */
  rollbackSite?: string;
  /** Leave the timers real (the entry awaits a real timer); the bus's own timer count is still asserted. */
  realTimers?: boolean;
}
export interface OwnDriver {
  conn: "own";
  /** Which connection, and why it is not the main handle. */
  why: string;
  setup?: (db: Db) => unknown | Promise<unknown>;
  /** Drive the production entry; return evidence that the site's transaction committed (a row, a file, a count), asserted truthy. */
  run: (db: Db) => unknown | Promise<unknown>;
}
export interface NestedDriver {
  conn: "nested";
  /** Why this RELEASE only ever runs inside a transaction that is already open (so it ends none and owes no notice of its own). */
  why: string;
  setup?: (db: Db) => unknown | Promise<unknown>;
  /** Call the production entry so that the site's RELEASE runs; `outer` opens the enclosing transaction first (the caller's). */
  commit: (db: Db) => unknown;
  outer?: boolean;
}
export type SiteDriver = MainDriver | OwnDriver | NestedDriver;

/** The committing stack, deep enough to reach the site under any wrapper. */
const stackNow = () => { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 64; try { return new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; } };
const turns = async (count = 8) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
/** Every ordinary main table: no virtual table, and no shadow table of one (SQLite refuses a trigger on those). */
const userTables = (db: Db) => {
  const rows = db.prepare("SELECT name, sql FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string | null }[];
  const virtual = rows.filter(row => /^CREATE VIRTUAL/i.test(row.sql ?? "")).map(row => `${row.name}_`);
  return rows.filter(row => !/^CREATE VIRTUAL/i.test(row.sql ?? "") && !virtual.some(prefix => row.name.startsWith(prefix))).map(row => row.name);
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** True only while the driver's entry runs: the background work database() starts (upgrade steps, reconcilers) commits on the same handle
 *  in its own turns, and those commits must not mark the witness's wake. */
let driving = false;
function installTriggers(db: Db, form: "mark" | "refuse"): number {
  db.function("w_site_driving", () => (driving ? 1 : 0));
  const tables = userTables(db);
  tables.forEach((table, i) => {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      // "refuse": the same mark, then the refusal, in one body (SQLite does not order two TEMP triggers of a table by creation)
      const body = "INSERT INTO mem_wake(topic) SELECT 'site' WHERE w_site_driving() AND NOT EXISTS(SELECT 1 FROM mem_wake WHERE topic='site'); SELECT murage_wake_mark() WHERE w_site_driving();"
        + (form === "refuse" ? " SELECT RAISE(ABORT,'w-site-refused') WHERE w_site_driving();" : "");
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS w_site_${form}_${i}_${event.toLowerCase()} AFTER ${event} ON main.${quote(table)} BEGIN ${body} END`);
    }
  });
  return tables.length;
}
/** How many recorded stacks hold a frame at server/<file>:<line>:<column> (the column tells a COMMIT from a ROLLBACK on the same line). */
const at = (stacks: string[], { file, line, col }: { file: string; line: number; col: number }) => {
  const frame = new RegExp(`[/\\\\]server[/\\\\]${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "[/\\\\]")}:${line}:${col}\\b`);
  return stacks.filter(stack => frame.test(stack)).length;
};

/** Register one test per driver. `drivers` keys are site ids (`file fn#k`, commit-site-scan.ts). */
export function siteSuite(title: string, drivers: Record<string, SiteDriver>): void {
  const sitesOf = (file: string) => LISTED.filter(site => site.file === file);
  const locate = (id: string): ListedSite => {
    const site = LISTED.find(candidate => listedId(candidate) === id);
    if (!site) throw new Error(`no such site in commit-sites.txt: ${id}`);
    return site;
  };
  describe(title, () => {
    beforeEach(() => { resetWakeForTest(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
    afterEach(() => { setWakeCommitTapForTest(null); vi.useRealTimers(); closeDatabase(); resetWakeForTest(); });
    for (const [id, driver] of Object.entries(drivers)) {
      it(id, async () => {
        const site = locate(id);
        const label = `${site.file}:${site.line}:${site.col} ${site.fn}#${site.k}`;
        const db = database();
        expect(wakeInstalled(db)).toBe(true);
        await driver.setup?.(db);
        await turns();
        const stacks: string[] = [];
        if (driver.conn === "own") {
          setWakeCommitTapForTest(() => { stacks.push(stackNow()); });
          const evidence = await driver.run(db);
          await turns();
          expect({ label, evidence: Boolean(evidence), fromMain: at(stacks, site) }).toEqual({ label, evidence: true, fromMain: 0 });
          return;
        }
        expect(site.kind).not.toBe("rollback");
        if (driver.conn === "nested") {
          // the RELEASE ran from this line:column with the transaction still open, reported nothing, and the enclosing COMMIT (the entry's
          // own, or the caller's when `outer`) delivered the wake once
          installTriggers(db, "mark");
          await turns();
          const runs: string[] = [];
          onWake("site", () => { runs.push("site"); });
          const releases: { stack: string; open: boolean }[] = [];
          const exec = db.exec;
          db.exec = (sql: string) => { const stack = stackNow(); exec.call(db, sql); if (/^\s*RELEASE\b/i.test(sql)) releases.push({ stack, open: db.isTransaction }); };
          setWakeCommitTapForTest(() => { stacks.push(stackNow()); });
          driving = true;
          try {
            if (driver.outer) exec.call(db, "BEGIN IMMEDIATE");
            driver.commit(db);
            expect({ label, reportsFromSite: at(stacks, site), ran: releases.filter(release => at([release.stack], site) > 0).map(release => release.open) }).toEqual({ label, reportsFromSite: 0, ran: [true] });
            if (driver.outer) exec.call(db, "COMMIT");
          } finally { driving = false; db.exec = exec; }
          await turns();
          expect({ label, open: db.isTransaction, ended: stacks.length > 0, runs: [...runs] }).toEqual({ label, open: false, ended: true, runs: ["site"] });
          return;
        }
        expect(installTriggers(db, "mark")).toBeGreaterThan(0); // a noMark site is held to it: it must mark nothing
        await turns();
        const runs: string[] = [];
        onWake("site", () => { runs.push("site"); });
        if (!driver.realTimers) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        const arms = wakeStats().timerArms;
        let inline = -1;
        setWakeCommitTapForTest(() => { stacks.push(stackNow()); });
        driving = true;
        try {
          const result = driver.commit(db);
          if (!(result instanceof Promise)) inline = runs.length; else await result;
        } finally { driving = false; }
        await turns();
        const times = driver.times ?? 1;
        if (process.env.W_SITE_DEBUG) console.log(`W_SITE_DEBUG ${label}\n${stacks.join("\n----\n")}`);
        // THE SITE ASSERTION: the observer reported an end from this very call site, once per commit
        expect({ label, reportsFromSite: at(stacks, site), open: db.isTransaction }).toEqual({ label, reportsFromSite: times, open: false });
        if (inline !== -1) expect({ label, inline }).toEqual({ label, inline: 0 }); // never on the committing stack
        expect({ label, runs: [...runs] }).toEqual({ label, runs: driver.noMark ? [] : ["site"] });
        expect({ label, timerArmed: wakeStats().timerArmed, arms: wakeStats().timerArms }).toEqual({ label, timerArmed: false, arms });
        // the rollback half: the same entry, on a fresh database brought to the same state, with every write refused
        if (typeof driver.rollback === "string" || driver.noMark) return;
        setWakeCommitTapForTest(null); vi.useRealTimers();
        closeDatabase(); resetWakeForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
        const again = database();
        expect(wakeInstalled(again)).toBe(true);
        await driver.setup?.(again);
        await turns();
        // each write marks the wake (the bus's mark flag set, the wake row written) and is then refused in the same trigger body, so the
        // statement is undone after the wake was really marked: the transaction rolls back with a marked wake that must deliver nothing
        installTriggers(again, "refuse");
        await turns();
        runs.length = 0; stacks.length = 0;
        onWake("site", () => { runs.push("site"); });
        const markedAt: string[] = [];
        setWakeCommitTapForTest(marked => { const stack = stackNow(); stacks.push(stack); if (marked) markedAt.push(stack); });
        let refused: unknown = null;
        driving = true;
        try { await (driver.rollback ?? driver.commit)(again); } catch (error) { refused = error; } finally { driving = false; }
        await turns();
        setWakeCommitTapForTest(null);
        // the transaction began and was undone by a ROLLBACK of this file (or the named one), reported on the main handle
        const undo = driver.rollbackSite ? [locate(driver.rollbackSite)] : sitesOf(site.file).filter(other => other.kind === "rollback");
        const rolledBack = undo.reduce((n, other) => n + at(stacks, other), 0);
        const markedThenUndone = undo.reduce((n, other) => n + at(markedAt, other), 0);
        if (process.env.W_SITE_DEBUG) console.log(`W_SITE_DEBUG rollback ${label} refused=${String(refused)} marked=${markedAt.length}\n${stacks.map(stack => stack.split("\n").slice(3, 8).join("\n")).join("\n----\n")}`);
        expect({ label, reportsFromSite: at(stacks, site), runs: [...runs], open: again.isTransaction, rolledBack: rolledBack > 0, markedThenUndone: markedThenUndone > 0, refused: refused === null ? null : String(refused).includes("w-site-refused") || "other" })
          .toEqual({ label, reportsFromSite: 0, runs: [], open: false, rolledBack: true, markedThenUndone: true, refused: refused === null ? null : true });
      });
    }
  });
}
