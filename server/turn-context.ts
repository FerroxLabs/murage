// Building the text a driver actually receives. Three situations force an
// inline replay of the active branch: a rewind (the visible branch changed),
// a fresh engine (this instance has no session here — the user switched the
// bot's model mid-thread), and an update appended outside the provider's own
// turn. The first two coincide today but are distinct markers on purpose:
// rewound also invalidates OTHER instances' cursors, fresh does not.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MESSAGE_ONLY_NOTE, NO_HUMAN_NOTE } from "./memory/fence-recovery.ts";
import type { BotRow } from "./bot-read.ts";
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import { assertSendReplayProof, type SendReplayProof } from "./memory/replay-lineage.ts";

/** Which engine wrote an assistant line: the provider instance id and the
 * name the model picker shows for it. Absent on user lines and on lines from
 * before rows were labelled (Message.engine). */
export interface TranscriptEngine {
  instanceId: string;
  label: string;
}

/** One replayed line. `source` is the door's BotRow for the row it renders (S6 rule 18b, bot-read.ts botRowOf): only a row the door shows
 * the reading bot becomes a line. */
export interface TranscriptEntry {
  id?: string;
  role: "user" | "assistant";
  text: string;
  engine?: TranscriptEngine;
  source: BotRow;
}

export interface TurnContextInput {
  /** PROVISIONAL INTERFACE: I carries the shared selector's F3 proof through
   * direct/rebuild/native paths, and rechecks it at every provider write. */
  replayProof?: SendReplayProof;
  /** Proof recorded when the retained session was positively started fresh. */
  retainedReplayProof?: SendReplayProof;
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: TranscriptEntry[];
  /** the provider instance this turn is being sent to, so a run written on
   * it reads as the engine answering now */
  currentInstanceId?: string;
  /** replayable lines the window left out or the memory check withheld */
  omitted?: number;
  /** the conversation goes back further than the rows the turn read
   * (TURN_TAIL_ROWS): older lines exist, uncounted */
  omittedMore?: boolean;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** Authorized memory changed; rebuild without claiming the user edited history. */
  memoryRefreshed?: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /** fresh only because Murage itself started a new engine session for this conversation (the
   * engine's session contract changed): same engine, nothing was switched over */
  sessionRestarted?: boolean;
  /** a message was appended outside the provider's own turn (for example,
   * a delegated teammate returned a result). Native resume state cannot
   * contain it, so the active branch must be replayed once. */
  externallyUpdated: boolean;
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean;
}

/** Drivers whose sendTurn rebuilds the entire prompt from `transcript` on
 * every turn — that is, every caller of createOpenAIChatRuntime, which turns
 * `turn.transcript` into chat `messages` (drivers/openai-chat.ts). They hold
 * no provider-side session and produce no resume cursor.
 *
 * They must never ALSO get the branch embedded in `turnText`: the model would
 * receive the same history twice, once as `messages` and once again inside the
 * final user message, and the two copies disagree about who is speaking. This
 * used to be hardcoded to "grok", which was true when Grok was the only such
 * driver and silently wrong the day openai-compat and minimax joined it.
 * Enforced against the drivers themselves by turn-context.test.ts. */
export const TRANSCRIPT_REPLAY_DRIVER_KINDS: readonly string[] = ["grok", "minimax", "openai-compat"];

export function replaysTranscriptNatively(driverKind: string): boolean {
  // Muse also renders the supplied transcript on every turn so that replies
  // delivered between native turns are present. Keep inline replay out of its
  // text on fresh sessions, rewinds, memory refreshes and external updates.
  return driverKind === "museCode" || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);
}

/** Does this engine need the thread replayed to it? True when a DIFFERENT
 * instance ran the last turn here — a cursor of our own is not enough,
 * because it only proves we once had a session covering some prefix of the
 * thread; every turn another engine took since is missing from it. Tasks
 * from before `lastInstanceId` existed fall back to the cursor map: a lone
 * cursor that is ours means a single-engine thread we can keep resuming;
 * anything else is ambiguous, and replaying is the safe side of ambiguous.
 * Gated on a prior USER turn: a new bot's thread is seeded with its own
 * greeting, and that alone is nothing to join. */
