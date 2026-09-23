// The note a call leaves in the conversation when it ends.
//
// A call is two layers, one bot: the voice host answers what it can and hands
// the rest to the engine. Handed-down work already lands in the thread as
// ordinary messages, but what the host answered on its own, and what it looked
// up, would otherwise exist only in the owner's memory of the call. This note
// is that record, so the next turn (and the owner scrolling back) starts from
// what was actually said.
//
// Deterministic on purpose: built from the call's own log, with no model in
// the loop, so the note cannot claim anything the call did not do.
import type { IncomingMessage, ServerResponse } from "node:http";

export const CALL_NOTE_PATH = /^\/api\/bots\/([\w-]+)\/call-note$/;

export type CallOutcome = "answered" | "looked_up" | "handed_down" | "engine" | "decision";

export interface CallLogEntry {
  said: string;
  outcome: CallOutcome;
  /** What was handed down or looked up, or the host's own answer. */
  detail?: string;
}

const MAX_ENTRIES = 40;
const MAX_CHARS = 400;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS - 1)}…` : flat}"`;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "1 min" : `${m} min`;
}

/** The note's text, or null when the call had nothing worth recording. */
export function callNoteText(log: CallLogEntry[], durationMs: number): string | null {
  const entries = log.filter((e) => e.said.trim()).slice(-MAX_ENTRIES);
  if (!entries.length) return null;
  const lines = [`**Call notes** (${minutes(durationMs)})`, ""];
  for (const e of entries) {
    const said = quote(e.said);
    if (e.outcome === "answered") lines.push(`- You said ${said}. Answered on the call${e.detail ? `: ${quote(e.detail)}` : "."}`);
    else if (e.outcome === "looked_up") lines.push(`- You said ${said}. Looked it up on the web${e.detail ? `: ${quote(e.detail)}` : "."}`);
    else if (e.outcome === "handed_down") lines.push(`- You said ${said}. Started as a task${e.detail ? `: ${quote(e.detail)}` : "."}`);
    else if (e.outcome === "decision") lines.push(`- You answered an approval: ${said}.`);
    else lines.push(`- You said ${said}. Sent as a message.`);
  }
  if (entries.some((e) => e.outcome === "handed_down" || e.outcome === "engine")) {
    lines.push("", "Anything started on the call continues in this conversation.");
  }
  return lines.join("\n");
}

export interface CallNoteDeps {
  bot(id: string): { id: string; threadId: string; tasks?: Array<{ threadId: string }> } | null;
  append(threadId: string, text: string): void;
  readBody(req: IncomingMessage): Promise<any>;
}

function parseLog(raw: unknown): CallLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const outcomes = new Set<CallOutcome>(["answered", "looked_up", "handed_down", "engine", "decision"]);
  const out: CallLogEntry[] = [];
  for (const entry of raw.slice(-MAX_ENTRIES)) {
    const said = typeof entry?.said === "string" ? entry.said.slice(0, 2_000) : "";
    const outcome = outcomes.has(entry?.outcome) ? (entry.outcome as CallOutcome) : null;
    if (!said.trim() || !outcome) continue;
    out.push({ said, outcome, detail: typeof entry?.detail === "string" ? entry.detail.slice(0, 2_000) : undefined });
  }
  return out;
}

/** Returns true when it handled the request. */
export async function handleCallNoteRoute(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: CallNoteDeps,
): Promise<boolean> {
  const match = path.match(CALL_NOTE_PATH);
  if (!match || method !== "POST") return false;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
    return true;
  };
  const body = await deps.readBody(req).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "body must be a JSON object" });
  const bot = deps.bot(match[1]);
  if (!bot) return send(404, { error: "no such bot" });
  const threadId = typeof body.threadId === "string" && /^[\w-]+$/.test(body.threadId) ? body.threadId : bot.threadId;
  if (threadId !== bot.threadId && !(bot.tasks ?? []).some((t) => t.threadId === threadId)) {
    return send(409, { error: "that task does not belong to this bot" });
  }
  const duration = Number(body.durationMs);
  const text = callNoteText(parseLog(body.log), Number.isFinite(duration) ? duration : 0);
  if (!text) return send(200, { ok: true, written: false });
  deps.append(threadId, text);
  return send(200, { ok: true, written: true });
}
