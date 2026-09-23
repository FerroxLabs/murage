// Work handed down from a call, and what became of it.
//
// The host is a chat model: it knows only what its messages say. Before this
// file, a hand-down reached it as whatever it had said aloud ("Let me look
// into that"), so a refused send, a failed engine turn or a finished answer
// looked the same as work under way, and "are you doing it?" was handed down
// again. LiveKit Agents and Pipecat both solve this the same way: every
// background tool call stays in the model's context as a tool call with a
// result that carries its live status (running / failed / done / cancelled),
// and a running call says, in its result, not to call it again. This is that,
// for Murage's hand-downs: the call screen reports what it knows (sent,
// refused, cancelled) and the harness fills in the rest from the thread.
import type { Message } from "../store.ts";

/** What the call screen knows about one hand-down. */
export interface HandDown {
  id: string;
  request: string;
  /** When the call screen sent it (ms). */
  at: number;
  /** "sending" until the harness answers the send. */
  state: "sending" | "accepted" | "refused" | "cancelled";
  /** Why a send was refused, in plain words. */
  reason?: string;
}

export type HandDownStatus =
  | { kind: "starting" }
  | { kind: "running"; steps: string[] }
  | { kind: "failed"; reason: string }
  | { kind: "done"; answer: string }
  | { kind: "cancelled" };

/** The longest finished answer handed back to the host in full. */
export const ANSWER_MAX_CHARS = 12_000;

export function parseHandDowns(raw: unknown): HandDown[] {
  if (!Array.isArray(raw)) return [];
  const out: HandDown[] = [];
  for (const entry of raw.slice(-12)) {
    const id = typeof entry?.id === "string" && /^[\w-]{1,64}$/.test(entry.id) ? entry.id : "";
    const request = typeof entry?.request === "string" ? entry.request.trim().slice(0, 2_000) : "";
    const at = typeof entry?.at === "number" && Number.isFinite(entry.at) ? entry.at : 0;
    const state = ["sending", "accepted", "refused", "cancelled"].includes(entry?.state) ? entry.state : "sending";
    if (!id || !request) continue;
    out.push({ id, request, at, state, reason: typeof entry?.reason === "string" ? entry.reason.slice(0, 400) : undefined });
  }
  return out;
}

const failedStep = (m: Message) => m.kind === "activity" && m.tool?.ok === false && /^error:/i.test(m.tool.name ?? "");

/**
 * What became of `handDown`, read from the conversation. The request is the
 * owner's message it became (same text, sent no earlier than the hand-down);
 * everything the bot wrote after it, up to the owner's next message, is its
 * outcome.
 */
export function handDownStatus(handDown: HandDown, path: Message[], busy: boolean): HandDownStatus {
  if (handDown.state === "refused") return { kind: "failed", reason: handDown.reason || "the request was refused" };
  if (handDown.state === "cancelled") return { kind: "cancelled" };
  const request = handDown.request.trim();
  let start = -1;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const m = path[i];
    if (m.role === "user" && m.kind === "text" && m.text?.trim() === request && m.at >= handDown.at - 10_000) {
      start = i;
      break;
    }
  }
  if (start < 0) return { kind: "starting" };
  let end = path.length;
  for (let i = start + 1; i < path.length; i += 1) {
    if (path[i].role === "user" && path[i].kind === "text") {
      end = i;
      break;
    }
  }
  const after = path.slice(start + 1, end);
  const failure = [...after].reverse().find(failedStep);
  const answer = [...after].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
  const last = after.at(-1);
  // still going: the running turn is this one (nothing newer from the owner)
  if (busy && end === path.length) {
    const steps = after
      .filter((m) => m.kind === "activity" && m.tool && !failedStep(m))
      .map((m) => m.tool!.spoken || m.tool!.summary || m.tool!.name)
      .filter(Boolean)
      .slice(-6);
    return { kind: "running", steps };
  }
  if (failure && (!answer || (last && failedStep(last)))) {
    return { kind: "failed", reason: failure.tool!.errorDetails || failure.tool!.name.replace(/^error:\s*/i, "") };
  }
  if (answer?.text) {
    const text = answer.text.trim();
    return { kind: "done", answer: text.length > ANSWER_MAX_CHARS ? `${text.slice(0, ANSWER_MAX_CHARS - 1)}…` : text };
  }
  return { kind: "running", steps: [] };
}

/** The tool result the host reads for a hand-down. The running wording is
 *  Pipecat's (async_tool_messages.py): it names the failure it prevents. */
export function handDownResult(status: HandDownStatus): string {
  switch (status.kind) {
    case "starting":
      return "Sent to your working self; it has not started yet. Do not hand it down again.";
    case "running":
      return [
        "This work is still running. You will be given its result later. Do not hand it down again and do not invent a result in the meantime.",
        status.steps.length ? `Steps so far (the only progress you may mention): ${status.steps.join("; ")}.` : "No steps reported yet.",
      ].join(" ");
    case "failed":
      return `This failed and nothing is running for it: ${status.reason.split("\n")[0]} Tell the owner plainly if they ask. If they ask for it again, news and plain facts go to quick_lookup; other work is handed down again only when they ask you to try again.`;
    case "cancelled":
      return "The owner cancelled this. Nothing is running for it.";
    case "done":
      return `Finished. Your working self's answer, as written in the chat:\n${status.answer}`;
  }
}

/** Two requests are the same work when most of their words are shared. */
export function sameRequest(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}
