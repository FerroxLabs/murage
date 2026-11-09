import { scrubCore } from "./scrub-accounting.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the smoothness gate (SMOOTHNESS-GATE-105): the log signatures Sean's own server.log showed, how a
// transcript page is read for cards and withheld lines, how a routine burst and a delegation chain are scored, and
// how one budget row is judged. smooth.mjs runs its scenarios at import, so everything a test can pin lives here.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pct } from "../scale/stats.mjs";

/** Room-window worker wall time includes commit; rowMs is the row work, never a substitute for wall time. */
export function workerSliceWall(text) {
  const rows = [...String(text).matchAll(/\[turn-trace\] (?:id=\S+ )?phase=memory\.indexSlice ms=(\d+(?:\.\d+)?) rowMs=(\d+(?:\.\d+)?) rows=(\d+)(?=\s|$)/g)]
    .map(m => ({ ms: Number(m[1]), rowMs: Number(m[2]) }))
    .filter(r => Number.isFinite(r.ms) && Number.isFinite(r.rowMs));
  return { count: rows.length, max: rows.length ? Math.max(...rows.map(r => r.ms)) : null,
    p99: pct(rows.map(r => r.ms), 0.99), rowMsMax: rows.length ? Math.max(...rows.map(r => r.rowMs)) : null };
}

/** Server log signatures, one regexp each. Counts only; no line is ever printed. */
export const SIGNATURES = {
  ioBudget: /\[io-budget\] /,
  // Both forms the server prints (index.ts: "during dispatch" and "at a late submission", plain or ", room member <name>").
  rePreparing: /context revoked (?:during dispatch|at a late submission) on thread [\w-]+; re-preparing/,
  contextCard: /context revoked (?:during dispatch|at a late submission) on thread [\w-]+ after \d+ rebuilds/,
  fenceRefused: /\[memory\] send fence refused/,
  homeNotRead: /engine history: \w+ home not read/,
  staleLease: /STALE_MEMORY_LEASE/,
  resets: /memory continuation reset thread=/,
  deletionPending: /conversation deletion: home left pending/,
  uncaught: /\b(uncaughtException|unhandledRejection)\b/,
};

/** How many lines of `text` carry each signature. */
export function countSignatures(text) {
  const out = Object.fromEntries(Object.keys(SIGNATURES).map(k => [k, 0]));
  for (const line of String(text ?? "").split("\n")) {
    for (const [k, re] of Object.entries(SIGNATURES)) if (re.test(line)) out[k]++;
  }
  return out;
}

/** The wire text of a withheld room or hand-off mirror (room-context.ts ROOM_REPLY_*), by its prefix. */
export const WITHHELD_PREFIXES = ["[Reply left out until earlier memory is checked]", "[Reply withheld", "[Reply forgotten"];
export const CONTEXT_CHANGED_PREFIX = "Context changed";

/** Open or answered approval cards on a transcript page: an `options` row carrying a card request id. */
export function cardsIn(messages) {
  return (messages ?? []).filter(m => m && m.kind === "options" && m.card && typeof m.card.requestId === "string");
}
export const openCards = messages => cardsIn(messages).filter(m => !m.card.answered);

/** Rows whose text is a withheld, checking or forgotten mirror. */
export function withheldIn(messages) {
  return (messages ?? []).filter(m => typeof m?.text === "string" && WITHHELD_PREFIXES.some(p => m.text.startsWith(p)));
}
/** Rows that end a turn with the "Context changed" card text (index.ts, two sites). */
export function contextChangedIn(messages) {
  return (messages ?? []).filter(m => typeof m?.text === "string" && m.text.startsWith(CONTEXT_CHANGED_PREFIX));
}
/** Error rows a turn left behind (kind error, or a failure status line). */
export function errorRowsIn(messages) {
  // server/index.ts:9157-9161 writes runtime.error as an activity, not kind:error.
  return (messages ?? []).filter(m => m && m.role !== "user" && !m.card?.intake && (m.kind === "error" || m.kind === "failure"
    || (m.kind === "activity" && m.tool?.ok === false && typeof m.tool?.name === "string" && m.tool.name.startsWith("error: "))));
}

/** The PATCH body that puts a bot at one approval level (server/full-access.ts contract; desktop surface). */
export function levelPatch(level, platform = process.platform) {
  // acknowledgeLocalAuto: the desktop's "Auto mode on this computer" warning (src/lib/level-change.ts needsLocalAck), which the
  // server requires where Auto mounts the host computer (macOS, Windows). Without it every raise above Ask was a 400 on the Mac
  // leg and S4/S10 measured Ask (GATE-PREP-1018 relay 3). Linux sends the 1.0.15 body unchanged, as the desktop does there.
  const ack = platform === "darwin" || platform === "win32" ? { acknowledgeLocalAuto: true } : {};
  switch (level) {
    case "ask": return { autoApprove: false };
    case "auto": return { autoApprove: true, fullAccess: false, ...ack };
    case "full": return { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true, ...ack };
    case "unlimited": return { autoApprove: true, fullAccess: true, noLimits: true, acknowledgeNoLimits: true, ...ack };
    default: throw new Error(`unknown level ${level}`);
  }
}
export const LEVELS = ["ask", "auto", "full", "unlimited"];

/** The ordinary dev commands of S4 (every one a command Sean's bots run daily), and the two stop lines. */
export const DEV_COMMANDS = [
  "git status", "ls -la", "cat package.json", "grep -rn TODO src", "pnpm vitest run server/x.test.ts",
  "npm test", "node -e 1", "mkdir -p tmp/out", "git diff --stat", "pnpm install --frozen-lockfile",
];
export const STOP_COMMANDS = ["rm -rf /", "shutdown -h now"];
/** Rig v5.8: the two stop lines are not alike at No limits. `rm -rf /` is on the short wipe-the-computer list
 * (server/always-ask.ts), which asks the owner at every level, No limits included. `shutdown` is only on the stop
 * line (server/auto-approve.ts DESTRUCTIVE), and No limits is "Full access without the stop line" (Sean 10-31: no
 * cards on owner turns, keep the deny rules and the short wipe list). So an owner No limits turn cards the first and
 * runs the second. */
export const WIPE_COMMANDS = ["rm -rf /"];
export const stopKind = cmd => (WIPE_COMMANDS.includes(cmd) ? "wipe" : "stopLine");

/** What the gate expects of the card count at a level for the ordinary commands: Ask asks for all, Full access and
 * No limits for none; Auto is reported, not budgeted (its allowlist is the product's, not this gate's). */
export function expectedCards(level, n = DEV_COMMANDS.length) {
  if (level === "ask") return { op: "==", value: n };
  if (level === "auto") return null;
  return { op: "==", value: 0 };
}

/** A routine burst read from GET /api/routines runs: lateness from each run's own slot (its first due time plus its
 * place in the dispatch spread), deferrals for connected apps, and runs that never started. */
export function routineBurst(runs, ids) {
  const mine = (runs ?? []).filter(r => ids.has(r.routineId));
  const started = mine.filter(r => typeof r.startedAt === "number");
  return {
    runs: mine.length,
    started: started.length,
    unstarted: mine.length - started.length,
    deferred: mine.filter(r => typeof r.attention === "string" && r.attention.startsWith("Waiting for connected apps")).length,
    lateness: started.map(r => r.startedAt - (r.slotAt ?? r.dueAt ?? r.scheduledFor)),
    fromDue: started.map(r => r.startedAt - (r.dueAt ?? r.scheduledFor)),
    statuses: Object.fromEntries([...new Set(mine.map(r => r.status ?? "?"))].map(s => [s, mine.filter(r => (r.status ?? "?") === s).length])),
  };
}

/** The routine's startup note (routines.ts STARTUP_NOTE) in the fakes' prompt dumps: how many dumps carry it. */
export const STARTUP_NOTE_MARK = "connected apps had not finished loading when this run started";
export function startupNotesIn(dumps) {
  return (dumps ?? []).filter(text => typeof text === "string" && text.includes(STARTUP_NOTE_MARK)).length;
}

/** A delegation chain from the server's own state, the same on both legs (a real engine never writes the fake's words):
 * the manager's "Messaged @<worker>" source rows (comms-visibility.ts messagedRow, written when a hand-off is queued) and
 * the hand-off receipts in <data>/delegation-receipts.json (delegations.ts DelegationReceipt: toBotId, status, finishedAt).
 * A hand-off is counted when either shows it; a result is back when its receipt is `done`; any other terminal status failed. */
export function chainFromServer({ managerMessages, receipts, workerId, workerName, sinceAt = 0 }) {
  const messaged = (managerMessages ?? []).filter(m => m && m.kind === "activity" && m.tool?.name === `Messaged @${workerName}` && (typeof m.at !== "number" || m.at >= sinceAt)).length;
  const mine = (Array.isArray(receipts) ? receipts : []).filter(r => r && r.toBotId === workerId && typeof r.finishedAt === "number" && r.finishedAt >= sinceAt);
  const statuses = {}; for (const r of mine) statuses[r.status ?? "?"] = (statuses[r.status ?? "?"] ?? 0) + 1;
  return { handedOver: Math.max(messaged, mine.length), messaged, receipts: mine.length, sawResult: mine.filter(r => r.status === "done").length, failed: mine.filter(r => r.status !== "done").length, statuses };
}

/** Poll `check` until it is truthy or `cap` ms pass; `{ ok, ms }`. Clock and sleep are injectable for the tests. */
export async function waitFor(check, { cap = 60_000, every = 250, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now() } = {}) {
  const t0 = now();
  for (;;) {
    if (await check()) return { ok: true, ms: Math.round(now() - t0) };
    if (now() - t0 >= cap) return { ok: false, ms: Math.round(now() - t0) };
    await sleep(every);
  }
}

/** Every runner bot gets its own working folder under the run's root, named by scenario and bot. At Full access a turn
 * takes its folder's writer lease, so a shared folder let one scenario's leftover turn hold the next scenario's turns
 * (TRIAGE-REAL-R2 "S8 root cause"). Names are reduced to [a-z0-9-] so the path is the same on every box. */
const folderPart = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
export const botFolder = (root, scenario, name) => `${String(root).replace(/\/+$/, "")}/${folderPart(scenario)}--${folderPart(name)}`;

/** Send one Stop and wait until the bot reads idle: used after a turn timed out, before the next message goes to that bot
 * (a message sent to a still-busy Codex bot is queued and starts the moment the old turn ends), and for every bot a
 * scenario made when the scenario ends. When the first Stop does not settle by `cap`, one bot-wide Stop follows
 * (`{ all: true }`) and the wait runs once more. `{ stopStatus, settled, ms, escalated }`. */
export async function stopAndSettle({ stop, isBusy, cap = 60_000, every = 250, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now() }) {
  const t0 = now();
  const first = await stop(false);
  let w = await waitFor(async () => !(await isBusy()), { cap, every, sleep, now });
  if (w.ok) return { stopStatus: first, settled: true, ms: Math.round(now() - t0), escalated: false };
  const all = await stop(true);
  w = await waitFor(async () => !(await isBusy()), { cap, every, sleep, now });
  return { stopStatus: first, allStatus: all, settled: w.ok, ms: Math.round(now() - t0), escalated: true };
}

/** S6 (c): a working conversation's DELETE is judged only when the turn was confirmed working when it was sent. A turn that
 * already ended makes 200 the right answer, so the row is not measured (null) rather than failed or passed. */
export function workingDeleteVerdict(busyBeforeDelete, status) {
  if (!busyBeforeDelete) return { workingRefused: null, workingConfirmed: 0, workingDeleteStatus: status };
  return { workingRefused: status === 409 ? 1 : 0, workingConfirmed: 1, workingDeleteStatus: status };
}

/** The real held turn of S6: a shell sleep at Full access, so it outlasts the two deletes (each budgeted 10 s) by far. */
export const REAL_HELD_SECONDS = 120;
export const heldPrompt = (engines, i) => engines === "real" ? `Run the shell command \`sleep ${REAL_HELD_SECONDS}\` and then reply with the word done (${i}).` : `Held turn ${i}: wait for the gate.`;

/** Answer every approval card a turn raises until the turn ends (S4, S7): a real engine may ask more than once for one command
 * (Codex asks again to run outside its sandbox when the sandbox fails). Each request id is answered once. `{ answered, timeout, cards }`:
 * `cards` times each one from the start of the wait (S7): `seenMs` (first poll that showed it), `answeredMs` (the answer was sent),
 * `resolvedMs` (first poll after the answer that no longer showed it, or the turn's end), `seenAt` and `cardAt` (the wall clock
 * when it was seen, and the card row's own time on the server), `status` (the answer's HTTP status) and
 * `tool` (the card's tool name only, never its input), `kind` (approval or question). `known`: request ids an earlier wait already
 * answered (a question can stay open past its turn), never answered or timed again. */
