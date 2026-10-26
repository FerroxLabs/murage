// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own words to a bot (a refusal, a stop, a failure to start, a placeholder), as opposed to a worker's. A status is made only from this
// closed table: a key and the few things its line may name (a bot's name, a number, one of a short list of codes, or words the result gate has
// already released). Free text cannot be a parameter, so a worker's string cannot be dressed as one of Murage's lines, and a provider's failure
// detail reaches a bot only as one of the codes below. People never see a key: the table writes the words.
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { EgressViolation, ReleasedText, recordRendered } from "./released-text.ts";
import { FAILURE_CODES, START_FAILURE_CODES, failureCodeFrom, startFailureCodeFrom, type FailureCode, type StartFailureCode } from "./failure-code.ts";
import { hostStoppedDisplayName } from "../shared/host-stop.ts";
import { loopNoticeDisplayName } from "../shared/loop-notice.ts";
import { sendNoticeDisplayName } from "../shared/send-notice.ts";
import { folderTrustDisplayName } from "../shared/folder-trust.ts";

/** A bot's name as it is on its record (people choose it; it is never a worker's reply). */
export type BotName = string & { readonly __botName: unique symbol };
export function botName(record: { name: string }): BotName { return record.name as BotName; }
/** The same, for a bot whose record may be gone: its id stands in. It takes the record, never a bare string. */
export function botNameOf(record: { name?: string } | null | undefined, botId: string): BotName { return (record?.name ?? botId) as BotName; }
/** A project card's title as its record has it, made only by the boundary's store adapter (server/boundary-ports.ts). */
export type CardTitle = string & { readonly __cardTitle: unique symbol };
export function cardTitle(record: { title: string }, shown: (record: { title: string }) => string = card => `'${card.title}'`): CardTitle { return shown(record) as CardTitle; }

/** Why a delegated or asked turn did not finish, in the few ways a bot can act on. Provider detail stays with the owner. */
export { FAILURE_CODES, START_FAILURE_CODES, failureCodeFrom, startFailureCodeFrom, type FailureCode, type StartFailureCode };
export type StopReasonCode = FailureCode;

const FAILURE_WORDS: Record<FailureCode, string> = {
  rate_limit: "the provider is limiting requests right now",
  auth: "it is not signed in to its provider",
  timeout: "its provider took too long to answer",
  provider_error: "its provider had an error",
  other: "it did not say why",
};
/** Why a turn could not start, always a named reason: a start is Murage's own step, so it never reads "it did not say why". */
const START_WORDS: Record<StartFailureCode, string> = {
  rate_limit: FAILURE_WORDS.rate_limit,
  auth: FAILURE_WORDS.auth,
  timeout: FAILURE_WORDS.timeout,
  provider_error: FAILURE_WORDS.provider_error,
  not_reachable: "it cannot be reached from this conversation",
  archived: "it is archived",
  sharing_removed: "it is no longer shared with this team",
  team_deleted: "its team was removed",
  binding_mismatch: "the request no longer fits its conversation",
  shared_paused: "sharing is paused",
  setup: "Murage could not set up its turn. Its conversation has the details",
};
/** A kept start code: one of today's, or a code an earlier build kept ("other" reads as a setup failure). */
/** A start code as a line takes it: today's codes, or "other" (an older caller, a kept ending), which names the start a setup failure. */
export type StartWhy = StartFailureCode | "other";
const startCodeOf = (why: StartWhy): StartFailureCode => why === "other" ? "setup" : why;

export const ENDED_REASONS = ["stopped", "failed", "error", "interrupted"] as const;
export type EndedReason = (typeof ENDED_REASONS)[number];
const ENDED_WORDS: Record<EndedReason, string> = {
  stopped: "its turn was stopped before it finished",
  failed: "its turn did not finish",
  error: "it could not start",
  interrupted: "it was interrupted before it finished",
};

export const QUEUE_REFUSALS = ["self", "too_deep", "no_target", "too_many"] as const;

