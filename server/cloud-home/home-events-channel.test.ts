// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// J5b r7 RED corpus, node side (DESIGN-J5b-r7.md sections 1, 4, 5, 8): T4b T5 T7 T9 T10 T11 T12 T13 T14 T14c T15 T16, MurageMain r7 rulings 7 and 8 (T17, T18),
// plus the shared record-fixture guard (G-VEC).
// Every test runs a REAL child node process (testdata/j5b-home-child.mjs) that loads server/home-events.ts with node:fs wrapped (call recorder, faults,
// a barrier after the first outbox fsync), and plays the part of murage-control itself: it reads the child's /api/health fields, "journals" what it
// took, and writes the ACK file. At base the child falls back to the base calls (spoolHomeEvent, eventSpoolFailures), so each test fails on the missing
// behavior (no homeEvents field, no outbox, onAbort time = Date.now()) and never on a missing export.
// Seams the builders must provide (design is silent, see PREP-REDS.md): env MURAGE_HOME_EVENTS_OUTBOX, MURAGE_HOME_EVENTS_ACK_FILE,
// MURAGE_HOME_EVENTS_ACK_UID (test only); reportHomeEvent, noteRestoreAborted(job), noteRestoreStuck(dir, marker, stuck), homeEventsHealthFields(env),
// loadHomeEventsOutbox(), drainHomeEvents(ms). The channel caps follow r7 (31 restore or stuck items plus 1 failure slot, 32 served, 512 ACK ids in total).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CAPS = { restoreItems: 31, failureSlot: 1, servedItems: 32, tombstonesPerType: 128 }; // r7 values; nothing below hard-codes them elsewhere
const HOME_EVENTS_TS = fileURLToPath(new URL("../home-events.ts", import.meta.url));
const CHILD = fileURLToPath(new URL("./testdata/j5b-home-child.mjs", import.meta.url));
const RECORDS = fileURLToPath(new URL("./testdata/j5b-records/", import.meta.url));
const DEPLOY_RECORDS = fileURLToPath(new URL("../../deploy/cloud-home/testdata/j5b-records/", import.meta.url));
const HEALTH = fileURLToPath(new URL("../../testdata/j5b-health/", import.meta.url));
const ACKS = fileURLToPath(new URL("../../testdata/j5b-ack/", import.meta.url));
const INDEX_TS = fileURLToPath(new URL("../index.ts", import.meta.url));
const BASE_AT = 1_800_000_000_000;
const FAILURE = "home.event_spool_failed";
const id16 = (type: string, key: string) => createHash("sha256").update(`${type}\0${key}`).digest("hex").slice(0, 16);

type Item = { id: string; type: string; at: number };
type Body = { homeEvents?: { v: number; items: Item[]; outboxDegraded: number }; eventSpoolFailures?: number };

class Child {
  private proc: ChildProcessWithoutNullStreams;
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  constructor(readonly dir: string, extraEnv: Record<string, string> = {}) {
    mkdirSync(join(dir, "ctl"), { recursive: true });
    mkdirSync(join(dir, "events"), { recursive: true });
    this.proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CHILD], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VITEST: "1", NODE_ENV: "test", MURAGE_TRUSTED_PROXY: "1",
        J5B_CTL: join(dir, "ctl"), J5B_HOME_EVENTS_TS: HOME_EVENTS_TS, J5B_STUCK_MARKER: join(dir, "restore-stuck-at"),
        MURAGE_HOME_EVENTS_DIR: join(dir, "events"), MURAGE_HOME_EVENTS_OUTBOX: join(dir, "home-events.outbox"),
        MURAGE_HOME_EVENTS_ACK_FILE: join(dir, "ack.json"), MURAGE_HOME_EVENTS_ACK_UID: String(process.getuid?.() ?? 0), ...extraEnv,
      },
    });
    this.proc.stdout.setEncoding("utf8");
    let buffer = "";
    this.proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const w = this.waiters.shift(); if (w) w(line); else this.lines.push(line); }
    });
    this.proc.stderr.on("data", () => undefined);
  }
  private next(): Promise<string> { return new Promise(resolve => { const line = this.lines.shift(); if (line !== undefined) resolve(line); else this.waiters.push(resolve); }); }
  async ready() { const r = JSON.parse(await this.next()); if (!r.ready) throw new Error("child not ready"); return this; }
  async send(command: Record<string, unknown>) { this.proc.stdin.write(JSON.stringify(command) + "\n"); return JSON.parse(await this.next()); }
  async health(): Promise<Body> { return (await this.send({ cmd: "health" })).body; }
  kill() { this.proc.kill("SIGKILL"); }
  fault(name: string, content = "") { writeFileSync(join(this.dir, "ctl", name), content); }
  clear(name: string) { rmSync(join(this.dir, "ctl", name), { force: true }); }
}

let dir = "";
const children: Child[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "j5b-channel-")); });
afterEach(() => { for (const c of children.splice(0)) c.kill(); rmSync(dir, { recursive: true, force: true }); });
const boot = async (extraEnv: Record<string, string> = {}) => { const c = new Child(dir, extraEnv); children.push(c); await c.ready(); await c.send({ cmd: "load" }); return c; };
const ackFile = () => join(dir, "ack.json");
const writeAck = (value: unknown) => writeFileSync(ackFile(), typeof value === "string" ? value : JSON.stringify(value));
const advertise = () => writeAck(JSON.parse(readFileSync(join(HEALTH, "ack-with-control.json"), "utf8")));
const items = async (c: Child) => (await c.health()).homeEvents?.items ?? [];
const waitFor = async (predicate: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await new Promise(r => setTimeout(r, 25)); } return predicate(); };
const crcHex = (raw: Buffer) => (crc32(raw) >>> 0).toString(16).padStart(8, "0");
/** The valid prefix of a record file, as the shared fixtures define it: [ops lists, byte length, clean]. */
function readRecords(path: string): [Array<Array<Record<string, unknown>>>, number, boolean] {
  if (!existsSync(path)) return [[], 0, true];
  const data = readFileSync(path);
  const records: Array<Array<Record<string, unknown>>> = [];
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(0x0a, offset);
    if (end < 0) return [records, offset, false];
    const line = data.subarray(offset, end), space = line.indexOf(0x20);
    if (space < 0 || line.subarray(0, space).toString() !== crcHex(line.subarray(space + 1))) return [records, offset, false];
    try { records.push(JSON.parse(line.subarray(space + 1).toString()).ops); } catch { return [records, offset, false]; }
    offset = end + 1;
  }
  return [records, offset, true];
}