export async function answerCards({ fetchCards, respond, isDone, cap = 200_000, every = 500, known = new Set(), sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now(), wall = () => Date.now() }) {
  const t0 = now(), answered = [], cards = [];
  const toolOf = card => typeof card?.tool === "string" ? card.tool.slice(0, 60) : typeof card?.tool?.name === "string" ? card.tool.name.slice(0, 60) : null;
  for (;;) {
    const open = await fetchCards();
    const openIds = new Set(open.map(c => c?.card?.requestId));
    for (const c of cards) if (c.resolvedMs === null && !openIds.has(c.requestId)) c.resolvedMs = Math.round(now() - t0);
    for (const c of open) {
      const id = c?.card?.requestId;
      if (typeof id !== "string" || answered.includes(id) || known.has(id)) continue;
      const row = { requestId: id, kind: isLimitCard(c.card) ? "limit" : isQuestionCard(c.card) ? "question" : "approval", tool: toolOf(c.card), seenMs: Math.round(now() - t0), seenAt: wall(), cardAt: typeof c.at === "number" ? c.at : null, answeredMs: null, resolvedMs: null, status: null };
      answered.push(id); known.add(id); cards.push(row);
      if (row.kind === "limit") continue; // left for the owner: not answered, not timed as an answer
      const r = await respond(c.card);
      row.answeredMs = Math.round(now() - t0); row.status = typeof r?.status === "number" ? r.status : null;
    }
    const done = await isDone();
    if (done || now() - t0 >= cap) {
      if (done) for (const c of cards) if (c.resolvedMs === null) c.resolvedMs = Math.round(now() - t0);
      return { answered, timeout: !done, cards };
    }
    await sleep(every);
  }
}

/** A question card, not an approval (shared/questions.ts isQuestionCard): it takes an answer or a Skip, never an Allow. */
export const isQuestionCard = card => Boolean(card?.requestId) && (Boolean(card.questions?.length) || (!card.tool && !card.routineRequest && !card.skillRequest && !card.intake));

/** The offer Murage makes when an engine is at its limit (limit-continuation.ts LIMIT_CARD_TOOL): the owner's choice of a backup
 * engine or Wait, not an approval. The runner leaves it for the owner and counts it: it says the engine, not Murage, stopped. */
export const LIMIT_CARD_TOOL = "murage_limit_offer";
export const isLimitCard = card => card?.tool === LIMIT_CARD_TOOL;

/** The owner's answer to one card through the app's route (POST /api/threads/:id/respond): Allow for an approval, the
 * question card's own Skip for a question (an answer would be a new owner message, a 7th turn S7 does not measure). */
export const ownerAnswer = card => isLimitCard(card) ? null : isQuestionCard(card) ? { requestId: card.requestId, behavior: "skip" } : { requestId: card.requestId, behavior: "allow" };

/** S3 uses the same thread respond route as S7/decideRequest, with the stop/wipe refusal of S4.
 * f28a6bad8 (1.0.17) emits cardClass: approval-card-grants.ts:104,128-131 and index.ts:9269.
 * Unclassified approvals therefore fail closed; questions and limit offers keep their own behavior. */
export function roomOwnerAnswer(card) {
  if (isLimitCard(card) || isQuestionCard(card)) return ownerAnswer(card);
  if (!card?.cardClass) return { requestId: card.requestId, behavior: "deny" };
  const stop = ["always-ask", "stop-line", "destructive-guard"].includes(card?.cardClass?.reason)
    || Boolean(card?.cardClass?.stop) || [card?.allowKey, card?.taskAllowKey, ...(card?.allowKeys ?? [])].some(k => typeof k === "string" && k.startsWith("stop:"))
    || STOP_COMMANDS.includes(card?.summary?.trim());
  return stop ? { requestId: card.requestId, behavior: "deny" } : ownerAnswer(card);
}

/** Keep both answered transcript cards and live cards, count each request once across all room rounds,
 * and retain answerCards' raw shown/answered timestamps as well as S7's derived timings. No I/O here. */
export async function answerRoomCards({ fetchMessages, fetchOpen, keepCard, respond, isDone, raised = new Set(), ...options }) {
  return answerCards({ ...options, isDone,
    fetchCards: async () => {
      const messages = await fetchMessages(), open = await fetchOpen();
      for (const row of [...cardsIn(messages), ...cardsIn(open)]) {
        raised.add(row.card.requestId); keepCard(row);
      }
      return openCards(open);
    },
    respond: card => { const answer = roomOwnerAnswer(card); return answer ? respond(answer) : null; },
  });
}

/** RIG-V58-ROOM-DRAIN rev 3, sections 1-4. All clocks and effects are injected.
 * fetchRoom returns the group wire row; fetchMembers returns every requested member
 * (including undefined for a missing row). Card readers return { rows, complete }.
 * Each effect receives { deadline, timeout, remaining(defaultMs) }; pagination and
 * retries MUST recalculate remaining before each operation. No ambient clock or I/O.
 * Lifecycle assumption: every S3 card holds a member turn in a tracked group operation.
 * Pure tests cannot prove that server assumption; final collection checks it again. */
export const roomSchemaError = message => Object.assign(Error(message), { roomSchema: true });
export function roomBudget(deadline, now, defaultMs) {
  const remaining = opDefault => {
    const left = deadline - now();
    if (left <= 0) throw Object.assign(Error("room deadline expired"), { roomDeadline: true });
    return Math.min(opDefault, left);
  };
  return { deadline, timeout: remaining(defaultMs), remaining };
}

export const roomProofRefusal = (requested, engines) => requested && engines !== "fake"
  ? "SMOOTH_ROOM_PROOF=1 requires fake engines; real-engine leg refused" : null;
const successfulStatus = status => Number.isInteger(status) && status >= 200 && status < 300;
export function roomProofChecks(proof) {
  const card = proof?.card, interrupt = proof?.interrupt;
  return {
    respond: !card?.error && Number.isInteger(card?.raised) && card.raised > 0 && card.answered === card.raised
      && successfulStatus(card.respondStatus) && typeof card.requestId8 === "string" && card.requestId8.length > 0,
    interrupt: interrupt?.sawWorking === true && successfulStatus(interrupt.interruptStatus)
      && interrupt.settled === true && Number.isFinite(interrupt.settledMs) && interrupt.settledMs >= 0 && interrupt.settledMs <= 60_000,
  };
}

/** Opt-in, post-measurement proof. Uses the ordinary drain and its settlement state;
 * exceptions leave done=false for the scenario wrapper's settlement gate. */
export async function runRoomRouteProof({ engines, options, members, send, ctl, readControl, setLevel, onControlFailure }) {
  const refusal = roomProofRefusal(true, engines);
  if (refusal) throw Error(refusal);
  const { state, now, sleep } = options;
  if (state.done !== true || state.incomplete) throw Error("room proof requires measured room DONE");
  const proof = state.proof = { card: { raised: 0, answered: 0, respondStatus: null, requestId8: null },
    interrupt: { sawWorking: false, interruptStatus: null, settledMs: null, settled: false }, ok: false };
  state.done = false;
  const mode = readControl("grok.mode"), command = readControl("permission-command");
  const levels = members.map(member => ({ id: member.id,
    level: !member.autoApprove ? "ask" : member.noLimits ? "unlimited" : member.fullAccess ? "full" : "auto" }));
  const allows = new Map(), raised = new Set();
  const restorationFailed = error => {
    state.controlRestoreFailed = true; state.done = false; state.incomplete = true;
    onControlFailure?.(error);
  };
  const restore = values => restoreControls({ ctl, readControl, values, onFailure: restorationFailed });
  const requireSuccess = (response, what) => { if (!successfulStatus(response?.status)) throw Error(`${what} rejected (${response?.status ?? "missing"})`); };
  try {
    ctl("grok.mode", "permission"); ctl("permission-command", DEV_COMMANDS[0]);
    for (const member of members) requireSuccess(await setLevel(member.id, "ask"), "proof Ask");
    const deadline = now() + 90_000;
    requireSuccess(await send("Room route proof: each member runs git status once.", roomBudget(deadline, now, 60_000)), "proof card send");
    const seen = await drainRoomCards({ ...options, raised, round: "proof.card", deadline,
      respond: async (answer, budget) => {
        const response = await options.respond(answer, budget);
        if (answer.behavior === "allow") allows.set(answer.requestId, response?.status ?? null);
        return response;
      } });
    const statuses = [...allows.values()];
    Object.assign(proof.card, { raised: raised.size, answered: statuses.filter(successfulStatus).length,
      respondStatus: statuses.find(status => !successfulStatus(status)) ?? statuses.at(-1) ?? null,
      requestId8: [...allows.keys()][0]?.slice(0, 8) ?? null });
    state.done = seen.status === "DONE" && !state.incomplete;
    if (!state.done) return proof;
    if (raised.size !== members.length || proof.card.answered !== members.length) {
      proof.card.error = "expected exactly one allowed approval per member";
    }
  } finally {
    // Attempt every restoration even if a previous one fails.
    const restored = await Promise.allSettled([
      Promise.resolve().then(() => restore({ "grok.mode": mode, "permission-command": command })),
      ...levels.map(async member => requireSuccess(await setLevel(member.id, member.level), "proof level restore")),
    ]);
    const failed = restored.find(result => result.status === "rejected");
    if (failed) {
      if (!state.controlRestoreFailed) restorationFailed(failed.reason);
      throw failed.reason;
    }
  }
  try {
    state.done = false;
    ctl("grok.mode", "slow-tool");
    const workingDeadline = now() + 30_000;
    requireSuccess(await send("Room route proof: start the slow tool.", roomBudget(workingDeadline, now, 30_000)), "proof interrupt send");
    while (now() < workingDeadline) {
      const room = await options.fetchRoom(roomBudget(workingDeadline, now, 30_000));
      if (typeof room?.working !== "boolean") throw roomSchemaError("proof working signal unreadable");
      if (room.working && now() < workingDeadline) { proof.interrupt.sawWorking = true; break; }
      await sleep(roomBudget(workingDeadline, now, 250).timeout);
    }
    if (!proof.interrupt.sawWorking) throw Error("proof never observed group working");
    const start = now(), deadline = start + 60_000;
    state.interruptSent = true; // no second interrupt from failure settlement
    const response = await options.interrupt(roomBudget(deadline, now, 10_000));
    proof.interrupt.interruptStatus = response?.status ?? null;
    state.interrupt = { status: proof.interrupt.interruptStatus };
    const seen = await drainRoomCards({ ...options, round: "proof.interrupt", deadline });
    Object.assign(proof.interrupt, { settledMs: Math.round(now() - start), settled: seen.status === "DONE" });
    state.done = seen.status === "DONE" && !state.incomplete;
  } finally { restore({ "grok.mode": mode }); }
  const checks = roomProofChecks(proof);
  proof.ok = checks.respond && checks.interrupt && !proof.card.error;
  return proof;
}

