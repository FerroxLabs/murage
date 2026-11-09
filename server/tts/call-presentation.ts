/** Complete-source projections for the two host consumers. Never serialize this authority. */
import { compileSpeechSource, MAX_SOURCE_BYTES, REST_ON_SCREEN } from "./speech-source.ts";
import type { VoiceHostState, VoiceHostTurn } from "../voice/voice-host.ts";

export const CONTEXT_UNAVAILABLE = "Context unavailable.";
export interface PresentationFields {
  state: VoiceHostState;
  history: VoiceHostTurn[];
  said: string;
  results: Record<string, string>;
  running: string[];
  answer?: string;
  /** Result identity, only when the requested answer's source is the result's source. */
  answerResultId?: string;
}
export interface PresentationIdentity {
  bootId: string;
  callId: string;
  threadId: string;
  botId: string;
  generationId: string;
  sourceMessageId?: string;
}
declare const presentationBrand: unique symbol;
export type ProtectedPresentation = Readonly<{ identity: PresentationIdentity; signal: AbortSignal; [presentationBrand]: true }>;
const presentations = new WeakMap<object, { fields: PresentationFields; live(): boolean }>();

/** Only coordinator code calls this constructor, after resolving full source identities. */
export function mintCallPresentation(identity: PresentationIdentity, source: PresentationFields, signal: AbortSignal, live: () => boolean): ProtectedPresentation {
  signal.throwIfAborted();
  if (!live()) throw new Error("call presentation unavailable");
  let bytes = 0;
  const project = (text: string): string => {
    bytes += Buffer.byteLength(text);
    if (bytes > 1024 * 1024) throw new Error("call presentation limit");
    return compileSpeechSource(text, { presentation: true, maxUnits: MAX_SOURCE_BYTES * 2, pronounce: false });
  };
  const optional = (text: string | undefined) => text === undefined ? undefined : project(text);
  const raw = source.state;
  // Closed field inventory. Unknown properties never become model inputs.
  const state: VoiceHostState = {
    botName: project(raw.botName), houseRules: optional(raw.houseRules), persona: optional(raw.persona), description: optional(raw.description), now: raw.now,
    task: { title: project(raw.task.title), busy: raw.task.busy, activity: raw.task.activity.map(project) },
    recent: raw.recent.map(row => ({ who: row.who, name: optional(row.name), text: project(row.text), at: row.at })),
    otherTasks: raw.otherTasks.map(task => ({ title: project(task.title), at: task.at })),
    needsYou: raw.needsYou.map(item => ({ title: project(item.title), summary: project(item.summary), at: item.at })),
    approval: optional(raw.approval),
    ...(raw.room ? { room: {
      name: project(raw.room.name), members: raw.room.members.map(member => ({ name: project(member.name), description: optional(member.description) })),
      working: raw.room.working === null ? null : project(raw.room.working),
      heard: raw.room.heard.map(turn => ({ member: project(turn.member), owner: project(turn.owner), reply: project(turn.reply) })),
    } } : {}),
  };
  const fields: PresentationFields = {
    state,
    history: source.history.map(turn => ({ role: turn.role, text: project(turn.text), ...(turn.handDown ? { handDown: { id: turn.handDown.id, request: project(turn.handDown.request) } } : {}) })),
    said: project(source.said), results: Object.fromEntries(Object.entries(source.results).map(([id, result]) => [id, project(result)])),
    running: source.running.map(project), answer: optional(source.answer), answerResultId: source.answerResultId,
  };
  freeze(fields);
  const snapshot = Object.freeze({ identity: Object.freeze({ ...identity }), signal }) as ProtectedPresentation;
  presentations.set(snapshot, { fields, live });
  return snapshot;
}
function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  Object.freeze(value);
}
/** Called immediately before dispatch, including retries. A JSON flag cannot pass. */
export function readCallPresentation(snapshot: ProtectedPresentation): PresentationFields {
  const found = presentations.get(snapshot);
  if (!found || snapshot.signal.aborted || !found.live()) throw new Error("call presentation unavailable");
  return found.fields;
}
/** D24 B.2 RULE: prefix formatting runs inside compile, before its final check. */
export function presentationPrefix(text: string, max: number): string {
  if (text === REST_ON_SCREEN) return text;
  return compileSpeechSource(text, { presentation: true, pronounce: false, maxUnits: MAX_SOURCE_BYTES * 2,
    releaseTransform: protectedText => {
      if (protectedText.length <= max) return protectedText;
      let end = Math.max(0, max);
      if (end && /[\uD800-\uDBFF]/.test(protectedText[end - 1])) end--;
      return protectedText.slice(0, end).trimEnd();
    } });
}
