// The phone's reading of the push contract (apps/mobile/contract/push.json),
// the oracle PushContract.swift and PushContract.java are held to.
import features from "../contract/push-features.json";

export type PushCategory = "approval" | "approval-open" | "question" | "done" | "resolved";
export interface PushPayload { bindingId: string; eventRef: string; category: PushCategory; revision: number; workspaceBadge: number; collapseKey: string }
export interface Issued { bindingId: string; detail: string; respond: string; expiresAt: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF = /^[a-f0-9]{64}$/;
const COLLAPSE = /^[a-f0-9]{32}$/;
const GROUP = /^[a-f0-9]{16}$/;
const CATEGORIES: readonly string[] = ["approval", "approval-open", "question", "done", "resolved"];
const KEYS = "bindingId,category,collapseKey,eventRef,revision,workspaceBadge";
const MAX = 2_147_483_647;

export const IOS_CATEGORY: Record<PushCategory, string> = { approval: "APPROVAL", "approval-open": "APPROVAL_OPEN", question: "QUESTION", done: "DONE", resolved: "DONE" };
export const ANDROID_CHANNEL: Record<PushCategory, string> = { approval: "approvals", "approval-open": "approvals", question: "questions", done: "finished", resolved: "finished" };
export const GENERIC: Record<PushCategory, { title: string; body: string }> = {
  approval: { title: "Murage", body: "Your attention is needed." },
  "approval-open": { title: "Murage", body: "Your attention is needed." },
  question: { title: "Murage", body: "Your attention is needed." },
  done: { title: "Murage", body: "A task has finished." },
  resolved: { title: "Murage", body: "No longer waiting." },
};
export const FEATURES: { richText: boolean; lockScreenActions: boolean } = features;

function fields(o: Record<string, unknown>, revision: unknown, badge: unknown): PushPayload | null {
  const { bindingId, eventRef, category, collapseKey } = o;
  if (typeof bindingId !== "string" || !UUID.test(bindingId) || typeof eventRef !== "string" || !REF.test(eventRef)) return null;
  if (typeof category !== "string" || !CATEGORIES.includes(category) || typeof collapseKey !== "string" || !COLLAPSE.test(collapseKey)) return null;
  const int = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX;
  if (!int(revision, 1) || !int(badge, 0)) return null;
  return { bindingId, eventRef, category: category as PushCategory, revision: revision as number, workspaceBadge: badge as number, collapseKey };
}

export function parsePayload(v: unknown): PushPayload | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== KEYS) return null;
  return fields(o, o.revision, o.workspaceBadge);
}

/** FCM data values are strings: a plain decimal with no sign or leading zero. */
export function parseFcmData(d: Record<string, string>): (PushPayload & { threadGroup: string }) | null {
  if (Object.keys(d).sort().join(",") !== `${KEYS},threadGroup`.split(",").sort().join(",")) return null;
  const num = (s: string) => (/^(0|[1-9][0-9]{0,9})$/.test(s) ? Number(s) : NaN);
  const payload = fields(d, num(d.revision), num(d.workspaceBadge));
  return payload && GROUP.test(d.threadGroup) ? { ...payload, threadGroup: d.threadGroup } : null;
}

export function parseIssued(v: unknown): Issued | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "bindingId,detail,expiresAt,respond") return null;
  const { bindingId, detail, respond, expiresAt } = o;
  if (typeof bindingId !== "string" || !UUID.test(bindingId)) return null;
  if (typeof detail !== "string" || !/^murage_pd_[A-Za-z0-9_-]{43}$/.test(detail)) return null;
  if (typeof respond !== "string" || !/^murage_pr_[A-Za-z0-9_-]{43}$/.test(respond)) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { bindingId, detail, respond, expiresAt };
}