export async function drainRoomCards(options) {
  const { fetchRoom, fetchMembers, fetchOpen, fetchMessages, keepCard, respond, now, sleep, deadline,
    state, known = new Set(), raised = new Set(), round = "tail", observation = false } = options;
  const start = now(), cards = [], answered = [], records = new Map();
  const result = { status: null, timeout: false, cards, answered, messages: [] };
  let consecutive = 0, failed = 0, finalCollection = false, lastPoll = null;
  const budget = ms => roomBudget(deadline, now, ms);
  const fail = async (status, error) => {
    Object.assign(result, { status, timeout: status === "TIMEOUT", error, lastPoll });
    if (!observation) {
      state.incomplete = true;
      if (status === "TIMEOUT") state.cardCloseTimeout = true; // sticky across all rounds and tail
      else state.error = error;
      state.notes ??= [];
      state.notes.push(`room ${round}: ${status}; ${error}; last poll ${JSON.stringify(lastPoll)}`);
      result.settlement = await settleRoomScenario({ ...options, known, raised });
    }
    return result;
  };
  for (;;) {
    if (now() >= deadline) return fail("TIMEOUT", "absolute deadline expired");
    try {
      // Sections 1, 2(a): group operation is authoritative, never inferred from idle bots.
      lastPoll = { complete: false, finalCollection };
      const room = await fetchRoom(budget(30_000));
      if (typeof room?.working !== "boolean") throw roomSchemaError("missing group row or non-boolean working");
      lastPoll.working = room.working;
      const members = await fetchMembers(budget(30_000));
      if (!Array.isArray(members) || members.length === 0 || members.some(m => typeof m?.busy !== "boolean"))
        throw roomSchemaError("missing member row or non-boolean busy");
      lastPoll.busy = members.some(m => m.busy);
      // Read/service cards even when the group is working (approval turns can hold working=true).
      // Preserve readable cards even if another read failed or was partial in this poll.
      let open, messages, readError;
      try { open = await fetchOpen(budget(30_000)); } catch (error) { readError = error; }
      try { messages = await fetchMessages(budget(60_000)); } catch (error) { readError ??= error; }
      for (const row of [...cardsIn(messages?.rows), ...cardsIn(open?.rows)]) {
        raised.add(row.card.requestId); keepCard(row);
      }
      if (Array.isArray(messages?.rows)) result.messages = messages.rows;
      const pending = openCards(open?.rows), ids = new Set(pending.map(row => row.card.requestId));
      if (open?.complete === true) for (const c of cards) {
        if (c.resolvedMs === null && !ids.has(c.requestId)) c.resolvedMs = Math.round(now() - start);
      }
      for (const row of pending) {
        const card = row.card, id = card.requestId;
        if (known.has(id)) continue;
        let record = records.get(id);
        if (!record) {
          record = { requestId: id, kind: isLimitCard(card) ? "limit" : isQuestionCard(card) ? "question" : "approval",
            tool: typeof card.tool === "string" ? card.tool.slice(0, 60) : card.tool?.name ?? null,
            seenMs: Math.round(now() - start), seenAt: now(), cardAt: typeof row.at === "number" ? row.at : null,
            answeredMs: null, resolvedMs: null, status: null };
          records.set(id, record); cards.push(record);
        }
        const answer = roomOwnerAnswer(card);
        if (!answer) { known.add(id); continue; }
        // A failed answer may be retried on the next poll, under the SAME deadline.
        const response = await respond(answer, budget(120_000));
        record.answeredMs = Math.round(now() - start); record.status = response?.status ?? null;
        if (!(record.status >= 200 && record.status < 300)) throw Error(`room answer rejected (${record.status})`);
        known.add(id); answered.push(id);
      }
      if (readError) throw readError;
      if (open?.complete !== true || messages?.complete !== true || !Array.isArray(open?.rows) || !Array.isArray(messages?.rows))
        throw Error("partial room transcript or open-card response");
      lastPoll.complete = true;
      lastPoll.open = pending.filter(row => !isLimitCard(row.card)).length;
      const eligible = room.working === false && !lastPoll.busy && lastPoll.open === 0;
      // Section 3: a successful read that crossed the deadline can NEVER become DONE.
      if (now() >= deadline) return fail("TIMEOUT", "deadline crossed inside poll");
      failed = 0;
      if (finalCollection && eligible) return Object.assign(result, { status: "DONE", lastPoll });
      if (finalCollection) { finalCollection = false; consecutive = 0; }
      consecutive = eligible ? consecutive + 1 : 0;
      if (consecutive === 2) {
        if (observation) return Object.assign(result, { status: "DONE", lastPoll });
        finalCollection = true; // Section 2(c): transcript + open cards + full predicate, same deadline.
        continue;
      }
    } catch (error) {
      consecutive = 0;
      if (now() >= deadline || error?.roomDeadline) return fail("TIMEOUT", "deadline crossed inside poll");
      if (!observation && (error?.roomSchema || finalCollection)) return fail("ERROR", String(error?.message ?? error));
      finalCollection = false;
      lastPoll = { ...lastPoll, complete: false, error: String(error?.message ?? error) };
      if (++failed >= 3 && !observation) return fail("TIMEOUT", "three consecutive failed polls");
    }
    try { await sleep(budget(1000).timeout); } // also bounds pending-card retries; polls are at least 1 s apart
    catch (error) {
      return fail(now() >= deadline || error?.roomDeadline ? "TIMEOUT" : "ERROR", String(error?.message ?? error));
    }
  }
}

/** Sections 3 and 4(d): ONE cleanup, including wrapper exceptions. Observation is
 * evidence only: it cannot clear incomplete/TIMEOUT and cannot recursively interrupt. */
export async function settleRoomScenario(options) {
  const { state, interrupt, now } = options;
  state.incomplete = true;
  if (state.settlement) return state.settlement;
  state.settlement = { settled: false, startedAt: now() };
  state.notes ??= [];
  if (!state.interruptSent && interrupt) {
    state.interruptSent = true; // latch before awaiting even a rejected/throwing transport
    const deadline = now() + 10_000;
    try {
      const response = await interrupt(roomBudget(deadline, now, 10_000));
      state.interrupt = { status: response?.status ?? null };
      if (!(response?.status >= 200 && response.status < 300)) state.interrupt.error = "room interrupt rejected";
    } catch (error) { state.interrupt = { status: null, error: String(error?.message ?? error) }; }
    state.notes.push(`room interrupt: ${JSON.stringify(state.interrupt)}`);
    state.settlement.startedAt = now(); // observation starts at interrupt RETURN, not send
  }
  state.settlement.deadline = state.settlement.startedAt + 30_000;
  try {
    const observed = await drainRoomCards({ ...options, observation: true, deadline: state.settlement.deadline });
    Object.assign(state.settlement, { settled: observed.status === "DONE", lastPoll: observed.lastPoll, cards: observed.cards });
  } catch (error) { state.settlement.error = String(error?.message ?? error); }
  return state.settlement;
}

/** The wrapper and tests share the actual later-scenario gate, including leg failure. */
export async function enforceRoomSettlement({ options, results, laterScenarios, stopServer }) {
  results.legFailed = true; // A clean observation permits later work, never repairs S3.
  const settlement = await settleRoomScenario(options);
  if (!settlement.settled || options.state.controlRestoreFailed || results.controlRestoreFailed) {
    results.legFailed = true;
    results.roomNeverSettled = true;
    for (const name of laterScenarios) results.scenarios[name] = { invalid: "room never settled" };
    if (!options.state.serverStopAttempted) {
      options.state.serverStopAttempted = true;
      try { await stopServer(); } catch (error) { options.state.notes.push(`owned server stop failed: ${String(error?.message ?? error)}`); }
    }
  }
  return settlement.settled && !options.state.controlRestoreFailed && !results.controlRestoreFailed;
}

export function recordCleanupFailure(results, reason) {
  results.legFailed = true;
  results.status = "FAIL";
  results.legFailureReason ??= reason;
  (results.notes ??= []).push(reason);
}

export function recordRoomDelete(results, id, response, error) {
  if (!error && response?.status >= 200 && response.status < 300) return;
  recordCleanupFailure(results, `cleanup: room ${id} DELETE ${response?.status ?? "transport error"}${error ? `: ${error}` : ""}`);
}

/** The engine's asks of one trace, in order (`permission.wait`, logged when the card closes): `askedMs` is when the engine asked,
 * in ms after the trace was received; `waitMs` is how long the card stayed open on the server. */
export function permissionWaits(logText, traceId) {
  if (typeof traceId !== "string" || !/^[\w-]+$/.test(traceId)) return [];
  const re = new RegExp(`\\[turn-trace\\] id=${traceId} phase=permission\\.wait at=(\\d+)ms\\b[^\\n]*?\\bms=(\\d+)`, "g");
  return [...String(logText ?? "").matchAll(re)].map(m => ({ askedMs: Math.max(0, Number(m[1]) - Number(m[2])), waitMs: Number(m[2]) }));
}

/** S7: one turn's cards, timed. `appearMs` is send to shown (the engine's thinking included); `visibleMs` is Murage's own part:
 * from the engine's ask (an ACP trace's permission.wait; the send time stands in for the trace's start, so it errs high) or,
 * where no ask is logged (the Claude driver, questions), from the card row's own server time, to the owner seeing it. Asks pair
 * with the approvals in order;
 * `resolveMs` is the owner's answer to the card closed (Murage's own); `waitMs` is how long the card held the turn (the server's
 * own count when logged). `cardWaitMs` is their sum: the owner's time, kept outside the turn's own latency. */
export function cardTimings(cards, asks = []) {
  let k = 0;
  const rows = (cards ?? []).map(c => {
    const question = c.kind === "question" || c.kind === "limit";
    const ask = question ? undefined : asks[k++];
    const resolveMs = c.resolvedMs !== null && c.answeredMs !== null ? Math.max(0, c.resolvedMs - c.answeredMs) : null;
    const waitMs = ask ? ask.waitMs : c.resolvedMs !== null ? Math.max(0, c.resolvedMs - c.seenMs) : null;
    const visibleMs = ask ? Math.max(0, c.seenMs - ask.askedMs) : typeof c.cardAt === "number" && typeof c.seenAt === "number" ? Math.max(0, c.seenAt - c.cardAt) : null;
    return { kind: c.kind ?? "approval", tool: c.tool ?? null, status: c.status ?? null, appearMs: c.seenMs, visibleMs, visibleFrom: ask ? "ask" : visibleMs === null ? null : "card", resolveMs, waitMs };
  });
  return { cards: rows, cardWaitMs: rows.reduce((a, r) => a + (r.waitMs ?? 0), 0) };
}

/** The fake lead's own words after each wake (fake lead-delegate says "lead saw the result" once the worker's result came
 * back, "lead was woken without" when it did not). Reported beside the server's count on the fake leg; never the budget. */
export function chainFromManager(messages) {
  const bot = (messages ?? []).filter(m => m && m.role === "bot" && typeof m.text === "string");
  return {
    handedOver: bot.filter(m => m.text.startsWith("lead handed over")).length,
    sawResult: bot.filter(m => m.text.startsWith("lead saw the result")).length,
    wokenEmpty: bot.filter(m => m.text.startsWith("lead was woken")).length,
    leadErrors: bot.filter(m => m.text.startsWith("lead error")).length,
  };
}

/** Bot replies in a room thread after `sinceAt` (ms), per member: the first and the last reply times from the send. */
/** Room rows name their speaker as `from: { botId, name, color }` (store.ts Message.from); `from.id` does not exist. */
export const speakerOf = m => m?.from?.botId ?? m?.botId;
export function roomReplies(messages, sinceAt, memberIds) {
  const replies = (messages ?? []).filter(m => m && m.role === "bot" && m.kind === "text" && typeof m.at === "number" && m.at > sinceAt && (!memberIds || memberIds.has(speakerOf(m))));
  const byMember = new Map();
  for (const m of replies) { const who = speakerOf(m) ?? "?"; if (!byMember.has(who)) byMember.set(who, m.at); }
  const times = [...byMember.values()].map(at => at - sinceAt).sort((a, b) => a - b);
  return { members: byMember.size, first: times[0] ?? null, last: times.at(-1) ?? null };
}

// ---- RIG-SMOOTH-R2 v3 telemetry: reads high, never low; nothing is subtracted; an unreadable tick is never a zero.
// Linux: the leg's own cgroup. macOS and Windows memory: the RSS sum of the leg user's processes born at or after a stamp taken
// before the server starts. macOS and Windows CPU: whole box.
/** The cgroup v2 path from /proc/self/cgroup ("0::/path"), or null when the box has no unified line. */
export function cgroupPathOf(text) {
  const m = /^0::(\/.*)$/m.exec(String(text ?? ""));
  return m && !m[1].includes("..") ? m[1] : null;
}
/** Cumulative CPU in microseconds from cpu.stat; null when unreadable. */
export function cgroupCpuUsec(text) {
  const m = /^usage_usec (\d+)$/m.exec(String(text ?? ""));
  return m ? Number(m[1]) : null;
}
/** MB from memory.current or memory.peak (a single number of bytes); null when unreadable. */
export function cgroupMemMb(text) {
  const s = String(text ?? "").trim();
  return /^\d+$/.test(s) ? Math.ceil(Number(s) / 1048576) : null;
}
/** Every resource reading rounds up, never to the nearest: a stored value is never under the true one. */
const up3 = x => Math.ceil(x * 1000) / 1000;
/** Cores used between two readings of a cumulative counter; null when the counter went backwards or the clock did not move. */
export function coresBetween(prev, now) {
  const dt = (now.t - prev.t) / 1000, ds = now.cpuS - prev.cpuS;
  if (!(dt > 0) || !Number.isFinite(ds) || ds < 0) return null;
  return up3(ds / dt);
}
/** Whole-box cores from one `top -l 0 -n 0` summary line (macOS percentages are of the whole machine), or null. */
export function coresFromTopLine(line, ncpu) {
  const m = /CPU usage: [\d.]+% user, [\d.]+% sys, ([\d.]+)% idle/.exec(String(line ?? ""));
  if (!m) return null;
  const idle = Number(m[1]);
  return idle >= 0 && idle <= 100 ? up3((100 - idle) / 100 * ncpu) : null;
}
/** The macOS table: `LC_ALL=C ps -A -o pid=,uid=,lstart=,rss=,comm=`, one object per row; null when ANY row cannot be read. */
export function macTable(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(?:(\d+)\s+)?(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) return null;
    const bornMs = Date.parse(m[4].replace(/\s+/g, " "));
    if (!Number.isFinite(bornMs)) return null;
    rows.push({ pid: Number(m[1]), ...(m[2] === undefined ? {} : { ppid: Number(m[2]) }), uid: Number(m[3]), bornMs, rssMb: Number(m[5]) / 1024, name: m[6].trim() });
  }
  return rows.length ? rows : null;
}
/** ps gives whole seconds, so the stamp is floored: a process born in the stamp's own second counts (reads high). */
export function legRss(rows, { uid, stampMs }) {
  if (!rows) return null;
  const floor = Math.floor(stampMs / 1000) * 1000;
  const mine = rows.filter(r => r.uid === uid && r.bornMs >= floor);
  return { rss: Math.ceil(mine.reduce((a, r) => a + r.rssMb, 0)), procs: mine.length };
}
/** Rows of one top sample (`top -l 0 -s 1 -n 5000 -o cpu -stats pid,uid,cpu`) from its raw stdout lines. macOS top prints, after
 * "Processes: N total", a digit-leading timestamp line ("2026/11/08 03:05:45") and more header lines BEFORE the table: only the lines
 * from the PID header on are rows. Returns { line(l), end() }; emit({ t, lines, total }) fires when the NEXT sample starts, so a sample is
 * closed only once its row count can be checked against top own total. end() says whether a sample was cut off (an unreadable tick). */