// Keep the same tombstones and live ids, but create the live adds in this process.
// A reloaded live add now waits for receipt reconciliation before any later append.
async function bootCompactionFixture() {
  const records = readRecords(join(RECORDS, "compaction-input.txt"))[0];
  const live = records.flat().filter(op => op.r === "add");
  const groups = records.map(rec => rec.filter(op => op.r !== "add")).filter(rec => rec.length);
  while (groups.length > 256 - live.length) groups[groups.length - 2].push(...groups.pop()!);
  const encoded = groups.map(ops => { const raw = Buffer.from(JSON.stringify({ v: 1, ops })); return crcHex(raw) + " " + raw.toString() + "\n"; }).join("");
  writeFileSync(join(dir, "home-events.outbox"), encoded);
  const c = await boot();
  advertise();
  for (const op of live) await c.send({ cmd: "report", type: op.type, at: op.at, id: op.id });
  expect((await items(c)).map(i => i.id).sort()).toEqual(live.map(op => op.id).sort());
  expect(readRecords(join(dir, "home-events.outbox"))[0].length).toBe(256);
  return c;
}

describe("G-VEC the shared record vectors", () => {
  // GUARD (passes at base by design): both languages read the same CRC32 line vectors the same way, `done` tombstone vectors included.
  it("reads every fixture to the valid prefix its manifest states, and the two copies are identical", () => {
    const manifest = JSON.parse(readFileSync(join(RECORDS, "manifest.json"), "utf8")) as Record<string, { valid_prefix_lines: number; valid_prefix_bytes: number; clean: boolean }>;
    expect(readFileSync(join(RECORDS, "manifest.json"))).toEqual(readFileSync(join(DEPLOY_RECORDS, "manifest.json")));
    for (const [name, expected] of Object.entries(manifest)) {
      const [records, size, clean] = readRecords(join(RECORDS, name));
      expect([name, records.length, size, clean]).toEqual([name, expected.valid_prefix_lines, expected.valid_prefix_bytes, expected.clean]);
      expect(readFileSync(join(RECORDS, name))).toEqual(readFileSync(join(DEPLOY_RECORDS, name)));
    }
    for (const name of ["compaction-input.txt", "compaction.json"]) expect(readFileSync(join(RECORDS, name))).toEqual(readFileSync(join(DEPLOY_RECORDS, name)));
    const done = readRecords(join(RECORDS, "valid-done.txt"))[0].flat().find(op => op.r === "done");
    expect(done, "a done op carries id, type and at (it is the tombstone)").toMatchObject({ type: "restore.aborted", at: BASE_AT + 1 });
  });
  it("the ACK fixtures stay within the channel bound and use 16 hex ids", () => {
    const manifest = JSON.parse(readFileSync(join(ACKS, "manifest.json"), "utf8")) as Record<string, { valid?: boolean; bytes?: number }>;
    for (const [name, expected] of Object.entries(manifest)) {
      if (expected.bytes !== undefined) expect(readFileSync(join(ACKS, name)).length, name).toBe(expected.bytes);
      if (expected.bytes !== undefined) expect(expected.bytes, name).toBeLessThanOrEqual(16384);
    }
    const max = JSON.parse(readFileSync(join(ACKS, "max.json"), "utf8")) as { acked: string[]; accepted: string[] };
    const ids = [...max.acked, ...max.accepted];
    expect(ids.length).toBe(512);
    expect(new Set(ids).size).toBe(512);
    expect(ids.every(id => /^[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(JSON.parse(readFileSync(join(ACKS, "offered-ids.json"), "utf8")).length).toBe(32);
  });
});

describe("T9 extended only when advertised", () => {
  it("holds three items across two restarts, a dismissal and a new restore without an advertisement, then serves each once", async () => {
    let c = await boot();
    for (const n of [1, 2, 3]) await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + n, id: id16("restore.aborted", `job-${n}`) });
    let body = await c.health();
    expect(body.homeEvents, "no ACK file: legacy mode, no homeEvents field").toBeUndefined();
    expect(typeof body.eventSpoolFailures).toBe("number");
    for (let restart = 0; restart < 2; restart++) { c.kill(); c = await boot(); expect((await c.health()).homeEvents).toBeUndefined(); }
    await c.send({ cmd: "stuck", stuck: false }); // a dismissal: the restore verdict clears, the held items stay
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 4, id: id16("restore.aborted", "job-4") });
    writeAck(readFileSync(join(HEALTH, "ack-without-control.json"), "utf8"));
    expect((await c.health()).homeEvents, "an ACK file without control is not an advertisement").toBeUndefined();
    advertise();
    body = await c.health();
    const recovered = body.homeEvents?.items ?? [];
    expect(recovered.map(i => i.at)).toEqual([1, 2, 3].map(n => BASE_AT + n));
    writeAck({ v: 1, control: 1, acked: recovered.map(i => i.id), accepted: [] });
    body = await c.health();
    const served = [...recovered, ...(body.homeEvents?.items ?? [])];
    expect(served.map(i => i.at), "at base, with the advertisement present, no homeEvents is served").toEqual([1, 2, 3, 4].map(n => BASE_AT + n));
    expect(new Set(served.map(i => i.id)).size).toBe(4);
    expect(body.homeEvents?.v).toBe(1);
  });
});

