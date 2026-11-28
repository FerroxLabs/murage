// FRICTION GATE witnesses. Every case enters through the release-kit step (scripts/release-kit/05f-friction.sh) with a run dir
// of real-format server.log lines, exactly as the canary hands it over. Assertions tagged "// T:<id>" are the mutant targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STEP = path.join(here, "..", "release-kit", "05f-friction.sh");
const T0 = "2026-11-27T12:00:00.000Z", T1 = "2026-11-27T12:05:00.000Z";
const IN = "2026-11-27T12:02:00.000Z", OUT = "2026-11-27T12:09:00.000Z";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friction-"));
let n = 0;

function run(logLines, { tasks, transcripts, prev, history, budget = 99, record = false, version = "9.9.9", prevVersion } = {}) {
  const dir = path.join(tmp, `r${++n}`); fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify(tasks ?? [{ id: "t1", engine: "claude", t0: T0, t1: T1, ok: true }]));
  fs.writeFileSync(path.join(dir, "server.log"), logLines.join("\n") + "\n");
  for (const [id, rows] of Object.entries(transcripts ?? {})) fs.writeFileSync(path.join(dir, "transcripts", `${id}.json`), JSON.stringify(rows));
  const scores = path.join(dir, "scores.json"), bfile = path.join(dir, "budget.json");
  fs.writeFileSync(scores, JSON.stringify(history ? { "linux/fresh": history } : prev ? { "linux/fresh": { "9.9.8": prev } } : {}));
  fs.writeFileSync(bfile, JSON.stringify({ "linux/fresh": budget }));
  const env = { ...process.env, FRICTION_SCORES: scores, FRICTION_BUDGET: bfile, ...(record ? { FRICTION_RECORD: "1" } : {}) };
  if (process.env.FRICTION_SCORER) env.FRICTION_SCORER = process.env.FRICTION_SCORER;
  const r = spawnSync("bash", [STEP, version, "linux", "fresh", dir, ...(prevVersion !== undefined ? [prevVersion] : [])], { env, encoding: "utf8" });
  const line = (r.stdout.match(/^FRICTION-SCORE .*$/m) ?? [""])[0];
  const total = Number((/ linux fresh (\d+) /.exec(line) ?? [])[1] ?? NaN);
  return { r, line, total, dir, scores };
}
const L = (iso, text) => `[${iso}] [out] ${text}`;

// One row per production marker site (FRICTION-1025 s5 table). line = real log shape from server/*.ts at b99bdb6a0e.
const SITES = [
  ["card", 2, L(IN, "approvals: asked bot=b1 tool=Read reason=ask origin=owner unattended=0 cmd=- level=ask owner=1 suppressed=0")],
  ["folder-trust", 2, L(IN, "acp close thread=th1 reason=folder-trust-card")],
  ["refusal ledger", 3, L(IN, "[memory] ledger refusal cause=checking:not-built")],
  ["refusal native fence", 3, L(IN, "native fence refusal engine=codex sink=stdin termination=closed")],
  ["refusal dispatch", 3, L(IN, "[turn] dispatch preparation failed on thread th1: memory not ready")],
  ["rebuild revoked", 2, L(IN, "[memory] context revoked at a late submission on thread th1; re-preparing (1 of 2)")],
  ["rebuild reset", 2, L(IN, "memory continuation reset thread=th1 engine=e1 reason=audience-changed")],
  ["held", 3, L(IN, "[owner-held] reply on thread th1 held back for the owner: masked")],
  ["busy send route", 3, L(IN, "[busy] route=POST /api/threads/th1/send op=sqlite waited=5000 holder=other err=locked")],
  ["banner fence omitted", 1, L(IN, "[memory] fence recovery tier=2 thread=th1 refused=x omitted=3")],
  ["banner recall off", 1, L(IN, "turn dispatch recall=off thread=th1")],
  ["banner browser", 1, L(IN, "[browser] continuing this turn without the browser: closing")],
];

for (const [name, weight, line] of SITES) {
  test(`site ${name} scores ${weight}`, () => {
    const { total, line: v } = run([line]);
    assert.equal(total, weight, v); // T:site
  });
}