export function topSampleCollector(emit) {
  let block = null, inTable = false;
  const close = () => { if (!block) return; const b = block; block = null; inTable = false; emit(b); };
  return {
    line(line) {
      const total = /^Processes: (\d+) total/.exec(line);
      if (total) { close(); block = { t: Date.now(), lines: [], total: Number(total[1]) }; return; }
      if (!block) return;
      if (/^\s*PID\b/.test(line)) { inTable = true; block.lines.push(line); return; }
      if (inTable && /^\s*\d/.test(line)) block.lines.push(line);
    },
    end() { const cut = block !== null; block = null; inTable = false; return cut; },
  };
}
/** Rows of one top sample, as { pid, uid, cpu } (cpu in percent of ONE core). The header is skipped; any other line that does not read is
 * no reading (null). */
export function parseTopProcs(lines) {
  const rows = [];
  for (const line of lines ?? []) {
    if (/^\s*PID\b/.test(line)) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!m) return null;
    rows.push({ pid: Number(m[1]), uid: Number(m[2]), cpu: Number(m[3]) });
  }
  // one pid twice means a sample that is not one snapshot of the process table: no reading
  if (new Set(rows.map(r => r.pid)).size !== rows.length) return null;
  return rows.length ? rows : null;
}
const APPLE_PATH = /^\/(System\/|usr\/(libexec|sbin|bin)\/|sbin\/|bin\/|Library\/Apple\/|Applications\/(Safari|Utilities)\b)/;
const centi = h => Math.ceil(h / 10) / 1000;
/** S9.cpuTree is the JUDGED CPU row on macOS (Sean 11-08; S9.cpu there is the whole machine, info only). This attribution block sits beside it
 * and shows where the whole-box S9.cpu goes; the block itself never judges. One top sample is split into
 *  - murage: every process of the leg user born at or after the leg stamp (server, workers, Electron, engine children),
 *  - apple: any process whose path is an Apple system path, checked FIRST and for any user (launchd daemons, Spotlight mds_stores, and
 *    mdworker_shared, which runs as the leg user and is born after the stamp but is never Murage; EXCEPT a descendant of a Murage root,
 *    which stays murage by lineage),
 *  - murage: ... (the rest of the leg user, born at or after the stamp),
 *  - other: everything else,
 * and the rig own processes (`rigPids`: every pid the rig spawned, recorded by pid, plus the rig node itself) are in none of them and are
 * never charged. Returns { cores, members, vanishedCores, otherCores, appleCores, procCpu } or null (no reading, never a zero).
 *  - the sample must hold exactly `expectedRows` rows (top own "Processes: N total"), else it is no reading;
 *  - a member of the last sample (pid AND start time, so a reused pid is a different process) that is gone from this one is charged its
 *    LAST OBSERVED cpu (members is a Map key -> hundredths of a percent; its last partial interval cannot be read); a previous member whose start time was unknown matches by pid alone;
 *  - a pid top lists that the ps table has not seen is counted as murage (reads high).
 * A child born AND gone inside one 1 s interval is invisible to per-process top: only the whole-box S9.cpu sees it. */
export function treeCores(procs, table, { uid, stampMs, rigPids = [], expectedRows, prev = new Map() }) {
  if (!procs || !table || !Number.isInteger(expectedRows) || procs.length !== expectedRows) return null;
  const floor = Math.floor(stampMs / 1000) * 1000;
  const rig = new Set(rigPids), info = new Map(table.map(r => [r.pid, r]));
  const members = new Map(), listed = new Map(), by = {};
  // lineage: a process whose parent chain reaches a Murage root (a leg-user process born after the stamp on a non-Apple path) is Murage whatever
  // its path, so a child that execs /bin/zsh, osascript or security is not charged to apple. Needs ppid in the ps table; without it, path only.
  const parent = new Map(table.map(r => [r.pid, r.ppid])), roots = new Set();
  for (const p of procs) { const row = info.get(p.pid), b = row?.bornMs; if (!rig.has(p.pid) && p.uid === uid && (b === undefined || b >= floor) && !(row && APPLE_PATH.test(row.name))) roots.add(p.pid); }
  const underRoot = pid => { let q = parent.get(pid); for (let i = 0; i < 32 && q !== undefined && q > 1; i++) { if (rig.has(q)) return false; if (roots.has(q)) return true; q = parent.get(q); } return false; };
  let mine = 0, apple = 0, other = 0, vanished = 0; // hundredths of a percent of one core
  for (const p of procs) {
    if (rig.has(p.pid)) continue;
    const row = info.get(p.pid), b = row?.bornMs;
    listed.set(p.pid, b === undefined ? "?" : String(b));
    const h = Math.round(p.cpu * 100), name = row ? baseName(row.name) : "?";
    if (row && APPLE_PATH.test(row.name) && !(p.uid === uid && b !== undefined && b >= floor && underRoot(p.pid))) { apple += h; by["apple:" + name] = (by["apple:" + name] ?? 0) + h; }
    else if (p.uid === uid && (b === undefined || b >= floor)) { members.set(p.pid + ":" + (b ?? "?"), h); mine += h; by["murage:" + name] = (by["murage:" + name] ?? 0) + h; }
    else { other += h; by["other:" + name] = (by["other:" + name] ?? 0) + h; }
  }
  for (const [key, last] of prev) {
    const [pid, born] = key.split(":"), now = listed.get(Number(pid));
    if (now === undefined || (born !== "?" && now !== "?" && now !== born)) vanished += last; // its last observed cpu, never a guess at the whole box
  }
  const procCpu = Object.fromEntries(Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, h]) => [k, centi(h)]));
  return { cores: centi(mine + vanished), members, vanishedCores: centi(vanished), otherCores: centi(other), appleCores: centi(apple), procCpu };
}
/** The attribution table of one window: mean cores by group and the top processes, from the samples treeCores produced. Null with no
 * trusted sample. Shows, never judges. */
export function attributionWindow(samples, from, to, excluded = []) {
  const w = samples.filter(s => Number.isFinite(s.treeCores) && s.t >= from && s.t <= to && !excluded.some(x => s.t >= x.from && s.t <= x.to));
  if (!w.length) return null;
  const mean = f => Math.round(w.reduce((a, s) => a + (s[f] ?? 0), 0) / w.length * 1000) / 1000;
  const acc = {};
  for (const s of w) for (const [k, v] of Object.entries(s.procCpu ?? {})) acc[k] = (acc[k] ?? 0) + v;
  const murage = mean("treeCores"), vanished = mean("vanishedCores"), apple = mean("appleCores"), other = mean("otherCores");
  const seen = murage - vanished + apple + other;
  return { n: w.length, meanCores: { murage, murageVanishedCharge: vanished, apple, other }, shareOfListed: seen > 0 ? { murage: Math.round((murage - vanished) / seen * 1000) / 1000, apple: Math.round(apple / seen * 1000) / 1000, other: Math.round(other / seen * 1000) / 1000 } : null,
    top: Object.entries(acc).map(([key, v]) => ({ key, meanCores: Math.round(v / w.length * 1000) / 1000 })).sort((x, y) => y.meanCores - x.meanCores).slice(0, 15) };
}
const LEFTOVER_NAMES = new Set(["node", "murage", "electron", "claude", "codex", "fuigo", "grok", "gemini", "droid", "openclaw", "pi", "opencode", "murage-browser-host"]);
const baseName = n => String(n ?? "").split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, "");
/** An earlier leg's server or engine still alive: born before the stamp it is outside the sum, so the leg would read low and is
 * invalid. The runner itself is not a leftover. */
export function leftovers(rows, { uid, stampMs, selfPid }) {
  const floor = Math.floor(stampMs / 1000) * 1000;
  return (rows ?? []).filter(r => r.uid === uid && r.bornMs < floor && r.pid !== selfPid && LEFTOVER_NAMES.has(baseName(r.name))).map(r => ({ pid: r.pid, name: baseName(r.name) }));
}
export const leftoverNames = names => (names ?? []).map(baseName).filter(n => LEFTOVER_NAMES.has(n));
/** The first Windows sampler line, as a verdict: "invalid" when the snapshot failed (the leg cannot start), else the leftovers. The
 * runner is one node born before the stamp, so only a second node is a leftover. */
export function winLeftovers(line) {
  if (String(line).trim() === "LEFTOVER-INVALID") return { invalid: true, left: [] };
  const names = leftoverNames(String(line).trim().split(/\s+/).slice(1));
  const nodes = names.filter(n => n === "node").length;
  return { invalid: false, left: names.filter(n => n !== "node" || nodes > 1) };
}
/** One data line of WIN_TELEMETRY_PS: "<busy 100 ns> <total 100 ns> <working set bytes> <processes>"; null for INVALID or anything else. */
export function winLine(line) {
  const m = /^(\d+) (\d+) (\d+) (\d+)$/.exec(String(line ?? "").trim());
  return m ? { busy: Number(m[1]), total: Number(m[2]), rss: Math.ceil(Number(m[3]) / 1048576), procs: Number(m[4]) } : null;
}
/** Whole-box cores between two GetSystemTimes readings; null when the counters did not move forward. */
export function winCores(prev, now, ncpu) {
  const db = now.busy - prev.busy, dt = now.total - prev.total;
  if (!(dt > 0) || db < 0) return null;
  return up3(db / dt * ncpu);
}
/** One "PEAKPROCS <summed working set bytes> <image>=<bytes> ..." line of WIN_TELEMETRY_PS: { rssMb, top:[{name, mb}] } (summed MB rounded up
 * like winLine; at most 8 entries, largest first, ties by name; names re-cut to [A-Za-z0-9._-] and 40 chars), or null when it is not
 * one or any part of it is malformed. winLine never reads this line, so it cannot touch a sample, a row or a verdict. Informational only. */
export const PEAK_PROCS_MAX = 8;
export function winPeakProcs(line) {
  const parts = String(line ?? "").trim().split(/\s+/);
  if (parts[0] !== "PEAKPROCS" || !/^\d+$/.test(parts[1] ?? "")) return null;
  const top = [];
  for (const tok of parts.slice(2)) {
    const m = /^([^=]+)=(\d+)$/.exec(tok);
    if (!m) return null;
    top.push({ name: m[1].replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40), bytes: Number(m[2]) });
  }
  top.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rssMb: Math.ceil(Number(parts[1]) / 1048576), top: top.slice(0, PEAK_PROCS_MAX).map(p => ({ name: p.name, mb: Math.ceil(p.bytes / 1048576) })) };
}
/** The gate markdown line for results.rssPeakProcs ({ atMs, rssMb, top }); null when the leg has none (Linux, Mac, an older rig). Information
 * only: not a row, not in the budgets or the verdict. */
export function rssPeakLine(results) {
  const p = results?.rssPeakProcs;
  if (!p || !Number.isFinite(p.rssMb) || !Array.isArray(p.top) || p.top.length === 0) return null;
  const at = Number.isFinite(p.atMs) ? new Date(p.atMs).toISOString() : "unknown time";
  const names = p.top.slice(0, PEAK_PROCS_MAX).map(t => `${String(t.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)} ${Number(t.mb)} MB`).join(", ");
  return `ALL.rss_peak_procs (${results.label ?? "run"}, info only, no budget): Windows leg-user working set peaked at ${p.rssMb} MB at ${at}; top processes: ${names}`;
}
/** The Windows sampler, run once as `powershell -EncodedCommand` for the whole run. Env SMOOTH_STAMP_MS is the stamp. First line
 * "LEFTOVER <names>" (every process born before the stamp, any owner) or LEFTOVER-INVALID, then one data line about every 900 ms, or INVALID.
 * One NtQuerySystemInformation(SystemProcessInformation) snapshot per tick needs no handle on any process, so nothing can be denied and
 * nothing is dropped: every process born after the stamp counts, whatever its owner. That reads high, never low. Any failed status, a walk
 * that leaves the returned bytes, an entry with no create time, or a snapshot missing this sampler itself is INVALID, never a smaller sum.
 * Rev 6.5: on each new maximum of the summed working set the same walk also yields one extra line after the data line,
 * "PEAKPROCS <summed bytes> <image>=<bytes> ..." (top 8 by working set, image name only: no command line, no path, name cut to [A-Za-z0-9._-], 40 chars).
 * winLine ignores it (null); winTelemetry hands it to winPeakProcs. Information only: no row, budget or verdict reads it. */
