// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own words to a bot (a refusal, a stop, a failure to start, a placeholder), as opposed to a worker's. A status is made only from this
// closed table: a key and the few things its line may name (a bot's name, a number, one of a short list of codes, or words the result gate has
// already released). Free text cannot be a parameter, so a worker's string cannot be dressed as one of Murage's lines, and a provider's failure
// detail reaches a bot only as one of the codes below. People never see a key: the table writes the words.
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { EgressViolation, ReleasedText } from "./released-text.ts";
import { FAILURE_CODES, failureCodeFrom, type FailureCode } from "./failure-code.ts";
import { hostStoppedDisplayName } from "../shared/host-stop.ts";
import { sendNoticeDisplayName } from "../shared/send-notice.ts";
import { folderTrustDisplayName } from "../shared/folder-trust.ts";

/** A bot's name as it is on its record (people choose it; it is never a worker's reply). */
export type BotName = string & { readonly __botName: unique symbol };
export function botName(record: { name: string }): BotName { return record.name as BotName; }
/** The same, for a name that has only an id to show. */
export function botNameOf(name: string | undefined, fallback: string): BotName { return (name ?? fallback) as BotName; }

/** Why a delegated or asked turn did not finish, in the few ways a bot can act on. Provider detail stays with the owner. */
export { FAILURE_CODES, failureCodeFrom, type FailureCode };
export type StopReasonCode = FailureCode;
export type StartFailureCode = FailureCode;

const FAILURE_WORDS: Record<FailureCode, string> = {
  rate_limit: "the provider is limiting requests right now",
  auth: "it is not signed in to its provider",
  timeout: "its provider took too long to answer",
  provider_error: "its provider had an error",
  other: "it did not say why",
};

export const ENDED_REASONS = ["stopped", "failed", "error", "interrupted"] as const;
export type EndedReason = (typeof ENDED_REASONS)[number];
const ENDED_WORDS: Record<EndedReason, string> = {
  stopped: "its turn was stopped before it finished",
  failed: "its turn did not finish",
  error: "it could not start",
  interrupted: "it was interrupted before it finished",
};

export const QUEUE_REFUSALS = ["self", "too_deep", "no_target", "too_many", "source_deleted"] as const;
export type QueueRefusal = (typeof QUEUE_REFUSALS)[number];

export type Outbound = ReleasedText | MurageStatus;

function wordsOf(value: Outbound): string {
  if (ReleasedText.is(value)) return ReleasedText.words(value);
  if (MurageStatus.is(value)) return MurageStatus.words(value);
  throw new EgressViolation("Only released text or a Murage status can be written to a bot");
}

const oneLine = (text: string): string => text.trim().replace(/\s+/g, " ");

/** The closed table. A line's parameters are only BotName, numbers, codes and already-released words (`Outbound`); the compile-time check
 * below fails on any raw `string` parameter. */
