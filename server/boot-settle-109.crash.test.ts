// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), row E3: deterministic deaths at named points, the child pattern of boot-settle-108. Each death is a
// spawned child (testing/boot-settle-109-child.ts) that builds a real data directory, prints `REACHED <point>` and exits 9. The next normal start is the real
// server (server/index.ts, a fresh process) on that directory: it settles the class. One more start of the real server changes nothing: the pack's full
// snapshot (every table, the file inventory, every *.json) taken after the first start equals the one taken after the second.
// What is on disk is read by the production readers in a further child, on a COPY of the directory, so the directory itself is opened only by the starts.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { MiB, STRICT, fillTo, healthOk, onStrictMount, sleep, snapshot, startServer, waitExited } from "./testing/strict-fs.ts";
import { VENUE_POST_CARD_POST } from "./venue-post-held.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "testing", "boot-settle-109-child.ts");

/** One run of the child on `data`. */
function child(home: string, data: string, scenario: string) {
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, BOOT_SETTLE_109_CHILD: "1", MURAGE_TEST_ENV_SCRUBBED: "1" };
  for (const key of ["PATH", "SystemRoot", "MURAGE_ENGINE_EXCLUSION_PATH"]) if (process.env[key]) env[key] = process.env[key];
  return spawnSync(process.execPath, [CHILD, scenario], { windowsHide: true, cwd: join(dirname(CHILD), "..", ".."), env, encoding: "utf8", timeout: 90_000 });
}
/** The child dies at `point`. */
function die(home: string, data: string, scenario: string, point: string): void {
  const run = child(home, data, scenario);
  expect(run.stdout, `${scenario}: ${run.stderr}`).toContain(`REACHED ${point}`);
  expect(run.status, `${scenario}: ${run.stderr}`).toBe(9);
}
/** What the production readers (or, for `replay:*`, the card writer) say of the data directory as it is on disk, taken from a copy: the directory is not opened. */
function read<T>(root: string, data: string, scenario: string): T {
  const copyHome = mkdtempSync(join(root, "look-")), copy = join(copyHome, ".murage");
  try {
    cpSync(data, copy, { recursive: true, filter: source => { const stat = lstatSync(source); return stat.isDirectory() || stat.isFile(); } });
    const run = child(copyHome, copy, scenario);
    const line = run.stdout.split("\n").find(text => text.startsWith("STATE "));
    expect(line, `${scenario}: ${run.stdout}\n${run.stderr}`).toBeDefined();
    expect(run.status, `${scenario}: ${run.stderr}`).toBe(0);
    return JSON.parse(line!.slice("STATE ".length)) as T;
  } finally { rmSync(copyHome, { recursive: true, force: true }); }
}
/** A normal start of the real server on `home` (a fresh process), served until it is healthy, `settled()` holds and its start-up work has gone quiet (no
 * commit to the message database and no change to the directory's files for one second), then stopped; what it left, for comparison. */
async function normalStart(home: string, data: string, port: number, settled: () => boolean): Promise<Left> {
  const run = startServer(home, port);
  try {
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    try {
      let seen = "", same = 0;
      for (let i = 0; i < 100 && !(same >= 10 && settled()); i++) {
        let files: string; try { files = sizes(data).sort().join(" "); } catch { files = `changing ${i}`; }
        const now = `${(db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version} ${files}`;
        same = now === seen ? same + 1 : 0; seen = now;
        await sleep(100);
      }
      expect(settled(), `the start completed its required recovery before its snapshot: ${JSON.stringify(db.prepare("SELECT * FROM transcript_index_state ORDER BY name").all())}\n${run.out()}`).toBe(true);
    } finally { db.close(); }
  } finally { run.child.kill("SIGTERM"); }
  expect(await waitExited(run), run.out().slice(-4000)).toBe(true);
  return left(data);
}

/** Every regular file under `dir` with its size (-wal/-shm left out, as the snapshot leaves them out). */
const sizes = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sizes(join(dir, entry.name))
  : entry.isFile() && !/-(wal|shm)$/.test(entry.name) ? [`${join(dir, entry.name)}:${statSync(join(dir, entry.name)).size}`] : []);