export const WIN_TELEMETRY_PS = [
  "Add-Type -TypeDefinition @'",
  "using System; using System.Text; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices;",
  "public static class SmoothTel {",
  "  [DllImport(\"ntdll.dll\")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);",
  "  public class P { public long Pid; public long Born; public long Ws; public string Name; }",
  "  const int MISMATCH = unchecked((int)0xC0000004); const int MIN_ENTRY = 152;",
  "  public static List<P> Snap() { if (IntPtr.Size != 8) return null; int len = 1 << 20; long me = Process.GetCurrentProcess().Id;",
  "    for (int tries = 0; tries < 6; tries++) { IntPtr b = Marshal.AllocHGlobal(len); try { int r = 0; int st = NtQuerySystemInformation(5, b, len, out r);",
  "      if (st == MISMATCH) { len = Math.Max(len * 2, r + 65536); continue; } if (st != 0 || r < MIN_ENTRY || r > len) return null;",
  "      var list = new List<P>(); int off = 0; bool self = false;",
  "      while (true) { if (off + MIN_ENTRY > r) return null; IntPtr p = IntPtr.Add(b, off); var e = new P();",
  "        e.Born = Marshal.ReadInt64(p, 32); e.Pid = Marshal.ReadInt64(p, 80); e.Ws = Marshal.ReadInt64(p, 144); int nameLen = Marshal.ReadInt16(p, 56) & 0xFFFF; IntPtr name = Marshal.ReadIntPtr(p, 64);",
  "        if (nameLen > 0) { long nb = name.ToInt64(), bb = b.ToInt64(); if (nameLen % 2 != 0 || nb < bb || nb + nameLen > bb + r) return null; }",
  "        e.Name = nameLen > 0 ? Marshal.PtrToStringUni(name, nameLen / 2) : \"\"; if (e.Ws < 0 || (e.Born <= 0 && e.Pid != 0)) return null;",
  "        if (e.Pid == me && e.Ws > 0) self = true; list.Add(e); int nx = Marshal.ReadInt32(p, 0); if (nx == 0) break; if (nx < MIN_ENTRY || nx > r - off - MIN_ENTRY) return null; off += nx; }",
  "      return self ? list : null; } finally { Marshal.FreeHGlobal(b); } } return null; }",
  "  public static string Leftovers(long stamp) { var s = Snap(); if (s == null) return \"LEFTOVER-INVALID\"; var sb = new StringBuilder(\"LEFTOVER\"); foreach (var e in s) if (e.Born < stamp && e.Name.Length > 0) sb.Append(' ').Append(e.Name.Replace(' ', '_')); return sb.ToString(); }",
  "  static long peakWs = -1; static string peakLine = null;",
  "  static string Clean(string nm) { var sb = new StringBuilder(); foreach (char c in nm) { if (sb.Length >= 40) break; sb.Append((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' ? c : '_'); } return sb.Length > 0 ? sb.ToString() : \"_\"; }",
  "  public static string TakePeak() { string p = peakLine; peakLine = null; return p; }",
  "  public static string Line(long stamp) {",
  "    long i, k, u; if (!GetSystemTimes(out i, out k, out u)) return \"INVALID\";",
  "    var s = Snap(); if (s == null) return \"INVALID\";",
  "    var mine = new List<P>(); long ws = 0; int n = 0; foreach (var e in s) if (e.Born >= stamp) { ws += e.Ws; n++; mine.Add(e); }",
  "    if (ws > peakWs) { peakWs = ws; mine.Sort((a, b) => b.Ws.CompareTo(a.Ws)); var pk = new StringBuilder(\"PEAKPROCS \" + ws); for (int j = 0; j < mine.Count && j < 8; j++) pk.Append(' ').Append(Clean(mine[j].Name)).Append('=').Append(mine[j].Ws); peakLine = pk.ToString(); }",
  "    return (k + u - i) + \" \" + (k + u) + \" \" + ws + \" \" + n; } }",
  "'@",
  "$stamp = ([long]$env:SMOOTH_STAMP_MS + 11644473600000L) * 10000L",
  "$left = try { [SmoothTel]::Leftovers($stamp) } catch { 'LEFTOVER-INVALID' }; [Console]::Out.WriteLine($left); [Console]::Out.Flush()",
  "while ($true) { $l = try { [SmoothTel]::Line($stamp) } catch { 'INVALID' }; [Console]::Out.WriteLine($l); $pk = try { [SmoothTel]::TakePeak() } catch { $null }; if ($pk) { [Console]::Out.WriteLine($pk) }; [Console]::Out.Flush(); Start-Sleep -Milliseconds 900 }",
].join("\n");
/** The argument for `powershell -EncodedCommand` (UTF-16LE base64), so no quoting of the script ever reaches cmd or argv rules. */
export const encodedPowerShell = script => Buffer.from(script, "utf16le").toString("base64");
/** The longest a window may go without a reading of a counter (samplers run about 1/s). There is no exemption: these counters do not
 * depend on a server being up, so a restart needs none. */
export const MAX_GAP_MS = 3000;
function fieldWindow(samples, field, from, to, stats, excluded = []) {
  const outside = t => !excluded.some(w => t >= w.from && t <= w.to);
  // Collapse only explicitly excluded time. A real sampling gap outside it still fails.
  const clock = t => t - excluded.reduce((n, w) => n + Math.max(0, Math.min(t, w.to) - w.from), 0);
  const all = samples.filter(s => field in s).sort((x, y) => x.t - y.t);
  const w = all.filter((s, i) => s.t >= from && s.t <= to && outside(s.t)
    && (field !== "cores" || !excluded.some(w => all[i - 1]?.t <= w.to && s.t > w.to)));
  const edges = [from, ...w.map(s => s.t), to].map(clock);
  let maxGapMs = 0;
  for (let i = 1; i < edges.length; i++) maxGapMs = Math.max(maxGapMs, edges[i] - edges[i - 1]);
  const invalid = w.filter(s => !Number.isFinite(s[field])).length;
  const ok = invalid === 0 && maxGapMs <= MAX_GAP_MS;
  return { stats: stats(ok ? w.map(s => s[field]) : []), n: w.length, maxGapMs, invalid, ok };
}
/** The pids the rig itself spawned. A released pid stays excluded for `graceMs` (a top sample taken just before the child exited is settled
 * after it), then is dropped, so a reused pid cannot hide a real Murage child for the rest of a long run. */
export function rigPidTracker({ graceMs = 15000, timer = setTimeout } = {}) {
  const pids = new Set();
  return {
    add: pid => { if (Number.isInteger(pid)) pids.add(pid); },
    release: pid => { const t = timer(() => pids.delete(pid), graceMs); t?.unref?.(); },
    list: () => [...pids],
  };
}
/** The pre-start quiet check, beside leftovers() and BEFORE Murage starts: null when load1 is under `max`, else the refusal text. It cannot be
 * caused by Murage and is never read after the stamp. */
export const preStartBusy = (load1, max = 2) => (Number.isFinite(load1) && load1 < max ? null : "not measured: box busy before Murage started, load1 " + (Number.isFinite(load1) ? load1.toFixed(2) : "unreadable") + " (needs under " + max + ")");
/** The pre-start ruling (MurageMain): a busy start (load1 at or over `max`, or unreadable) is only REFUSED on an idle-only leg (scenario names exactly
 * ["idle"]), whose S9.cpu reading would be the whole point. Every other leg runs and records the busy flag, so its CPU and latency rows read not
 * measured (judgeRow) while its per-process io rows stay measured. Returns { busy, refuse, reason } (reason null when quiet). */
export function preStartCheck(load1, scenarioNames, max = 2) {
  const reason = preStartBusy(load1, max), busy = reason !== null;
  const names = Array.isArray(scenarioNames) ? scenarioNames : [];
  return { busy, refuse: busy && names.length === 1 && names[0] === "idle", reason };
}
/** What every result file records about itself: the rig commit (env RIG_SHA, else git HEAD of the rig dir, 40 hex or null) and, on macOS,
 * the Spotlight state (`mdutil -s /` output, or "unreadable"). Never throws: a missing field reads null, and null is shown as unknown. */