const TABLE = {
  // refusals and short answers on the hand-off routes
  unknown_sender: () => "unknown sender",
  fields_required: () => "toBotId and message required",
  cannot_message_self: () => "a bot cannot message itself",
  cannot_delegate_self: () => "a bot cannot delegate to itself",
  depth_exhausted: () => "the Chief-to-lead-to-specialist handoff depth is exhausted",
  depth_exhausted_delegate: () => "the Chief-to-lead-to-specialist handoff depth is exhausted: complete this work without another handoff",
  queued_for_review: (p: { name: BotName }) => `Queued for review: @${p.name} will only pick it up if the user approves after your turn finishes.`,
  delegation_queued: (p: { name: BotName }) => `Delegation queued: @${p.name} will pick it up after your current turn finishes.`,
  too_many_delegations: () => "too many delegations queued on this turn: finish some first",
  no_such_bot: () => "no such bot",
  source_not_sender: () => "source conversation does not belong to sender",
  source_gone: () => "source conversation no longer exists",
  no_longer_on_roster: () => "that bot is no longer on your roster",
  handoff_limit: (p: { max: number }) => `at most ${p.max} peer handoffs are allowed per turn`,
  task_other_conversation: () => "that task belongs to a different conversation",
  task_unknown: () => "unknown task id: delegation receipts are kept for about 48 hours",
  // answers
  already_asked_done: (p: { name: BotName }) => `(you already asked @${p.name} this in this turn; their answer is above)`,
  already_asked_running: (p: { name: BotName }) => `(you already asked @${p.name} this in this turn; their answer comes back to you)`,
  already_asked_note: () => "already asked in this turn; the answer comes back to you",
  in_line: (p: { name: BotName }) => `${p.name} is busy; your request is in line.`,
  handed_over_turn: (p: { name: BotName }) => `Already handed to @${p.name} in this turn: their result comes back to you.`,
  handed_over_turn_done: (p: { name: BotName }) => `Already handed to @${p.name} in this turn, and it has finished: its result is already with you. It was not sent again.`,
  source_conversation_deleted: () => "this conversation was deleted",
  handed_over_run: (p: { name: BotName }) => `Already handed to @${p.name} in this run: their result comes back to you.`,
  handed_over_run_working: (p: { name: BotName }) => `Already handed to @${p.name} in this run: still working, their result comes back to you.`,
  asked_in_run_note: () => "already asked in this run; the answer comes back to you",
  ended_in_run: (p: { name: BotName; reason: EndedReason }) => `This was already handed to @${p.name} in this run, and it ended: ${ENDED_WORDS[p.reason]}.`,
  answered_in_run: (p: { name: BotName; answer: Outbound }) => `You already asked @${p.name} this in this run. Their answer: ${wordsOf(p.answer)}`,
  stopped_no_partial: () => "(the bot's turn was stopped before it finished)",
  stopped_partial: (p: { partial: Outbound }) => `(the bot's turn was stopped before it finished; partial reply follows)\n\n${wordsOf(p.partial)}`,
  turn_failed: (p: { code: FailureCode }) => `(the bot's turn failed: ${FAILURE_WORDS[p.code]})`,
  nothing: () => "",
  no_reply: () => "(the bot finished without a text reply)",
  wait_timed_out: () => "(timed out waiting for the bot to reply)",
  could_not_start: (p: { why: StartFailureCode }) => `(couldn't start that bot: ${FAILURE_WORDS[p.why]})`,
  no_audience_task: () => "(no audience task)",
  withheld: () => `[${ROOM_REPLY_WITHHELD}]`,
  origin_unconfirmed: () => RECEIPT_ORIGIN_UNCONFIRMED_LINE,
  request_finished: () => "The request finished.",
  request_failed: () => "The request did not finish.",
  result_unavailable: () => "(that result is no longer available)",
  shared_request_finished: () => "The shared request finished.",
  // what the owner's conversation and the pair room say about a finished hand-off (bots read these rows too)
  replied_to_task: (p: { name: BotName; reply: Outbound }) => `@${p.name} replied to the delegated task:\n\n${wordsOf(p.reply).trim()}`,
  delegation_completed_no_text: (p: { name: BotName }) => `Delegation to @${p.name} completed without a text reply`,
  delegation_stopped_early: (p: { name: BotName }) => `Delegation to @${p.name} was stopped before it finished`,
  delegation_failed: (p: { name: BotName; why: FailureCode }) => `Delegation to @${p.name} failed: ${FAILURE_WORDS[p.why]}`,
  delegation_failed_plain: (p: { name: BotName }) => `Delegation to @${p.name} failed`,
  delegation_failed_with: (p: { name: BotName; why: Outbound }) => `Delegation to @${p.name} failed: ${wordsOf(p.why)}`,
  delegated_turn_completed: () => "Delegated turn completed",
  delegated_turn_stalled: () => "Delegated turn stalled and was stopped",
  delegated_turn_stopped: () => "Delegated turn was stopped before it finished",
  delegated_turn_settings_changed: () => "Delegated turn did not finish: provider settings changed",
  delegated_turn_engine_changed: () => "Delegated turn did not finish: its engine was turned off or changed",
  delegated_turn_failed: (p: { why: FailureCode }) => `Delegated turn failed: ${FAILURE_WORDS[p.why]}`,
  delegated_turn_failed_plain: () => "Delegated turn did not finish",
  delegated_turn_could_not_start: (p: { why: StartFailureCode }) => `Delegated turn could not start: ${FAILURE_WORDS[p.why]}`,
  turn_stopped_early: () => "Turn was stopped before it finished",
  turn_failed_note: (p: { code: FailureCode }) => `Turn failed: ${FAILURE_WORDS[p.code]}`,
  peer_could_not_start: (p: { name: BotName; why: StartFailureCode }) => `${p.name} could not start: ${FAILURE_WORDS[p.why]}`,
  still_working: (p: { name: BotName }) => `@${p.name} is still working: ask converted to a delegation`,
  // a hand-off's ending, as the delegation receipt keeps it
  receipt_cancelled: () => "cancelled",
  receipt_owner_stopped: () => "the owner stopped this handoff while it was waiting",
  receipt_turn_unfinished: () => "the delegating turn did not finish",
  receipt_denied: () => "the user denied this handoff",
  receipt_expired: () => "the approval card expired without an answer",
  receipt_not_approved: () => "the approval was cancelled before a decision",
  receipt_failed: () => "the hand-off failed",
  receipt_source_gone: () => "the source conversation is no longer available",
  receipt_bots_gone: () => "one of the bots no longer exists",
  receipt_stayed_busy: (p: { name: BotName; tries: number }) => `@${p.name} stayed busy through ${p.tries} retries`,
  receipt_other_section: (p: { from: BotName; to: BotName }) => `@${p.from} and @${p.to} now belong to different sections`,
  // a delegation row in the owner's conversation
  row_stopped_by_you: (p: { name: BotName }) => `Delegation to @${p.name} stopped by you`,
  row_cancelled: (p: { name: BotName }) => `Delegation to @${p.name} was cancelled`,
  row_denied: (p: { name: BotName }) => `Delegation to @${p.name} denied by user`,
  row_still_busy: (p: { name: BotName; tries: number }) => `Delegation to @${p.name} canceled: still busy after ${p.tries} retries`,
  row_other_section: (p: { name: BotName }) => `Delegation to @${p.name} canceled: bots now belong to different sections`,
  row_could_not_start: (p: { name: BotName; why: StartFailureCode }) => `error: delegation to @${p.name} could not start: ${FAILURE_WORDS[p.why]}`,
  row_failed_to_run: (p: { why: FailureCode }) => `error: delegation failed: ${FAILURE_WORDS[p.why]}`,
  row_no_such_bot: (p: { name: BotName }) => `error: delegation to ${p.name} failed: no such bot`,
  row_approval: (p: { name: BotName; line: Outbound }) => `Delegation to @${p.name}: ${wordsOf(p.line)}`,
  // a project card's result line in its room
  card_result_line: (p: { desk: BotName; lead: BotName; card: BotName }) => `${p.desk} to ${p.lead}: result for ${p.card}`,
  // a row of a running delegation's recent activity (the words inside were released by the gate)
  activity_name: (p: { name: Outbound }) => { const name = wordsOf(p.name).trim(); return hostStoppedDisplayName(name) ?? sendNoticeDisplayName(name) ?? folderTrustDisplayName(name) ?? `tool: ${name}`; },
  activity_text: (p: { text: Outbound }) => {
    const text = oneLine(wordsOf(p.text));
    return `text: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`;
  },
  activity_line: (p: { text: Outbound }) => wordsOf(p.text),
  // a failed or retried step of a running delegation: the kind of failure, never the provider's own words
  activity_retrying: (p: { code: FailureCode }) => `retrying after a failure: ${FAILURE_WORDS[p.code]}`,
  activity_error: (p: { code: FailureCode }) => `error: ${FAILURE_WORDS[p.code]}`,
} as const;

