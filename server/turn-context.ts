// Building the text a driver actually receives. Three situations force an
// inline replay of the active branch: a rewind (the visible branch changed),
// a fresh engine (this instance has no session here — the user switched the
// bot's model mid-thread), and an update appended outside the provider's own
// turn. The first two coincide today but are distinct markers on purpose:
// rewound also invalidates OTHER instances' cursors, fresh does not.
/** Which engine wrote an assistant line: the provider instance id and the
 * name the model picker shows for it. Absent on user lines and on lines from
 * before rows were labelled (Message.engine). */
export interface TranscriptEngine {
  instanceId: string;
  label: string;
}

export interface TranscriptEntry {
  id?: string;
  role: "user" | "assistant";
  text: string;
  engine?: TranscriptEngine;
}

export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: TranscriptEntry[];
  /** the provider instance this turn is being sent to, so a run written on
   * it reads as the engine answering now */
  currentInstanceId?: string;
  /** replayable lines the window left out or the memory check withheld */
  omitted?: number;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** Authorized memory changed; rebuild without claiming the user edited history. */
  memoryRefreshed?: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
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
  return TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);
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
  transcript: TranscriptEntry[];
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

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
export const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread: this bot was switched over to you. Replies written on other engines are part of this bot's record; do not restate, summarise, correct or disown them. Where your own limits differ, say your own limit and continue with what you can do. The conversation so far:]";
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
export function transcriptForDriver(transcript: readonly TranscriptEntry[], currentInstanceId?: string): Array<{ role: "user" | "assistant"; text: string; header?: string }> {
  const headers = runHeaders(transcript, currentInstanceId);
  return transcript.map((m, i) => ({ role: m.role, text: m.text, ...(headers[i] ? { header: headers[i] } : {}) }));
}

/** Shared by native messages, inline history and session recovery. */
export function replayMetadata(omitted = 0): string {
  return [FRESH_PREAMBLE, ...(omitted > 0 ? [`[${omitted} earlier ${omitted === 1 ? "line" : "lines"} of this conversation ${omitted === 1 ? "is" : "are"} not shown.]`] : [])].join("\n");
}

export function renderDriverReplay(transcript: readonly { role: "user" | "assistant"; text: string; header?: string }[], metadata = ""): string {
  return [metadata, ...transcript.map(item => `${item.header ? item.header + "\n\n" : ""}${item.role === "user" ? "User" : "Assistant"}: ${item.text}`)].filter(Boolean).join("\n");
}

/** Budget the rendered representation, including quotes, labels and headers.
 * Keep whole newest rows. Binary search avoids repeatedly walking long tails. */
export function fitRenderedReplay(transcript: TranscriptEntry[], currentInstanceId?: string, omitted = 0, maxBytes = 192 * 1024): { transcript: TranscriptEntry[]; omitted: number } {
  const budget = Math.min(maxBytes, 192 * 1024);
  const fits = (drop: number) => 256 + Buffer.byteLength(renderDriverReplay(transcriptForDriver(transcript.slice(drop), currentInstanceId), replayMetadata(omitted + drop)) + "\n\n[Now reply to the user's latest message:]\n\n") <= budget;
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
  const { text, transcript, rewound, fresh, externallyUpdated, replaysNatively, memoryRefreshed, currentInstanceId, omitted } = input;
  const resume = !rewound && !fresh && !externallyUpdated && !memoryRefreshed;
  const replay = !resume && !replaysNatively && (transcript.length > 0 || Boolean(omitted));
  if (!replay) return { turnText: replaysNatively && (transcript.length > 0 || Boolean(omitted)) ? `${replayMetadata(omitted)}\n\n${text}` : text, resume };
  const headers = runHeaders(transcript, currentInstanceId);
  return {
    turnText: [
      rewound ? REWOUND_PREAMBLE : memoryRefreshed ? "[Your authorized memory context was refreshed. Continue using only the current memory and conversation history below:]" : externallyUpdated ? EXTERNAL_UPDATE_PREAMBLE : FRESH_PREAMBLE,
      ...(rewound || memoryRefreshed || externallyUpdated ? ["[Replies written on other engines are part of this bot's record; do not restate, summarise, correct or disown them. Where your own limits differ, say your own limit and continue with what you can do.]"] : []),
      ...(omitted && omitted > 0 ? [`[${omitted} earlier ${omitted === 1 ? "line" : "lines"} of this conversation ${omitted === 1 ? "is" : "are"} not shown.]`] : []),
      "",
      ...transcript.flatMap((m, i) => {
        const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`;
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
