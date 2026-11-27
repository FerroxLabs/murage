#!/usr/bin/env node
// Real-size rig verdict: one function, verdictOfEvidence(dir), decides GREEN / RED / INVALID from a run's evidence files. The
// live rig (rig.mts) writes its evidence and then calls it; a replay calls it on the same files. There is no second rule set,
// so a replay can never be kinder than the run was: an INVALID run replays INVALID.
//   RED: a field-failure line in server.log or messages.jsonl (GATE below), or the per-turn completion rule (completion.mjs).
//   INVALID: no RED, but the run did not create the pressure (invalidReasons below), or a piece of evidence the rules need is
//   missing or not recorded. Old evidence without validity-input.json therefore replays INVALID, never GREEN.
// Evidence lifecycle (one run = one fresh dir, sealed last): every run writes only into <evidence-root>/<run id>, a dir that
// must not exist when the run starts (openRun), so no file of another run is ever next to its own. The run's very last write
// is run-complete.json (sealRun): the run id, the live verdict and the size + sha256 of every evidence file. A replay names the
// run id and reads only that dir (replayRun); a dir with no seal (the run failed or is still running), a seal for another run
// id, or a file changed after the seal is INVALID, never GREEN.
// Usage: verdict.mjs <evidence-root> <run-id> [out.json]    exit 0 GREEN, 1 RED, 2 INVALID or usage error
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { judgeCompletion } from "./completion.mjs";

/** Gate: any hit is RED. */
export const GATE = {
  contextRevoked: /MEMORY_CONTEXT_REVOKED/,
  retainedBudget: /ledger refusal cause=checking:retained-budget|fence=checking\/retained-budget/,
  ledgerRefusal: /\[memory\] ledger refusal cause=/,
  emitRefused: /swallowed error site=response\.emit/,
  dispatchRevoked: /context revoked during dispatch/,
  dispatchFailed: /dispatch preparation failed|Murage couldn't start this reply|could not set up its turn/,
  retainedFenceRefused: /\[memory\] retained fence refused/,
  stoppedNoContext: /I stopped this turn because (?:some of its context is no longer available|it grew past a safety limit)/,
  replyWithheld: /the reply is still being checked against earlier memory/,
  ownerMountLost: /\[mount-relay\] mount unavailable/,
};
/** Load shape: reported so a GREEN run proves it was really under the field's pressure. */
export const SHAPE = {
  admissionLockTimeout: /AdmissionLockTimeout/,
  importRevoke: /memory receipts revoked scope=records cause=import/,
  recallWithheld: /turn dispatch recall=withheld/,
  ioBudget: /\[io-budget\] writing/,
  settleDeadline: /pending fence settle outcome=deadline/,
};

export function judge(text) {
  const count = (re) => text.split("\n").filter(line => re.test(line)).length;
  const gate = Object.fromEntries(Object.entries(GATE).map(([k, re]) => [k, count(re)]));
  const shape = Object.fromEntries(Object.entries(SHAPE).map(([k, re]) => [k, count(re)]));
  const red = Object.entries(gate).filter(([, n]) => n > 0).map(([k]) => k);
  return { verdict: red.length ? "RED" : "GREEN", red, gate, shape };
}

/** The evidence files a verdict is made from. validity-input.json holds what the rig measured about its own pressure:
 * { trackedLinks, lockHoldMs, dbGb, dbBytes, loadEndedEarly (null or why), eventReconnects }. */
export const EVIDENCE = { serverLog: "server.log", messages: "messages.jsonl", completionInput: "completion-input.json", validityInput: "validity-input.json" };

const accepted = (status) => typeof status === "number" && status >= 200 && status < 300;