export function engineIsFresh(input: {
  instanceId: string;
  lastInstanceId: string | undefined;
  resumeCursors: Record<string, unknown>;
  transcript: ReadonlyArray<{ role: TranscriptEntry["role"]; engine?: Pick<TranscriptEngine, "instanceId"> }>;
}): boolean {
  const { instanceId, lastInstanceId, resumeCursors, transcript } = input;
  if (!transcript.some((m) => m.role === "user")) return false;
  if (lastInstanceId !== undefined) return lastInstanceId !== instanceId || resumeCursors[instanceId] === undefined;
  // No task-level record: the last labelled reply says who answered last. A
  // lone cursor of ours proves nothing about turns another engine took, and
  // that is the pre-label thread whose engine B ran turns we never saw.
  const recorded = [...transcript].reverse().find((m) => m.role === "assistant")?.engine?.instanceId;
  if (recorded !== undefined) return recorded !== instanceId || resumeCursors[instanceId] === undefined;
  const cursorIds = Object.keys(resumeCursors);
  return !(cursorIds.length === 1 && cursorIds[0] === instanceId);
}

/** Dispatches that went out message-only (a memory recovery's last rebuild, or
 * a first rebuild whose replay the selective gate dropped), keyed by the
 * running turn's lineage. The session such a dispatch starts holds only that
 * one message: its cursor is never published, so the next turn finds no
 * session and takes the fresh path with the authorized replay. */
const messageOnlyDispatches = new WeakSet<object>();
export function markMessageOnlyDispatch(lineage: object | undefined): void {
  if (lineage) messageOnlyDispatches.add(lineage);
}
export function isMessageOnlyDispatch(lineage: object | undefined): boolean {
  return lineage !== undefined && messageOnlyDispatches.has(lineage);
}

/** Heal only a provable legacy tier-two session. Every read is an indexed seek
 * into that session's starting turn; no transcript or all-session scan. Tier-one
 * notes also describe healthy replays, so they never justify a reset. */
export function isLegacyMessageOnlySession(db: DatabaseSync, threadId: string, instanceId: string, nativeSession: string): boolean {
  const session = db.prepare("SELECT first_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?").get(threadId, instanceId, nativeSession);
  if (!session) return false;
  const thread = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(threadId);
  if (!thread) return false;
  // The direct recovery note is keyed by the triggering input, whose row was
  // present when the session's first prompt was built. Resolve one lineage row
  // before joining messages: a deleted row must not walk back through history.
  const input = db.prepare("SELECT m.id,m.role FROM memory_line_lineage l JOIN messages m ON m.thread_id=? AND m.id=l.message_id WHERE l.thread_no=? AND l.lsn=(SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND lsn<=? ORDER BY lsn DESC LIMIT 1)").get(threadId, thread.no, thread.no, session.first_lsn);
  if (!input || input.role !== "user") return false;
  const id = `memory-note-${createHash("sha256").update(threadId + "\0" + String(input.id)).digest("hex")}`;
  const noteRow = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, id);
  if (!noteRow) return false;
  const note = JSON.parse(String(noteRow.json));
  if (note.role !== "bot" || note.kind !== "activity" || note.murageLine !== true || note.memoryNote !== "without-memory" || note.memoryReplay === true
    || !note.turnId || (note.tool?.name !== MESSAGE_ONLY_NOTE && note.tool?.name !== NO_HUMAN_NOTE)) return false;
  // A note for another provider turn on the same input cannot identify this
  // cursor. Bind it to the first lineage row of the session's starting turn.
  const generated = db.prepare("SELECT json_extract(m.json,'$.turnId') AS turn_id FROM memory_line_lineage l JOIN messages m ON m.thread_id=? AND m.id=l.message_id WHERE l.thread_no=? AND l.lsn=(SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND turn_lsn=? ORDER BY lsn LIMIT 1)").get(threadId, thread.no, thread.no, session.first_lsn);
  return generated !== undefined && generated.turn_id === note.turnId;
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
export const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread: this bot was switched over to you. Replies written on other engines are part of this bot's record; do not restate, summarise, correct or disown them. Where your own limits differ, say your own limit and continue with what you can do. The conversation so far:]";
export const RESTARTED_PREAMBLE =
  "[Murage started a fresh engine session for this conversation; here is the conversation so far.]";