/** Why a shared queue closed a request it never ran, in the few fixed ways Murage says it. */
export const QUEUE_CLOSE_CODES = ["expired", "not_reachable", "archived", "sharing_removed", "team_deleted", "binding_mismatch", "deadlock", "refused"] as const;
export type QueueCloseCode = (typeof QUEUE_CLOSE_CODES)[number];
const QUEUE_CLOSE_WORDS: Record<QueueCloseCode, (name: string) => string> = {
  expired: name => `${name} could not get to this in a day. Ask again.`,
  not_reachable: name => `${name} cannot be reached from here.`,
  archived: name => `${name} is archived.`,
  sharing_removed: name => `${name} is no longer shared with this team.`,
  team_deleted: name => `${name} is no longer shared with this team.`,
  binding_mismatch: () => "This request no longer fits this conversation. Ask again.",
  deadlock: name => `${name} is already waiting on you, so answer them first.`,
  // any other reason admission closes a request for: it keeps its own record, and the bot is told it was not taken on
  refused: name => `${name} could not take this on. Ask again.`,
};
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
  source_deleted: () => "this conversation was deleted",
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
  handed_over_finished: (p: { name: BotName }) => `Already handed to @${p.name} in this turn, and it has finished: its result is already with you. It was not sent again.`,
  handed_over_run: (p: { name: BotName }) => `Already handed to @${p.name} in this run: their result comes back to you.`,
  handed_over_run_working: (p: { name: BotName }) => `Already handed to @${p.name} in this run: still working, their result comes back to you.`,
  asked_in_run_note: () => "already asked in this run; the answer comes back to you",
  ended_in_run: (p: { name: BotName; reason: EndedReason }) => `This was already handed to @${p.name} in this run, and it ended: ${ENDED_WORDS[p.reason]}.`,
  answered_in_run: (p: { name: BotName; answer: Outbound }) => `You already asked @${p.name} this in this run. Their answer: ${wordsOf(p.answer)}`,
  stopped_no_partial: () => "(the bot's turn was stopped before it finished)",
  stopped_partial: (p: { partial: Outbound }) => `(the bot's turn was stopped before it finished; partial reply follows)\n\n${wordsOf(p.partial)}`,
  unfinished_partial: (p: { ending: Outbound; partial: Outbound }) => `(${wordsOf(p.ending).trim().replace(/[.]$/, "")}. It did not finish; its partial reply follows)\n\n${wordsOf(p.partial)}`,
  turn_failed: (p: { code: FailureCode }) => `(the bot's turn did not finish: ${FAILURE_WORDS[p.code]})`,
  nothing: () => "",
  no_reply: () => "(the bot finished without a text reply)",
  wait_timed_out: () => "(timed out waiting for the bot to reply)",
  could_not_start: (p: { why: StartWhy }) => `(couldn't start that bot: ${START_WORDS[startCodeOf(p.why)]})`,
  no_audience_task: () => "(no audience task)",
  withheld: () => `[${ROOM_REPLY_WITHHELD}]`,
  // a result left out only until an earlier check finishes (REPLY-WITHHELD-CONTRACT C1): nothing was withdrawn
  checking: () => `[${ROOM_REPLY_CHECKING}]`,
  // a delegation result whose check has not finished: the asking bot's final answer for that request (lanes/release103/NOHOLD-DELEGATION.md)
  no_answer_checking: () => "(no answer: that memory is still being checked, try again later)",
  // a delegation result whose check did not finish within the wait (1.0.5, DELEGATED-REPLY-WITHHELD.md): the asker learns the worker finished and where the words are
  no_answer_check_timed_out: (p: { name: BotName }) => `(no answer yet: @${p.name} finished, but the reply is still being checked against earlier memory. Read it in @${p.name}'s own conversation, or ask again in a minute)`,
  origin_unconfirmed: () => RECEIPT_ORIGIN_UNCONFIRMED_LINE,
  request_finished: () => "The request finished.",
  request_failed: () => "The request did not finish.",
  result_unavailable: () => "(that result is no longer available)",
  shared_request_finished: () => "The shared request finished.",
  shared_not_approved: () => "The shared request was not approved.",
  // why a shared queue closed a request before it ran (the owner reads the same words in the conversation)
  queue_paused_steps: (p: { steps: number }) => `Paused: ${p.steps} team steps since your last message. Say continue.`,
  queue_closed: (p: { name: BotName; why: QueueCloseCode }) => QUEUE_CLOSE_WORDS[p.why](p.name),
  // what the owner's conversation and the pair room say about a finished hand-off (bots read these rows too)
  replied_to_task: (p: { name: BotName; reply: Outbound }) => `@${p.name} replied to the delegated task:\n\n${wordsOf(p.reply).trim()}`,
  delegation_completed_no_text: (p: { name: BotName }) => `Delegation to @${p.name} completed without a text reply`,
  delegation_stopped_early: (p: { name: BotName }) => `Delegation to @${p.name} was stopped before it finished`,
  delegation_failed: (p: { name: BotName; why: FailureCode }) => `Delegation to @${p.name} did not finish: ${FAILURE_WORDS[p.why]}`,
  delegation_failed_plain: (p: { name: BotName }) => `Delegation to @${p.name} did not finish`,
  delegation_failed_with: (p: { name: BotName; why: Outbound }) => `Delegation to @${p.name} did not finish: ${wordsOf(p.why)}`,
  delegated_turn_completed: () => "Delegated turn completed",
  delegated_turn_stalled: () => "Delegated turn stalled and was stopped",
  delegated_turn_stopped: () => "Delegated turn was stopped before it finished",
  delegated_turn_settings_changed: () => "Delegated turn did not finish: provider settings changed",
  delegated_turn_engine_changed: () => "Delegated turn did not finish: its engine was turned off or changed",
  delegated_turn_failed: (p: { why: FailureCode }) => `Delegated turn did not finish: ${FAILURE_WORDS[p.why]}`,
  delegated_turn_failed_plain: () => "Delegated turn did not finish",
  delegated_turn_could_not_start: (p: { why: StartWhy }) => `Delegated turn could not start: ${START_WORDS[startCodeOf(p.why)]}`,
  turn_stopped_early: () => "Turn was stopped before it finished",
  turn_failed_note: (p: { code: FailureCode }) => `Turn did not finish: ${FAILURE_WORDS[p.code]}`,
  peer_could_not_start: (p: { name: BotName; why: StartWhy }) => `${p.name} could not start: ${START_WORDS[startCodeOf(p.why)]}`,
  still_working: (p: { name: BotName }) => `@${p.name} is still working: ask converted to a delegation`,
  // a hand-off's ending, as the delegation receipt keeps it
  receipt_cancelled: () => "cancelled",
  receipt_owner_stopped: () => "the owner stopped this handoff while it was waiting",
  receipt_turn_unfinished: () => "the delegating turn did not finish",
  receipt_denied: () => "the user denied this handoff",
  draft_only_handoff: () => "This bot drafts replies for you to send, so it hands work only to teammates that draft too.",
  receipt_draft_only: () => "this bot drafts replies for you to send, so it hands work only to teammates that draft too",
  receipt_expired: () => "the approval card expired without an answer",
  receipt_not_approved: () => "the approval was cancelled before a decision",
  receipt_deleted: () => "the conversation was deleted",
  receipt_restart: () => "interrupted by a restart",
  receipt_dismissed: () => "dismissed by you",
  receipt_unreadable: () => "the queued handoff could not be read",
  receipt_request_gone: () => "the shared request is no longer available",
  receipt_uncertain: (p: { name: BotName }) => `Murage restarted while handing this to @${p.name}. It may have started. Check @${p.name}'s conversation, or send it again.`,
  receipt_held_busy: (p: { name: BotName }) => `@${p.name} stayed busy, so this wasn't sent. Send again or dismiss it.`,
  receipt_held_didnotstart: (p: { name: BotName }) => `This didn't start for @${p.name}. Send again or dismiss it.`,
  receipt_failed: () => "the hand-off did not finish",
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
  row_could_not_start: (p: { name: BotName; why: StartWhy }) => `error: delegation to @${p.name} could not start: ${START_WORDS[startCodeOf(p.why)]}`,
  row_failed_to_run: (p: { why: FailureCode }) => `error: delegation did not finish: ${FAILURE_WORDS[p.why]}`,
  row_no_such_bot: (p: { name: BotName }) => `error: delegation to ${p.name} did not finish: no such bot`,
  row_approval: (p: { name: BotName; line: Outbound }) => `Delegation to @${p.name}: ${wordsOf(p.line)}`,
  // a project card's result line in its room
  card_result_line: (p: { desk: BotName; lead: BotName; card: CardTitle }) => `${p.desk} to ${p.lead}: result for ${p.card}`,
  // what is on record after a reply claimed every done criterion was met (counts only, never a criterion's words)
  criteria_claim_corrected: (p: { met: number; total: number }) => `On record: ${p.met} of ${p.total} done criteria met.`,
  // a voice call with the owner ended (its notes stay with the owner)
  call_ended: (p: { minutes: number }) => `The voice call ended after ${p.minutes} min.`,
  // the owner confirmed a first-run setup step
  setup_confirmed: () => "That setup step is saved.",
  // a row of a running delegation's recent activity (the words inside were released by the gate)
  activity_name: (p: { name: Outbound }) => { const name = wordsOf(p.name).trim(); return hostStoppedDisplayName(name) ?? sendNoticeDisplayName(name) ?? loopNoticeDisplayName(name) ?? folderTrustDisplayName(name) ?? `tool: ${name}`; },
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