/** Why a run proves nothing even with no symptom: the pressure was not there, or was not recorded. Empty = valid. */
export function invalidReasons({ facts, sends, delegations, serverText }) {
  const f = facts && typeof facts === "object" ? facts : {};
  const num = (name) => (typeof f[name] === "number" && Number.isFinite(f[name]) ? f[name] : undefined);
  const missing = ["trackedLinks", "lockHoldMs", "dbGb", "dbBytes", "eventReconnects"].filter((name) => num(name) === undefined);
  if (!(f.loadEndedEarly === null || typeof f.loadEndedEarly === "string")) missing.push("loadEndedEarly");
  return [
    ...missing.map((name) => `${name} not recorded in this evidence`),
    ...(num("trackedLinks") === undefined || f.trackedLinks > 0 ? [] : ["no tracked notebook"]),
    ...(Array.isArray(delegations) && delegations.some((d) => accepted(d.status)) ? [] : ["no delegation accepted"]),
    ...(num("lockHoldMs") !== undefined && f.lockHoldMs > 0 && !/\[rig\] admission ledger lock held/.test(serverText) ? ["no admission-lock pulse"] : []),
    ...(num("dbGb") === undefined || num("dbBytes") === undefined || f.dbBytes >= 0.9 * f.dbGb * 1024 ** 3 ? [] : ["ballast short of RIG_DB_GB"]),
    ...(Array.isArray(sends) && sends.some((s) => accepted(s.status)) ? [] : ["no turn accepted"]),
    ...(typeof f.loadEndedEarly === "string" ? [`load ${f.loadEndedEarly}`] : []),
    ...(num("eventReconnects") === undefined || f.eventReconnects === 0 ? [] : [`event stream reconnected ${f.eventReconnects}x (turn ends may be missing)`]),
  ];
}

/** The verdict of one run, live or replayed: the same files, the same rules, the same answer. */
export function verdictOfEvidence(dir) {
  const invalid = [];
  const read = (name) => {
    const path = join(dir, name);
    if (existsSync(path) && statSync(path).isFile()) return readFileSync(path, "utf8");
    invalid.push(`${name} missing from the evidence`);
    return undefined;
  };
  const json = (name) => {
    const text = read(name);
    if (text === undefined) return undefined;
    try { const value = JSON.parse(text); if (value && typeof value === "object") return value; } catch { /* reported below */ }
    invalid.push(`${name} is not readable JSON`);
    return undefined;
  };
  const serverText = read(EVIDENCE.serverLog) ?? "";
  const messagesText = read(EVIDENCE.messages);
  const input = json(EVIDENCE.completionInput);
  const facts = json(EVIDENCE.validityInput);
  const result = judge(`${serverText}\n${messagesText ?? ""}`);
  const empty = { unfinished: [], delegationsIncomplete: [], badEnds: [], stillRunning: [] };
  let completion = { red: [], ...empty };
  if (messagesText !== undefined && input) {
    const rowsByThread = {};
    let rowsOk = true;
    for (const line of messagesText.split("\n").filter(Boolean)) {
      try { const row = JSON.parse(line); (rowsByThread[row.threadId] ??= []).push(row); } catch { rowsOk = false; }
    }
    if (!rowsOk) invalid.push(`${EVIDENCE.messages} has a row that is not JSON`);
    const lists = ["sends", "delegations", "ends", "starts"].filter((name) => !Array.isArray(input[name]));
    // a list the completion rule needs but the evidence lacks: the rest is still judged (a RED stays RED), a GREEN is refused
    for (const name of lists) invalid.push(`${name} not recorded in this evidence`);
    completion = judgeCompletion({ ...input, ...Object.fromEntries(lists.map((name) => [name, []])), rowsByThread });
  } else invalid.push("completion not judged");
  const red = [...result.red, ...completion.red];
  invalid.push(...invalidReasons({ facts, sends: input?.sends, delegations: input?.delegations, serverText }));
  return { ...result, red, invalid, verdict: red.length ? "RED" : invalid.length ? "INVALID" : "GREEN",
    completion: { unfinished: completion.unfinished, delegationsIncomplete: completion.delegationsIncomplete, badEnds: completion.badEnds, stillRunning: completion.stillRunning } };
}

export const exitCodeOf = (verdict) => (verdict === "GREEN" ? 0 : verdict === "RED" ? 1 : 2);