describe("T10 outbox EROFS", () => {
  it("serves a degraded item and removes it only on accepted or acked", async () => {
    const c = await boot();
    advertise();
    c.fault("outbox-erofs");
    const idA = id16("restore.aborted", "a"), idB = id16("restore.aborted", "b");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: idA });
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 2, id: idB });
    let body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id), "the degraded items are still served").toEqual([idA, idB]);
    expect(body.homeEvents?.outboxDegraded).toBe(2);
    writeAck({ v: 1, control: 1, acked: [], accepted: [idA] });
    body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id)).toEqual([idB]);
    expect(body.homeEvents?.outboxDegraded).toBe(1);
    writeAck({ v: 1, control: 1, acked: [idB], accepted: [idA] });
    expect((await items(c)).length).toBe(0);
  });
});

describe("T11 outbox survives kill, dismiss and control storage loss", () => {
  it("serves (restore.aborted, job.at, id(job.id)) after SIGKILL before any intake, and stops after a done", async () => {
    const job = { id: "job-eleven", at: BASE_AT + 111 };
    const wanted = { id: id16("restore.aborted", job.id), type: "restore.aborted", at: job.at };
    let c = await boot();
    advertise();
    await c.send({ cmd: "abort", job });
    expect(await waitFor(() => existsSync(join(dir, "ctl", "barrier-after_outbox_fsync"))), "no barrier: nothing was fsynced to an outbox (base spools to a file)").toBe(true);
    c.kill(); // dismissal (the restore journal is gone) and a control that never took the item: only the outbox remains
    c = await boot();
    expect(await items(c), "served after restart with at == job.at").toEqual([wanted]);
    writeAck({ v: 1, control: 1, acked: [wanted.id], accepted: [] });
    expect(await items(c)).toEqual([]);
    c.kill();
    c = await boot();
    expect(await items(c), "done persisted: the control accepted it, one add in all").toEqual([]);
  });
});

describe("T12 outbox partial append repaired", () => {
  it("repairs a short append in process, serves both items, and loads both after a restart", async () => {
    let c = await boot();
    advertise();
    c.fault("outbox-short", "7");
    const a = { id: id16("restore.aborted", "a"), at: BASE_AT + 1 }, b = { id: id16("restore.aborted", "b"), at: BASE_AT + 2 };
    await c.send({ cmd: "report", type: "restore.aborted", ...a });
    c.clear("outbox-short"); // space returns without a restart
    await c.send({ cmd: "report", type: "restore.aborted", ...b });
    expect((await items(c)).map(i => i.id), "both served").toEqual([a.id, b.id]);
    const [records, , clean] = readRecords(join(dir, "home-events.outbox"));
    expect(clean, "a partial line was left in the outbox before the next append (base has no outbox)").toBe(true);
    expect(records.flat().filter(op => op.r === "add").map(op => op.id)).toEqual([a.id, b.id]);
    c.kill();
    c = await boot();
    expect((await items(c)).map(i => i.id), "both loaded after the restart").toEqual([a.id, b.id]);
  });
});

describe("T13 stuck identity stable and distinct", () => {
  const dirFsyncBeforeAdd = (trace: Array<{ op: string; dir?: boolean; path?: string; to?: string }>) => {
    const rename = trace.findIndex(t => t.op === "rename" && String(t.to).endsWith("restore-stuck-at"));
    const sync = trace.findIndex((t, i) => i > rename && t.op === "fsync" && t.dir === true);
    const add = trace.findIndex((t, i) => i > sync && t.op === "write" && String(t.path).endsWith("home-events.outbox"));
    return rename >= 0 && sync > rename && add > sync;
  };
  it("fsyncs the directory after the marker rename and before the outbox add, and a new incident at the same time is a new id", async () => {
    const c = await boot();
    advertise();
    c.fault("now", String(BASE_AT + 500));
    await c.send({ cmd: "stuck", stuck: true });
    const first = await items(c);
    expect(first.length, "one stuck item served (base serves no homeEvents)").toBe(1);
    expect(first[0].id, "the stuck id is the first 16 hex characters of a sha256 (r7)").toMatch(/^[0-9a-f]{16}$/);
    expect(dirFsyncBeforeAdd((await c.send({ cmd: "trace" })).trace), "fsync(dir) after the rename, before the outbox add").toBe(true);
    await c.send({ cmd: "stuck", stuck: true });
    expect((await items(c)).map(i => i.id), "one incident re-asserted at every boot is one id").toEqual([first[0].id]);
    const marker = JSON.parse(readFileSync(join(dir, "restore-stuck-at"), "utf8"));
    await c.send({ cmd: "stuck", stuck: false }); // cleared
    const recovered = await items(c);
    expect(recovered.filter(i => i.type === "restore.finished")).toEqual([{ type: "restore.finished", at: BASE_AT + 500, id: id16("restore.finished", marker.nonce) }]);
    writeAck({ v: 1, control: 1, acked: recovered.map(i => i.id), accepted: [] });
    c.fault("now", String(BASE_AT + 500)); // the clock is set back to the same time
    await c.send({ cmd: "stuck", stuck: true });
    const second = await items(c);
    expect(second.length).toBe(1);
    expect(second[0].at, "the first incident's key is tombstoned, so the same millisecond is stored one higher (a reused key would be suppressed as a duplicate)").toBe(first[0].at + 1);
    expect(second[0].id, "two distinct ids reach the CP mock").not.toBe(first[0].id);
  });
});