export function rigProvenance({ env = {}, git, mdutil, platform }) {
  let sha = /^[0-9a-f]{40}$/.test(String(env.RIG_SHA ?? "")) ? env.RIG_SHA : null;
  if (!sha) { try { const s = String(git?.() ?? "").trim(); sha = /^[0-9a-f]{40}$/.test(s) ? s : null; } catch { sha = null; } }
  let spotlight = null;
  if (platform === "darwin") { try { spotlight = String(mdutil?.() ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || "unreadable"; } catch { spotlight = "unreadable"; } }
  return { rigSha: sha, spotlight };
}
/** The box-quiet preflight: S9.cpuTree is only a reading when the whole box was quiet, so load1 (sampled by the rig each second on macOS) must be
 * under `maxLoad` for EVERY sample of the window. No load sample, or one unreadable, is not quiet (fails closed: the row reads not measured). */
export const BOX_QUIET_LOAD = 2;
export function boxQuiet(samples, from, to, excluded = [], maxLoad = BOX_QUIET_LOAD) {
  const w = samples.filter(s => "load1" in s && s.t >= from && s.t <= to && !excluded.some(x => s.t >= x.from && s.t <= x.to));
  const max = w.length ? Math.max(...w.map(s => (Number.isFinite(s.load1) ? s.load1 : Infinity))) : null;
  // coverage: load must be read across the whole window, no gap over MAX_GAP_MS (one low reading cannot qualify a window)
  const edges = [from, ...w.map(s => s.t).sort((x, y) => x - y), to];
  let gap = 0; for (let i = 1; i < edges.length; i++) gap = Math.max(gap, edges[i] - edges[i - 1]);
  return { quiet: w.length > 0 && Number.isFinite(max) && max < maxLoad && gap <= MAX_GAP_MS, maxGapMs: gap, maxLoad1: Number.isFinite(max) ? max : null, n: w.length, bound: maxLoad };
}
/** CPU and RSS of one window from samples ({ t, cores?, rss? }; a field that is present and null is an unreadable tick). Each counter
 * is judged alone: one unreadable tick or one gap over MAX_GAP_MS empties it, so its budget row reads "not measured" and fails. */
export function sampleWindow(samples, from, to, stats, excluded = []) {
  const c = fieldWindow(samples, "cores", from, to, stats, excluded), r = fieldWindow(samples, "rss", from, to, stats, excluded);
  // S9.cpuTree exists only where the rig sampled the process tree (macOS); a leg without it keeps its old shape
  const t = samples.some(s => "treeCores" in s) ? fieldWindow(samples, "treeCores", from, to, stats, excluded) : null;
  const at = t ? attributionWindow(samples, from, to, excluded) : null;
  const q = t ? boxQuiet(samples, from, to, excluded) : null;
  return { cpu: c.stats, rssMb: r.stats, ...(t ? { cpuTree: q.quiet ? t.stats : stats([]), boxQuiet: q } : {}), ...(at ? { attribution: { ...at, boxQuiet: q.quiet } } : {}), telemetry: { cpu: { samples: c.n, maxGapMs: c.maxGapMs, invalid: c.invalid, ok: c.ok }, rss: { samples: r.n, maxGapMs: r.maxGapMs, invalid: r.invalid, ok: r.ok }, ...(t ? { cpuTree: { samples: t.n, maxGapMs: t.maxGapMs, invalid: t.invalid, ok: t.ok && q.quiet } } : {}) } };
}
/** ALL.rss on Linux: the cgroup's own peak also counts. An unreadable peak empties the row. */
export function withPeak(rssMb, peakMb) {
  if (!Number.isFinite(peakMb)) return { ...rssMb, n: 0, max: null, peakMb: null };
  return rssMb?.max === null || rssMb?.max === undefined ? rssMb : { ...rssMb, max: Math.max(rssMb.max, peakMb), peakMb };
}
/** One card as results keep it: the whole card, through the product's redaction, or a plain statement when that is not available. */
export function keptCard(card, redact) {
  if (typeof redact !== "function") return { unavailable: "redaction not loaded: payload not kept" };
  try { return { payload: redact(JSON.stringify(card ?? null)) }; } catch { return { unavailable: "redaction failed: payload not kept" }; }
}
/** S9.io. An io-budget line reports the 60 s before it (server/io-budget.ts: IO_BUDGET_INTERVAL_MS), so a line in the idle scenario's first
 * minute reads the previous scenario. The log size is polled from the scenario's start. The count starts at the last poll before
 * start + 60 s, so a line at or after that mark always counts, and it runs to an absolute deadline just after start + 60 s + seconds: this
 * can read high, never low. A gap between polls over IDLE_IO_MAX_GAP_MS means both counts are null, so the row reads not measured.
 * `ioBudgetOldWay` is the old count, from the scenario's start over `seconds`, shown beside it. */
export const IDLE_IO_SETTLE_MS = 60_000, IDLE_IO_MARGIN_MS = 2_000, IDLE_IO_POLL_MS = 500, IDLE_IO_MAX_GAP_MS = 3_000;
export async function idleIoCounts({ seconds, mark, startMs, now, sleep, logSize, logFrom, count }) {
  const deadline = startMs + IDLE_IO_SETTLE_MS + seconds * 1000 + IDLE_IO_MARGIN_MS;
  const polls = [{ t: startMs, size: mark }];
  // the time is stamped after the size is read, so a poll stamped before the mark really read the log before the mark
  while (now() < deadline) { await sleep(IDLE_IO_POLL_MS); const size = logSize(); polls.push({ t: now(), size }); }
  for (let i = 1; i < polls.length; i++) if (polls[i].t - polls[i - 1].t > IDLE_IO_MAX_GAP_MS) return { ioBudget: null, ioBudgetOldWay: null, ioPollGapMs: polls[i].t - polls[i - 1].t };
  const atMark = polls.filter(p => p.t < startMs + IDLE_IO_SETTLE_MS).at(-1);
  const oldEnd = polls.find(p => p.t >= startMs + seconds * 1000) ?? polls.at(-1);
  const ioBudget = count(logFrom(atMark.size));
  const ioBudgetOldWay = count(Buffer.from(logFrom(mark), "utf8").subarray(0, Math.max(0, oldEnd.size - mark)).toString("utf8"));
  return { ioBudget, ioBudgetOldWay };
}
/** ALL.eld and ALL.eld250: an unreadable sample empties both, and no samples at all never reads as no stalls. */
export function eldSummary(rows, stats) {
  const w = rows ?? [], bad = w.some(r => !Number.isFinite(r.stall));
  if (bad || !w.length) return { ...stats([]), secondsOver250: null, ...(bad ? { unreadable: true } : {}) };
  return { ...stats(w.map(r => r.stall)), secondsOver250: w.filter(r => r.stall > 250).length };
}
/** Whether a transcript page proves it holds every row since `since`: the whole thread, or a page reaching back before that time. */
export function pageCovers(messages, hasMore, since) {
  if (hasMore !== true || since === null) return true;
  const ats = (messages ?? []).map(m => m?.at).filter(Number.isFinite);
  return ats.length > 0 && Math.min(...ats) < since;
}
/** A timing row where every turn must have its timing: one missing timing empties the row, so it reads not measured. */
export function allTimed(values, stats) {
  const rows = values ?? [], untimed = rows.filter(v => !Number.isFinite(v)).length;
  return untimed ? { n: rows.length, p50: null, p90: null, max: null, untimed } : stats(rows);
}
/** A card timing row: every timing read, but one approval card with no timing empties the row, so it reads not measured. */
export function cardStat(cards, key, stats) {
  const rows = cards ?? [], untimed = rows.filter(c => c.kind === "approval" && !Number.isFinite(c[key])).length;
  return untimed ? { n: rows.length, p50: null, p90: null, max: null, untimed } : stats(rows.map(c => c[key]));
}
/** Any retained or printed error text: through the product's redaction, or a plain statement, never the raw text. */
export function scrubAccounting(text, visit = () => {}) {
  if (typeof text !== "string") throw TypeError("scrubber requires text");
  return scrubCore(text.slice(0, 2000), visit);
}
export function keptText(text, redact, cap = 2000, visit) {
  if (typeof redact !== "function") return "redaction not loaded: text not kept";
  try { return scrubAccounting(redact(String(text ?? "")).slice(0, Math.min(2000, cap)), visit); }
  catch { return "redaction or accounting scrub failed: text not kept"; }
}
/** SSE completion allowlist: no usage, cost, charge, token fields or arbitrary objects. */
export function keptTurnEnd(end, redact) {
  const text = value => typeof value === "string" ? keptText(value, redact, 300) : null;
  return { stopReason: text(end?.stopReason), deniedBy: text(end?.deniedBy),
    denials: (Array.isArray(end?.denials) ? end.denials : []).filter(v => typeof v === "string").slice(0, 10).map(text) };
}

export const failedTurnKey = event => typeof event?.turnId === "string" && event.turnId
  ? `turn:${event.turnId}` : `thread:${event?.threadId}:turn:${event?.turn ?? "unknown"}`;

/** Pure SSE projection: callers append synchronously before resolving waiters or
 * starting transcript reads. seen contains full identities, never shortened IDs. */
export function failureEventRecord({ event, ownedThreads, seen, at, scenario }, redact) {
  if (!ownedThreads.has(event?.threadId) || !(event.type === "turn.failed"
    || (event.type === "turn.completed" && event.ok === false)) || seen.has(failedTurnKey(event))) return null;
  return { kind: "first", key: keptText(failedTurnKey(event), redact, 300), at,
    scenario: keptText(scenario, redact, 80), threadId8: keptText(event.threadId, redact, 8),
    turnId8: typeof event.turnId === "string" ? keptText(event.turnId, redact, 8) : null,
    outcome: "turn.failed", ...keptTurnEnd(event, redact) };
}

/** Production filesystem adapter; injection lets tests exercise removal errors. */
export function controlAdapter({ pathOf, readFileSync, writeFileSync, rmSync }) {
  return {
    readControl(name) {
      try { return readFileSync(pathOf(name), "utf8"); }
      catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    },
    ctl(name, value) {
      if (value !== null) return writeFileSync(pathOf(name), String(value));
      try { rmSync(pathOf(name)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    },
  };
}

export function restoreControls({ ctl, readControl, values, onFailure }) {
  const failures = [];
  for (const [name, value] of Object.entries(values)) {
    try { ctl(name, value); } catch (error) { failures.push(`${name}: ${error?.code ?? "write failed"}`); }
    try { if (readControl(name) !== value) failures.push(`${name}: read-back mismatch`); }
    catch (error) { failures.push(`${name}: ${error?.code ?? "read failed"}`); }
  }
  if (failures.length) {
    const error = Error(`control restoration failed: ${failures.join("; ")}`);
    onFailure?.(error);
    throw error;
  }
}

/** JSON-RPC frames: server/drivers/acp/core.ts:4268,4293-4295; native envelope is
 * {at,dir,source,msg} (server/drivers/native.ts:227). turn-trace's key=value writer
 * is server/turn-trace.ts:42-49,60; CURRENT rpc spans carry outcome only
 * (server/drivers/acp/core.ts:2796-2799), not code/message. Accept those pairs if
 * present in a tested build, but never invent a message from an outcome/rpcCode.
 * Input must already be redacted. Only error.code/message survive, never data. */
export function rpcErrorsIn(lines) {
  const errors = [], seen = new Set();
  const add = error => {
    if (!Number.isSafeInteger(error?.code) || typeof error?.message !== "string") return;
    const row = { code: error.code, message: keptText(error.message, text => text, 300) }, key = JSON.stringify(row);
    if (!seen.has(key) && errors.length < 10) { seen.add(key); errors.push(row); }
  };
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== "string") continue;
    try {
      const start = line.indexOf("{");
      if (start >= 0) {
        const value = JSON.parse(line.slice(start));
        add(value?.error); add(value?.msg?.error);
      } else {
        const code = /(?:^|\s)code=(-?\d+)(?=\s|$)/.exec(line);
        const message = /(?:^|\s)message=("(?:[^"\\]|\\.)*"|[^\s"]+)(?=\s|$)/.exec(line);
        if (code && message) add({ code: Number(code[1]), message: message[1].startsWith('"') ? JSON.parse(message[1]) : message[1] });
      }
    } catch { /* malformed or truncated lines give no evidence */ }
    if (errors.length === 10) break;
  }
  return errors;
}

/** Select only this turn window's incoming native RPC errors, never protocol
 * payloads. Native files are product-redacted at server/drivers/native.ts:227;
 * redact each complete line again before parsing, never after a truncation. */
export function nativeRpcErrorsIn(text, sinceAt, redact) {
  if (typeof text !== "string" || !Number.isFinite(sinceAt) || typeof redact !== "function") return [];
  const lines = [];
  for (const raw of text.split("\n")) {
    try {
      const line = String(redact(raw)).slice(0, 64 * 1024), frame = JSON.parse(line);
      const at = typeof frame.at === "string" ? Date.parse(frame.at) : NaN;
      if (frame.dir === "in" && at >= sinceAt && frame.msg?.error) lines.push(line);
    } catch { /* malformed, truncated and non-error frames are not retained */ }
  }
  return rpcErrorsIn(lines);
}

const keptTrace = (lines, redact) => (Array.isArray(lines) ? lines : []).filter(line => typeof line === "string")
  .slice(-40).map(line => keptText(line, redact, 600));

/** Pure, explicit failed-turn record. Call only for runner-owned bots; errorRows
 * must be this turn's rows. No transcript fallback and no spreading engine data. */
export function failedTurnRecord({ at, scenario, botId, result, errorRows = [] }, redact) {
  const rows = errorRowsIn(Array.isArray(errorRows) ? errorRows : []);
  const rowText = row => row.tool?.errorDetails ?? row.text ?? row.error ?? row.card?.title ?? row.tool?.name;
  const error = rows.map(rowText).filter(value => typeof value === "string").join("\n") || result?.error;
  const errorTrace = keptTrace(result?.errorTrace, redact);
  const nativeRpc = (Array.isArray(result?.rpcErrors) ? result.rpcErrors : []).flatMap(row =>
    Number.isSafeInteger(row?.code) && typeof row?.message === "string"
      ? [JSON.stringify({ error: { code: row.code, message: keptText(row.message, redact, 300) } })] : []);
  // Current runtime.error rows retain the RPC diagnostic and sanitized message:
  // server/index.ts:9154-9161; acp/core.ts:5684 and 869-883 supply the older details form.
  const rowRpc = rows.flatMap(row => {
    const message = rowText(row);
    if (typeof message !== "string") return [];
    const detailCode = /(?:^|\n)Engine error code: (-?\d+)(?=\n|$)/.exec(message);
    const code = row.tool?.diagnostic?.rpcCode ?? (detailCode ? Number(detailCode[1]) : undefined);
    return Number.isSafeInteger(code) ? [JSON.stringify({ error: { code, message: keptText(message.split("\n")[0], redact, 300) } })] : [];
  });
  return { at, scenario: keptText(scenario, redact, 80), botId8: keptText(botId, redact, 8).slice(0, 8),
    outcome: typeof result?.outcome === "string" ? keptText(result.outcome, redact, 80) : null,
    ...keptTurnEnd(result, redact), error: typeof error === "string" ? keptText(error, redact) : null,
    rpcErrors: rpcErrorsIn([...nativeRpc, ...rowRpc, ...errorTrace]).map(row => ({ code: row.code, message: keptText(row.message, redact, 300) })), errorTrace };
}
/** The turn-trace lines of one failed turn, through the same redaction, for its error class: never a line without the trace's id. */
export function traceLinesOf(logText, traceId, redact, cap = 40) {
  if (typeof redact !== "function" || typeof traceId !== "string" || !/^[\w-]+$/.test(traceId)) return [];
  return keptTrace(String(logText ?? "").split("\n").filter(l => l.includes(`[turn-trace] id=${traceId} `)).slice(-cap), redact);
}
/** S1's routine prompt. On real engines it carries its own list and says where the line goes, so a model has nothing to ask (11-06 Mac: 8 of 8
 * cards asked what "item N" meant). It does not tell the model not to ask: a card here still counts. Fake engines keep the old words. */
const ROUTINE_LIST = ["apples", "bread", "coffee", "dates", "eggs", "figs", "grapes", "honey"];
export const routinePrompt = (engines, i) => engines === "real"
  ? `Here is the list: ${ROUTINE_LIST.map((w, k) => `item ${k} is ${w}`).join(", ")}. Reply here in this chat with one short line about ${ROUTINE_LIST[i % ROUTINE_LIST.length]}.`
  : `Post one line about item ${i}.`;
/** Rows a real leg's empty data dir cannot measure: true only with the rig's proof the dir was empty at the start and the scenario's own words. */
export function emptyDirRow(row, results) {
  if (results?.engines !== "real" || results?.dataDirEmptyAtStart !== true) return false;
  // the row's own value must be truly absent: a malformed or null value is unreadable evidence, not an empty dir
  if (row.path.split(".").reduce((o, k) => o?.[k], results) !== undefined) return false;
  if (row.realEmptyDir === "deleteThread" && results?.scenarios?.deletion?.error !== undefined) return false;
  if (row.realEmptyDir === "longThread") return /^no top-40 thread belongs to a visible bot/.test(String(results?.scenarios?.longThread?.error ?? ""));
  if (row.realEmptyDir === "deleteThread") return results?.scenarios?.deletion?.deleteThreadStatus === "no old conversation found";
  return false;
}
/** S2 on real engines: a prompt a real model can act on, naming the product's own hand-off tool (server/drivers/agents-proxy.ts). */
export const realDelegationPrompt = worker => `Use your delegate_bot tool now to hand this task to the bot with id ${worker.id} (${worker.name}): reply with the single word pong. Do not do the task yourself and do not use ask_bot. When its result comes back, tell me the word it replied with.`;
/** The data-dir guard of smooth.mjs on every OS: a path under a "smooth..." directory and never inside a .murage directory
 * (Windows paths use backslashes). */