test("non-friction lines score nothing: recall=full, fence omitted=0, busy off a send route", () => {
  const { total, line } = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1"), L(IN, "turn dispatch recall=full thread=th1"), L(IN, "[memory] fence recovery tier=1 thread=th1 refused=x omitted=0"),
    L(IN, "[busy] route=GET /api/bots op=sqlite waited=1 holder=other err=x")]);
  assert.equal(total, 2, line); // T:quiet
});

test("wipe-check and question-tool asks are edge rows, not friction", () => {
  const { total, line } = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1"), L(IN, "approvals: asked bot=b1 tool=Bash reason=always-ask:wipe origin=owner owner=1"),
    L(IN, "approvals: asked bot=b1 tool=Ask reason=question-tool origin=owner owner=1")]);
  assert.equal(total, 2, line); // T:edge
});

test("lines outside the task window belong to no task", () => {
  const { total, line } = run([L(OUT, "[memory] ledger refusal cause=x"), L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")]);
  assert.equal(total, 2, line); // T:window
});

test("transcript markers score and a log+transcript pair for one event counts once", () => {
  const tr = { t1: [{ role: "bot", actorKind: "murage", text: "Local control is off, so this bot can't use the computer yet." },
    { role: "bot", text: "I stopped this turn because some of its context is no longer available." }] };
  const a = run([], { transcripts: tr });
  assert.equal(a.total, 4, a.line); // T:transcript
});

test("one event seen in both server.log and the transcript counts once", () => {
  const tr = { t1: [{ role: "bot", text: "I stopped this turn because some of its context is no longer available." }] };
  const b = run([L(IN, "[memory] ledger refusal cause=x")], { transcripts: tr });
  assert.equal(b.total, 3, b.line); // T:dedup
});

test("a recall banner in the log and a Local-control banner in the transcript are two events", () => {
  const tr = { t1: [{ role: "bot", actorKind: "murage", text: "Local control is off, so this bot can't use the computer yet." }] };
  const r2 = run([L(IN, "turn dispatch recall=off thread=th1")], { transcripts: tr });
  assert.equal(r2.total, 2, r2.line); // T:distinct
});

// server/auto-approve.ts:995 prints origin=<asker> and owner=<context.ownerStarted>: a real owner card can carry owner=0.
const OWNER_CARD_OWNER0 = "approvals: asked bot=b1 tool=shell reason=unread-call:U20 origin=owner unattended=0 cmd=shell level=full owner=0 held=unread suppressed=0";
test("an owner card that logs owner=0 still scores; a card from another asker does not", () => {
  const o = run([L(IN, OWNER_CARD_OWNER0)]);
  assert.equal(o.total, 2, o.line); // T:ownercard
});

test("a card from another asker is not owner friction", () => {
  // a run the owner started (owner=1) can still get a card for another asker's call: origin names the asker
  const g = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask origin=other unattended=0 cmd=- level=ask owner=1 suppressed=0")]);
  assert.equal(g.total, 0, g.line); // T:guest
});

test("an event in overlapping task windows counts once", () => {
  const two = [{ id: "t1", engine: "claude", t0: T0, t1: T1, ok: true }, { id: "t2", engine: "claude", t0: T0, t1: T1, ok: true }];
  const o = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { tasks: two });
  assert.equal(o.total, 2, o.line); // T:overlap
  assert.equal(o.r.status, 0, o.line);
});

// electron/main.mjs slog() stamps one prefix per data chunk: the later lines of a chunk carry no stamp (real logs: win-1020 server.log:100-101).
test("an unstamped line of a multi-line chunk belongs to the instant of the stamped line above it", () => {
  const a = run([L(IN, "native fence refusal engine=codex sink=stdin termination=closed"), "[memory] ledger refusal cause=checking:not-built", "turn dispatch recall=off thread=th1"]);
  assert.equal(a.total, 7, a.line); // T:chunk
});

test("an unstamped line after a stamped line outside the window stays outside it", () => {
  const b = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1"), L(OUT, "noise"), "[memory] ledger refusal cause=checking:not-built"]);
  assert.equal(b.total, 2, b.line); // T:chunkout
});

test("a friction line before any stamp cannot be attributed and fails the run", () => {
  const { r, line } = run(["[memory] ledger refusal cause=checking:not-built", L(IN, "noise")]);
  assert.equal(r.status, 1, line); // T:unattrib
  assert.match(line, /unattributable:server\.log:1/);
});

test("a task window with no stamped server.log line fails the run", () => {
  const { r, line } = run([L(OUT, "noise"), "[memory] ledger refusal cause=x"]);
  assert.equal(r.status, 1, line); // T:nolog
  assert.match(line, /no-log:t1/);
});

test("a hanging task scores 3 and fails the gate even inside budget", () => {
  const { r, total, line } = run([L(IN, "noise")], { tasks: [{ id: "t1", engine: "claude", t0: T0, t1: T1, ok: false, hang: true }] });
  assert.equal(total, 3, line); // T:hang
  assert.equal(r.status, 1); // T:hangfail
  assert.match(line, /task-failed:t1/);
});

test("a run that measured no task never passes", () => {
  const empty = run([L(IN, "noise")], { tasks: [] });
  assert.equal(empty.r.status, 1, empty.line); // T:empty
  assert.match(empty.line, /task-failed:no-tasks/);
});

test("a task with no usable window never passes", () => {
  const bad = run([L(IN, "noise")], { tasks: [{ id: "t1", engine: "claude", t0: "never", t1: T1, ok: true }] });
  assert.equal(bad.r.status, 1, bad.line); // T:badwindow
  assert.match(bad.line, /bad-window:t1/);
});

test("any increase over the previous release fails; equal passes", () => {
  const up = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1"), L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { prev: { total: 2, byKind: { card: 2 }, tasks: 1 } });
  assert.equal(up.r.status, 1, up.line); // T:increase
  assert.match(up.line, /increase:4>2/);
  const same = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { prev: { total: 2, byKind: { card: 2 }, tasks: 1 } });
  assert.equal(same.r.status, 0, same.line); // T:equal
});

