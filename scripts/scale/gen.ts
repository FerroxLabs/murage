// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scale rig generator (SCALE-PLAN section 5): writes a whole Murage data dir in the
// "extreme", "pr" or "owner" shape (shapes.mjs), deterministically from a seed, with the
// tree under test's own code. It runs INSIDE the tree under test:
//
//   MURAGE_DATA_DIR=/scale/data SCALE_SHAPE=pr SCALE_SEED=1 \
//     node --experimental-strip-types /scale-rig/gen.ts base     # roster, history, memory, receipts, routines
//     (start the server once, send two real turns to Sable, stop it: rig.mjs --prime)
//     node --experimental-strip-types /scale-rig/gen.ts hot      # the resumed Sable session, on the real session id
//     node --experimental-strip-types /scale-rig/gen.ts manifest # counts and sizes, printed as JSON
//
// What is real and what is templated:
//   - schema, roster and files: the tree's own database() migrations, Store (createBot,
//     createTask, createGroup, createGroupTask), reconcileMemoryRoster and setMemoryMode;
//   - memory capture: captureMessage() for every stored row, exactly as message-db.ts does;
//   - lineage: outputRootsFor(), recordOutputRoots() and recordSessionRoots() for every reply
//     and session (v6 sets in 1.0.1, v7 chains in 1.0.2: each tree writes its own shape);
//   - the word index and vectors: MemoryIndex.upsert() and MemoryIndex.vector();
//   - message rows, memory records, checkpoint versions and receipts are rows in the tree's
//     own tables in the shape their writers produce (store.ts appendMessage, perf-fixture.ts,
//     consolidate.ts refreshMemoryCheckpoint, disclosures.ts linkMemoryDisclosureOutput's final
//     state: each row on its turn's receipt and the session's newest, shapes.mjs rcReceiptOutputs),
//     with the tables' own triggers firing. Building 3M messages or 500k receipts
//     through a live server would take days, so these are bulk rows, not API calls.
//
// It never touches ~/.murage: it refuses any MURAGE_DATA_DIR outside SCALE_ROOT (default /scale).

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rcReceiptOutputs, shape as shapeOf } from "./shapes.mjs";

const pass = process.argv[2] ?? "";
if (!["base", "hot", "manifest"].includes(pass)) { console.error("usage: gen.ts base|hot|manifest"); process.exit(2); }

// ---- guard: a scratch data dir only
const ROOT = resolve(process.env.SCALE_ROOT ?? "/scale");
const DATA = process.env.MURAGE_DATA_DIR ? resolve(process.env.MURAGE_DATA_DIR) : "";
const live = resolve(homedir(), ".murage");
if (!DATA || !DATA.startsWith(ROOT + "/") || DATA.split("/").includes(".murage") || DATA === live || live.startsWith(DATA + "/")) {
  console.error(`gen.ts refuses MURAGE_DATA_DIR=${DATA || "(unset)"}: it must sit under ${ROOT}/ and never be a live data dir`);
  process.exit(2);
}
if (pass === "base" && existsSync(DATA) && readdirSync(DATA).length) { console.error(`gen.ts base: ${DATA} is not empty`); process.exit(2); }
mkdirSync(DATA, { recursive: true, mode: 0o700 });