export type StatusKey = keyof typeof TABLE;
/** `host_line` is the one key outside the table: a line a Murage module composed itself from its own fixed tables (server/host-words.ts). */
export type AnyStatusKey = StatusKey | "host_line";
type TableFn<K extends StatusKey> = (typeof TABLE)[K];
export type StatusArgs<K extends StatusKey> = Parameters<TableFn<K>> extends [infer P] ? [P] : [];

// compile-time: no table line takes a raw string
type RawStringFree<P> = P extends undefined ? true
  : P extends object ? ({ [K in keyof P]: P[K] extends ReleasedText | MurageStatus ? true : P[K] extends string ? (string extends P[K] ? false : true) : P[K] extends number ? true : false }[keyof P] extends true ? true : false)
  : false;
type OffendingKeys = { [K in StatusKey]: RawStringFree<Parameters<TableFn<K>>[0]> extends true ? never : K }[StatusKey];
export const TABLE_TAKES_NO_RAW_STRINGS: [OffendingKeys] extends [never] ? true : { offending: OffendingKeys } = true;

const PERSISTABLE = new Set<string>([
  "no_such_bot", "receipt_cancelled", "receipt_owner_stopped", "receipt_turn_unfinished", "receipt_denied", "receipt_expired", "receipt_not_approved", "receipt_failed",
  "receipt_source_gone", "receipt_bots_gone", "receipt_stayed_busy", "receipt_other_section", "request_finished", "turn_stopped_early", "delegation_failed_plain",
  "delegated_turn_failed_plain", "delegated_turn_failed", "delegated_turn_could_not_start", "delegated_turn_completed", "request_failed", "result_unavailable",
  "delegated_turn_stalled", "delegated_turn_stopped", "delegated_turn_settings_changed", "delegated_turn_engine_changed",
  "turn_failed_note", "delegation_stopped_early", "delegation_completed_no_text", "row_failed_to_run", "turn_failed",
]);