// THE SNAPSHOT AND ITS NAMED EXCLUSIONS. The pack's snapshot (strict-fs `snapshot`: every table, the file inventory, every *.json) is compared in full, except
// for what every normal start writes of its own, start after start, on an idle installation. Each exclusion is ONE field of ONE row or file, named here with
// its reason; the rest of that row, table or file is still compared exactly.
type Row = Record<string, unknown>;
const START = "(this start's own)";
const withoutKey = (json: unknown, drop: (value: Row) => void): string => { const value = JSON.parse(String(json)) as Row; drop(value); return JSON.stringify(value); };
const PER_START_ROWS: Record<string, (row: Row) => Row> = {
  // bot_call_settings key='fact_scan_from': the instant this start began, from which it re-reads call facts (bot-calls-schema.ts markFactReplay)
  bot_call_settings: row => row.key === "fact_scan_from" ? { ...row, value: START } : row,
  // memory_open_turns_build id=1, column `boot`: the count of starts (memory open-turns bumpOpenTurnsBoot)
  memory_open_turns_build: row => String(row.id) === "1" ? { ...row, boot: START } : row,
  // memory_scope_bindings id='memory-last-run-version', `at` inside `intent`: the instant of this start (the version stays compared).
  // memory_scope_bindings id='memory-shape-check', mark `memory_scope_bindings.intent` inside `intent`: how far the shape check has read THIS table; the first
  // start writes its own two marker rows after its check, so the next start reads them and moves the mark (once; the other marks stay compared)
  memory_scope_bindings: row => row.id === "memory-last-run-version" ? { ...row, intent: withoutKey(row.intent, value => { delete value.at; }) }
    : row.id === "memory-shape-check" ? { ...row, intent: withoutKey(row.intent, value => { delete (value.marks as Row)["memory_scope_bindings.intent"]; }) } : row,
  // search_intents, the marker row (rowid=0, no thread): each start writes a new marker for the search index, a new seq and a random nonce (message-search-index.ts)
  search_intents: row => String(row.rowid) === "0" && row.thread_key === null ? { ...row, seq: START, nonce: START } : row,
  // speech_clock id=1: the single clock row of the spoken replies, advanced to this start's instant
  speech_clock: row => String(row.id) === "1" ? { ...row, value: START } : row,
  // app_write_revision: read whole here; its counter is compared separately (see `left`)
  app_write_revision: row => row,
};
const HEALTH_LOG = join("health", "server.current.ndjson");
/** Files a start only appends to: the health log gains this start's one line, the outside-run journal this start's one seal line. The earlier bytes are compared. */
const APPENDED = [HEALTH_LOG, "outside-state.jsonl"];
const NO_COUNTS_FILE = "(no counts file)";
type Left = ReturnType<typeof left>;
function left(data: string) {
  const full = snapshot(data);
  const tables = { ...full.tables }, inventory = { ...full.inventory }, json = { ...full.json };
  const rows: Record<string, string[]> = {};
  const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
  try {
    for (const [table, strip] of Object.entries(PER_START_ROWS)) {
      expect(tables[table], `${table} is in the snapshot`).toBeDefined(); delete tables[table];
      const all = db.prepare(`SELECT * FROM ${table} ORDER BY 1`); all.setReadBigInts(true);
      rows[table] = (all.all() as Row[]).map(row => JSON.stringify(strip(row), (_key, value) => typeof value === "bigint" ? `${value}n` : value as unknown));
    }
    rows.transcript_index_state = db.prepare("SELECT * FROM transcript_index_state ORDER BY name").all().map(row => JSON.stringify(row));
  } finally { db.close(); }
  const appended: Record<string, string> = {};
  for (const name of APPENDED) { expect(inventory[name], `${name} is in the snapshot`).toBeDefined(); delete inventory[name]; appended[name] = readFileSync(join(data, name), "utf8"); }
  // messages.db: its size is its page count, which a start's own writes above can grow; its content is compared table by table
  expect(inventory["messages.db"]).toBeDefined(); delete inventory["messages.db"];
  // bots.json: `turnStateBase`, a random id each start's roster checkpoint draws (store.ts); every other field of every bot is compared
  expect(json["bots.json"]).toBeDefined(); delete json["bots.json"];
  const bots = (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as Row[]).map(({ turnStateBase: _base, ...bot }) => bot);
  // sentinel-delivery.json: compared whole, by its hash in `json` (a start with nothing to settle does not write it: sentinel/delivery.ts start)
  expect(json["sentinel-delivery.json"]).toBeDefined();
  // app_write_revision id=1, column `n`: the count of transcript writes. It is NOT left out: it is compared against the number of writes the start is
  // known to make (expectUnchanged). memory-upgrade-counts.json: its `key` is "<epoch>:<n>" of that same row; its counts are compared
  // The file exists only when a start had upgrade work left over (database.ts startBackgroundUpgrade: an ordinary start runs no counts thread; since
  // the train files turn_first as done on an empty file, a first start is ordinary too). Absent: its absence is compared (`upgradeCounts: null`, and a
  // start that creates it then also changes `json`). Present: compared exactly as before.
  const hasCounts = existsSync(join(data, "memory-upgrade-counts.json"));
  expect(json["memory-upgrade-counts.json"] !== undefined).toBe(hasCounts); delete json["memory-upgrade-counts.json"];
  const { key: upgradeKey, ...upgradeCounts } = hasCounts ? JSON.parse(readFileSync(join(data, "memory-upgrade-counts.json"), "utf8")) as Row : { key: NO_COUNTS_FILE };
  const revision = rows.app_write_revision!.map(row => JSON.parse(row) as { id: string; n: string });
  rows.app_write_revision = rows.app_write_revision!.map(row => JSON.stringify({ ...(JSON.parse(row) as Row), n: "(compared by expectUnchanged)" }));
  expect(revision.map(row => row.id)).toEqual(["1n"]);
  return { same: { tables, rows, inventory, json, bots, upgradeCounts: hasCounts ? upgradeCounts : null }, appended, writes: Number(revision[0]!.n.slice(0, -1)), upgradeKey: String(upgradeKey) };
}
/** One more start changed nothing: the full snapshot is equal, and the append-only files hold what they held plus this start's own line.
 * `rewrites`: the transcript writes this start makes that leave every row as it was. None, except in the card worlds: every start hands each changed
 * file-watch run to the card writer again (server/index.ts, after projects.linkLegacyRuns), which patches the existing card with the same content: the
 * `messages` table is equal, the write counter is exactly one higher. */