/** The seal: written last by a run that reached its verdict. A dir without it was never finished. */
export const RUN_COMPLETE = "run-complete.json";
/** What the seal covers: the verdict inputs, the live verdict and the rig's own log. */
export const SEALED = [...Object.values(EVIDENCE), "verdict.json", "rig.log"];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const runIdOk = (id) => typeof id === "string" && RUN_ID.test(id);
export const newRunId = () => `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** Start a run: <root>/<runId>, created here and only here. A dir that already exists is refused (throws), never reused. */
export function openRun(root, runId) {
  if (!runIdOk(runId)) throw new Error(`run id ${JSON.stringify(runId)} must be [A-Za-z0-9._-], at most 128`);
  mkdirSync(root, { recursive: true });
  const dir = join(root, runId);
  mkdirSync(dir); // not recursive: EEXIST when another run (or an earlier try of this one) has this id
  return dir;
}

const fingerprint = (path) => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };

/** End a run: the last write. Records the run id, the live verdict and a fingerprint of every sealed file present. */
export function sealRun(dir, runId, verdict) {
  const files = Object.fromEntries(SEALED.filter((name) => existsSync(join(dir, name))).map((name) => [name, fingerprint(join(dir, name))]));
  const tmp = join(dir, `.${RUN_COMPLETE}.tmp`);
  writeFileSync(tmp, JSON.stringify({ runId, verdict, sealedAt: new Date().toISOString(), files }, null, 1) + "\n");
  renameSync(tmp, join(dir, RUN_COMPLETE));
}

/** Replay one run: only <root>/<runId>, only if its seal matches. Anything else is INVALID (exit 2), never GREEN. */
export function replayRun(root, runId) {
  const refused = (why) => ({ runId, verdict: "INVALID", red: [], invalid: [why], refused: true });
  if (!runIdOk(runId)) return refused(`run id ${JSON.stringify(runId)} is not a run id`);
  const dir = join(root, runId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return refused(`no run ${runId} under ${root}`);
  const sealPath = join(dir, RUN_COMPLETE);
  if (!existsSync(sealPath)) return refused(`run ${runId} has no ${RUN_COMPLETE}: it did not finish (failed or still running), so it has no verdict`);
  let seal;
  try { seal = JSON.parse(readFileSync(sealPath, "utf8")); } catch { return refused(`${RUN_COMPLETE} of run ${runId} is not readable JSON`); }
  if (!seal || seal.runId !== runId) return refused(`${RUN_COMPLETE} in ${runId} belongs to run ${JSON.stringify(seal?.runId)}`);
  const files = seal.files && typeof seal.files === "object" ? seal.files : {};
  for (const name of Object.values(EVIDENCE)) if (!files[name]) return refused(`${RUN_COMPLETE} of run ${runId} does not cover ${name}`);
  for (const [name, want] of Object.entries(files)) {
    const path = join(dir, name);
    if (!SEALED.includes(name) || !existsSync(path)) return refused(`${name} sealed in run ${runId} is gone`);
    const got = fingerprint(path);
    if (got.bytes !== want?.bytes || got.sha256 !== want?.sha256) return refused(`${name} changed after run ${runId} was sealed`);
  }
  const result = verdictOfEvidence(dir);
  // the rules may have changed since the run: a replay can be stricter than the live verdict, never kinder
  if (result.verdict === "GREEN" && seal.verdict !== "GREEN") return { ...result, runId, recorded: seal.verdict, verdict: "INVALID", invalid: [`run ${runId} was ${seal.verdict} live`] };
  return { ...result, runId, recorded: seal.verdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // a replay that crashes (unreadable file, out.json not writable) has no verdict: exit 2, never Node's 1 (= RED)
  process.on("uncaughtException", (error) => { console.error(`RIG INVALID replay failed: ${error?.stack ?? error}`); process.exit(2); });
  const [root, runId, out] = process.argv.slice(2);
  const usage = "usage: verdict.mjs <evidence-root> <run-id> [out.json]   (the run id the rig printed; only that sealed run is read)";
  if (!root || !runId || !existsSync(root) || !statSync(root).isDirectory()) { console.error(usage); process.exit(2); }
  // the out file must not land in the run it judges (it would change a sealed file)
  if (out && out !== "-" && (resolve(out) + sep).startsWith(resolve(root, runId) + sep)) { console.error(`${usage}\nout.json must be outside the run dir`); process.exit(2); }
  const result = replayRun(root, runId);
  if (out && out !== "-") writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`RIG ${result.verdict} run=${runId} invalid=${result.invalid.join(";") || "-"} red=${result.red.join(",") || "-"}${result.gate ? ` ${JSON.stringify(result.gate)} shape=${JSON.stringify(result.shape)}` : ""}`);
  process.exit(exitCodeOf(result.verdict));
}