const EXTERNAL_UPDATE_PREAMBLE =
  "[This conversation received an update outside your provider session. The complete current history follows so you can use that update in your next response:]";

/** One header per run of assistant replies written on the same engine, to
 * sit before the run's first reply. Runs are taken over the assistant lines
 * in order, so a long back and forth on one engine is one run. A run on the
 * engine the turn is sent to is headed only after another engine's run. A
 * transcript with no label anywhere gets no headers at all, so a thread from
 * before rows were labelled replays exactly as it always did. */
export function runHeaders(transcript: readonly TranscriptEntry[], currentInstanceId?: string): Array<string | undefined> {
  const headers: Array<string | undefined> = transcript.map(() => undefined);
  if (!transcript.some((m) => m.role === "assistant" && m.engine)) return headers;
  const runs: Array<{ start: number; key: string; label: string; count: number }> = [];
  transcript.forEach((m, index) => {
    if (m.role !== "assistant") return;
    const key = m.engine?.instanceId ?? "";
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.count++;
    else runs.push({ start: index, key, label: m.engine?.label ?? "", count: 1 });
  });
  runs.forEach((run, i) => {
    const one = run.count === 1;
    if (run.key === "") {
      headers[run.start] = `[The next ${one ? "reply carries" : `${run.count} replies carry`} no engine label.]`;
    } else if (run.key === currentInstanceId) {
      if (i > 0) headers[run.start] = `[The next ${one ? "reply was" : `${run.count} replies were`} written on ${run.label}, the engine answering now.]`;
    } else {
      headers[run.start] = `[The next ${one ? "reply was" : `${run.count} replies were`} written on ${run.label}.]`;
    }
  });
  return headers;
}

/** The transcript as a driver that replays natively receives it: no engine
 * object, the run header riding on the first reply of its run. */
export function transcriptForDriver(transcript: readonly TranscriptEntry[], currentInstanceId?: string, replayProof?: SendReplayProof): Array<{ id?: string; role: "user" | "assistant"; text: string; header?: string }> {
  transcript = checkedTranscript(transcript, replayProof);
  const headers = runHeaders(transcript, currentInstanceId);
  return transcript.map((m, i) => ({ ...(m.id ? { id: m.id } : {}), role: m.role, text: replayImageText(m.text), ...(headers[i] ? { header: headers[i] } : {}) }));
}

/** Annotate only bounded, authorized history, including the rendered replay budget. */
function replayImageText(text: string): string {
  return splitTranscriptAttachments(text).images.length
    ? `[These images were attached to an earlier message. They do not show the current screen.]
${text}`
    : text;
}

function checkedTranscript(transcript: readonly TranscriptEntry[], proof?: SendReplayProof): TranscriptEntry[] {
  if (!proof) return [...transcript]; // legacy callers, migrated by Slice I
  assertSendReplayProof(proof);
  const candidates = new Set(proof.messageIds);
  return transcript.filter(entry => {
    const id = entry.id ?? entry.source.id;
    if (!candidates.has(id)) throw new Error("SEND_REPLAY_UNPROVEN_LINE");
    return !proof.excludedIds.has(id);
  });
}

/** Shared by native messages, inline history and session recovery. */
export function replayMetadata(omitted = 0, sessionRestarted = false, more = false): string {
  const notice = omittedNotice(omitted, more);
  return [sessionRestarted ? RESTARTED_PREAMBLE : FRESH_PREAMBLE, ...(notice ? [notice] : [])].join("\n");
}

/** The line that says how much of the conversation the replay leaves out.
 * `more`: the turn read only the newest rows and older ones exist, so the
 * count is not known and none is claimed. */