const statuses = new WeakSet<object>();
/** Never exported: a status is made only by `MurageStatus.build` / the host capability, which carry it. */
const STATUS_KEY = Symbol("murage-status-mint");
let hostClaimed = false;

export class MurageStatus {
  readonly #words: string;
  readonly key: AnyStatusKey;
  /** What a stored copy needs to write the same line again: only strings and numbers, and only for the keys a receipt keeps. */
  readonly data: Readonly<Record<string, string | number>> | undefined;
  /** The released texts this line quotes, so a row written from it keeps the link to their originals. */
  readonly quotes: readonly ReleasedText[];
  private constructor(key: AnyStatusKey, words: string, data: Readonly<Record<string, string | number>> | undefined, quotes: readonly ReleasedText[], mint: symbol) {
    if (mint !== STATUS_KEY) throw new EgressViolation("A status is made from the table, never by hand");
    this.key = key; this.#words = words; this.data = data ? Object.freeze({ ...data }) : undefined; this.quotes = Object.freeze([...quotes]);
    statuses.add(this);
    Object.freeze(this);
  }
  /** The one way to make a status: a key from the table and the parameters its line names. */
  static build<K extends StatusKey>(key: K, ...args: StatusArgs<K>): MurageStatus {
    const line = TABLE[key] as (p?: unknown) => string;
    if (typeof line !== "function" || !Object.prototype.hasOwnProperty.call(TABLE, key)) throw new EgressViolation("Not a Murage status line");
    const params = args[0] as Record<string, unknown> | undefined;
    const quotes: ReleasedText[] = [];
    for (const value of Object.values(params ?? {})) {
      if (ReleasedText.is(value)) quotes.push(value);
      else if (MurageStatus.is(value)) quotes.push(...value.quotes);
    }
    return new MurageStatus(key, line(params), PERSISTABLE.has(key) ? plainData(params) : undefined, quotes, STATUS_KEY);
  }
  /** Taken once, by server/host-words.ts when it loads: the function that wraps a line a Murage module composed from its own fixed tables. A
   * second claim is a violation, so no other module can wrap a string as a status. */
  static claimHost(): (words: string) => MurageStatus {
    if (hostClaimed) throw new EgressViolation("Host lines can be made only by server/host-words.ts");
    hostClaimed = true;
    return words => new MurageStatus("host_line", words, undefined, [], STATUS_KEY);
  }
  static is(value: unknown): value is MurageStatus { return typeof value === "object" && value !== null && #words in value && statuses.has(value); }
  static words(status: MurageStatus): string {
    if (!MurageStatus.is(status)) throw new EgressViolation("Not a Murage status");
    return status.#words;
  }
  toString(): never { throw new EgressViolation("A status is written by a sink, never joined into a string"); }
  toJSON(): never { throw new EgressViolation("A status is written by a sink, never joined into a string"); }
  [Symbol.toPrimitive](): never { throw new EgressViolation("A status is written by a sink, never joined into a string"); }
}

function plainData(params: Record<string, unknown> | undefined): Record<string, string | number> | undefined {
  if (!params) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
    else return undefined;
  }
  return out;
}

