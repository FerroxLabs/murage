// Real-size rig: did every turn the rig started really finish? Owner: rig-realsize lane. Pure (no I/O) so the rule is tested
// on its own (completion.test.mjs) and is replayed on a sealed run (verdict.mjs <evidence-root> <run-id>).
//
// The rule is per turn id, never per thread. The server stamps the ids itself:
//   - the owner's message row carries the rig's own sendId and, once a turn took it, dispatchedIn = that turn's id;
//   - a delegated prompt is the row "dlg-<taskId>" in the worker's thread, again with dispatchedIn = the delegated turn's id;
//   - an engine reply row carries turnId, and the turn's last reply also turnTerminal: true;
//   - the result handed back to the asker is the row "dres-<taskId>" in the asker's thread.
// A sent turn is finished only if ITS OWN turn id has a delivered final reply with the tool's real answer. A delegation is
// complete only if its delegated turn has that too AND the answer reached the asker. An accepted API call proves neither.
// Any other turn on the same thread (a later wave, the wake-up after a delegated reply) can never stand in for it; turns
// nobody sent by hand (the wake-up after a delegated reply) are covered by two more rules: every turn end seen during the
// drive must be turn.completed ok (badEnds), and every turn that started must have ended before the run is judged (stillRunning).

/** What the rig's fake engine answers when the owner tool really ran on the last step (fake-custom-tool.ts customToolReply + the rig's MCP server). */
export const REPLY = "custom tool said: owner tool status ok";
const HANDED_BACK = "replied to the delegated task:";

/** The final reply of exactly this turn, or why there is none. */
function finalReplyProblem(rows, turnId) {
  const own = rows.filter((r) => r.turnId === turnId);
  const last = own.filter((r) => r.turnTerminal === true && r.role === "bot" && r.kind === "text" && r.murageLine !== true);
  if (!last.length) return `turn ${turnId} has no final reply (${own.length} rows of its own)`;
  if (last.length > 1) return `turn ${turnId} has ${last.length} final replies`;
  if (!String(last[0].text ?? "").startsWith(REPLY)) return `turn ${turnId} final reply is not the tool's answer: ${JSON.stringify(String(last[0].text ?? "").slice(0, 80))}`;
  return null;
}

/** The turn that took this prompt row, checked to its own final reply. */
function promptProblem(rows, prompt, what) {
  if (!prompt) return `${what} is not in the conversation`;
  if (typeof prompt.dispatchedIn !== "string" || !prompt.dispatchedIn) return `${what} was never taken by a turn`;
  return finalReplyProblem(rows, prompt.dispatchedIn);
}

/**
 * Conversations whose newest turn start of the drive has no end yet: [{ threadId, generation, started, ended }].
 * A conversation runs one turn at a time and every start/end event carries the server's dispatch generation. A dispatch
 * that is prepared again (context revoked during dispatch) starts a second time under a new generation and only that one
 * ends, so the rule is about the NEWEST start: its own generation must have an end. Starts are in arrival order. Events
 * without a generation fall back to counting (more starts than ends = still running).
 */
export function openTurns({ starts, ends }) {
  if (!Array.isArray(starts) || !Array.isArray(ends)) throw new TypeError("openTurns needs the drive's turn starts and ends");
  const byThread = (list) => { const m = new Map(); for (const e of list) m.set(e.threadId, [...(m.get(e.threadId) ?? []), e]); return m; };
  const started = byThread(starts), ended = byThread(ends), open = [];
  for (const [threadId, list] of started) {
    const own = ended.get(threadId) ?? [], newest = list.at(-1);
    const known = newest.generation !== undefined && newest.generation !== null && own.every((e) => e.generation !== undefined && e.generation !== null);
    const done = known ? own.some((e) => e.generation === newest.generation) : own.length >= list.length;
    if (!done) open.push({ threadId, generation: newest.generation ?? null, started: list.length, ended: own.length });
  }
  return open;
}

/**
 * sends:       [{ tag, threadId, sendId, status }]                      every owner send of the drive (status = HTTP status)
 * delegations: [{ tag, status, taskId, fromThreadId, toThreadId }]      every delegation the rig POSTed (status = HTTP status)
 * rowsByThread:{ [threadId]: message rows, complete for the drive }
 * ends:        [{ threadId, generation, type, ok, stopReason }]         every turn end event seen during the drive
 * starts:      [{ threadId, generation }]                               every turn start event seen during the drive, in order
 */
export function judgeCompletion({ sends, delegations, rowsByThread, ends, starts }) {
  const rowsOf = (threadId) => rowsByThread[threadId] ?? [];
  const unfinished = [], delegationsIncomplete = [];
  for (const s of sends) {
    let reason;
    if (!(s.status < 300)) reason = `send refused status=${s.status}`;
    else if (!s.sendId) reason = "send has no send id";
    else {
      const mine = rowsOf(s.threadId).filter((r) => r.role === "user" && r.sendId === s.sendId);
      reason = mine.length > 1 ? `send id appears ${mine.length} times` : promptProblem(rowsOf(s.threadId), mine[0], "the sent message");
    }
    if (reason) unfinished.push({ tag: s.tag, threadId: s.threadId, reason });
  }
  for (const d of delegations) {
    let reason;
    if (!(d.status < 300)) reason = `delegation refused status=${d.status}`;
    else if (!d.taskId) reason = "accepted delegation has no task id";
    else {
      const worker = rowsOf(d.toThreadId);
      reason = promptProblem(worker, worker.find((r) => r.id === `dlg-${d.taskId}` && r.role === "user"), "the delegated prompt");
      if (!reason) {
        const back = rowsOf(d.fromThreadId).find((r) => r.id === `dres-${d.taskId}`);
        const text = String(back?.text ?? ""), at = text.indexOf(HANDED_BACK);
        if (!back) reason = "the delegated answer never reached the asker";
        else if (at < 0 || !text.slice(at + HANDED_BACK.length).trimStart().startsWith(REPLY)) reason = `the asker got no answer, only: ${JSON.stringify(text.slice(0, 80))}`;
      }
    }
    if (reason) delegationsIncomplete.push({ tag: d.tag, taskId: d.taskId ?? null, reason });
  }
  const badEnds = ends.filter((e) => !(e.type === "turn.completed" && e.ok === true));
  const stillRunning = openTurns({ starts, ends });
  const red = [...(unfinished.length ? ["unfinishedTurns"] : []), ...(delegationsIncomplete.length ? ["delegationsIncomplete"] : []), ...(badEnds.length ? ["badTurnEnds"] : []), ...(stillRunning.length ? ["turnsStillRunning"] : [])];
  return { red, unfinished, delegationsIncomplete, badEnds, stillRunning, turns: sends.length, delegationsAccepted: delegations.filter((d) => d.status < 300).length };
}