export function dataDirAllowed(dir) {
  const d = String(dir ?? "");
  // macOS and Windows file systems ignore case, and Windows also drops trailing dots and spaces (".MURAGE", ".murage." and
  // ".murage " all open the real .murage), so every component is compared folded.
  const fold = s => s.toLowerCase().replace(/[. ]+$/, "");
  return d !== "" && /[\\/]smooth/i.test(d) && !d.split(/[\\/]/).some(s => fold(s) === ".murage");
}
const murageComponent = p => String(p).split(/[\\/]/).some(s => s.toLowerCase().replace(/[. ]+$/, "") === ".murage");
/** RIG-SMOOTH-R2 (a): the real path of the data dir and of every ancestor (root first) must stay out of .murage, and the dir's own
 * real path must still pass dataDirAllowed. `realpath` is realpathSync.native in smooth.mjs; any throw refuses. A junction or symlink
 * anywhere on the path is caught, whatever its depth. */
export function dataDirRealOk(dir, realpath) {
  const d = String(dir ?? ""); if (!d) return false;
  const parts = d.split(/[\\/]/); const sep = d.includes("\\") && !d.startsWith("/") ? "\\" : "/";
  try {
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join(sep); if (p === "" || /^[A-Za-z]:$/.test(p)) continue;
      if (murageComponent(realpath(p))) return false;
    }
    return dataDirAllowed(realpath(d));
  } catch { return false; }
}
/** RIG-SMOOTH-R2 (d): the staged browser host against the build under test. */
export function browserHostVerdict({ sha256, expected } = {}) {
  if (!sha256) return "absent";
  if (!expected) return "unverified";
  return String(sha256).toLowerCase() === String(expected).toLowerCase() ? "ok" : "mismatch";
}
/** True when `metaUrl` (import.meta.url) is the script node was started with (argv[1]), on every OS: compares file URLs,
 * never "file://" + a raw path (a Windows path has backslashes and a drive letter). */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(resolve(argv1)).href; } catch { return false; }
}
/** The OS variables the real leg passes through to the server besides its own: none on Linux (the env stays as in 1.0.15),
 * the login names on macOS (keychain sign-ins), and on Windows what Node, cmd shims and the engines need to start at all. */
export function osPassThrough(platform) {
  if (platform === "win32") return ["SystemRoot", "windir", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "HOMEDRIVE", "HOMEPATH"];
  if (platform === "darwin") return ["USER", "LOGNAME", "SHELL"];
  return [];
}

/** The line smooth.mjs writes to the server log right before it spawns a server process. */
export const SERVER_START_MARK = "[smooth] server start";
const ELD_LINE = /\[eld\] t=(\d+) p50=[\d.]+ p99=[\d.]+ max=([\d.]+)/g;
/**
 * Event-loop stalls, one per `[eld]` line: the line's own max, or the silence since the line before it (less the 1 s
 * cadence), whichever is larger. `raw` is the old rule (SMOOTH-ELD-ROOT-CAUSE): it also counts the silence between a
 * stopped server and the next process's first line, which is no stall of any process (SMOOTH-RIG-RESTART-GAP).
 * `fixed` gives that one line its own max only. Every line after it (module load, startup work) stays in the window.
 * A new process is a SERVER_START_MARK line; a log with none (older rigs) falls back on
 * `phase=startup.module.loaded ms=M`: of the `[eld]` lines within M ms before it and the one after, the one after the
 * longest silence.
 * Returns { raw, fixed, restarts } with rows { t, stall } in [from, to].
 */
export function eldStalls(text, from = -Infinity, to = Infinity) {
  const s = String(text ?? "");
  const rows = [...s.matchAll(ELD_LINE)].map(m => ({ at: m.index, t: +m[1], max: +m[2] }));
  const gap = i => (i ? rows[i].t - rows[i - 1].t - 1000 : 0);
  const firstOfProcess = new Set();
  const marks = []; for (let k = s.indexOf(SERVER_START_MARK); k >= 0; k = s.indexOf(SERVER_START_MARK, k + 1)) marks.push(k);
  const after = at => rows.findIndex(r => r.at > at);
  if (marks.length) { for (const k of marks) { const i = after(k); if (i > 0) firstOfProcess.add(i); } }
  else {
    const re = /phase=startup\.module\.loaded ms=(\d+)/g;
    // the first startup line is the first process: nothing before it to leave out
    for (const m of [...s.matchAll(re)].slice(1)) {
      // module load took ms=M since the process began, so its first line is one of the ceil(M/1000)+1 before, or the next.
      const j0 = after(m.index), j = j0 < 0 ? rows.length : j0, back = Math.ceil(+m[1] / 1000) + 1;
      const cands = []; for (let i = j - back; i <= j; i++) if (i > 0 && i < rows.length) cands.push(i);
      if (cands.length) firstOfProcess.add(cands.reduce((a, b) => (gap(b) > gap(a) ? b : a)));
    }
  }
  const pick = fix => rows.map((r, i) => ({ t: r.t, stall: Math.max(r.max, fix && firstOfProcess.has(i) ? 0 : gap(i)) })).filter(r => r.t >= from && r.t <= to);
  const restarts = [...firstOfProcess].filter(i => rows[i].t >= from && rows[i].t <= to).map(i => ({ t: rows[i].t, gapMs: gap(i) }));
  return { raw: pick(false), fixed: pick(true), restarts };
}

/** Extend SMOOTH-RIG-RESTART-GAP's exclusion without hiding the old/raw observations.
 * The first ELD sample after the excluded window also straddles its end, so cannot be
 * attributed to ALL. Both its max and silence stay with the info-only window. */
export const ELD_COVER_MS = 5000;
export function measuredEld(text, from, to, stats, excluded = [], { head = false } = {}) {
  const { raw, fixed, restarts } = eldStalls(text, from, to);
  // coverage over the whole window: the server logs one line a second, so a log that stops before the window's end (or, when the server was
  // up from the start of the window, begins late) is not a measurement. Checked on every line, before any exclusion.
  const covered = fixed.length > 0 && (!Number.isFinite(to) || to - fixed.at(-1).t <= ELD_COVER_MS) && (!head || !Number.isFinite(from) || fixed[0].t - from <= ELD_COVER_MS);
  if (!covered) return { ...stats([]), secondsOver250: null, coverageGap: true, raw: eldSummary(raw, stats), restarts, excludedWindows: excluded };
  const after = new Set(excluded.map(w => fixed.find(r => r.t > w.to)?.t));
  const kept = fixed.filter(r => !after.has(r.t) && !excluded.some(w => r.t >= w.from && r.t <= w.to));
  return { ...eldSummary(kept, stats), raw: eldSummary(raw, stats), restarts, excludedWindows: excluded };
}

/** io-budget reports the previous 60 s (server/io-budget.ts:19). Its lines have no
 * timestamp, so the first ELD line AFTER end+60 s is the conservative byte boundary.
 * The mixed minute belongs to WARM info, never ALL; retain its count explicitly. */
export function warmIoCounts(text, windows = []) {
  if (!windows.length) return { all: countSignatures(text).ioBudget, warm: 0, overlap: 0 };
  const bytes = Buffer.from(text, "utf8");
  let warm = 0, overlap = 0, all = 0, at = 0;
  const ranges = windows.map(w => {
    const tail = bytes.subarray(w.logTo).toString("utf8");
    const end = [...tail.matchAll(/\[eld\] t=(\d+)/g)].find(m => +m[1] > w.to + 60_000);
    return { ...w, ioTo: end ? w.logTo + Buffer.byteLength(tail.slice(0, end.index), "utf8") : bytes.length };
  });
  for (const line of String(text).split(/(?<=\n)/)) {
    const count = SIGNATURES.ioBudget.test(line) ? 1 : 0;
    const end = at + Buffer.byteLength(line, "utf8");
    const window = ranges.find(w => end > w.logFrom && at < w.ioTo);
    if (window) { warm += count; if (at >= window.logTo) overlap += count; }
    else all += count;
    at = end;
  }
  return { all, warm, overlap };
}

const get = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** One budget row judged against a results file. The limit is the row's value on every run, loaded or not. A missing value never
 * passes. On a loaded run a latency row also shows the old 1.5 factor beside it, as information only: it never changes `pass`. */
export function judgeRow(row, results, { oldLoadedFactor = 1.5 } = {}) {
  const scenario = results?.scenarios?.[row.scenario];
  const onMac = String(results?.telemetryMode?.mode ?? "").startsWith("mac-");
  // A row marked gatesIn is report-only for this release (IO-AMP moved to 1.0.19, Sean 11-08). It is decided here, once, before every other
  // branch: it can never fail the leg, whatever the scenario, the OS-bytes proof or a missing value says. It shows its value (or not measured,
  // with the reason) and the marker. Gating rows never reach this branch and keep every branch below.
  if (row.reportOnly === true && row.gatesIn) {
    const osBytesUnknown = row.osBytesSensitive === true && onMac && results?.env?.engineExclusion?.verdict !== "ok";
    const rawV = get(results, row.path);
    const num = typeof rawV === "number" && Number.isFinite(rawV) ? rawV : typeof rawV === "boolean" ? (rawV ? 1 : 0) : null;
    const value = osBytesUnknown || scenario?.invalid ? null : num;
    const wouldPass = value === null ? undefined : row.op === "<=" ? value <= row.value : row.op === ">=" ? value >= row.value : value === row.value;
    const oldWay = typeof row.oldWayPath === "string" ? get(results, row.oldWayPath) : undefined;
    return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value, value, pass: true, reportOnly: true, gatesIn: row.gatesIn,
      ...(value === null ? { missing: true } : { wouldPass }), ...(osBytesUnknown ? { osBytesUnknown: true } : {}), ...(scenario?.invalid ? { invalid: scenario.invalid } : {}),
      ...(oldWay !== undefined && value !== null ? { oldWay } : {}), unit: row.unit ?? "" };
  }
  if (row.macOnly && !onMac) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value, value: null, pass: true, notApplicable: true, unit: row.unit ?? "" };
  // macOS: S9.cpu is the whole-machine top, which reads Spotlight, mediaanalysisd and anything else on the box (Sean 11-08): shown with its
  // own label and wouldPass, never judged. S9.cpuTree is the judged CPU row there; Linux (cgroup) and Windows keep S9.cpu judged.
  if (row.macReportOnly === true && onMac) {
    const rawM = get(results, row.path);
    const valueM = scenario?.invalid ? null : typeof rawM === "number" && Number.isFinite(rawM) ? rawM : null;
    return { id: row.id, scenario: row.scenario, what: row.macWhat ?? row.what, op: row.op, limit: row.value, value: valueM, pass: true, reportOnly: true,
      ...(valueM === null ? { missing: true } : { wouldPass: valueM <= row.value }), unit: row.unit ?? "" };
  }
  // a macOnly reportOnly (attribution-only) row never takes a scenario invalidity as its own failure (the other rows of the scenario carry it); S9.cpuTree is no longer such a row
  if (scenario?.invalid && row.reportOnly === true && row.macOnly && onMac) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value, value: null, pass: true, reportOnly: true, missing: true, invalid: scenario.invalid, unit: row.unit ?? "" };
  if (scenario?.invalid) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value,
    value: null, pass: false, missing: true, invalid: scenario.invalid, unit: row.unit ?? "" };
  // a leg that started on a busy box (preStartCheck): the whole-box CPU row and every latency row are not measured; io rows are per-process and stay measured
  // The whole-box CPU row is never a pass off a busy start (Fable 43): it reads not measured AND not green. A latency row reads not measured and the leg runs.
  if (row.boxLoadSensitive === true && results?.boxBusyAtStart === true && onMac)
    return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value, value: null, pass: false, missing: true, busyAtStart: true, unit: row.unit ?? "" };
  if (row.latency === true && results?.boxBusyAtStart === true && onMac)
    return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value, value: null, pass: false, missing: true, busyAtStart: true, unit: row.unit ?? "" };
  // a Mac leg whose engine-exclusion addon is not the verified one has no OS write floor: the io rows rest on application bytes alone (osBytes unknown)
  if (row.osBytesSensitive === true && onMac && results?.env?.engineExclusion?.verdict !== "ok")
    return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value, value: null, pass: false, missing: true, osBytesUnknown: true, unit: row.unit ?? "" };
  // Before engineTime exemptions: incomplete S3 replies FAIL on real engines too.
  if (scenario?.incomplete === true && ["S3.cards", "S3.replies", "S3.first", "S3.last"].includes(row.id))
    return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit: row.value,
      value: null, pass: false, missing: true, roomIncomplete: true, unit: row.unit ?? "" };
  const raw = get(results, row.path);
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : typeof raw === "boolean" ? (raw ? 1 : 0) : null;
  const limit = row.value;
  const oldFactor = row.latency && results?.load === true && value !== null ? { limit: row.value * oldLoadedFactor, wouldPass: value <= row.value * oldLoadedFactor } : null;
  let pass = false;
  if (value !== null) {
    if (row.op === "<=") pass = value <= limit;
    else if (row.op === ">=") pass = value >= limit;
    else if (row.op === "==") pass = value === limit;
    else throw new Error(`budget ${row.id}: unknown op ${row.op}`);
  }
  const error = get(results, row.path.split(".").slice(0, 2).join(".") + ".error");
  // section 5: on real engines an engineTime row is the model's time, not Murage's (boot, deletes, stalls and stops stay judged), and a
  // fakeOnly row (the stop lines) is never sent; both are shown, never judged
  // a realOnly row (S10, real engines' own approval behaviour) is not sent on fake engines: shown, never judged
  // a macOnly row (S9.cpuTree) reads the macOS process tree: on any other leg it is n/a, never judged; on macOS it is judged. The next branch is
  // for a macOnly row that is also reportOnly (none in budgets.json now; kept for such a row, not removed)
  if (row.macOnly && row.reportOnly === true && value === null && String(results?.telemetryMode?.mode ?? "").startsWith("mac-")) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, reportOnly: true, missing: true, unit: row.unit ?? "" };
  if (row.macOnly && !String(results?.telemetryMode?.mode ?? "").startsWith("mac-")) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, notApplicable: true, unit: row.unit ?? "" };
  // report-only row (ALL.io r2): the value is printed and wouldPass shown, but it can never fail the leg
  if (row.reportOnly === true && value !== null) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, reportOnly: true, wouldPass: pass, unit: row.unit ?? "" };
  if (row.realOnly && results?.engines !== "real") return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, notApplicable: true, unit: row.unit ?? "" };
  if ((row.engineTime || row.fakeOnly) && results?.engines === "real") return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, notApplicable: true, unit: row.unit ?? "" };
  // a real leg's fresh empty data dir has no long thread and no old conversation; the fake leg on the data copy is these rows' proof.
  // Only on the rig's own proof that the dir was empty at the start AND the scenario's own words: anything else stays a FAIL.
  if (value === null && emptyDirRow(row, results)) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, missing: true, emptyDir: true, unit: row.unit ?? "" };
  // an optional row measures something a run may not raise (S7's cards: the real model decides whether a tool asks). "None raised" needs
  // proof: the count at row.noneWhenZero was really read and is exactly 0. A card with no timing, or no count, is not measured and fails.
  if (row.optional && value === null && typeof error !== "string" && typeof row.noneWhenZero === "string" && get(results, row.noneWhenZero) === 0) return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass: true, none: true, unit: row.unit ?? "" };
  const oldWay = typeof row.oldWayPath === "string" ? get(results, row.oldWayPath) : undefined;
  return { id: row.id, scenario: row.scenario, what: row.what, op: row.op, limit, value, pass, unit: row.unit ?? "", ...(value === null ? { missing: true } : {}), ...(typeof error === "string" ? { error } : {}), ...(oldFactor ? { oldFactor } : {}), ...(oldWay !== undefined ? { oldWay } : {}) };
}