test("a run with a different task count than the previous release fails", () => {
  const { r, line } = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { prev: { total: 2, byKind: { card: 2 }, tasks: 2 } });
  assert.equal(r.status, 1, line); // T:tasklist
  assert.match(line, /task-list-changed:1!=2/);
});

test("a swapped task or engine with the same count fails the same-task-list check", () => {
  const card = L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1");
  const a = run([card], { prev: { total: 2, byKind: { card: 2 }, tasks: 1, taskList: ["t9:claude"] } });
  assert.equal(a.r.status, 1, a.line); // T:tasklistswap
  assert.match(a.line, /task-list-changed:1!=1/);
  const b = run([card], { prev: { total: 2, byKind: { card: 2 }, tasks: 1, taskList: ["t1:claude"] } });
  assert.equal(b.r.status, 0, b.line);
});

test("the previous release is the highest version, not the last one inserted", () => {
  const { r, line } = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { version: "9.9.11", history: { "9.9.10": { total: 9, byKind: { card: 9 }, tasks: 1 }, "9.9.2": { total: 0, byKind: {  }, tasks: 1 } } });
  assert.match(line, /prev=9 /, line); // T:prevorder
  assert.equal(r.status, 0, line);
});

test("an explicitly requested previous release with no record fails instead of skipping the comparisons", () => {
  const card = L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1");
  const { r, line } = run([card], { history: { "9.9.7": { total: 2, byKind: { card: 2 } } }, prevVersion: "9.9.8" });
  assert.equal(r.status, 1, line); // T:prevmissing
  assert.match(line, /prev-missing:9\.9\.8/, line);
  const ok = run([card], { history: { "9.9.7": { total: 2, byKind: { card: 2 }, tasks: 1 } }, prevVersion: "9.9.7" });
  assert.equal(ok.r.status, 0, ok.line);
  const proto = run([card], { history: { "9.9.7": { total: 2, byKind: { card: 2 } } }, prevVersion: "constructor" });
  assert.equal(proto.r.status, 1, proto.line);
  assert.match(proto.line, /prev-missing:constructor/, proto.line); // T:prevproto
});

test("a zero-event run asking for an unknown-name previous release still fails, nothing else can fail it", () => {
  const zero = run([L(IN, "noise")], { history: {}, prevVersion: "constructor" }); // zero events: nothing else can fail it
  assert.equal(zero.r.status, 1, zero.line); // T:prevprotozero
  assert.match(zero.line, /prev-missing:constructor/, zero.line);
});