/** The keys a stored record (a receipt, a request's ending) may keep, and the exact parameters each keeps. A kept line is written again only when
 * its parameters match this schema: a bot's name must be the name of a bot on the roster now, a code one of the five, a count a small whole
 * number. Anything else reads as no line at all, so nothing kept can carry words that are not Murage's. */
type ParamKind = "bot" | "card" | "code" | "start" | "count" | "close";
const KEPT: Readonly<Record<string, Readonly<Record<string, ParamKind>>>> = {
  no_such_bot: {}, receipt_cancelled: {}, receipt_owner_stopped: {}, receipt_turn_unfinished: {}, receipt_denied: {}, receipt_draft_only: {}, receipt_expired: {}, receipt_not_approved: {},
  receipt_deleted: {}, receipt_restart: {}, receipt_dismissed: {}, receipt_unreadable: {}, receipt_request_gone: {}, receipt_uncertain: { name: "bot" }, receipt_held_busy: { name: "bot" }, receipt_held_didnotstart: { name: "bot" },
  receipt_failed: {}, receipt_source_gone: {}, receipt_bots_gone: {}, receipt_stayed_busy: { name: "bot", tries: "count" }, receipt_other_section: { from: "bot", to: "bot" },
  request_finished: {}, request_failed: {}, result_unavailable: {}, shared_not_approved: {}, turn_stopped_early: {}, delegation_failed_plain: { name: "bot" },
  delegation_stopped_early: { name: "bot" }, delegation_completed_no_text: { name: "bot" }, delegated_turn_failed_plain: {}, delegated_turn_failed: { why: "code" },
  delegated_turn_could_not_start: { why: "start" }, delegated_turn_completed: {}, delegated_turn_stalled: {}, delegated_turn_stopped: {},
  delegated_turn_settings_changed: {}, delegated_turn_engine_changed: {}, turn_failed_note: { code: "code" }, row_failed_to_run: { why: "code" }, turn_failed: { code: "code" },
  queue_paused_steps: { steps: "count" }, queue_closed: { name: "bot", why: "close" },
  withheld: {}, checking: {}, no_answer_checking: {}, no_answer_check_timed_out: { name: "bot" }, card_result_line: { desk: "bot", lead: "bot", card: "card" }, criteria_claim_corrected: { met: "count", total: "count" }, call_ended: { minutes: "count" },
  setup_confirmed: {},
};
const PERSISTABLE = new Set<string>(Object.keys(KEPT));

