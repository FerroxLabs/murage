// Noticing a bot that is going in circles: the same tool call, the same
// arguments, again and again in one turn. Nothing watched for that, and
// it is the user's money. This only OBSERVES — it counts and says so; the
// human has Stop. Cutting a call off, or steering the model, needs the
// harness to own the call or to be able to speak mid-turn, neither of which
// is true for CLI drivers today (see plan items 3.2 / 3.3).

import { createHash } from "node:crypto";

import { appAction, isGenericTool } from "../shared/app-action-words.ts";
import { plainConnectedAppText } from "../shared/connected-app-tools.ts";

/** Tool name plus its arguments, whitespace-normalized. A bare tool name
 * is not a call worth counting: "Bash" five times may be five different
 * commands, and Claude's item.started carries only the name. */
export function callKey(tool: string, args: string | undefined): string | null {
  const a = (args ?? "").replace(/\s+/g, " ").trim();
  if (!a || a === tool) return null;
  return `${tool}:${a}`;
}

/** What a permission ask runs, as the engine reported it (server/contracts.ts request.opened). */
export interface RepeatAsk {
  tool: string;
  summary?: string;
  /** The engine's tool input as JSON text, when it reports one. */
  toolInput?: string;
  /** The engine's structured call, when it reports one. */
  toolCall?: { name: string; input: unknown };
}

function inputText(ask: RepeatAsk): string | undefined {
  if (ask.toolInput) return ask.toolInput;
  if (ask.toolCall?.input === undefined) return undefined;
  try { return JSON.stringify(ask.toolCall.input); } catch { return undefined; }
}

function inputObject(ask: RepeatAsk): unknown {
  if (ask.toolCall?.input !== undefined) return ask.toolCall.input;
  if (!ask.toolInput) return undefined;
  try { return JSON.parse(ask.toolInput); } catch { return undefined; }
}

/** A permission ask as a countable call: its target and its input. An engine
 * that files every connected-app ask under one title (ACP: kind "other",
 * title "murage_connectors__APPS_MULTI_EXECUTE_TOOL") is told apart by what
 * the call runs, so five different app actions are never "the same call". */
export function askCallKey(ask: RepeatAsk): string | null {
  const summary = ask.summary ?? "";
  // Only a bare identifier (the same rule item.started uses) says nothing about what runs: a command or a path is
  // already the call, and a model-written field beside it (Bash's "description") must not split a real loop.
  const bare = !/\s|\//.test(summary.trim());
  const input = bare ? inputText(ask) : undefined;
  return callKey(ask.tool, [summary, input ? boundedInput(input) : ""].filter(Boolean).join(" "));
}

/** The input part of a key, bounded so a thread's 256 keys stay small: short inputs as they are, longer ones by
 * their length and a digest of the whole text. */
const KEY_INPUT_MAX_CHARS = 2_048;
function boundedInput(input: string): string {
  if (input.length <= KEY_INPUT_MAX_CHARS) return input;
  return `${input.slice(0, 256)} #${input.length}:${createHash("sha256").update(input).digest("hex")}`;
}

/** The connected-app actions a call runs, by slug, in order of first use. */
function appSlugs(input: unknown): string[] {
  const rows = input && typeof input === "object" && !Array.isArray(input) ? (input as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(rows)) return [];
  const slugs: string[] = [];
  for (const row of rows) {
    const slug = row && typeof row === "object" ? (row as { tool_slug?: unknown }).tool_slug : undefined;
    if (typeof slug === "string" && slug.trim() && !slugs.includes(slug.trim())) slugs.push(slug.trim());
  }
  return slugs;
}

/** The call a repeat notice names, in words a person reads: the app action
 * ("Gmail: list drafts") or the plain connected-app wording, never a
 * service id, and a generic engine kind ("other") is left out. */
export function askCallLabel(ask: RepeatAsk): string {
  const slugs = appSlugs(inputObject(ask));
  const what = slugs.length
    ? slugs.map((slug) => { const said = appAction(slug); return said ? `${said.app}: ${said.action}` : slug; }).join(", ")
    : plainConnectedAppText((ask.summary ?? "").replace(/\s+/g, " ").trim());
  if (!what) return ask.tool;
  return isGenericTool(ask.tool) ? what : `${ask.tool}: ${what}`;
}

export class RepeatDetector {
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly thresholds: readonly number[];
  private readonly maxKeysPerThread: number;

  constructor(opts: { thresholds: readonly number[]; maxKeysPerThread?: number }) {
    this.thresholds = [...opts.thresholds].sort((a, b) => a - b);
    this.maxKeysPerThread = opts.maxKeysPerThread ?? 256;
    if (!Number.isInteger(this.maxKeysPerThread) || this.maxKeysPerThread < 1) {
      throw new Error("maxKeysPerThread must be a positive integer");
    }
  }

  /** Count one call. `threshold` is set exactly when the count lands on one. */
  record(threadId: string, key: string): { count: number; threshold?: number } {
    let per = this.counts.get(threadId);
    if (!per) this.counts.set(threadId, (per = new Map()));
    const previous = per.get(key);
    // Keep a bounded, recency-ordered set instead of retaining every unique
    // command an arbitrarily long turn ever issued. Existing keys move to
    // the back; when full, the least-recently-seen signature falls out.
    if (previous !== undefined) per.delete(key);
    else if (per.size >= this.maxKeysPerThread) per.delete(per.keys().next().value!);
    const count = (previous ?? 0) + 1;
    per.set(key, count);
    return this.thresholds.includes(count) ? { count, threshold: count } : { count };
  }

  /** The turn ended: a new turn starts its own count. */
  settle(threadId: string) {
    this.counts.delete(threadId);
  }
}