const WORK = resolve(process.env.SCALE_WORK ?? process.cwd());
const SHAPE_NAME = process.env.SCALE_SHAPE ?? "pr";
const S = shapeOf(SHAPE_NAME);
const SEED = Number(process.env.SCALE_SEED ?? 1) >>> 0;
const DAY = 86_400_000;
// Timestamps are anchored to the generation day (or SCALE_EPOCH_END, ms) so history is three years old
// when the rig runs; everything else (ids, text, shape) depends only on the seed.
const END = Number(process.env.SCALE_EPOCH_END ?? Math.floor(Date.now() / DAY) * DAY - DAY);
const START = END - 3 * 365 * DAY;
const log = (...a: unknown[]) => console.log(`[gen ${pass} ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---- determinism: one seeded generator for ids and text, a virtual clock for every Date.now() the tree reads
function generator(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const idRandom = generator(SEED ^ (pass === "hot" ? 0x51ab1e : 0x1d));
const hex = (n: number) => Math.floor(n * 4294967296).toString(16).padStart(8, "0");
function seededUuid(): string {
  const h = hex(idRandom()) + hex(idRandom()) + hex(idRandom()) + hex(idRandom());
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const nodeCrypto = createRequire(import.meta.url)("node:crypto");
nodeCrypto.randomUUID = seededUuid;
syncBuiltinESMExports();
Object.defineProperty(globalThis.crypto, "randomUUID", { value: seededUuid, configurable: true, writable: true });
let clock = START;
const realNow = Date.now;
if (pass === "base") Date.now = () => clock;

const rnd = generator(SEED);
const pick = <T,>(items: readonly T[], r = rnd) => items[Math.floor(r() * items.length)];
const between = (lo: number, hi: number, r = rnd) => lo + Math.floor(r() * (hi - lo + 1));
const SYLLABLES = ["ba", "ko", "ri", "tu", "ne", "sha", "lo", "mi", "ve", "dra", "pen", "cor", "fil", "gan", "hul", "jex", "kar", "lum", "nor", "pix"];
const WORDS = (() => { const w = new Set<string>(), r = generator(SEED ^ 0x77); while (w.size < 1500) { let s = ""; const n = 2 + Math.floor(r() * 3); for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(r() * SYLLABLES.length)]; w.add(s); } return [...w]; })();
const TOPICS = ["pipeline", "renewals", "hiring", "the Q4 offsite", "vendor contracts", "the support backlog", "pricing page copy", "the board deck", "churn", "onboarding emails"];
const sentence = (count: number, r = rnd) => { const out: string[] = []; for (let i = 0; i < count; i++) out.push(WORDS[Math.floor(r() * r() * WORDS.length)]); return out.join(" "); };
const TOOLS = ["read_file", "web_search", "run_command", "edit_file", "list_dir", "memory_search", "fetch_url", "grep"];

// ---- the tree under test
const imp = (path: string) => import(pathToFileURL(join(WORK, path)).href);
const { database, closeDatabase } = await imp("server/database.ts");
const { setMemoryMode } = await imp("server/memory/repository.ts");
const { reconcileMemoryRoster } = await imp("server/memory/policy.ts");
const { captureMessage, captureSource } = await imp("server/memory/capture.ts");
const lineage = await imp("server/memory/replay-lineage.ts");
// 1.0.2 trees take the allowance first (writerAllowance bounds the read by the root ceiling); the 1.0.1 tree takes none
const rootsFor = (rows: unknown) => typeof lineage.writerAllowance === "function" ? lineage.outputRootsFor(lineage.writerAllowance("scale generator"), rows) : lineage.outputRootsFor(rows);
const { MemoryIndex } = await imp("server/memory/index.ts");
const { threadCheckpointId } = await imp("server/memory/checkpoints.ts");
const schema = await imp("server/memory/schema.ts");

type Row = { id: string; at: number; parentId: string | null; role: "user" | "bot"; kind: string; text?: string; turnId?: string; [k: string]: unknown };
// An install from before 1.0.2 has auto_vacuum=0 (database.ts sets INCREMENTAL on a fresh file only): an existing empty
// file is not a fresh installation, so the tree's own migrations build the tables with SQLite's default, none.
if (pass === "base" && S.autoVacuumOff) closeSync(openSync(join(DATA, "messages.db"), "a", 0o600));
const db = database();
if (pass === "base" && S.autoVacuumOff && Number(db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum) !== 0) throw new Error("gen.ts: the owner shape needs auto_vacuum=0 and the file came out with it on");
db.exec("PRAGMA synchronous=OFF");
const insertRow = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
const setLeaf = db.prepare("INSERT INTO thread_state(thread_id, active_leaf_id) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id");
function writeRows(threadId: string, rows: Row[]) {
  for (const row of rows) insertRow.run(threadId, row.id, row.at, row.role, row.kind, row.text ?? null, JSON.stringify(row));
  if (rows.length) setLeaf.run(threadId, rows[rows.length - 1].id);
  // what message-db.ts does after each committed row: memory capture. A turn's closing reply goes to
  // captureSource with exactly what captureMessage would hand it (the reply is the turn's only authored
  // text here); captureMessage itself would walk the whole active path per reply (wholeTurnText), which
  // makes building a 200k-row thread quadratic.
  for (const row of rows) {
    if (row.role === "bot" && row.kind === "text" && row.turnTerminal) {
      const from = row.from as { botId?: string } | undefined;
      captureSource(db, { id: `message:${threadId}:${row.id}`, threadId, messageId: row.id, turnId: row.turnId, parentId: row.parentId, kind: "text", speaker: from?.botId ?? "assistant", outcome: "recorded", text: row.text ?? "", occurredAt: row.at, actorId: from?.botId });
    } else captureMessage(db, threadId, row);
  }
}
// Connection-local cache counters (memory/provenance-stamp.ts) are not data. Their identity triggers probe every version
// of a record id on each insert, which makes writing 150k versions of one checkpoint quadratic (a real cost the rig's
// turns still pay through the server's own connection); the generator drops them on its own connection only.
const quietCounters = () => { for (const row of db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' AND (name LIKE 'ident\\_%' ESCAPE '\\' OR name LIKE 'prov\\_%' ESCAPE '\\')").all()) db.exec(`DROP TRIGGER IF EXISTS temp."${String(row.name)}"`); };
const tx = (work: () => void) => { db.exec("BEGIN IMMEDIATE"); try { work(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } };

/** One turn of a thread: the owner's message, tool chips, the reply. */
function turnRows(parent: string | null, at: number, chips: number, from?: Record<string, unknown>, routine = false, r = rnd): Row[] {
  const turnId = seededUuid();
  const rows: Row[] = [];
  let prev = parent, t = at;
  if (!routine) {
    const user: Row = { id: seededUuid(), at: t, parentId: prev, role: "user", kind: "text", text: `About ${pick(TOPICS, r)}: ${sentence(between(20, 70, r), r)}?`, origin: "desktop" };
    rows.push(user); prev = user.id; t += between(200, 2000, r);
  }
  for (let c = 0; c < chips; c++) {
    const name = pick(TOOLS, r);
    const chip: Row = { id: seededUuid(), at: t, parentId: prev, role: "bot", kind: "activity", text: sentence(between(4, 12, r), r), tool: { name, ok: r() > 0.03, summary: `${name} ${sentence(3, r)}` }, turnId, ...(from ? { from } : {}) };
    rows.push(chip); prev = chip.id; t += between(100, 4000, r);
  }
  const reply: Row = { id: seededUuid(), at: t, parentId: prev, role: "bot", kind: "text", text: `${sentence(between(60, 220, r), r)}. Open items on ${pick(TOPICS, r)} follow.`, turnId, turnTerminal: true, ...(from ? { from } : {}) };
  rows.push(reply);
  return rows;
}

// ================================================================== base
async function base() {
  const t0 = realNow();
  writeFileSync(join(DATA, "config.json"), JSON.stringify({ instances: {
    grok: { driver: "grokAgent", config: { cli: "/scale-rig/fake-acp.sh", fullAuto: true } },
    claude: { driver: "claudeAgent", config: { cli: "/scale-rig/fake-claude.sh" } },
  } }, null, 2), { mode: 0o600 });
  // Memory on first: switching the mode later moves the policy revision and voids every receipt.
  setMemoryMode("active");
  const { Store } = await imp("server/store.ts");
  const store = new Store(() => ({ instanceId: "grok", model: "grok-4.6" }));
  // One bots.json / groups.json write at the end instead of one per created record (same content).
  const saveBots = store.saveBots.bind(store), saveGroups = store.saveGroups.bind(store);
  store.saveBots = () => {}; store.saveGroups = () => {};

  // ---- roster
  const teams = Array.from({ length: S.teams }, (_, i) => `Team ${String(i + 1).padStart(2, "0")}`);
  const named = ["Sable", "Slope", "Capt", "Claudia"];
  const bots: any[] = [];
  for (let i = 0; i < S.bots; i++) {
    clock = START + Math.floor((i / S.bots) * 900 * DAY);
    const claude = named[i] === "Claudia" || (i >= named.length && i % 4 === 3);
    const bot = store.createBot({ name: named[i] ?? `Bot ${String(i).padStart(2, "0")}`, title: "Scale", section: teams[i % teams.length], modelSelection: claude ? { instanceId: "claude", model: "claude-sonnet-4-5" } : { instanceId: "grok", model: "grok-4.6" } }, { seedMessages: false });
    bots.push(bot);
  }
  const sable = bots[0];
  // tasks: Sable's share first, the rest round robin over the other bots
  for (let n = 0; n < S.tasks; n++) {
    const bot = n < S.sableTasks ? sable : bots[1 + ((n - S.sableTasks) % (bots.length - 1))];
    clock = START + Math.floor((n / S.tasks) * 1080 * DAY);
    store.createTask(bot.id, `Task ${n}: ${pick(TOPICS)}`, false);
  }
  const rooms: any[] = [];
  for (let t = 0; t < S.teams; t++) {
    clock = START + t * 20 * DAY;
    const members = bots.filter((_, i) => i % teams.length === t).slice(0, 5).map(b => b.id);
    if (members.length < 2) members.push(bots[(t + 1) % bots.length].id);
    rooms.push(store.createGroup(`${teams[t]} room`, members, false, teams[t], { completed: true }));
  }
  clock = START + 30 * DAY;
  const feed = store.createGroup("Ops feed", bots.slice(0, Math.min(4, bots.length)).map(b => b.id), false, teams[0], { completed: true });
  for (let n = 0; n < S.groupTasks; n++) { clock = START + Math.floor((n / Math.max(1, S.groupTasks)) * 1080 * DAY); store.createGroupTask(rooms[n % rooms.length].id, `Room task ${n}`, false); }
  store.saveBots = saveBots; store.saveGroups = saveGroups;
  saveBots(); saveGroups();
  reconcileMemoryRoster(store);
  log(`roster: ${bots.length} bots, ${S.tasks} tasks, ${rooms.length + 1} rooms, ${S.groupTasks} room tasks`);

  // ---- threads and their sizes
  type Thread = { id: string; bot?: any; room?: any; rows: number; kind: string; created: number };
  const threads: Thread[] = [];
  const botThreads = (bot: any) => [bot.threadId, ...(bot.tasks ?? []).map((t: any) => t.threadId)];
  for (const bot of store.bots) for (const id of new Set(botThreads(bot))) threads.push({ id, bot, rows: 0, kind: id === bot.threadId ? "direct" : "task", created: (bot.tasks ?? []).find((t: any) => t.threadId === id)?.createdAt ?? bot.createdAt });
  for (const room of store.groups) for (const id of new Set([room.threadId, ...(room.tasks ?? []).map((t: any) => t.threadId)])) threads.push({ id, room, rows: 0, kind: room.id === feed.id && id === feed.threadId ? "feed" : "room", created: room.createdAt });
  const sableBot = store.bots.find((b: any) => b.id === sable.id);
  const sableMain = threads.find(t => t.id === sableBot.threadId)!;
  sableMain.rows = S.sableMainRows;
  const sableTasks = threads.filter(t => t.bot?.id === sable.id && t.kind === "task");
  for (const t of sableTasks) t.rows = Math.floor(S.sableTaskRows / Math.max(1, sableTasks.length));
  const feedThread = threads.find(t => t.kind === "feed")!;
  feedThread.rows = S.routineRoomRows;
  const rest = threads.filter(t => t.rows === 0);
  let left = Math.max(0, S.rowsTotal - S.sableMainRows - S.sableTaskRows - S.routineRoomRows - S.hotReceipts / 1.5 * (S.hotChips + 2));
  const spread = (list: Thread[], rows: number) => {
    const weights = list.map((_, i) => 1 / Math.pow(i + 3, 0.8));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    list.forEach((t, i) => { t.rows = Math.max(4, Math.floor(rows * weights[i] / weightSum)); });
  };
  // the owner's room mix: a fixed share of the rows in room threads (the other shapes spread every thread on one curve)
  const roomRest = rest.filter(t => t.kind === "room"), otherRest = rest.filter(t => t.kind !== "room");
  if (S.roomRowsShare > 0 && roomRest.length && otherRest.length) { spread(roomRest, left * S.roomRowsShare); spread(otherRest, left * (1 - S.roomRowsShare)); }
  else spread(rest, left);
  const plannedRows = threads.reduce((a, t) => a + t.rows, 0);
  log(`threads: ${threads.length}, planned rows ${plannedRows}`);

  // ---- messages, captured as they are written
  let written = 0;
  const color = (bot: any) => ({ botId: bot.id, name: bot.name, color: bot.color });
  const memberBot = (room: any, r: () => number) => store.bots.find((b: any) => b.id === pick(room.memberIds, r)) ?? sableBot;
  let oldCard = false;
  for (const [index, thread] of threads.entries()) {
    const r = generator(SEED ^ (index * 2654435761));
    const perTurn = thread.kind === "feed" ? 1 + S.chipsPerTurn : 2 + S.chipsPerTurn;
    const turns = Math.max(1, Math.floor(thread.rows / perTurn));
    const first = Math.max(START, thread.created), span = Math.max(DAY, END - first);
    let parent: string | null = null, batch: Row[] = [];
    const flush = () => { if (batch.length) { tx(() => writeRows(thread.id, batch)); written += batch.length; batch = []; } };
    for (let k = 0; k < turns; k++) {
      const at = first + Math.floor((k / turns) * span);
      clock = at;
      const from = thread.room ? color(memberBot(thread.room, r)) : undefined;
      const rows = turnRows(parent, at, between(Math.max(0, S.chipsPerTurn - 2), S.chipsPerTurn + 2, r), from, thread.kind === "feed", r);
      // one unanswered question card from about two years ago in the longest thread (SCALE-PLAN D2)
      if (thread === sableMain && !oldCard && at > START + 365 * DAY) {
        oldCard = true;
        rows.push({ id: seededUuid(), at: at + 1, parentId: rows[rows.length - 1].id, role: "bot", kind: "options", text: "Which vendor should I shortlist?", card: { requestId: `req-${seededUuid()}`, question: "Which vendor should I shortlist?", options: [{ label: "Acme" }, { label: "Globex" }] } });
      }
      batch.push(...rows); parent = rows[rows.length - 1].id;
      if (batch.length >= 20_000) flush();
    }
    flush();
    if (index % 200 === 0) log(`messages ${written}/${plannedRows} (${index}/${threads.length} threads, ${Math.round((realNow() - t0) / 1000)} s)`);
  }
  log(`messages written: ${written}`);

  // ---- memory: jobs done except a backlog, active records, checkpoints, waiting records
  quietCounters();
  tx(() => {
    db.exec(`UPDATE memory_jobs SET status='complete',cursor=COALESCE((SELECT length(CAST(json_extract(v.payload,'$.text') AS BLOB)) FROM memory_source_versions v WHERE v.source_id=memory_jobs.source_id AND v.revision=memory_jobs.source_revision),0),
      coverage='[]' WHERE status='pending'`);
    db.prepare(`UPDATE memory_jobs SET status='pending',cursor=0 WHERE rowid IN (SELECT rowid FROM memory_jobs ORDER BY rowid DESC LIMIT ?)`).run(S.pendingJobs);
  });
  const meta = () => db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get();
  const scopeOf = (kind: string, owner: string) => String(db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind, owner)?.id ?? "");
  const insertRecord = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,created_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)");
  const insertEvidence = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,?,?,?,0,?)");
  const insertProjection = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'indexed',?,NULL)");
  // sources spread over the given threads (a fixed pseudo-random order), the owner's words or the bots' replies
  const sourcesOf = (threadIds: string[], limit: number, speaker: "owner" | "any" = "any") => db.prepare(`SELECT s.id,s.revision,length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS bytes,json_extract(v.payload,'$.text') AS text
    FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.thread_id IN (SELECT value FROM json_each(?)) AND s.state='active' AND s.kind='text' AND (?='any' OR s.speaker=?) ORDER BY (s.rowid*2654435761)%1000003 LIMIT ?`).all(JSON.stringify(threadIds), speaker, speaker, limit);
  const indexed: Array<{ id: string; version: number; scopeId: string; text: string; deleted: boolean; archived: boolean }> = [];
  const activeByBot = new Map<string, Array<{ id: string; version: number; source: { id: string; revision: number } }>>();
  const vectorTargets: Array<{ id: string; version: number; scopeId: string; text: string; deleted: boolean; archived: boolean }> = [];
  for (const bot of store.bots) {
    const own = threads.filter(t => t.bot?.id === bot.id).map(t => t.id);
    const count = bot.id === sable.id ? S.sableActive : S.botActive;
    // facts rest on the owner's own words (never withheld by lineage); chunks on any captured line
    const sources = sourcesOf(own, Math.max(count, 1)), owned = sourcesOf(own, Math.max(count, 1), "owner");
    if (!sources.length || !owned.length) continue;
    const scope = scopeOf("bot", bot.id), list: Array<{ id: string; version: number; source: { id: string; revision: number } }> = [];
    tx(() => {
      for (let n = 0; n < count; n++) {
        const fact = n % 3 !== 0;
        const src = fact ? owned[n % owned.length] : sources[n % sources.length];
        const text = fact ? `${bot.name} remembers: ${String(src.text).slice(0, 180)}` : String(src.text).slice(0, 2000);
        const id = `scale-${fact ? "fact" : "chunk"}-${bot.name.replace(/\W/g, "")}-${n}`, at = START + Math.floor((n / count) * (END - START));
        insertRecord.run(id, 1, scope, fact ? "fact" : "source", text, fact ? "owner-statement" : "assistant-inference", "active", at, null, at);
        insertEvidence.run(id, 1, src.id, Number(src.revision), Math.min(Number(src.bytes), 2000));
        const vector = bot.id === sable.id && vectorTargets.length < S.vectors;
        insertProjection.run(id, 1, vector ? "indexed" : "unavailable");
        const entry = { id, version: 1, scopeId: scope, text, deleted: false, archived: false };
        indexed.push(entry); if (vector) vectorTargets.push(entry);
        list.push({ id, version: 1, source: { id: String(src.id), revision: Number(src.revision) } });
      }
      // other bots' vectors (an install-wide count past the 12k matrix cap)
      if (bot.id !== sable.id) for (const entry of indexed.slice(-Math.min(list.length, 50))) if (vectorTargets.length < S.vectors) vectorTargets.push(entry);
    });
    activeByBot.set(bot.id, list);
    // the direct thread's checkpoint: one active version, every older one archived (consolidate.ts refreshMemoryCheckpoint)
    const versions = bot.id === sable.id ? S.sableCheckpointVersions : S.botCheckpointVersions;
    const convo = scopeOf("conversation", bot.threadId);
    const cpId = threadCheckpointId(convo, bot.threadId);
    const cpSources = sourcesOf([bot.threadId], Math.min(versions + 4, 50_000));
    if (!cpSources.length || !convo) continue;
    tx(() => {
      for (let v = 1; v <= versions; v++) {
        const at = START + Math.floor((v / versions) * (END - START));
        const items = [0, 1, 2, 3].map(i => cpSources[(v + i * 7) % cpSources.length]);
        const text = "Working evidence; statements are not fulfilled commitments.\n" + items.map(item => `Assistant hypothesis (recorded): ${JSON.stringify(String(item.text).slice(0, 96))}`).join("\n");
        const last = v === versions;
        insertRecord.run(cpId, v, convo, "checkpoint", text, "assistant-inference", last ? "active" : "archived", at, last ? null : at + 60_000, at);
        const seen = new Set<string>();
        for (const item of items) { if (seen.has(String(item.id))) continue; seen.add(String(item.id)); insertEvidence.run(cpId, v, item.id, Number(item.revision), Math.min(96, Number(item.bytes))); }
        insertProjection.run(cpId, v, "unavailable");
        indexed.push({ id: cpId, version: v, scopeId: convo, text, deleted: false, archived: !last });
      }
    });
  }
  // vectors past the 12k matrix cap install-wide even in the small shape (records of any scope)
  const planned = new Set(vectorTargets);
  for (const entry of indexed) { if (vectorTargets.length >= S.vectors) break; if (!planned.has(entry)) vectorTargets.push(entry); }
  // waiting for the owner (Sable)
  const sableScope = scopeOf("bot", sable.id), sableSources = sourcesOf([sableBot.threadId], S.waiting);
  tx(() => { for (let n = 0; n < Math.min(S.waiting, sableSources.length); n++) {
    const id = `scale-wait-${n}`, at = END - n * 3_600_000;
    insertRecord.run(id, 1, sableScope, "fact", `Sean prefers the report to open with the three numbers that moved most (${n}).`, "assistant-inference", "candidate", at, null, at);
    insertEvidence.run(id, 1, sableSources[n].id, Number(sableSources[n].revision), Math.min(80, Number(sableSources[n].bytes)));
  } });
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  log(`records: ${indexed.length} (incl. checkpoint versions), vectors planned ${vectorTargets.length}`);

  // ---- receipts and lineage, thread by thread, sessions of a few dozen turns
  const totalTurns = threads.reduce((a, t) => a + Math.max(1, Math.floor(t.rows / (2 + S.chipsPerTurn))), 0);
  const receiptRate = Math.min(1, S.receiptsTotal / 1.5 / Math.max(1, totalTurns));
  quietCounters();
  const insertReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  const { policy_revision: policy, deletion_epoch: deletion } = meta();
  let receipts = 0, sessions = 0, rootCalls = 0;
  const readRows = db.prepare("SELECT id,role,kind,at,json_extract(json,'$.turnId') AS turn FROM messages WHERE thread_id=? ORDER BY rowid");
  // Room transcripts (the owner shape): a room reply is shown lines of its members' own threads written before it.
  const linesOf = new Map<string, Array<{ threadId: string; id: string; role: string; at: number }>>();
  const threadLines = (id: string) => { let l = linesOf.get(id); if (!l) { l = (readRows.all(id) as Array<{ id: string; role: string; at: number }>).map(x => ({ threadId: id, id: x.id, role: x.role, at: Number(x.at) })); linesOf.set(id, l); } return l; };
  const crossLines = (thread: Thread, at: number, count: number) => {
    const members: string[] = (thread.room?.memberIds ?? []).map((id: string) => store.bots.find((b: any) => b.id === id)?.threadId).filter(Boolean);
    if (!count || !members.length) return [];
    const each = Math.ceil(count / members.length), out: Array<{ threadId: string; id: string; role: string }> = [];
    for (const member of members) {
      const lines = threadLines(member);
      let lo = 0, hi = lines.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid].at < at) lo = mid + 1; else hi = mid; }
      for (const l of lines.slice(Math.max(0, lo - each), lo)) out.push({ threadId: l.threadId, id: l.id, role: l.role });
    }
    return out.slice(-count);
  };
  let receiptOutputs = 0;
  for (const [index, thread] of threads.entries()) {
    if (receipts >= S.receiptsTotal) break;
    const r = generator(SEED ^ 0xdead ^ (index * 40503));
    const rows = readRows.all(thread.id) as Array<{ id: string; role: string; kind: string; at: number; turn: string | null }>;
    // turns: the bot rows that share a turn id, with the owner row before them
    const turns: Array<{ bot: string[]; reply: string; at: number; lines: Array<{ threadId: string; id: string; role: string }> }> = [];
    let current: (typeof turns)[number] | null = null, lastTurn = "";
    for (const row of rows) {
      if (row.role === "bot" && row.turn && row.turn !== lastTurn) { current = { bot: [], reply: "", at: row.at, lines: [] }; turns.push(current); lastTurn = row.turn; }
      if (row.role === "bot" && current && row.turn === lastTurn) { current.bot.push(row.id); if (row.kind === "text") current.reply = row.id; }
      if (current) current.lines.push({ threadId: thread.id, id: row.id, role: row.role });
    }
    const driverBot = thread.bot ?? store.bots.find((b: any) => b.id === thread.room?.memberIds?.[0]) ?? sableBot;
    const driver = driverBot.modelSelection?.instanceId ?? "grok";
    const records = activeByBot.get(driverBot.id) ?? activeByBot.get(sable.id) ?? [];
    if (!records.length || !turns.length) continue;
    tx(() => {
      for (let s = 0; s < turns.length;) {
        const length = between(S.sessionTurns[0], S.sessionTurns[1], r), session = seededUuid(), part = turns.slice(s, s + length);
        s += length; sessions++;
        const revoked = r() < S.revokedFraction;
        const window: Array<{ threadId: string; id: string; role: string }> = [];
        const planned: Array<{ lookup: boolean; unique: typeof records; at: number }> = [], made: number[] = [];
        part.forEach((turn, k) => {
          let count = 0;
          if (r() < receiptRate) {
            for (const lookup of r() < 0.5 ? [false, true] : [false]) {
              const cited = Array.from({ length: lookup ? between(1, 3, r) : between(6, 20, r) }, () => pick(records, r));
              planned.push({ lookup, unique: [...new Map(cited.map(c => [c.id, c])).values()], at: turn.at });
              count++;
            }
          }
          made.push(count);
          // the reply rests on what its context carried (replay-lineage.ts): real lineage writes; a room reply was
          // also shown its members' own threads (room-transcript.ts)
          if (turn.reply && k % S.rootStride === 0) {
            const shown = thread.room && S.crossThreadLines ? [...crossLines(thread, turn.at, S.crossThreadLines), ...window.slice(-S.hotWindow)] : window.slice(-S.hotWindow);
            lineage.recordOutputRoots(thread.id, turn.reply, rootsFor(shown)); rootCalls++;
          }
          window.push(...turn.lines);
        });
        // the receipts' final output lists, as the RC writer leaves them (each row on its turn's receipt and the session's newest)
        const outputs = rcReceiptOutputs(part.map((turn, k) => ({ bot: turn.bot, receipts: made[k] })));
        planned.forEach(({ lookup, unique, at }, i) => {
          insertReceipt.run(seededUuid(), thread.id, driver, session, JSON.stringify(unique.map(c => ({ id: c.id, version: c.version }))), JSON.stringify(unique.map(c => c.source)), JSON.stringify(outputs[i]),
            revoked ? Math.max(0, Number(policy) - 1) : policy, deletion, lookup ? 120 : 900, revoked ? "revoked" : "delivered", at);
          receipts++; receiptOutputs += outputs[i].length;
        });
        lineage.recordSessionRoots(thread.id, driver, session, rootsFor(window.slice(-S.hotWindow)));
      }
    });
    if (index % 200 === 0) log(`receipts ${receipts}/${S.receiptsTotal}, sessions ${sessions}, root calls ${rootCalls} (${index}/${threads.length} threads, ${Math.round((realNow() - t0) / 1000)} s)`);
  }
  log(`receipts: ${receipts} in ${sessions} sessions (${receiptOutputs} receipt outputs), ${rootCalls} reply root sets`);

  // ---- routines: definitions plus a full run history, in the pre-0.1.62 file shape every tree migrates
  const routines = Array.from({ length: S.routines }, (_, i) => {
    const bot = store.bots[i % store.bots.length];
    return { id: seededUuid(), name: `Routine ${i}: ${pick(TOPICS)}`, prompt: `Check ${pick(TOPICS)} and post a two line summary.`, target: "bot", botId: bot.id, runOn: "ember", enabled: false,
      schedule: { type: "interval", everyMinutes: i % 2 ? 60 : 15, anchorAt: START }, durationMinutes: 30, createdAt: START, updatedAt: START };
  });
  const runs = Array.from({ length: S.routineRuns }, (_, n) => {
    const routine = routines[n % routines.length], at = END - (S.routineRuns - n) * 1_800_000;
    return { id: seededUuid(), routineId: routine.id, routineName: routine.name, prompt: routine.prompt, target: "bot", botId: routine.botId, scheduledFor: at, status: "completed", trigger: "schedule", createdAt: at, startedAt: at + 900, finishedAt: at + 45_000, seenAt: at + 60_000 };
  });
  writeFileSync(join(DATA, "routines.json"), JSON.stringify({ version: 1, routines, runs }, null, 1), { mode: 0o600 });

  // ---- the word index (every record version, archived ones included) and vectors past the 12k matrix cap
  closeDatabase();
  const index = new MemoryIndex(join(DATA, "memory-index.db"));
  try {
    for (let at = 0; at < indexed.length; at += 500) index.upsert(indexed.slice(at, at + 500));
    const manifest = JSON.parse(readFileSync(join(WORK, "shared/memory-model-manifest.json"), "utf8"));
    const model = `${manifest.model}@${manifest.revision}`, dims = Number(manifest.dimensions ?? 384);
    const vr = generator(SEED ^ 0x7ec);
    for (const entry of vectorTargets) {
      const values = Array.from({ length: dims }, () => vr() * 2 - 1);
      const norm = Math.sqrt(values.reduce((a, b) => a + b * b, 0));
      index.vector(entry, model, 0, values.map(v => v / norm));
    }
  } finally { index.close(); }
  const check = database();
  check.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  writeFileSync(join(DATA, "scale-gen.json"), JSON.stringify({ shape: SHAPE_NAME, seed: SEED, start: START, end: END, sage: { botId: sable.id, threadId: sableBot.threadId }, schema: schema.MEMORY_SCHEMA_VERSION, autoVacuumOff: Boolean(S.autoVacuumOff), baseSeconds: Math.round((realNow() - t0) / 1000) }, null, 1));
  log(`base done in ${Math.round((realNow() - t0) / 1000)} s`);
}

// ================================================================== hot: the resumed Sable session
async function hot() {
  const t0 = realNow();
  const gen = JSON.parse(readFileSync(join(DATA, "scale-gen.json"), "utf8"));
  const bots = JSON.parse(readFileSync(join(DATA, "bots.json"), "utf8"));
  const list = Array.isArray(bots) ? bots : bots.bots;
  const sable = list.find((b: any) => b.id === gen.sage.botId);
  const task = (sable.tasks ?? []).find((t: any) => t.threadId === sable.threadId) ?? {};
  const instance = sable.modelSelection?.instanceId ?? "grok";
  const session = task.resumeCursors?.[instance] ?? sable.resumeCursors?.[instance];
  if (typeof session !== "string" || !session) throw new Error("hot: Sable has no resumed session; run the prime step (rig.mjs --prime) first");
  const thread = sable.threadId;
  const leaf = db.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(thread)?.id ?? null;
  const { policy_revision: policy, deletion_epoch: deletion } = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get();
  const scope = String(db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(sable.id)?.id);
  // what the session was shown: Sable's facts resting on the owner's words in this thread (valid when shown)
  const records = db.prepare(`SELECT r.id,r.version,e.source_id,e.source_revision FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version
    JOIN memory_sources s ON s.id=e.source_id WHERE r.scope_id=? AND r.state='active' AND r.kind='fact' AND s.speaker='owner' AND s.thread_id=? LIMIT 5000`).all(scope, thread) as Array<{ id: string; version: number; source_id: string; source_revision: number }>;
  if (!records.length) throw new Error("hot: no active Sable records");
  const turnsCount = Math.ceil(S.hotReceipts / 1.5);
  const r = generator(SEED ^ 0x407);
  // The session's turns happened just now, after the prime turns and before the rig starts.
  const startAt = realNow() - turnsCount * 30;
  const turns: Array<{ rows: Row[]; bot: string[]; reply: string; at: number }> = [];
  let parent: string | null = leaf;
  for (let k = 0; k < turnsCount; k++) {
    const rows = turnRows(parent, startAt + k * 30, S.hotChips, undefined, false, r);
    rows.forEach((row, i) => { row.at = startAt + k * 30 + Math.min(i, 29); });
    parent = rows[rows.length - 1].id;
    turns.push({ rows, bot: rows.filter(x => x.role === "bot").map(x => x.id), reply: rows[rows.length - 1].id, at: rows[0].at });
  }
  quietCounters();
  tx(() => { for (let k = 0; k < turns.length; k += 200) writeRows(thread, turns.slice(k, k + 200).flatMap(t => t.rows)); });
  log(`hot: ${turns.length} turns, ${turns.reduce((a, t) => a + t.rows.length, 0)} rows on session ${session.slice(0, 8)}…`);
  // Receipts: a frame per turn plus a lookup companion every other turn, until hotReceipts. Each bot row is listed on its
  // turn's frame and the session's newest receipt: the final state of the RC linkMemoryDisclosureOutput (rcReceiptOutputs).
  const insertReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'delivered',?)");
  let receipts = 0;
  const made = turns.map((_, k) => { const n = Math.max(0, Math.min(k % 2 === 0 ? 2 : 1, S.hotReceipts - receipts)); receipts += n; return n; });
  const outputs = rcReceiptOutputs(turns.map((t, k) => ({ bot: t.bot, receipts: made[k] })));
  tx(() => {
    let i = 0;
    for (let k = 0; k < turns.length; k++) {
      for (let n = 0; n < made[k]; n++, i++) {
        const lookup = n === 1;
        const cited = [...new Map(Array.from({ length: lookup ? between(1, 3, r) : between(8, 20, r) }, () => pick(records, r)).map(c => [c.id, c])).values()];
        insertReceipt.run(seededUuid(), thread, instance, session, JSON.stringify(cited.map(c => ({ id: c.id, version: c.version }))), JSON.stringify(cited.map(c => ({ id: c.source_id, revision: c.source_revision }))), JSON.stringify(outputs[i]), policy, deletion, lookup ? 120 : 900, turns[k].at);
      }
    }
  });
  log(`hot: ${receipts} receipts written (${Math.round((realNow() - t0) / 1000)} s)`);
  // Lineage: every bot row rests on the context window before its turn; the session holds the union.
  const window: Array<{ threadId: string; id: string; role: string }> = [];
  let calls = 0;
  for (const [k, turn] of turns.entries()) {
    tx(() => {
      const roots = rootsFor(window.slice(-S.hotWindow));
      for (const id of turn.bot) { lineage.recordOutputRoots(thread, id, roots); calls++; }
      lineage.recordSessionRoots(thread, instance, session, roots);
    });
    window.push(...turn.rows.map(row => ({ threadId: thread, id: row.id, role: row.role })));
    if (k % 100 === 0) log(`hot lineage ${k}/${turns.length} (${Math.round((realNow() - t0) / 1000)} s)`);
  }
  const size = db.prepare("SELECT r.size FROM memory_session_roots s JOIN memory_root_sets r ON r.set_id=s.set_id WHERE s.thread_id=? AND s.driver_instance=? AND s.native_session=?").get(thread, instance, session);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  const out = { ...gen, hot: { session, turns: turns.length, receipts, rootCalls: calls, sessionRoots: Number(size?.size ?? -1), seconds: Math.round((realNow() - t0) / 1000) } };
  writeFileSync(join(DATA, "scale-gen.json"), JSON.stringify(out, null, 1));
  log(`hot done: session roots ${out.hot.sessionRoots}, ${out.hot.seconds} s`);
}

// ================================================================== manifest
function manifest() {
  const one = (sql: string) => { try { return db.prepare(sql).get(); } catch (error) { return String((error as Error).message); } };
  const size = (name: string) => { try { return statSync(join(DATA, name)).size; } catch { return 0; } };
  const out = {
    gen: existsSync(join(DATA, "scale-gen.json")) ? JSON.parse(readFileSync(join(DATA, "scale-gen.json"), "utf8")) : null,
    messages: one("SELECT count(*) AS n, count(DISTINCT thread_id) AS threads, sum(length(json)) AS bytes FROM messages"),
    longest: one("SELECT thread_id, count(*) AS n FROM messages GROUP BY thread_id ORDER BY n DESC LIMIT 1"),
    sources: one("SELECT count(*) AS n FROM memory_sources"),
    records: one("SELECT count(*) AS n, sum(state='active') AS active, sum(state='archived') AS archived, sum(kind='checkpoint') AS checkpoints FROM memory_records"),
    receipts: one("SELECT count(*) AS n, sum(state='revoked') AS revoked FROM memory_disclosures"),
    receiptOutputs: one("SELECT count(*) AS n, count(DISTINCT message_id) AS outputs, round(count(*) * 1.0 / max(1, count(DISTINCT message_id)), 2) AS receiptsPerOutput FROM memory_disclosure_outputs"),
    autoVacuum: one("PRAGMA auto_vacuum"),
    rootSets: one("SELECT count(*) AS n, max(size) AS largest FROM memory_root_sets"),
    rootMembers: one("SELECT count(*) AS n FROM memory_root_set_members"),
    sessions: one("SELECT count(*) AS n FROM memory_session_roots"),
    jobs: one("SELECT sum(status='pending') AS pending, count(*) AS n FROM memory_jobs"),
    meta: one("SELECT schema_version,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta"),
    files: { messagesDb: size("messages.db"), messagesWal: size("messages.db-wal"), memoryIndex: size("memory-index.db"), bots: size("bots.json"), routines: size("routines.json") },
  };
  closeDatabase();
  console.log("MANIFEST " + JSON.stringify(out));
}

if (pass === "base") await base();
else if (pass === "hot") await hot();
else manifest();
process.exit(0);