/** The status lines a bot may read (LINEAGE-DESIGN-S6 rule 14), each rendered fresh from what its row keeps. Every other line in the table is
 * the owner's only: a bot reading a row that carries one reads nothing there. Each key here is one a row keeps (KEPT). */
export const BOT_VISIBLE_STATUS: ReadonlySet<StatusKey> = new Set<StatusKey>(["withheld", "checking", "no_answer_checking", "no_answer_check_timed_out", "request_finished", "result_unavailable", "card_result_line", "criteria_claim_corrected", "call_ended", "setup_confirmed"]);

/** Is this a bot on the roster now? Supplied once by the server; with none, no kept line naming a bot is written again (fail closed). */
let rosterHas: ((name: string) => boolean) | undefined;
export function configureStatusRoster(lookup: ((name: string) => boolean) | undefined): void { rosterHas = lookup; }
/** Is this a project card that exists now? Supplied by the server once cards are kept by id; with none, no kept line naming a card is written
 * again (fail closed). */
let cardHas: ((card: string) => boolean) | undefined;
export function configureStatusCards(lookup: ((card: string) => boolean) | undefined): void { cardHas = lookup; }


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
    // the released texts it quotes are written out with it: a prompt or tool answer built from it is shown them (released-text.ts)
    for (const quote of status.quotes) recordRendered(quote);
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