function expectUnchanged(again: Left, settled: Left, rewrites: 0 | 1 = 0): void {
  expect(again.same, "one more start changes nothing").toEqual(settled.same);
  expect(again.writes, "the transcript write counter").toBe(settled.writes + rewrites);
  expect(again.upgradeKey).toBe(settled.upgradeKey === NO_COUNTS_FILE ? NO_COUNTS_FILE : settled.upgradeKey.replace(/:\d+$/, `:${settled.writes + rewrites}`));
  for (const name of APPENDED) {
    expect(again.appended[name]!.startsWith(settled.appended[name]!), `${name}: the earlier lines are untouched`).toBe(true);
    expect(again.appended[name]!.slice(settled.appended[name]!.length).trim().split("\n"), `${name}: one line for the one start`).toHaveLength(1);
  }
}
/** One number read from the message database while a server has it open (a separate read-only connection): only to wait for the start's own recovery.
 * `idle`: the start has also finished building its skill index (a derived file it builds in the background; stopped mid-build it leaves a temp file). */
function count(data: string, sql: string): number {
  const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
  try { return Number((db.prepare(sql).get() as { n: number }).n); } finally { db.close(); }
}
const idle = (data: string) => existsSync(join(data, "skill-index.db"));
const cardWritten = (data: string) => () => idle(data) && count(data, "SELECT count(*) AS n FROM messages WHERE kind='routine.run'") > 0;
const postMoved = (data: string) => () => idle(data) && count(data, "SELECT count(*) AS n FROM venue_posts WHERE state='posted'") > 0;
function world(root: string) {
  const home = join(root, "home"), data = join(home, ".murage"); mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
  return { home, data };
}
interface CardState { unread: boolean; cards: Array<{ id?: string; runId?: string; status?: string }> }
interface VenueState { state: string | null; answered: string | null }

