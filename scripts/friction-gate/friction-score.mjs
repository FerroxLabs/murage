#!/usr/bin/env node
// FRICTION GATE scorer (FRICTION-1025.md section 5). Owners: scorer, markers, weights, budget.json and scores.json = this
// file's lane (q1024-frictiongate); the canary driver that produces tasks.json + server.log + transcripts = the release
// canary seat (REL); the budget policy (which edge rows a script may trigger on purpose) = MAIN.
//
// Run dir contract (one dir per OS x profile):
//   tasks.json            [{ id, engine, t0, t1, ok, hang? }]   t0/t1 ISO instants of the owner task; owner turns only
//   server.log            lines start "[<ISO>] "; each line is attributed to the task whose [t0,t1] holds its instant
//   transcripts/<id>.json optional, array of { role, actorKind?, text } for that task
// Counting: refusal/held/busy are reported by both sources for one event, so their count = max(log hits, transcript hits);
// every other kind sums both sources (a log note and a transcript banner are different events). A log line is claimed by one task only. Weights are the section 5 table.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEIGHTS = { card: 2, "folder-trust": 2, refusal: 3, rebuild: 2, held: 3, busy: 3, banner: 1, hang: 3 };

const SEND_ROUTE = /route=POST \/\S*(send|message|turn|chat)/i;
// owner= is context.ownerStarted, not "who is asking": real owner cards log origin=owner ... owner=0. Only origin names the asker.
const NON_OWNER_ORIGIN = /\borigin=(other|guest|other-human)\b/;
const LOG_RULES = [
  { kind: "folder-trust", marker: "reason=folder-trust-card", test: (l) => l.includes("reason=folder-trust-card") },
  { kind: "card", marker: "approvals: asked bot=", test: (l) => l.includes("approvals: asked bot=") && !NON_OWNER_ORIGIN.test(l) && !l.includes("reason=folder-trust-card") && !l.includes("reason=always-ask:") && !l.includes("reason=question-tool") },
  { kind: "refusal", marker: "[memory] ledger refusal cause=", test: (l) => l.includes("[memory] ledger refusal cause=") },
  { kind: "refusal", marker: "native fence refusal", test: (l) => l.includes("native fence refusal") },
  { kind: "refusal", marker: "[turn] dispatch preparation failed on thread", test: (l) => l.includes("[turn] dispatch preparation failed on thread") },
  { kind: "rebuild", marker: "context revoked at a late submission", test: (l) => l.includes("context revoked at a late submission") },
  { kind: "rebuild", marker: "memory continuation reset", test: (l) => l.includes("memory continuation reset") },
  { kind: "held", marker: "[owner-held] reply on thread", test: (l) => l.includes("[owner-held] reply on thread") },
  { kind: "busy", marker: "[busy] route=POST", test: (l) => l.includes("[busy] route=") && SEND_ROUTE.test(l) },
  { kind: "banner", marker: "fence recovery tier=", test: (l) => /fence recovery tier=.*\bomitted=([1-9]\d*)/.test(l) },
  { kind: "banner", marker: "turn dispatch recall=", test: (l) => /turn dispatch recall=(held|off|withheld)\b/.test(l) },
  { kind: "banner", marker: "continuing this turn without the browser", test: (l) => l.includes("continuing this turn without the browser") },
];
const TRANSCRIPT_RULES = [
  { kind: "refusal", marker: "I stopped this turn because", test: (m) => String(m.text ?? "").includes("I stopped this turn because") },
  { kind: "refusal", marker: "Murage couldn't start this reply", test: (m) => String(m.text ?? "").includes("Murage couldn't start this reply") },
  { kind: "held", marker: "Murage held back this message", test: (m) => String(m.text ?? "").includes("Murage held back this message") },
  { kind: "busy", marker: "Busy for a moment", test: (m) => String(m.text ?? "").includes("Busy for a moment") },
  { kind: "banner", marker: "actorKind:murage", test: (m) => m.actorKind === "murage" && !/I stopped this turn because|Murage couldn't start this reply|Murage held back this message|Busy for a moment/.test(String(m.text ?? "")) },
];
const SAME_EVENT_KINDS = new Set(["refusal", "held", "busy"]);
export const MARKERS = [...LOG_RULES, ...TRANSCRIPT_RULES].map((r) => r.marker);

const lineTime = (line) => { const m = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/.exec(line); return m ? Date.parse(m[1]) : NaN; };
// electron/main.mjs slog() stamps one prefix per stdout/stderr chunk, so later lines of a multi-line chunk carry no stamp: such a line
// belongs to the instant of the last stamped line above it. A line before the first stamp has no instant (see unattributable below).
const lineInstants = (lines) => { let last = NaN; return lines.map((l) => { const t = lineTime(l); if (!Number.isNaN(t)) last = t; return last; }); };

/** Score one run dir. Returns { events:[{task,engine,kind,marker,weight,ref}], perTask, byKind, total, failedTasks }. */
export function scoreRun(dir) {
  const tasks = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
  // Fail closed: a run with no task, or a task with no usable window, measured nothing and must not PASS.
  const unusable = !Array.isArray(tasks) || tasks.length === 0 ? ["no-tasks"]
    : tasks.filter((t) => !t || !t.id || !Number.isFinite(Date.parse(t.t0)) || !Number.isFinite(Date.parse(t.t1)) || Date.parse(t.t1) < Date.parse(t.t0)).map((t) => `bad-window:${t?.id ?? "?"}`);
  if (unusable.length) return { events: [], byKind: {}, total: 0, failedTasks: unusable, taskCount: 0 };
  const logPath = path.join(dir, "server.log");
  const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, "latin1").split("\n") : [];
  const instants = lineInstants(lines);
  const events = [];
  const failedTasks = [];
  // Fail closed: a friction marker line with no instant (before any stamp) cannot be given to a task, so it must not be dropped silently.
  lines.forEach((line, i) => { if (Number.isNaN(instants[i]) && LOG_RULES.some((r) => r.test(line))) failedTasks.push(`unattributable:server.log:${i + 1}`); });
  const claimed = new Set(); // a log line belongs to the first task whose window holds it, never two
  for (const t of tasks) {
    const t0 = Date.parse(t.t0), t1 = Date.parse(t.t1);
    const logHits = new Map(); // kind -> [{marker, ref}]
    let stamped = 0;
    lines.forEach((line, i) => {
      const at = instants[i];
      if (at >= t0 && at <= t1 && !Number.isNaN(lineTime(line))) stamped++;
      if (!(at >= t0 && at <= t1) || claimed.has(i)) return;
      claimed.add(i);
      const rule = LOG_RULES.find((r) => r.test(line));
      if (!rule) return;
      if (!logHits.has(rule.kind)) logHits.set(rule.kind, []);
      logHits.get(rule.kind).push({ marker: rule.marker, ref: `server.log:${i + 1}` });
    });
    // Fail closed: a task window holding no stamped server.log line means the log is empty, wrong or in another clock; the run measured nothing.
    if (stamped === 0) failedTasks.push(`no-log:${t.id}`);
    const trHits = new Map();
    const tp = path.join(dir, "transcripts", `${t.id}.json`);
    if (fs.existsSync(tp)) {
      JSON.parse(fs.readFileSync(tp, "utf8")).forEach((m, i) => {
        const rule = TRANSCRIPT_RULES.find((r) => r.test(m));
        if (!rule) return;
        if (!trHits.has(rule.kind)) trHits.set(rule.kind, []);
        trHits.get(rule.kind).push({ marker: rule.marker, ref: `transcripts/${t.id}.json[${i}]` });
      });
    }
    for (const kind of new Set([...logHits.keys(), ...trHits.keys()])) {
      const a = logHits.get(kind) ?? [], b = trHits.get(kind) ?? [];
      // Only kinds both sources report for the same event are merged by max; banners/rebuilds are distinct events per source.
      for (const h of SAME_EVENT_KINDS.has(kind) ? (a.length >= b.length ? a : b) : [...a, ...b]) events.push({ task: t.id, engine: t.engine, kind, marker: h.marker, weight: WEIGHTS[kind], ref: h.ref });
    }
    if (t.hang === true) events.push({ task: t.id, engine: t.engine, kind: "hang", marker: "tasks.json:hang", weight: WEIGHTS.hang, ref: `tasks.json:${t.id}` });
    if (t.ok === false || t.hang === true) failedTasks.push(t.id);
  }
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.weight;
  const total = events.reduce((n, e) => n + e.weight, 0);
  return { events, byKind, total, failedTasks, taskCount: tasks.length, taskList: tasks.map((t) => `${t.id}:${t.engine ?? ""}`).sort() };
}

