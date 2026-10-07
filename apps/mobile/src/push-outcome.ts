// What an answer from the host means on the phone's screen. A detail that
// is not exactly right is the generic text (spec §3.5 "Generic text is a
// complete, working outcome"). A respond answer becomes one local notice.
import { GENERIC, type PushCategory } from "./push-contract";

export type Notice = "approved" | "denied" | "stepUp" | "alreadyAnswered" | "unreachable" | "openApp";
export const NOTICE_TEXT: Record<Notice, { title: string; body: string }> = {
  approved: { title: "Murage", body: "Approved." },
  denied: { title: "Murage", body: "Denied." },
  stepUp: { title: "Murage", body: "Open Murage to allow this." },
  alreadyAnswered: { title: "Murage", body: "This was already answered." },
  unreachable: { title: "Murage", body: "Couldn't reach your Murage, open the app." },
  openApp: { title: "Murage", body: "Open Murage to answer this." },
};
export interface Target { threadId: string; messageId?: string; requestId?: string }

const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

export function detail(status: number | null, body: unknown, category: PushCategory): { title: string; body: string; target: Target | null } {
  const generic = { ...GENERIC[category], target: null };
  if (status !== 200 || !body || typeof body !== "object") return generic;
  const b = body as { title?: unknown; body?: unknown; target?: { threadId?: unknown; messageId?: unknown; requestId?: unknown } };
  if (typeof b.title !== "string" || b.title.length < 1 || b.title.length > 200) return generic;
  if (typeof b.body !== "string" || b.body.length > 2000) return generic;
  if (!b.target || !id(b.target.threadId)) return generic;
  const target: Target = { threadId: b.target.threadId };
  if (id(b.target.messageId)) target.messageId = b.target.messageId;
  if (id(b.target.requestId)) target.requestId = b.target.requestId;
  return { title: b.title, body: b.body, target };
}

export function notice(status: number | null, body: unknown, decision: "allow" | "deny"): Notice {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  if (status === null || status >= 500) return "unreachable";
  if (status === 200) {
    const outcome = (body as { outcome?: unknown } | null)?.outcome;
    if (outcome === "unavailable") return "openApp";
    return decision === "allow" ? "approved" : "denied";
  }
  if (status === 403 && code === "step_up") return "stepUp";
  if (status === 409 && code === "already_answered") return "alreadyAnswered";
  return "openApp";
}
