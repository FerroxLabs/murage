// `POST /api/voice/cleanup`: tidy a finished dictation, or hand it back.
//
// Gated exactly like `POST /api/voice/transcribe` and registered beside it in
// the dispatcher: route-policy.ts class "conversation" (desktop surface proof,
// or the companion door for a phone), and both of the companion's allowlists.
// This file adds no gate of its own; it must not be reachable by anything the
// transcribe route is not.
//
// Never an error for a model failure: clean-up that cannot happen answers 200
// with the raw text and `cleaned: false`, because the caller has already
// stopped dictating and the words are the person's.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CleanupResult } from "./dictation-cleanup.ts";

export const CLEANUP_PATH = "/api/voice/cleanup";

/** The longest transcript this route will tidy. Two minutes of speech is
 *  about 400 words; this is generous and bounds what one call can spend. */
export const MAX_CLEANUP_CHARS = 8000;

/** Who the message is for, so the model knows the target and the names. */
export interface CleanupContext {
  botId?: string;
  groupId?: string;
}

export type CleanupRunner = (text: string, context: CleanupContext) => Promise<CleanupResult>;

/**
 * How many clean-ups one harness will run in a window. Shaped after the
 * transcribe clip budget (in memory, injectable clock) but far simpler: a
 * clean-up is one short text call, so a plain count is enough. A person
 * dictating cannot reach 60 a minute; a runaway client does.
 */
export const CLEANUP_BUDGET_MAX = 60;
export const CLEANUP_BUDGET_WINDOW_MS = 60_000;

export interface CleanupBudget {
  allow(now?: number): boolean;
}

export function createCleanupBudget(max = CLEANUP_BUDGET_MAX, windowMs = CLEANUP_BUDGET_WINDOW_MS): CleanupBudget {
  let at: number[] = [];
  return {
    allow(now = Date.now()) {
      at = at.filter((when) => when > now - windowMs);
      if (at.length >= max) return false;
      at.push(now);
      return true;
    },
  };
}

/** Over budget is not an error to the person: the raw text comes back. */
export function withBudget(run: CleanupRunner, budget: CleanupBudget): CleanupRunner {
  return (text, context) => (budget.allow() ? run(text, context) : Promise.resolve({ text, cleaned: false }));
}

export interface CleanupRouteDeps {
  run: CleanupRunner;
  readBody: (req: IncomingMessage) => Promise<unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const idOf = (value: unknown): string | undefined => (typeof value === "string" && /^[\w-]{1,128}$/.test(value) ? value : undefined);

export async function handleCleanupRoute(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: CleanupRouteDeps,
): Promise<boolean> {
  if (url.pathname !== CLEANUP_PATH) return false;
  if (method !== "POST") {
    res.setHeader("allow", "POST");
    json(res, 405, { error: "POST text to this route" });
    return true;
  }
  let body: { text?: unknown; botId?: unknown; groupId?: unknown } | null;
  try {
    body = (await deps.readBody(req)) as typeof body;
  } catch {
    json(res, 400, { error: "That request could not be read." });
    return true;
  }
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    json(res, 400, { error: "text is required" });
    return true;
  }
  if (text.length > MAX_CLEANUP_CHARS) {
    // Not an error the person can fix: give the words back untouched.
    json(res, 200, { text, cleaned: false });
    return true;
  }
  try {
    const result = await deps.run(text, { botId: idOf(body?.botId), groupId: idOf(body?.groupId) });
    json(res, 200, { text: result.text, cleaned: result.cleaned });
  } catch {
    json(res, 200, { text, cleaned: false });
  }
  return true;
}
