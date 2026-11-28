// Owner: rig-realsize lane. Test fixture (not a test file): the evidence files of one small clean run (3 turns, 2 delegations,
// no symptom, every turn finished, full pressure facts), written the way rig.mts writes them. Shared by replay.test.mjs and
// rerun.test.mjs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPLY } from "./completion.mjs";

export const ANSWER = `${REPLY} ${"x".repeat(40)}`;
export const GB = 1024 ** 3;
export const VALID = { trackedLinks: 3, lockHoldMs: 2600, dbGb: 0.2, dbBytes: 0.2 * GB, loadEndedEarly: null, eventReconnects: 0 };

/** Write one clean run's evidence into dir (which must exist). `change` edits the pieces first; a piece set to undefined is
 * not written. */
export function writeCleanRun(dir, change = (e) => e) {
  const threads = ["t-a", "t-b", "t-c", "t-d", "t-e"];
  const rows = [], starts = [], ends = [];
  let generation = 0;
  const turn = (threadId, turnId, promptRow) => {
    generation++;
    starts.push({ threadId, generation, at: generation });
    rows.push({ threadId, ...promptRow, dispatchedIn: turnId }, { threadId, id: `ev-${turnId}`, role: "bot", kind: "text", text: ANSWER, turnId, turnTerminal: true });
    ends.push({ threadId, type: "turn.completed", ok: true, stopReason: "end_turn", generation, at: generation });
  };
  const sends = threads.slice(0, 3).map((threadId, i) => ({ tag: `rigturn-1-${i}`, threadId, sendId: `send-${i}`, status: 202 }));
  for (const s of sends) turn(s.threadId, `turn-${s.sendId}`, { id: `m-${s.sendId}`, role: "user", kind: "text", text: `__custom_tool__:ops_metrics ${s.tag} Long task`, sendId: s.sendId });
  const delegations = [0, 1].map((i) => ({ tag: sends[i].tag, status: 200, taskId: `task-${i}`, fromThreadId: threads[i], toThreadId: threads[3 + i] }));
  for (const d of delegations) {
    turn(d.toThreadId, `turn-${d.taskId}`, { id: `dlg-${d.taskId}`, role: "user", kind: "text", text: "[Delegated by another bot. Do the work and reply directly.]" });
    rows.push({ threadId: d.fromThreadId, id: `dres-${d.taskId}`, role: "bot", kind: "text", text: `@Rig Reviewer replied to the delegated task:\n\n${ANSWER}` });
    turn(d.fromThreadId, `turn-wake-${d.taskId}`, { id: `wake-${d.taskId}`, role: "user", kind: "text", text: "delegated answer arrived" });
  }
  const e = change({
    serverLog: ["[io-budget] ERROR AdmissionLockTimeout at timer", "[rig] admission ledger lock held 2600ms", "turn dispatch thread=t-a"].join("\n"),
    rows, completionInput: { sends, delegations, starts, ends }, facts: { ...VALID },
  });
  if (e.serverLog !== undefined) writeFileSync(join(dir, "server.log"), e.serverLog);
  if (e.rows !== undefined) writeFileSync(join(dir, "messages.jsonl"), e.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (e.completionInput !== undefined) writeFileSync(join(dir, "completion-input.json"), JSON.stringify(e.completionInput));
  if (e.facts !== undefined) writeFileSync(join(dir, "validity-input.json"), JSON.stringify(e.facts));
  return dir;
}