describe("E3 deterministic deaths at named points", () => {
  for (const kind of ["group", "task"] as const) {
    it(`card:after-unread (${kind}): the unread survived, the card did not; the next normal start writes the card; one more start changes nothing`, { timeout: 120_000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), "boot-settle-109-")); const { home, data } = world(root);
      try {
        die(home, data, `card:after-unread:${kind}`, "card:after-unread");
        const died = read<CardState>(root, data, `inspect:card:${kind}`);
        expect(died.unread, "the unread mark was written before the death").toBe(true);
        expect(died.cards, "the card was not written").toEqual([]);

        const port = await freePortBlock([0, 1], 19_971, 200);
        const settled = await normalStart(home, data, port, cardWritten(data));
        const after = read<CardState>(root, data, `inspect:card:${kind}`);
        expect(after.cards, "the next normal start wrote the run's one card").toHaveLength(1);
        expect(after.cards[0]!.status).toBe("completed");
        expect(after.unread, "the unread mark is still there").toBe(true);

        expectUnchanged(await normalStart(home, data, port, cardWritten(data)), settled, 1);
        expect(read<CardState>(root, data, `inspect:card:${kind}`)).toEqual(after);
        // the run handed to the card writer once more: an existing card is patched, never added or announced again
        expect(read<{ run: boolean; cards: number; unread: boolean; notified: number }>(root, data, `replay:card:${kind}`)).toEqual({ run: true, cards: 1, unread: true, notified: 0 });
      } finally { removeTempDirSync(root); }
    });
  }

  it("venue:after-move: the death inside the transaction rolls the move back; the next normal start settles row and card; one more start changes nothing", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "boot-settle-109-")); const { home, data } = world(root);
    try {
      die(home, data, "venue:after-move", "venue:after-move");
      const died = read<VenueState>(root, data, "inspect:venue");
      expect(died.state, "the move died with its transaction").toBe("posting");
      expect(died.answered, "the card was not settled").toBeNull();

      const port = await freePortBlock([0, 1], 19_971, 200);
      const settled = await normalStart(home, data, port, postMoved(data));
      const after = read<VenueState>(root, data, "inspect:venue");
      expect(after.state, "the next normal start moved the row").toBe("posted");
      expect(after.answered, "the next normal start settled the card").toBe(VENUE_POST_CARD_POST);

      expectUnchanged(await normalStart(home, data, port, postMoved(data)), settled);
      expect(read<VenueState>(root, data, "inspect:venue")).toEqual(after);
    } finally { removeTempDirSync(root); }
  });

  it("upgrade:first-start (MAIN 2026-11-17 Q6): a first start with upgrade work left writes the counts file; one more start changes nothing, the file compared exactly", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "boot-settle-109-")); const { home, data } = world(root);
    try {
      const fixture = child(home, data, "readonly:fixture");
      expect(fixture.stdout, fixture.stderr).toContain("FIXTURE");
      // upgrade work left over: one walker structure is not yet filled for the history on disk (message-walker.ts WALKED)
      const db = new DatabaseSync(join(data, "messages.db"));
      try { db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('browser_check', 0, 0, 0)").run(); } finally { db.close(); }
      expect(existsSync(join(data, "memory-upgrade-counts.json")), "no counts file before the first start").toBe(false);
      const walked = () => idle(data) && count(data, "SELECT count(*) AS n FROM transcript_index_state WHERE name='browser_check' AND done=1") > 0
        && count(data, "SELECT count(*) AS n FROM transcript_index_state WHERE done=0") === 0
        && existsSync(join(data, "memory-upgrade-counts.json")) && postMoved(data)();
      const port = await freePortBlock([0, 1], 19_971, 200);
      const settled = await normalStart(home, data, port, walked);
      expect(settled.same.upgradeCounts, "the first start with upgrade work wrote the counts file").not.toBeNull();
      expect(settled.upgradeKey).toMatch(/^.+:\d+$/);
      expectUnchanged(await normalStart(home, data, port, walked), settled);
    } finally { removeTempDirSync(root); }
  });

  it.skipIf(!onStrictMount)("readonly:after-listen: a read-only server killed after it listens left the post alone; the next normal start settles it; one more start changes nothing", { timeout: 300_000 }, async () => {
    const root = join(STRICT, "e3-ro"); rmSync(root, { recursive: true, force: true });
    const { home, data } = world(root);
    try {
      const fixture = child(home, data, "readonly:fixture");
      expect(fixture.stdout, fixture.stderr).toContain("FIXTURE");
      expect(read<VenueState>(root, data, "inspect:venue")).toEqual({ state: "posting", answered: null });
      const port = await freePortBlock([0, 1], 19_951, 200);
      // 100 MiB free: below the start floor (128 MiB), above the worker's floor: only the start check makes it read-only
      fillTo(join(root, "ballast"), 100 * MiB);
      const before = snapshot(data);                         // MAIN 2026-11-17 Q2: the whole read-only snapshot, every file's bytes, no exclusion
      const readOnly = startServer(home, port);
      try {
        expect(await healthOk(port, readOnly), readOnly.out().slice(-4000)).toBe(true);
        expect(((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { diskLow?: { mode?: string } }).diskLow?.mode).toBe("read-only");
        process.stdout.write("REACHED readonly:after-listen\n");
      } finally { readOnly.child.kill("SIGKILL"); }
      expect(await waitExited(readOnly)).toBe(true);
      expect(snapshot(data), "the read-only start changed no byte of the data dir").toEqual(before);
      rmSync(join(root, "ballast"), { force: true });
      expect(read<VenueState>(root, data, "inspect:venue"), "a read-only start never ran the venue recovery").toEqual({ state: "posting", answered: null });

      const settled = await normalStart(home, data, port, postMoved(data));
      const after = read<VenueState>(root, data, "inspect:venue");
      expect(after.state, "the next normal start moved the row").toBe("posted");
      expect(after.answered, "the next normal start settled the card").toBe(VENUE_POST_CARD_POST);

      expectUnchanged(await normalStart(home, data, port, postMoved(data)), settled);
      expect(read<VenueState>(root, data, "inspect:venue")).toEqual(after);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