const validRecord = (r) => !!r && typeof r === "object" && Number.isFinite(r.total) && !!r.byKind && typeof r.byKind === "object" && (Array.isArray(r.taskList) || Number.isFinite(r.tasks)); // the task list is what the same-tasks check compares: a record without one cannot be compared

/** Verdict vs the previous release's record and the budget table. record = { total, byKind } | null. */
export function judge(score, prev, budget, { prevMissing = null } = {}) {
  const reasons = [];
  if (prevMissing) reasons.push(`prev-missing:${prevMissing}`); // an explicitly requested comparison release with no record cannot be skipped
  if (score.failedTasks.length) reasons.push(`task-failed:${score.failedTasks.join(",")}`);
  if (prev) {
    // Same task list: the recorded id:engine list must match, not only the count (a swapped task keeps the count). Old records carry the count only.
    if (Array.isArray(prev.taskList) ? prev.taskList.join(",") !== score.taskList.join(",") : Number.isFinite(prev.tasks) && prev.tasks !== score.taskCount) reasons.push(`task-list-changed:${score.taskCount}!=${prev.tasks ?? prev.taskList?.length}`);
    if (score.total > prev.total) reasons.push(`increase:${score.total}>${prev.total}`);
    for (const k of Object.keys(score.byKind)) if (!(k in (prev.byKind ?? {}))) reasons.push(`new-kind:${k}`);
  }
  if (score.total > budget) reasons.push(`over-budget:${score.total}>${budget}`);
  return { pass: reasons.length === 0, reasons };
}