test("a requested previous release whose record is malformed fails closed, even for a zero-event run", () => {
  // total + byKind alone is not a record either: without a task list the same-tasks check cannot run
  for (const bad of [{}, { total: 0 }, { total: "0", byKind: {} }, { total: 0, byKind: null }, { total: 0, byKind: {} }, { byKind: {}, taskList: ["t1:claude"] }, null]) {
    const z = run([L(IN, "noise")], { history: { "9.9.7": bad }, prevVersion: "9.9.7" });
    assert.equal(z.r.status, 1, z.line); // T:prevmalformed
    assert.match(z.line, /prev-missing:9\.9\.7/, z.line);
  }
  const good = run([L(IN, "noise")], { history: { "9.9.7": { total: 0, byKind: {}, tasks: 1 } }, prevVersion: "9.9.7" });
  assert.equal(good.r.status, 0, good.line);
});

test("with no --prev-version a malformed newest record fails closed instead of skipping the comparison", () => {
  const auto = run([L(IN, "noise")], { history: { "9.9.7": {} } });
  assert.equal(auto.r.status, 1, auto.line); // T:prevmalformedauto
});

test("with no --prev-version a null newest record fails closed", () => {
  const nul = run([L(IN, "noise")], { history: { "9.9.7": null } });
  assert.equal(nul.r.status, 1, nul.line); // T:prevmalformednull
  assert.match(nul.line, /prev-missing:9\.9\.7/, nul.line);
});

test("an empty previous-release argument is a requested comparison with no name and fails closed", () => {
  const card = L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1");
  const empty = run([card], { history: {}, prevVersion: "" });
  assert.equal(empty.r.status, 1, empty.line); // T:prevempty
  assert.match(empty.line, /NO-PREV FAIL/, empty.line);
});

test("a new event kind fails even when the total did not go up", () => {
  const { r, line } = run([L(IN, "turn dispatch recall=off thread=th1")], { prev: { total: 5, byKind: { card: 5 }, tasks: 1 } });
  assert.equal(r.status, 1, line); // T:newkind
  assert.match(line, /new-kind:banner/);
});

test("over the baseline budget fails even when not above the previous release", () => {
  const { r, line } = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { prev: { total: 9, byKind: { card: 9 }, tasks: 1 }, budget: 0 });
  assert.equal(r.status, 1, line); // T:budget
  assert.match(line, /over-budget:2>0/);
});

test("missing run inputs fail closed", () => {
  const dir = path.join(tmp, "nb"); fs.mkdirSync(dir);
  const r = spawnSync("bash", [STEP, "9.9.9", "linux", "fresh", dir], { encoding: "utf8" });
  assert.equal(r.status, 1); // T:noinput
  assert.match(r.stdout, /NO-INPUT FAIL/);
});

test("an os/profile row with no budget entry fails closed", () => {
  const a = run([L(IN, "noise")]); // budget.json written by run() holds only linux/fresh
  const r = spawnSync("bash", [STEP, "9.9.9", "windows", "fresh", a.dir], { env: { ...process.env, FRICTION_BUDGET: path.join(a.dir, "budget.json"), FRICTION_SCORES: a.scores }, encoding: "utf8" });
  assert.equal(r.status, 1); // T:nobudget
  assert.match(r.stderr, /NO-BUDGET FAIL/);
});