export function omittedNotice(omitted = 0, more = false): string | null {
  if (more) return "[Earlier lines of this conversation are not shown.]";
  return omitted > 0 ? `[${omitted} earlier ${omitted === 1 ? "line" : "lines"} of this conversation ${omitted === 1 ? "is" : "are"} not shown.]` : null;
}

export function renderDriverReplay(transcript: readonly { role: "user" | "assistant"; text: string; header?: string }[], metadata = ""): string {
  return [metadata, ...transcript.map(item => `${item.header ? item.header + "\n\n" : ""}${item.role === "user" ? "User" : "Assistant"}: ${item.text}`)].filter(Boolean).join("\n");
}

/** Budget the rendered representation, including quotes, labels and headers.
 * Keep whole newest rows. Binary search avoids repeatedly walking long tails. */
export function fitRenderedReplay(transcript: TranscriptEntry[], currentInstanceId?: string, omitted = 0, maxBytes = 192 * 1024, more = false): { transcript: TranscriptEntry[]; omitted: number } {
  const budget = Math.min(maxBytes, 192 * 1024);
  const fits = (drop: number) => 256 + Buffer.byteLength(renderDriverReplay(transcriptForDriver(transcript.slice(drop), currentInstanceId), replayMetadata(omitted + drop, false, more)) + "\n\n[Now reply to the user's latest message:]\n\n") <= budget;
  if (!fits(transcript.length)) throw new Error("This engine context window cannot hold the conversation replay notice.");
  let low = 0, high = transcript.length;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (fits(mid)) high = mid; else low = mid + 1; }
  return { transcript: transcript.slice(low), omitted: omitted + low };
}

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, rewound, fresh, externallyUpdated, replaysNatively, memoryRefreshed, currentInstanceId, omitted, omittedMore } = input;
  const transcript = checkedTranscript(input.transcript, input.replayProof);
  let replayReset = false;
  if (input.replayProof) {
    const retained = input.retainedReplayProof;
    replayReset = !retained && input.replayProof.epochs.some(([, revision]) => revision !== 0);
    if (retained) {
      try {
        assertSendReplayProof(retained);
        replayReset = retained.threadId !== input.replayProof.threadId || JSON.stringify(retained.epochs) !== JSON.stringify(input.replayProof.epochs);
      } catch { replayReset = true; }
    }
  }
  const notice = omittedNotice(omitted, omittedMore);
  const restarted = input.sessionRestarted === true && fresh && !rewound && !memoryRefreshed && !externallyUpdated;
  const resume = !rewound && !fresh && !externallyUpdated && !memoryRefreshed && !replayReset;
  const replay = !resume && !replaysNatively && (transcript.length > 0 || Boolean(notice));
  if (!replay) return { turnText: replaysNatively && (transcript.length > 0 || Boolean(notice)) ? `${replayMetadata(omitted, restarted, omittedMore)}\n\n${text}` : text, resume };
  const headers = runHeaders(transcript, currentInstanceId);
  return {
    turnText: [
      rewound ? REWOUND_PREAMBLE : memoryRefreshed ? "[Your authorized memory context was refreshed. Continue using only the current memory and conversation history below:]" : externallyUpdated ? EXTERNAL_UPDATE_PREAMBLE : restarted ? RESTARTED_PREAMBLE : FRESH_PREAMBLE,
      ...(rewound || memoryRefreshed || externallyUpdated || restarted ? ["[Replies written on other engines are part of this bot's record; do not restate, summarise, correct or disown them. Where your own limits differ, say your own limit and continue with what you can do.]"] : []),
      ...(notice ? [notice] : []),
      "",
      ...transcript.flatMap((m, i) => {
        const line = `${m.role === "user" ? "User" : "Assistant"}: ${replayImageText(m.text)}`;
        return headers[i] ? [headers[i]!, line] : [line];
      }),
      "",
      "[Now reply to the user's latest message:]",
      "",
      text,
    ].join("\n"),
    resume,
  };
}