export function tsv(score) {
  return ["task\tengine\tevent\tmarker\tweight\tref", ...score.events.map((e) => [e.task, e.engine, e.kind, e.marker, e.weight, e.ref].join("\t"))].join("\n") + "\n";
}

export function verdictLine({ version, os, profile }, score, prev, budget, verdict) {
  return `FRICTION-SCORE ${version} ${os} ${profile} ${score.total} prev=${prev ? prev.total : "none"} budget=${budget} ${verdict.pass ? "PASS" : "FAIL"}${verdict.reasons.length ? ` (${verdict.reasons.join(" ")})` : ""}`;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cmpVersion = (x, y) => { const a = x.split(/[.-]/), b = y.split(/[.-]/); for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (parseInt(a[i], 10) || 0) - (parseInt(b[i], 10) || 0); if (d) return d; } return 0; };
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d);

// CLI: friction-score.mjs <rundir> --version V --os linux|windows|macos --profile fresh|real [--prev-version V0] [--record] [--scores f] [--budget f]
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2); const dir = a[0];
  const opt = (n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; };
  const meta = { version: opt("version"), os: opt("os"), profile: opt("profile") };
  if (!dir || !meta.version || !meta.os || !meta.profile) { console.error("usage: friction-score.mjs <rundir> --version V --os O --profile P [--prev-version V0] [--record]"); process.exit(2); }
  const scoresFile = opt("scores", path.join(here, "scores.json"));
  const budgets = readJson(opt("budget", path.join(here, "budget.json")), {});
  const scores = readJson(scoresFile, {});
  const key = `${meta.os}/${meta.profile}`;
  const budget = budgets[key];
  if (typeof budget !== "number") { console.error(`FRICTION-SCORE ${meta.version} ${key} NO-BUDGET FAIL (budget.json has no row for ${key})`); process.exit(1); }
  const history = scores[key] ?? {};
  const prevVersion = opt("prev-version", Object.keys(history).filter((v) => v !== meta.version).sort(cmpVersion).pop());
  const prevAsked = a.includes("--prev-version");
  const rec = prevVersion && Object.hasOwn(history, prevVersion) ? history[prevVersion] : undefined;
  const prev = validRecord(rec) ? rec : null; // a record that is not a real score ({} / no total / no task list) is no record: fail closed, never a free pass
  const prevBad = rec !== undefined && prev === null;
  const score = scoreRun(dir);
  const verdict = judge(score, prev, budget, { prevMissing: (prevAsked && !prev) || prevBad ? prevVersion || "(empty)" : null });
  fs.writeFileSync(path.join(dir, "friction.tsv"), tsv(score));
  const line = verdictLine(meta, score, prev, budget, verdict);
  fs.writeFileSync(path.join(dir, "friction-verdict.txt"), line + "\n");
  console.log(line);
  if (a.includes("--record") && verdict.pass) { // a FAIL run is never the next release's baseline
    history[meta.version] = { total: score.total, byKind: score.byKind, tasks: score.taskCount, taskList: score.taskList };
    scores[key] = history;
    fs.writeFileSync(scoresFile, JSON.stringify(scores, null, 2) + "\n");
  }
  process.exit(verdict.pass ? 0 : 1);
}