describe("T4b served failure never absorbs; accepted retires without overflow", () => {
  const fill = async (c: Child, from: number, count: number) => { for (let n = from; n < from + count; n++) await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + n, id: id16("restore.aborted", `r${n}`) }); };
  const opsOf = () => readRecords(join(dir, "home-events.outbox"))[0];
  it("T4b-1 accepted retires without overflow: 31 restore items plus the failure slot, all accepted and never acked, then a new restore item is served directly", async () => {
    const c = await boot();
    advertise();
    await fill(c, 1, CAPS.restoreItems);
    await c.send({ cmd: "report", type: FAILURE, at: BASE_AT + 900, id: id16(FAILURE, "slot") });
    const first = await items(c);
    expect(first.length, "31 restore items plus the failure slot are served (base serves no homeEvents)").toBe(CAPS.restoreItems + CAPS.failureSlot);
    writeAck({ v: 1, control: 1, acked: [], accepted: first.map(i => i.id) });
    expect(await items(c)).toEqual([]);
    await fill(c, 500, 1);
    const after = await items(c);
    expect(after.length).toBe(1);
    expect(after[0].type).toBe("restore.aborted");
    const ops = opsOf().flat();
    expect(ops.filter(op => op.r === "add" && op.type === FAILURE).length, "no overflow record: the failure slot was not replaced").toBe(1);
  });
  it("T4b-2 a served failure item never absorbs: with nothing consumed, the 32nd restore item makes ONE overflow record with a NEW failure id", async () => {
    writeFileSync(join(dir, "hold-ack"), "");
    const c = await boot({ MURAGE_HOME_EVENTS_HOLD_ACK: join(dir, "hold-ack") });
    advertise();
    await fill(c, 1, CAPS.restoreItems);
    const slot = id16(FAILURE, "slot");
    await c.send({ cmd: "report", type: FAILURE, at: BASE_AT + 900, id: slot });
    expect((await items(c)).length, "31 + slot full (base serves no homeEvents)").toBe(CAPS.restoreItems + CAPS.failureSlot);
    c.fault("now", String(BASE_AT + 3000));
    await fill(c, 700, 1);
    const last = opsOf().at(-1)!;
    expect(last.map(op => op.r), "ONE record: done oldest, add new, done failure item, add new failure item").toEqual(["done", "add", "done", "add"]);
    expect(last[0].id).toBe(id16("restore.aborted", "r1"));
    expect(last[2].id, "the served failure item is retired, not reused").toBe(slot);
    expect(last[3]).toMatchObject({ type: FAILURE });
    expect(last[3].id).not.toBe(slot);
    const served = await items(c);
    expect(served.length).toBeLessThanOrEqual(CAPS.servedItems);
    expect(served.filter(i => i.type === FAILURE).length).toBe(1);
  });
});

describe("T5 exit 75 drains degraded items", () => {
  // Behavioral half (r7). The source pins for closeRequested stay in restore-job-j3.test.ts (index.ts:31865, 34485, 34533).
  it("waits while a degraded item exists, and returns as soon as that item is accepted, long before the limit", async () => {
    const c = await boot();
    advertise();
    c.fault("outbox-erofs");
    const id = id16("restore.aborted", "t5");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id });
    setTimeout(() => writeAck({ v: 1, control: 1, acked: [], accepted: [id] }), 400);
    const drained = await c.send({ cmd: "drain", ms: 10_000 });
    expect(drained.ok, "drainHomeEvents is not provided (base has none)").toBe(true);
    expect(drained.elapsedMs, "the drain waited for the acceptance").toBeGreaterThanOrEqual(300);
    expect(drained.elapsedMs, "the drain ended on the acceptance, not on its limit").toBeLessThan(5000);
  });
  it("returns at once when nothing is degraded", async () => {
    const c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: id16("restore.aborted", "t5b") });
    const drained = await c.send({ cmd: "drain", ms: 10_000 });
    expect(drained.ok).toBe(true);
    expect(drained.elapsedMs).toBeLessThan(1000);
  });
});

describe("T7 counter by mode", () => {
  it("extended mode serves no eventSpoolFailures; legacy mode serves the base counter", async () => {
    const legacy = await boot(); // no ACK file: legacy mode
    legacy.fault("outbox-erofs");
    chmodSync(join(dir, "events"), 0o500); // the base spool directory refuses writes too, so the base counter moves at base as well
    await legacy.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: id16("restore.aborted", "t7") });
    const legacyBody = await legacy.health();
    expect(legacyBody.homeEvents, "legacy mode has no homeEvents field").toBeUndefined();
    expect(legacyBody.eventSpoolFailures, "legacy mode keeps the base counter").toBeGreaterThanOrEqual(1);
    legacy.kill();
    chmodSync(join(dir, "events"), 0o700);
    legacy.clear("outbox-erofs");
    const c = await boot();
    advertise();
    const body = await c.health();
    expect(body.homeEvents, "with the advertisement present base serves no homeEvents").toBeDefined();
    expect(body.eventSpoolFailures, "extended mode no longer serves the counter (MU-38)").toBeUndefined();
  });
  it("pins the wiring in index.ts: the health body spreads homeEventsHealthFields, onAbort and the post-recover path call noteRestoreAborted", () => {
    const source = readFileSync(INDEX_TS, "utf8");
    expect(source, "health spreads homeEventsHealthFields").toMatch(/\.\.\.homeEventsHealthFields\(/);
    expect((source.match(/noteRestoreAborted\(/g) ?? []).length, "onAbort and post-recover").toBeGreaterThanOrEqual(2);
    expect(source, "the Date.now() spool at abort is gone").not.toMatch(/spoolHomeEvent\(HOME_EVENTS_DIR, "restore\.aborted"/);
  });
});

describe("T14 retired key never reused", () => {
  it("a tombstone keeps (type, at) out of reuse: B at T+1 after A retires, B stays T+1 after a restart, C at T+2", async () => {
    const T = BASE_AT + 4000;
    const idA = id16("restore.aborted", "t14a"), idB = id16("restore.aborted", "t14b"), idC = id16("restore.aborted", "t14c");
    let c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: T, id: idA });
    expect((await items(c)).map(i => [i.id, i.at]), "A served at T (base serves no homeEvents)").toEqual([[idA, T]]);
    writeAck({ v: 1, control: 1, acked: [], accepted: [idA] });
    expect(await items(c)).toEqual([]);
    const done = readRecords(join(dir, "home-events.outbox"))[0].flat().filter(op => op.r === "done");
    expect(done).toEqual([{ r: "done", id: idA, type: "restore.aborted", at: T }]);
    await c.send({ cmd: "report", type: "restore.aborted", at: T, id: idB });
    expect((await items(c)).map(i => [i.id, i.at]), "B at T gets T+1: the tombstone holds T").toEqual([[idB, T + 1]]);
    await c.send({ cmd: "report", type: "restore.aborted", at: T, id: idA });
    expect((await items(c)).map(i => i.id), "a tombstoned id is never re-added").toEqual([idB]);
    c.kill();
    c = await boot();
    expect((await items(c)).map(i => [i.id, i.at]), "B keeps T+1 from its add").toEqual([[idB, T + 1]]);
    await c.send({ cmd: "report", type: "restore.aborted", at: T, id: idC });
    const recovered = await items(c);
    expect(recovered.map(i => [i.id, i.at])).toEqual([[idB, T + 1]]);
    writeAck({ v: 1, control: 1, acked: [idB], accepted: [] });
    expect([...recovered, ...await items(c)].map(i => [i.id, i.at]), "C at T gets T+2 after B is reconciled").toEqual([[idB, T + 1], [idC, T + 2]]);
  });
});

