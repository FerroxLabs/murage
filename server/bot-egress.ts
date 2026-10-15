// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one way a hand-off route answers a bot. A reply is built with `botBody` from fields whose types say what may be in them: words are
// released text or a Murage status, names come from a bot's record, the rest are numbers, flags and short codes. `sendBot` writes only a body
// that `botBody` made. The compile-time types stop a worker's string from getting here; the checks below stop one that was cast past them:
// a string is accepted only under the few keys that carry ids and codes, every `Outbound` is checked by its private field, and a body that was
// not built here is never written. In a test a violation throws. In the running app it is logged and the reader gets the withheld line, so the
// failure is closed, not open.
import type { ServerResponse } from "node:http";
import { EgressViolation, WorkerText, collectRendered, type EgressOrigin, type SourceRange } from "./released-text.ts";
import { MurageStatus, isOutbound, outboundCopy, outboundWords, status, type BotName, type Outbound } from "./murage-status.ts";
import { reviewReplyShown } from "./project-review.ts";
import type { Message } from "./store.ts";

declare const bodyBrand: unique symbol;
/** A reply body that `botBody` built and froze. */
export type BotBody = Readonly<Record<string, unknown>> & { readonly [bodyBrand]: true };
export interface BotReply { status: number; body: BotBody }

export interface BotBodyInput {
  botName?: BotName;
  toBotName?: BotName;
  text?: Outbound;
  error?: Outbound;
  message?: Outbound;
  note?: Outbound;
  result?: Outbound;
  recentActivity?: readonly Outbound[];
  code?: string;
  retry?: string;
  reason?: string;
  taskId?: string;
  status?: string;
  elapsed?: string;
  approvalOutcome?: "deny" | "expired" | "cancelled";
  approvalSource?: "user" | "system";
  busy?: boolean;
  queued?: boolean;
  done?: boolean;
  timeout?: boolean;
  waitedMs?: number;
  elapsedMs?: number;
}

/** The keys under which a plain string may appear: ids, codes and a name taken from a bot's record. */
const STRING_KEYS: ReadonlySet<string> = new Set(["taskId", "code", "status", "retry", "reason", "elapsed", "approvalOutcome", "approvalSource", "botName", "toBotName"]);

const bodies = new WeakSet<object>();
/** What each body's released words rest on: the bot it is written to is shown them, so they join its running turn's sources. */
export interface BodyShown { origins: EgressOrigin[]; ranges: SourceRange[] }
const shownIn = new WeakMap<object, BodyShown>();
type Writer = (res: ServerResponse, statusCode: number, body: unknown, shown?: BodyShown) => void;
let write: Writer | undefined;

/** The server's JSON writer, supplied once so this module never reaches into the server. `shown` is what the body's released words rest on
 * (server/steer-lineage.ts addShownToRunningTurn takes it into the calling bot's running turn). */
export function configureBotEgress(writer: Writer | undefined): void { write = writer; }

function testing(): boolean { return process.env.VITEST !== undefined || process.env.NODE_ENV === "test"; }

const WITHHELD = (): string => MurageStatus.words(status("withheld"));

function refuse(why: string): string {
  if (testing()) throw new EgressViolation(why);
  console.error(`bot-egress: ${why}; the reader gets the withheld line`);
  return WITHHELD();
}

function convert(value: unknown, key: string): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return STRING_KEYS.has(key) ? value : refuse(`a string under "${key}" cannot be written to a bot`);
  if (isOutbound(value)) return outboundWords(value);
  if (WorkerText.is(value)) return refuse(`worker words under "${key}" were not released`);
  if (Array.isArray(value)) return Object.freeze(value.map(item => convert(item, key)));
  return refuse(`an unrecognised value under "${key}" cannot be written to a bot`);
}

export function botBody(input: BotBodyInput): BotBody {
  const out: Record<string, unknown> = {};
  const built = collectRendered(() => {
    for (const [key, value] of Object.entries(input)) {
      const converted = convert(value, key);
      if (converted !== undefined) out[key] = converted;
    }
  });
  Object.freeze(out);
  bodies.add(out);
  if (built.origins.length || built.ranges.length) shownIn.set(out, { origins: built.origins, ranges: built.ranges });
  return out as BotBody;
}

/** What a body built here shows the bot it is written to (empty for one that quotes no released words). */
export function bodyShown(body: BotBody): BodyShown { return shownIn.get(body) ?? { origins: [], ranges: [] }; }

export function botReply(statusCode: number, input: BotBodyInput): BotReply { return { status: statusCode, body: botBody(input) }; }

/** Writes a body that `botBody` built. Anything else is a violation. */
export function sendBot(res: ServerResponse, statusCode: number, body: BotBody): void {
  let sent: BotBody = body;
  if (typeof body !== "object" || body === null || !bodies.has(body)) {
    if (testing()) throw new EgressViolation("a reply body was not built by botBody");
    console.error("bot-egress: a reply body was not built by botBody; the reader gets the withheld line");
    sent = botBody({ text: status("withheld") });
  }
  if (!write) throw new EgressViolation("the bot reply writer is not configured");
  const shown = shownIn.get(sent);
  write(res, statusCode, sent, shown);
}

// ── transcript sinks ────────────────────────────────────────────────────────────────────────────────
// A row that carries released words is written with the link to their originals, taken from the words themselves, so a copy without its link
// cannot be written. A row of Murage's own words carries none.

export interface RowStore { appendMessage(threadId: string, message: Omit<Message, "id" | "at">, id?: string): Message }
type RowExtras = Omit<Partial<Message>, "id" | "at" | "role" | "kind" | "text" | "tool" | "copyOf">;

const sinkStores = new WeakMap<object, RowStore>();
function appendRow(sink: RowSink, threadId: string, message: Omit<Message, "id" | "at">, id?: string): Message {
  const store = sinkStores.get(sink);
  if (!store) throw new EgressViolation("Not a row sink");
  return store.appendMessage(threadId, message, id);
}

/** The only handle the hand-off code has on the transcript's write side. It has no `appendMessage` and no `append` of its own, and the store it holds is
 * kept where only `writeBotRow` / `writeActivityRow` below can reach it: the first takes its link to the original from the released words themselves. */
export class RowSink {
  constructor(store: RowStore) { sinkStores.set(this, store); Object.freeze(this); }
}

/** A bot's text row (a worker's reply, or Murage's line quoting it). `reviewNonce`: the reply is a reviewer's, shown with its verdict block as one line. */
export function writeBotRow(sink: RowSink, threadId: string, extra: RowExtras, text: Outbound, reviewNonce?: string, id?: string): Message {
  const copy = outboundCopy(text);
  const words = outboundWords(text);
  return appendRow(sink, threadId, { ...extra, role: "bot", kind: "text", text: reviewNonce ? reviewReplyShown(words, reviewNonce) : words, ...(copy?.messageIds.length ? { copyOf: copy } : {}) } as Omit<Message, "id" | "at">, id);
}

/** An activity row whose name is Murage's own line. */
export function writeActivityRow(sink: RowSink, threadId: string, extra: RowExtras, name: Outbound, ok?: boolean, id?: string): Message {
  return appendRow(sink, threadId, { ...extra, role: "bot", kind: "activity", tool: { name: outboundWords(name), ...(ok === undefined ? {} : { ok }) } } as Omit<Message, "id" | "at">, id);
}