/** Compare strictly major.minor (5.10 follows 5.9). */
export function rigVersionAtLeast(version, major, minor) {
  const match = typeof version === "string" && /^(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor)));
}

/** Every row judged; `pass` is true only when every row passed. */
export function judge(budgets, results, options) {
  const rows = (budgets.rows ?? []).map(row => judgeRow(row, results, options));
  if (results?.roomProofRequested === true) {
    const checks = roomProofChecks(results.scenarios?.room?.proof);
    const proofRows = ["respond", "interrupt"].map(step => ({ id: `S3.proof.${step}`, scenario: "room",
      what: step === "respond" ? "allowed room card response proven" : "working room interrupted and settled within 60 s",
      op: "==", limit: 1, value: results.engines === "fake" && checks[step] ? 1 : 0,
      pass: results.engines === "fake" && checks[step], unit: "" }));
    const lastRoom = rows.findLastIndex(row => row.scenario === "room");
    rows.splice(lastRoom < 0 ? rows.length : lastRoom + 1, 0, ...proofRows);
  }
  const refusal = roomProofRefusal(results?.roomProofRequested === true, results?.engines);
  if (refusal) return { rows, pass: false, failed: rows.filter(r => !r.pass).length, invalid: refusal };
  if (results?.mode === "packaged" && results.preflight?.ok !== true) {
    return { rows, pass: false, failed: rows.filter(r => !r.pass).length, invalid: results.preflight?.refusal ?? "packaged preflight did not complete" };
  }
  const hasVersion = Object.hasOwn(results ?? {}, "rigVersion");
  const validVersion = typeof results?.rigVersion === "string" && /^\d+\.\d+$/.test(results.rigVersion);
  const legacy = validVersion ? !rigVersionAtLeast(results.rigVersion, 5, 8)
    : !hasVersion && !Object.hasOwn(results ?? {}, "phase");
  if (hasVersion && !validVersion) return { rows, pass: false, failed: rows.filter(r => !r.pass).length,
    invalid: "invalid rigVersion: expected a major.minor string" };
  if (!legacy && (results?.legFailed || results?.phase !== "finished")) {
    const reason = results.legFailed
      ? results.legFailureReason ?? (results.roomNeverSettled ? "room never settled" : results.scenarios?.room?.incomplete ? "room did not settle" : "room cleanup failed")
      : `run did not finish cleanup (phase: ${results.phase ?? "missing"})`;
    return { rows, pass: false, failed: rows.filter(r => !r.pass).length, invalid: reason };
  }
  // a leg run with the CPU profiler is evidence for a fixer, never a judged leg: its timings are not the product's
  if (results?.cpuProfiled === true) return { rows, pass: false, failed: rows.filter(r => !r.pass).length, invalid: "this leg ran with the CPU profiler (SMOOTH_CPU_PROF_DIR): not a judged leg" };
  return { rows, pass: !results?.legFailed && rows.every(r => r.pass), failed: rows.filter(r => !r.pass).length,
    ...(results?.legFailed ? { invalid: results.roomNeverSettled ? "room never settled" : results.scenarios?.room?.incomplete ? "room did not settle" : "room cleanup failed" } : {}) };
}

/** The verdict file the release gate reads (release-ci-gate.mjs smoothnessVerdict): one tree, both runs. */
export function verdictOf({ tree, idle, loaded, engines, at = Date.now() }) {
  return {
    tree, engines: engines ?? idle?.engines ?? "fake", at: new Date(at).toISOString(),
    pass: Boolean(idle?.pass) && Boolean(loaded?.pass),
    load: { idle: idle ? { pass: idle.pass, failed: idle.failed } : null, loaded: loaded ? { pass: loaded.pass, failed: loaded.failed } : null },
    rows: Object.fromEntries([...(idle?.rows ?? []).map(r => [r.id, { value: r.value, pass: r.pass, ...(r.busyAtStart ? { busyAtStart: true } : {}), ...(r.osBytesUnknown ? { osBytesUnknown: true } : {}), ...(r.gatesIn ? { reportOnly: true, gatesIn: r.gatesIn } : {}) }]), ...(loaded?.rows ?? []).map(r => [`${r.id}@load`, { value: r.value, pass: r.pass, ...(r.busyAtStart ? { busyAtStart: true } : {}), ...(r.osBytesUnknown ? { osBytesUnknown: true } : {}), ...(r.gatesIn ? { reportOnly: true, gatesIn: r.gatesIn } : {}) }])]),
  };
}

/** The markdown table of one judged run. */
export function table(judged, title, infoRows = []) {
  const lines = [`### ${title}`, "", "| Row | Scenario | Budget | Value | Result |", "|---|---|---|---|---|"];
  const infoLine = r => `| ${r.id} | ${r.scenario} | ${r.what} (no budget) | ${r.value} | info only |`;
  const lastRoom = judged.rows.filter(row => row.scenario === "room").at(-1);
  for (const r of judged.rows) {
    const v = r.roomIncomplete ? "not measured (room did not settle)" : r.none ? "none raised" : r.busyAtStart ? "not measured: box busy at start" : r.osBytesUnknown ? "not measured: osBytes unknown" : r.missing ? "not measured" : `${r.value}${r.unit ? ` ${r.unit}` : ""}`;
    lines.push(`| ${r.id} | ${r.scenario} | ${r.what} ${r.op} ${r.limit}${r.unit ? ` ${r.unit}` : ""} | ${v} | ${r.invalid ? `INVALID (${r.invalid})` : r.busyAtStart ? "not measured (box busy at start)" : r.osBytesUnknown ? "not measured (osBytes unknown)" : r.reportOnly ? (r.missing ? "report only (not measured)" : `report only (${r.wouldPass ? "within" : "over"} the bound)`) : r.notApplicable ? "n/a (real engine)" : r.emptyDir ? "not measured (empty data dir; the fake leg on the data copy is the proof)" : r.pass ? "PASS" : "FAIL"}${r.error ? ` (${String(r.error).slice(0, 80)})` : ""}${r.oldFactor ? ` [info only, old factor: limit ${r.oldFactor.limit}, would ${r.oldFactor.wouldPass ? "pass" : "fail"}]` : ""}${r.oldWay !== undefined ? ` [info only, old way: ${r.oldWay}]` : ""}${r.gatesIn ? ` [${r.gatesIn}]` : ""} |`);
    if (r === lastRoom) for (const info of infoRows.filter(row => row.id === "S3.cardWait")) lines.push(infoLine(info));
  }
  for (const r of infoRows.filter(row => row.id !== "S3.cardWait" || !lastRoom)) lines.push(infoLine(r));
  lines.push("", `${judged.pass ? "PASS" : "FAIL"}: ${judged.rows.length - judged.failed} of ${judged.rows.length} rows pass.${judged.invalid ? ` INVALID: ${judged.invalid}.` : ""}`);
  return lines.join("\n");
}

// Both dispatch adapters call this immediately before a message send attempt.
export function firstSendRecorder({ results, runId, runStart, now, logSize, ready, persist, save, fail, requestId }) {
  return (method, path, body) => {
    if (method !== "POST" || !/\/messages(?:\?|$)/.test(path)) return null;
    if (!results.firstSend) {
      const epochMs = now();
      let logByteOffset = null;
      try { logByteOffset = logSize(); } catch { fail("first send log offset unavailable"); }
      const mark = Object.freeze({ epochMs, runId, requestId: body?.requestId ?? body?.sendId ?? requestId(), logByteOffset });
      results.firstSend = mark;
      results.firstSendDelayMs = epochMs - runStart;
      try { if (persist(mark) === false) fail("first send event persistence failed"); }
      catch { fail("first send event persistence failed"); }
      if (save() === false) fail("first send results persistence failed");
    }
    if (!ready()) fail("message send attempted before server readiness");
    return results.firstSend;
  };
}
export function allEldWindows(text, firstSend, runStart, to, stats, excluded = []) {
  return {
    eld: firstSend ? measuredEld(text, firstSend.epochMs, to, stats, excluded, { head: true }) : null,
    eldFromRunStart: measuredEld(text, runStart, to, stats, excluded),
  };
}

/** ALL.io r2 (gate lane): the real writing lines only (no cpu or traffic lines), outside the WARM windows. Each line reports the 60 s before it,
 * so the sum of its MB/min is the MB written in the minutes the budget judged too busy. `mb` is the leg total, `peak` the largest line of any source. */
export function ioWriteStats(text, windows = []) {
  const bytes = Buffer.from(text, "utf8");
  const ranges = windows.map(w => {
    const tail = bytes.subarray(w.logTo).toString("utf8");
    const end = [...tail.matchAll(/\[eld\] t=(\d+)/g)].find(m => +m[1] > w.to + 60_000);
    return { ...w, ioTo: end ? w.logTo + Buffer.byteLength(tail.slice(0, end.index), "utf8") : bytes.length };
  });
  let lines = 0, mb = 0, peak = 0, at = 0;
  for (const line of String(text).split(/(?<=\n)/)) {
    const end = at + Buffer.byteLength(line, "utf8");
    const m = /\[io-budget\] writing ([\d.]+) MB\/min/.exec(line);
    if (m && !ranges.some(w => end > w.logFrom && at < w.ioTo)) { lines++; mb += +m[1]; peak = Math.max(peak, +m[1]); }
    at = end;
  }
  return { lines, mb: Math.round(mb * 10) / 10, peak };
}