describe("T14c outbox compaction keeps the newest 128 tombstones per type", () => {
  it("compacts past 256 lines, keeping every live add and the newest 128 tombstones of each type", async () => {
    const vector = JSON.parse(readFileSync(join(RECORDS, "compaction.json"), "utf8")) as { live_add_ids: string[]; kept_tombstone_ids: Record<string, string[]>; dropped_tombstone_ids: Record<string, string[]> };
    const c = await bootCompactionFixture();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 77_000, id: id16("restore.aborted", "t14c-trigger") });
    const ops = readRecords(join(dir, "home-events.outbox"))[0].flat();
    const tombstones = ops.filter(op => op.r === "done");
    for (const type of ["restore.aborted", "restore.stuck"]) {
      const ids = tombstones.filter(op => op.type === type).map(op => op.id);
      expect(ids.length, `${type}: at most ${CAPS.tombstonesPerType} tombstones kept (base never compacts)`).toBeLessThanOrEqual(CAPS.tombstonesPerType);
      expect([...ids].sort(), `${type}: the newest tombstones are the ones kept`).toEqual([...vector.kept_tombstone_ids[type]].sort());
    }
    expect(ops.filter(op => op.r === "add").map(op => op.id), "every live add survives compaction").toEqual(expect.arrayContaining(vector.live_add_ids));
    expect(readRecords(join(dir, "home-events.outbox"))[2], "the compacted file is clean").toBe(true);
    const input = readRecords(join(RECORDS, "compaction-input.txt"))[0].flat().filter(op => op.r === "done");
    for (const type of ["restore.aborted", "restore.stuck"]) {
      const dropped = input.filter(op => op.type === type && vector.dropped_tombstone_ids[type]?.includes(op.id as string)).map(op => op.at as number);
      const floors = ops.filter(op => op.r === "floor" && op.type === type).map(op => op.at as number);
      expect(floors.length, `${type}: one floor op`).toBe(dropped.length ? 1 : 0);
      if (dropped.length) expect(floors[0], `${type}: floor is the highest dropped at (monotone)`).toBe(Math.max(...dropped));
    }
  });
});

describe("T15 retire only through a durable done", () => {
  it("a failed done keeps the id as retiring (not served, counted), the retire gate holds new items, a restart reloads it, and a healthy append retires it", async () => {
    const idK = id16("restore.aborted", "t15k"), idN = id16("restore.aborted", "t15n"), idN2 = id16("restore.aborted", "t15n2");
    let c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: idK });
    expect((await items(c)).map(i => i.id), "K served (base serves no homeEvents)").toEqual([idK]);
    c.fault("outbox-eio");
    writeAck({ v: 1, control: 1, acked: [idK], accepted: [] });
    let body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id), "(1) K is not served while its done cannot be written").toEqual([]);
    expect(body.homeEvents?.outboxDegraded, "(1) a retiring item is counted (r6-L8 guard)").toBeGreaterThanOrEqual(1);
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 2, id: idN });
    body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id), "(2) the retire gate: a new item waits while K is retiring").toEqual([]);
    expect(body.homeEvents?.outboxDegraded).toBeGreaterThanOrEqual(2);
    writeAck({ v: 1, control: 1, acked: [], accepted: [] }); // control restarted without storage: K is no longer listed
    c.kill();
    c = await boot();
    c.fault("outbox-eio");
    expect((await items(c)).map(i => i.id), "(3) after SIGKILL K is reloaded and served, N (memory only) is gone").toEqual([idK]);
    c.clear("outbox-eio");
    writeAck({ v: 1, control: 1, acked: [idK], accepted: [] });
    expect(await items(c), "(4) with a healthy append K's done lands and K retires").toEqual([]);
    expect(readRecords(join(dir, "home-events.outbox"))[0].filter(rec => rec.some(op => op.r === "done" && op.id === idK)).length, "(4) ONE record holds K's done (rule P)").toBe(1);
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 3, id: idN2 });
    expect((await items(c)).map(i => i.id), "(4) the next new item is served").toEqual([idN2]);
  });
});

describe("T16 the ACK reader accepts the writer's maximum and rejects over-limit files whole", () => {
  const offered = JSON.parse(readFileSync(join(ACKS, "offered-ids.json"), "utf8")) as string[];
  // The 32 items come from a FILE input (the outbox fixture), never from a helper call.
  const bootOnFixture = async () => {
    writeFileSync(join(dir, "home-events.outbox"), readFileSync(join(RECORDS, "outbox-32.txt")));
    const c = await boot();
    advertise();
    return c;
  };
  it("serves the 32 offered items and retires all of them from max.json (512 ids in total, 9,788 bytes)", async () => {
    const c = await bootOnFixture();
    expect((await items(c)).map(i => i.id), "32 items served (base ignores the outbox file)").toEqual(offered);
    writeAck(readFileSync(join(ACKS, "max.json"), "utf8"));
    expect(await items(c), "all 32 retire").toEqual([]);
  });
  for (const name of ["over-513.json", "both-lists.json", "hex17.json", "no-control.json"]) {
    it(`ignores ${name} whole: nothing retires`, async () => {
      const c = await bootOnFixture();
      expect((await items(c)).map(i => i.id)).toEqual(offered);
      writeAck(readFileSync(join(ACKS, name), "utf8"));
      expect((await items(c)).map(i => i.id), `${name} must retire nothing`).toEqual(offered);
    });
  }
});

