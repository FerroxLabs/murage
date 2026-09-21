// Short-lived OVERFLOW storage for the built-in agents tools. Not another
// history store, and not a redaction boundary: a tool result that fits inside
// the proxy's limit (server/drivers/agents-result.ts) never reaches this file
// at all, and is handed to the model exactly as the harness produced it. What
// lands here is only the part of an oversized result that would otherwise have
// been thrown away, so the model can page back to it instead of rerunning the
// action that produced it.
//
// Ownership is BOTH the bot and the conversation, taken from the live internal
// capability and never from a request body, so a room speaker or a sibling
// thread cannot read another turn's saved id even if it guesses one.
import { randomUUID } from "node:crypto";
import { redactSecretsInText } from "./redact.ts";

export const TOOL_RESULT_PREVIEW_CHARS = 16_000;
export const TOOL_RESULT_MAX_CHARS = 128 * 1024;
export const TOOL_RESULT_TTL_MS = 60 * 60_000;
const MAX_RESULTS = 128;
const MAX_RESULTS_PER_OWNER = 16;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_OWNER_BYTES = 2 * 1024 * 1024;

/** Slice without splitting a surrogate pair: a lone high surrogate at the cut
 * would be re-encoded as U+FFFD by anything downstream, and the offset the
 * notice hands back would then no longer line up with the saved text. */
export function toolResultPrefix(text: string, chars: number): string {
  const prefix = text.slice(0, chars);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

type Owner = { botId: string; threadId: string };
type SavedResult = Owner & { text: string; bytes: number; expiresAt: number; truncated: boolean };

/** Bounded in memory; lost on restart, expired after an hour, or evicted
 * oldest-first under pressure. Reads do not extend retention. The transcript
 * remains the durable record; this cache is only a way to page a large answer. */
export class ToolResults {
  private readonly results = new Map<string, SavedResult>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  private expire(): void {
    const now = this.now();
    for (const [id, result] of this.results) {
      if (result.expiresAt <= now) this.results.delete(id);
    }
  }

  save(owner: Owner, text: string, truncated = false) {
    this.expire();
    // Redact before taking the prefix, so a credential straddling the cut is
    // masked as a whole rather than half-saved. The proxy already redacted
    // what it sent; this pass covers the route being reached any other way.
    const redacted = redactSecretsInText(text);
    const bounded = toolResultPrefix(redacted, TOOL_RESULT_MAX_CHARS);
    const result = { botId: owner.botId, threadId: owner.threadId, text: bounded, bytes: Buffer.byteLength(bounded),
      expiresAt: this.now() + TOOL_RESULT_TTL_MS, truncated: truncated || bounded.length < redacted.length };
    const id = `r-${randomUUID()}`;
    this.results.set(id, result);
    // At most 129 entries are inspected here. Enforce the owner's limit
    // before the global one so one noisy thread does not evict its neighbours.
    for (const ownOnly of [true, false]) {
      const entries = [...this.results].filter(([, entry]) => !ownOnly ||
        (entry.botId === owner.botId && entry.threadId === owner.threadId));
      let bytes = entries.reduce((sum, [, entry]) => sum + entry.bytes, 0);
      let count = entries.length;
      for (const [oldId, entry] of entries) {
        if (bytes <= (ownOnly ? MAX_OWNER_BYTES : MAX_BYTES) && count <= (ownOnly ? MAX_RESULTS_PER_OWNER : MAX_RESULTS)) break;
        this.results.delete(oldId);
        bytes -= entry.bytes;
        count--;
      }
    }
    return { id, length: bounded.length, truncated: result.truncated, expiresAt: result.expiresAt };
  }

  read(owner: Owner, id: string, offset: number) {
    this.expire();
    const result = this.results.get(id);
    if (!result || result.botId !== owner.botId || result.threadId !== owner.threadId) return null;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > result.text.length) return null;
    // A supplied offset may point at the low half of a surrogate pair.
    const char = result.text.charCodeAt(offset);
    const start = char >= 0xdc00 && char <= 0xdfff ? Math.max(0, offset - 1) : offset;
    const text = toolResultPrefix(result.text.slice(start), TOOL_RESULT_PREVIEW_CHARS);
    return { id, text, offset: start, nextOffset: start + text.length, length: result.text.length,
      truncated: result.truncated, expiresAt: result.expiresAt };
  }
}