/** What a kept line's parameters are, checked against its key's schema (see KEPT). `roster`: names are checked against the bots on the roster now. */
function keptParams(key: string, data: unknown, roster: boolean): Record<string, string | number> | undefined {
  const schema = KEPT[key];
  if (!schema || !Object.prototype.hasOwnProperty.call(KEPT, key)) return undefined;
  const given = data === undefined || data === null ? {} : data;
  if (typeof given !== "object" || Array.isArray(given)) return undefined;
  const entries = Object.entries(given as Record<string, unknown>);
  if (entries.length !== Object.keys(schema).length) return undefined;
  const out: Record<string, string | number> = {};
  for (const [name, value] of entries) {
    const kind = Object.prototype.hasOwnProperty.call(schema, name) ? schema[name] : undefined;
    if (kind === "code") { if (typeof value !== "string" || !(FAILURE_CODES as readonly string[]).includes(value)) return undefined; }
    else if (kind === "start") { if (typeof value !== "string" || !([...START_FAILURE_CODES, "other"] as readonly string[]).includes(value)) return undefined; }
    else if (kind === "count") { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) return undefined; }
    else if (kind === "close") { if (typeof value !== "string" || !(QUEUE_CLOSE_CODES as readonly string[]).includes(value)) return undefined; }
    else if (kind === "bot") {
      if (typeof value !== "string" || value.length < 1 || value.length > 80 || /[\p{Cc}\u2028\u2029]/u.test(value)) return undefined;
      if (roster && (!rosterHas || !rosterHas(value))) return undefined;
    } else if (kind === "card") {
      if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\p{Cc}\u2028\u2029]/u.test(value)) return undefined;
      if (roster && (!cardHas || !cardHas(value))) return undefined;
    } else return undefined;
    out[name] = value as string | number;
  }
  return out;
}

/** A line as a stored record keeps it: its key and plain parameters, in a field of their own, never inside a text. A line the record cannot keep
 * (a quote of released words, Murage's own composed lines) is kept as the plain failure. */
export interface StoredStatus { key: string; data?: Readonly<Record<string, string | number>> }
export function storedStatusOf(line: Outbound): StoredStatus {
  if (MurageStatus.is(line) && line.key !== "host_line" && PERSISTABLE.has(line.key) && line.data && keptParams(line.key, line.data, false)) {
    return Object.keys(line.data).length ? { key: line.key, data: line.data } : { key: line.key };
  }
  return { key: "request_failed" };
}
/** What a row written from `line` keeps of it (rule 11): its key and plain parameters when the table keeps that line, else nothing (a quote of
 * released words, a host line, a line with parameters a row cannot keep). Unlike storedStatusOf there is no fallback line. */