describe("T17 R-loss-1 app half (MurageMain r7 ruling 7)", () => {
  // The app hands out a stored key `at` that is already used only when its copy of the earlier event E1 is gone: memory-only AND a crash. Dropping
  // either condition, or changing the kind or the millisecond, gives E2 a different key. At base the whole family fails on the missing channel.
  const T = BASE_AT + 31337;
  const e1 = { id: id16("restore.aborted", "rloss-e1"), type: "restore.aborted", at: T };
  const run = async (opts: { e2Type?: string; e2At?: number; memoryOnly: boolean; crash: boolean }) => {
    let c = await boot();
    advertise();
    if (opts.memoryOnly) c.fault("outbox-erofs");
    await c.send({ cmd: "report", ...e1 });
    expect((await items(c)).map(i => [i.type, i.at]), "E1 served (base serves no homeEvents)").toEqual([[e1.type, e1.at]]);
    if (opts.crash) { c.kill(); c.clear("outbox-erofs"); c = await boot(); } // a whole-unit crash: both memory copies are gone
    else c.clear("outbox-erofs");
    const recovered = opts.crash && !opts.memoryOnly ? await items(c) : [];
    if (recovered.length) writeAck({ v: 1, control: 1, acked: recovered.map(i => i.id), accepted: [] });
    await c.send({ cmd: "report", type: opts.e2Type ?? "restore.aborted", at: opts.e2At ?? T, id: id16("restore.aborted", "rloss-e2") });
    return [...recovered, ...await items(c)].map(i => [i.type, i.at]);
  };
  it("all conditions together: E2 is served under E1's key", async () => {
    const served = await run({ memoryOnly: true, crash: true });
    expect(served, "E1 is gone, so E2 takes the same key").toEqual([["restore.aborted", T]]);
  });
  it("different kind: delivered under its own key", async () => {
    const served = await run({ memoryOnly: true, crash: true, e2Type: "restore.stuck" });
    expect(served).toEqual([["restore.stuck", T]]);
  });
  it("different millisecond: delivered under its own key", async () => {
    const served = await run({ memoryOnly: true, crash: true, e2At: T + 5 });
    expect(served).toEqual([["restore.aborted", T + 5]]);
  });
  it("E1 durable in the app: E2 gets T+1", async () => {
    const served = await run({ memoryOnly: false, crash: true });
    expect(served).toEqual([["restore.aborted", T], ["restore.aborted", T + 1]]);
  });
  it("no crash: E1 is still in the map, E2 gets T+1", async () => {
    const served = await run({ memoryOnly: true, crash: false });
    expect(served).toEqual([["restore.aborted", T], ["restore.aborted", T + 1]]);
  });
});

describe("T18 a hold is never silent (MurageMain r7 ruling 8)", () => {
  it("while /data refuses writes and a retiring item waits, a new event is held, and outboxDegraded counts both", async () => {
    const idK = id16("restore.aborted", "t18k"), idN = id16("restore.aborted", "t18n");
    const c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: idK });
    expect((await items(c)).map(i => i.id), "K served (base serves no homeEvents)").toEqual([idK]);
    c.fault("outbox-eio");
    writeAck({ v: 1, control: 1, acked: [idK], accepted: [] });
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 2, id: idN });
    const body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id), "N is held in memory, not served").toEqual([]);
    expect(body.homeEvents?.outboxDegraded, "MU-H1: a hold with outboxDegraded 0 is a silent hold; K retiring plus N held is 2").toBeGreaterThanOrEqual(2);
  });
  it("guard: a healthy outbox never reports a hold", async () => {
    const c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: id16("restore.aborted", "t18g") });
    expect((await c.health()).homeEvents?.outboxDegraded, "base serves no homeEvents").toBe(0);
  });
});

describe("T17f tombstone expiry never reuses a key (r8 M1)", () => {
  it("after A's tombstone is compacted away a new item at A's time is stored above A's time (the durable floor)", async () => {
    const T = BASE_AT + 90_000, idA = id16("restore.aborted", "t17f-a"), idB = id16("restore.aborted", "t17f-b");
    let c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: T, id: idA });
    expect((await items(c)).map(i => [i.id, i.at]), "A served at T (base serves no homeEvents)").toEqual([[idA, T]]);
    writeAck({ v: 1, control: 1, acked: [], accepted: [idA] });
    expect(await items(c)).toEqual([]);
    writeAck({ v: 1, control: 1, acked: [], accepted: [] }); // control restarted without storage
    for (let n = 1; n <= 300; n++) await c.send({ cmd: "report", type: "restore.aborted", at: T + 1000 + n, id: id16("restore.aborted", `t17f-${n}`) });
    const ops = readRecords(join(dir, "home-events.outbox"))[0].flat();
    expect(ops.some(op => op.r === "done" && op.id === idA), "A's tombstone was compacted away").toBe(false);
    expect(ops.find(op => op.r === "floor" && op.type === "restore.aborted")?.at as number, "a floor op at or above T").toBeGreaterThanOrEqual(T);
    c.kill();
    c = await boot();
    const reloaded = await items(c);
    writeAck({ v: 1, control: 1, acked: reloaded.map(i => i.id), accepted: [] });
    expect(await items(c)).toEqual([]);
    await c.send({ cmd: "report", type: "restore.aborted", at: T, id: idB });
    const served = await items(c);
    const gotB = served.find(i => i.id === idB);
    expect(gotB ? gotB.at > T : served.length + "|" + JSON.stringify(served.slice(-2)) + "|" + readRecords(join(dir, "home-events.outbox"))[0].at(-1)?.map(o => String(o.r) + String(o.at)).join(","), "B at T is stored above T").toBe(true);
  });
});