export function status<K extends StatusKey>(key: K, ...args: StatusArgs<K>): MurageStatus { return MurageStatus.build(key, ...args); }

/** A status written again from what a receipt kept. Only keys a receipt keeps, with string or number parameters. */
export function statusFromStored(key: string | undefined, data: unknown): MurageStatus | undefined {
  if (!key || !PERSISTABLE.has(key) || !(key in TABLE)) return undefined;
  const params: Record<string, unknown> = {};
  if (data && typeof data === "object") for (const [name, value] of Object.entries(data as Record<string, unknown>)) if (typeof value === "string" || typeof value === "number") params[name] = value;
  try { return (MurageStatus.build as (key: StatusKey, p: unknown) => MurageStatus)(key as StatusKey, params); } catch { return undefined; }
}

const LEGACY_NOTES: Array<[RegExp, () => MurageStatus]> = [
  [/^cancelled$/, () => status("receipt_cancelled")],
  [/^the owner stopped this handoff while it was waiting$/, () => status("receipt_owner_stopped")],
  [/^the delegating turn did not finish$/, () => status("receipt_turn_unfinished")],
  [/^the user denied this handoff$/, () => status("receipt_denied")],
  [/^no such bot$/, () => status("no_such_bot")],
  [/^the source conversation is no longer available$/, () => status("receipt_source_gone")],
  [/^one of the bots no longer exists$/, () => status("receipt_bots_gone")],
  [/^@(.{1,80}) stayed busy through (\d{1,3}) retries$/, () => status("request_failed")],
  [/^@(.{1,80}) and @(.{1,80}) now belong to different sections$/, () => status("request_failed")],
  [/^stopped before it finished$/, () => status("turn_stopped_early")],
];

const NOTE_PREFIX = "status:";

/** A line as a request's outcome note keeps it: a status that a receipt can rewrite is kept by its key and plain values, so the note reads back as
 * the same line; any other status keeps only the key of the plain failure. Words a worker wrote never go into a note. */
export function noteOf(line: Outbound): string {
  if (MurageStatus.is(line) && line.key !== "host_line" && PERSISTABLE.has(line.key) && line.data) return `${NOTE_PREFIX}${JSON.stringify({ key: line.key, data: line.data })}`.slice(0, 400);
  return `${NOTE_PREFIX}${JSON.stringify({ key: "request_failed" })}`;
}
/** The same, for a receipt's own record of its ending. */
export function noteFromStored(key: string | undefined, data: unknown): string | undefined {
  const line = statusFromStored(key, data);
  return line ? noteOf(line) : undefined;
}

/** What an older receipt or request note said, as one of today's lines. A note this does not recognise is a free-text failure detail: it reads as
 * `fallback` (the plain "The request finished." unless the caller knows the request failed) and never as the text. */
export function statusFromNote(note: string | undefined | null, fallback: "request_finished" | "request_failed" = "request_finished"): MurageStatus {
  const text = (note ?? "").trim();
  if (text.startsWith(NOTE_PREFIX)) {
    try {
      const parsed = JSON.parse(text.slice(NOTE_PREFIX.length)) as { key?: unknown; data?: unknown };
      const line = typeof parsed.key === "string" ? statusFromStored(parsed.key, parsed.data) : undefined;
      if (line) return line;
    } catch { /* an unreadable note is the plain line below */ }
    return status(fallback);
  }
  for (const [pattern, make] of LEGACY_NOTES) if (pattern.test(text)) return make();
  return status(fallback);
}

/** The original a written row must link to: the released text's own, or the one a status quotes. */
export function outboundCopy(value: Outbound): { threadId: string; messageIds: string[] } | undefined {
  const text = ReleasedText.is(value) ? value : value.quotes.find(quote => quote.copyOf);
  const copy = text?.copyOf;
  return copy ? { threadId: copy.threadId, messageIds: [...copy.messageIds] } : undefined;
}

export function isOutbound(value: unknown): value is Outbound { return ReleasedText.is(value) || MurageStatus.is(value); }

/** The words of a released or status value, for a sink that writes them. */
export function outboundWords(value: Outbound): string { return wordsOf(value); }