export function statusRecordOf(line: Outbound): StoredStatus | undefined {
  if (!MurageStatus.is(line) || line.key === "host_line" || !PERSISTABLE.has(line.key) || !line.data || !keptParams(line.key, line.data, false)) return undefined;
  return Object.keys(line.data).length ? { key: line.key, data: line.data } : { key: line.key };
}
/** Does a stored record's line have the shape its key keeps (names are checked when the line is written again)? */
export function storedStatusShapeOk(key: string | undefined, data: unknown): boolean { return Boolean(key) && keptParams(key!, data, false) !== undefined; }

/** A status written again from what a record kept: only keys a record keeps, with exactly the parameters the key's schema names. */
export function statusFromStored(key: string | undefined, data: unknown): MurageStatus | undefined {
  if (!key) return undefined;
  const params = keptParams(key, data, true);
  if (!params) return undefined;
  try { return (MurageStatus.build as (key: StatusKey, p: unknown) => MurageStatus)(key as StatusKey, params); } catch { return undefined; }
}

const LEGACY_NOTES: Array<[RegExp, () => MurageStatus]> = [
  [/^cancelled$/, () => status("receipt_cancelled")],
  [/^the conversation was deleted$/, () => status("receipt_deleted")],
  [/^interrupted by a restart$/, () => status("receipt_restart")],
  [/^dismissed by you$/, () => status("receipt_dismissed")],
  [/^the queued handoff could not be read$/, () => status("receipt_unreadable")],
  [/^the shared request is no longer available$/, () => status("receipt_request_gone")],
  [/^the owner stopped this handoff while it was waiting$/, () => status("receipt_owner_stopped")],
  [/^the delegating turn did not finish$/, () => status("receipt_turn_unfinished")],
  [/^the user denied this handoff$/, () => status("receipt_denied")],
  [/^no such bot$/, () => status("no_such_bot")],
  [/^the source conversation is no longer available$/, () => status("receipt_source_gone")],
  [/^one of the bots no longer exists$/, () => status("receipt_bots_gone")],
  [/^@(.{1,80}) stayed busy through (\d{1,3}) retries$/, () => status("request_failed")],
  [/^@(.{1,80}) and @(.{1,80}) now belong to different sections$/, () => status("request_failed")],
  [/^stopped before it finished$/, () => status("turn_stopped_early")],
  [/^stopped$/, () => status("turn_stopped_early")],
  [/^could not start$/, () => status("delegated_turn_could_not_start", { why: "setup" })],
  [/^The shared request was not approved\.$/, () => status("shared_not_approved")],
];

/** What an older receipt or request note said, as one of today's lines. Only a few exact fixed lines Murage itself wrote are recognised, and none of
 * them carries a parameter; anything else (a provider's failure text, whatever it begins with) reads as `fallback` and never as the text. */
export function statusFromNote(note: string | undefined | null, fallback: "request_finished" | "request_failed" = "request_finished"): MurageStatus {
  return statusFromLegacyNote(note) ?? status(fallback);
}
/** How a hand-off cancelled before it ran ended, as its receipt keeps it: one of the fixed lines Murage wrote, or plainly cancelled. Never
 * "finished": the owner's cancel, a deleted team, removed sharing or a closing project all read as cancelled. */
export function cancelledEnding(note: string | undefined | null): MurageStatus { return statusFromLegacyNote(note) ?? status("receipt_cancelled"); }

/** The same, with no line at all for a note it does not recognise. */
export function statusFromLegacyNote(note: string | undefined | null): MurageStatus | undefined {
  const text = (note ?? "").trim();
  for (const [pattern, make] of LEGACY_NOTES) if (pattern.test(text)) return make();
  return undefined;
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