describe("T15b an intermittent done failure piggybacks (r8 M2)", () => {
  it("every record that holds N's add also holds K's done, and one record retires K when the shim is removed", async () => {
    const idK = id16("restore.aborted", "t15bk"), idN = id16("restore.aborted", "t15bn"), idP = id16("restore.aborted", "t15bp");
    let c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: idK });
    expect((await items(c)).map(i => i.id), "K served (base serves no homeEvents)").toEqual([idK]);
    c.fault("outbox-fail-done", idK);
    writeAck({ v: 1, control: 1, acked: [idK], accepted: [] });
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 2, id: idN });
    const body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id), "(1) N is not served while K's done is not durable").toEqual([]);
    expect(body.homeEvents?.outboxDegraded).toBeGreaterThanOrEqual(2);
    expect(readRecords(join(dir, "home-events.outbox"))[0].flat().some(op => op.id === idN), "N's add never landed without K's done").toBe(false);
    c.clear("outbox-fail-done");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 3, id: idP });
    const last = readRecords(join(dir, "home-events.outbox"))[0].at(-1)!;
    expect(last.map(op => `${op.r}:${op.id}`), "(2) ONE record: K's done, N's add, P's add").toEqual([`done:${idK}`, `add:${idN}`, `add:${idP}`]);
    c.kill();
    c = await boot();
    expect((await items(c)).map(i => i.id), "(3) K absent, N and P served").toEqual([idN, idP]);
  });
});

describe("T19 outbox rename then directory fsync fails (r8 M3)", () => {
  it("claims no done while relinking, lands it in the new inode afterwards, and loses nothing", async () => {
    const idY = id16("restore.aborted", "t19y"), idZ = id16("restore.aborted", "t19z");
    let c = await bootCompactionFixture();
    c.fault("outbox-dirfsync-after-rename");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 80_000, id: idY }); // lands, then compaction renames and the directory fsync fails
    expect((await items(c)).some(i => i.id === idY), "Y served (base serves no homeEvents)").toBe(true);
    writeAck({ v: 1, control: 1, acked: [idY], accepted: [] });
    let body = await c.health();
    expect(body.homeEvents?.items.some(i => i.id === idY), "Y is retiring, not served").toBe(false);
    expect(body.homeEvents?.outboxDegraded, "Y's done is not claimed while relinking").toBeGreaterThanOrEqual(1);
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 80_001, id: idZ });
    c.clear("outbox-dirfsync-after-rename");
    body = await c.health();
    expect(body.homeEvents?.outboxDegraded, "after the relink the done and Z's add landed").toBe(0);
    writeAck({ v: 1, control: 1, acked: [], accepted: [] }); // control restarted without storage: only the file decides
    c.kill();
    c = await boot();
    const served = (await items(c)).map(i => i.id);
    expect(served, "Y absent, Z reloaded").toContain(idZ);
    expect(served).not.toContain(idY);
  });
});

describe("T20s /api/health opsAlertsWaiting follows outboxDegraded (r8 ruling 8)", () => {
  it("counts a held item and returns to 0 when the append lands", async () => {
    const c = await boot();
    advertise();
    c.fault("outbox-eio");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: id16("restore.aborted", "t20s") });
    const held = (await c.send({ cmd: "health" })).body as { opsAlertsWaiting?: number };
    expect(held.opsAlertsWaiting, "base counts spool files and stays 0").toBeGreaterThanOrEqual(1);
    c.clear("outbox-eio");
    expect(((await c.send({ cmd: "health" })).body as { opsAlertsWaiting?: number }).opsAlertsWaiting).toBe(0);
  });
});

describe("T19b a replaced outbox inode is never written through the old descriptor (r8 M3, MU-88)", () => {
  it("claims a done only after the descriptor is identified with the file at the path", async () => {
    const idY = id16("restore.aborted", "t19by");
    let c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: idY });
    expect((await items(c)).map(i => i.id), "Y served (base serves no homeEvents)").toEqual([idY]);
    const path = join(dir, "home-events.outbox");
    writeFileSync(path + ".swap", readFileSync(path));
    renameSync(path + ".swap", path); // another inode now stands at the path; the child's descriptor names the unlinked one
    writeAck({ v: 1, control: 1, acked: [idY], accepted: [] });
    expect(await items(c)).toEqual([]);
    writeAck({ v: 1, control: 1, acked: [], accepted: [] }); // control restarted without storage: only the file decides
    c.kill();
    c = await boot();
    expect(await items(c), "the done landed in the file at the path: Y is not served again").toEqual([]);
  });
});

describe("r8b M4 restart reconciliation", () => {
  async function restartRetirement() {
    const idK = id16("restore.aborted", "r8b-retiring-k");
    let c = await boot();
    advertise();
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 1, id: idK });
    expect((await items(c)).map(i => i.id)).toEqual([idK]);
    c.fault("outbox-eio");
    writeAck({ v: 1, control: 1, acked: [idK], accepted: [] });
    expect((await c.health()).homeEvents?.outboxDegraded).toBe(1);
    advertise(); // control restarts without the memory receipt
    c.kill();
    c = await boot();
    return { c, idK };
  }
  it("does not report a recovered retiring item as zero before the receipt returns", async () => {
    const { c, idK } = await restartRetirement();
    const body = await c.health();
    expect(body.homeEvents?.items.map(i => i.id)).toEqual([idK]);
    expect(body.homeEvents?.outboxDegraded, "an unresolved reload must keep the existing hold episode positive").toBe(1);
    c.clear("outbox-eio");
    writeAck({ v: 1, control: 1, acked: [], accepted: [idK] });
    expect((await c.health()).homeEvents?.outboxDegraded).toBe(0);
  });
  it("a recovered entry fences later adds until its receipt can be reconciled", async () => {
    const { c, idK } = await restartRetirement();
    c.clear("outbox-eio");
    const idN = id16("restore.aborted", "r8b-retiring-n");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 2, id: idN });
    expect((await items(c)).map(i => i.id), "N cannot pass K after the empty-ACK restart").toEqual([idK]);
    expect(readRecords(join(dir, "home-events.outbox"))[0].flat().some(op => op.r === "add" && op.id === idN)).toBe(false);
    writeAck({ v: 1, control: 1, acked: [], accepted: [idK] });
    expect((await items(c)).map(i => i.id)).toEqual([idN]);
    const last = readRecords(join(dir, "home-events.outbox"))[0].at(-1)!;
    expect(last.map(op => `${op.r}:${op.id}`)).toEqual([`done:${idK}`, `add:${idN}`]);
  });
});