test("--record persists the score and the next version is judged against it", () => {
  const first = run([L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1")], { record: true, version: "9.9.9" });
  const rec = JSON.parse(fs.readFileSync(first.scores, "utf8"));
  assert.equal(rec["linux/fresh"]?.["9.9.9"]?.total, 2); // T:record
  const dir = path.join(tmp, "next"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([{ id: "t1", engine: "claude", t0: T0, t1: T1, ok: true }]));
  fs.writeFileSync(path.join(dir, "server.log"), [L(IN, "approvals: asked bot=b1 tool=Read reason=ask owner=1"), L(IN, "turn dispatch recall=held thread=th1")].join("\n") + "\n");
  const bfile = path.join(dir, "b.json"); fs.writeFileSync(bfile, JSON.stringify({ "linux/fresh": 99 }));
  const env = { ...process.env, FRICTION_SCORES: first.scores, FRICTION_BUDGET: bfile }; if (process.env.FRICTION_SCORER) env.FRICTION_SCORER = process.env.FRICTION_SCORER;
  const r2 = spawnSync("bash", [STEP, "9.9.10", "linux", "fresh", dir], { env, encoding: "utf8" });
  assert.equal(r2.status, 1, r2.stdout); // T:chain
  assert.match(r2.stdout, /prev=2 .*increase:3>2/);
});

test("a FAIL run is never recorded as the next release's baseline", () => {
  const f = run([L(IN, "[memory] ledger refusal cause=x")], { record: true, budget: 0 });
  assert.equal(f.r.status, 1, f.line);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.scores, "utf8")), {}); // T:recordfail
});

test("the step needs the scorer verdict line", () => {
  const dir = path.join(tmp, "nv"); fs.mkdirSync(dir);
  const mute = path.join(dir, "mute.mjs"); fs.writeFileSync(mute, "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "tasks.json"), "[]"); fs.writeFileSync(path.join(dir, "server.log"), "\n");
  const r = spawnSync("bash", [STEP, "9.9.9", "linux", "fresh", dir], { env: { ...process.env, FRICTION_SCORER: mute }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout); // T:noverdict
  assert.match(r.stdout, /NO-VERDICT FAIL/);
});

test("the scorer runs through a symlinked, space-containing path", () => {
  const dir = path.join(tmp, "sl"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([{ id: "t1", engine: "claude", t0: T0, t1: T1, ok: true }])); fs.writeFileSync(path.join(dir, "server.log"), L(IN, "noise") + "\n");
  const real = process.env.FRICTION_SCORER ?? path.join(here, "friction-score.mjs");
  const link = path.join(dir, "link dir"); fs.mkdirSync(link); fs.symlinkSync(real, path.join(link, "friction-score.mjs"));
  const bfile = path.join(dir, "b.json"); fs.writeFileSync(bfile, JSON.stringify({ "linux/fresh": 99 }));
  const s = spawnSync("bash", [STEP, "9.9.9", "linux", "fresh", dir], { env: { ...process.env, FRICTION_SCORER: path.join(link, "friction-score.mjs"), FRICTION_BUDGET: bfile, FRICTION_SCORES: path.join(dir, "s.json") }, encoding: "utf8" });
  assert.match(s.stdout, /^FRICTION-SCORE 9\.9\.9 linux fresh 0 /m, s.stdout); // T:symlink
});

test("friction.tsv lists every event with its server.log line", () => {
  const { dir } = run([L(IN, "noise"), L(IN, "[memory] ledger refusal cause=x")]);
  assert.ok(fs.existsSync(path.join(dir, "friction.tsv")), "friction.tsv written"); // T:tsvfile
  const rows = fs.readFileSync(path.join(dir, "friction.tsv"), "utf8").trim().split("\n");
  assert.equal(rows.length, 2);
  assert.match(rows[1], /^t1\tclaude\trefusal\t\[memory\] ledger refusal cause=\t3\tserver\.log:2$/); // T:tsvref
});

// Marker drift: the scorer can only count what the product still prints. Each log marker must still be emitted by production source.
test("every log marker is still emitted by production code", () => {
  const root = path.join(here, "..", "..");
  const src = ["server/auto-approve.ts", "server/index.ts", "server/ledger-refusal.ts", "server/drivers/engine-input.ts", "server/drivers/acp/core.ts", "server/consuming-turn-response.ts"]
    .map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
  for (const m of ["approvals: asked bot=", "reason=folder-trust-card", "[memory] ledger refusal cause=", "native fence refusal", "[turn] dispatch preparation failed on thread",
    "context revoked at a late submission", "memory continuation reset", "[owner-held] reply on thread", "[busy] route=", "fence recovery tier=", "turn dispatch recall=", "continuing this turn without the browser"]) {
    assert.ok(src.includes(m === "reason=folder-trust-card" ? "folder-trust-card" : m), `marker gone from product: ${m}`); // T:drift
  }
});