describe("r8b M5 rejected admissions recover", () => {
  it("clears the customer count when writes recover and records a failure for rejected admissions", async () => {
    const c = await boot();
    advertise();
    for (let n = 0; n < CAPS.restoreItems; n++) await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + n, id: id16("restore.aborted", `r8b-full-${n}`) });
    const admitted = await items(c);
    expect(admitted.length).toBe(CAPS.restoreItems);
    c.fault("outbox-eio");
    const rejected = id16("restore.aborted", "r8b-rejected");
    await c.send({ cmd: "report", type: "restore.aborted", at: BASE_AT + 100, id: rejected });
    expect((await items(c)).some(i => i.id === rejected)).toBe(false);
    expect((await c.health()).homeEvents?.outboxDegraded).toBe(1);
    c.clear("outbox-eio");
    const recovered = await c.health() as Body & { opsAlertsWaiting: number };
    expect(recovered.opsAlertsWaiting, "recovery clears the customer warning even before existing entries retire").toBe(0);
    const failure = recovered.homeEvents?.items.filter(i => i.type === FAILURE) ?? [];
    expect(failure.length, "rejected admissions leave a durable failure report").toBe(1);
    expect(readRecords(join(dir, "home-events.outbox"))[0].flat().some(op => op.r === "add" && op.id === failure[0].id)).toBe(true);
    writeAck({ v: 1, control: 1, acked: [...admitted, ...failure].map(i => i.id), accepted: [] });
    const done = await c.health() as Body & { opsAlertsWaiting: number };
    expect(done.homeEvents?.items).toEqual([]);
    expect(done.opsAlertsWaiting).toBe(0);
  });
});


describe("restore.finished recovery", () => {
  it("reports one completion paired to the marker, ignores absent and invalid markers, and retires on ACK", async () => {
    const c = await boot();
    advertise();
    await c.send({ cmd: "stuck", stuck: false });
    expect(await items(c)).toEqual([]);
    writeFileSync(join(dir, "restore-stuck-at"), JSON.stringify({ at: BASE_AT, nonce: "invalid" }));
    await c.send({ cmd: "stuck", stuck: false });
    expect(await items(c)).toEqual([]);
    c.fault("now", String(BASE_AT));
    await c.send({ cmd: "stuck", stuck: true });
    const marker = JSON.parse(readFileSync(join(dir, "restore-stuck-at"), "utf8"));
    expect(await items(c)).toEqual([{ type: "restore.stuck", at: BASE_AT, id: id16("restore.stuck", marker.nonce) }]);
    c.fault("now", String(BASE_AT + 500));
    await c.send({ cmd: "stuck", stuck: false });
    const finished = { type: "restore.finished", at: BASE_AT + 500, id: id16("restore.finished", marker.nonce) };
    expect((await items(c)).filter(i => i.type === "restore.finished")).toEqual([finished]);
    expect(existsSync(join(dir, "restore-stuck-at"))).toBe(false);
    await c.send({ cmd: "stuck", stuck: false });
    expect((await items(c)).filter(i => i.type === "restore.finished")).toEqual([finished]);
    writeAck({ v: 1, control: 1, acked: (await items(c)).map(i => i.id), accepted: [] });
    expect(await items(c)).toEqual([]);
    c.kill();
    const restarted = await boot();
    expect(await items(restarted)).toEqual([]);
  });

  it("a crash at marker clear leaves the completion durable and re-reporting keeps the same id and at", async () => {
    let c = await boot();
    advertise();
    c.fault("now", String(BASE_AT));
    await c.send({ cmd: "stuck", stuck: true });
    const marker = JSON.parse(readFileSync(join(dir, "restore-stuck-at"), "utf8"));
    c.fault("now", String(BASE_AT + 600));
    c.fault("crash-before-marker-clear");
    void c.send({ cmd: "stuck", stuck: false });
    expect(await waitFor(() => existsSync(join(dir, "ctl", "barrier-before-marker-clear")))).toBe(true);
    const finished = { type: "restore.finished", at: BASE_AT + 600, id: id16("restore.finished", marker.nonce) };
    expect(readRecords(join(dir, "home-events.outbox"))[0].flat().filter(op => op.r === "add" && op.type === "restore.finished")).toEqual([{ r: "add", ...finished }]);
    expect(JSON.parse(readFileSync(join(dir, "restore-stuck-at"), "utf8"))).toEqual(marker);
    c.clear("crash-before-marker-clear");
    c = await boot();
    c.fault("now", String(BASE_AT + 900));
    await c.send({ cmd: "stuck", stuck: false });
    expect((await items(c)).filter(i => i.type === "restore.finished")).toEqual([finished]);
    expect(existsSync(join(dir, "restore-stuck-at"))).toBe(false);
    expect(readRecords(join(dir, "home-events.outbox"))[0].flat().filter(op => op.r === "add" && op.type === "restore.finished")).toHaveLength(1);
    writeAck({ v: 1, control: 1, acked: (await items(c)).map(i => i.id), accepted: [] });
    expect(await items(c)).toEqual([]);
  });
});
