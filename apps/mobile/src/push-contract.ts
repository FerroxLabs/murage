// The phone's reading of the push contract (apps/mobile/contract/push.json),
// the oracle PushContract.swift and PushContract.java are held to.
import features from "../contract/push-features.json";

export const PUSH_CONTRACT_VERSION = 2;
export type PushCategory = "approval" | "approval-open" | "question" | "done" | "resolved" | "device-job" | "call" | "call-note";
/** expiresAt is present exactly on the call kinds (contract v2). */
export interface PushPayload { bindingId: string; eventRef: string; category: PushCategory; revision: number; workspaceBadge: number; collapseKey: string; expiresAt?: number }
export interface Issued { bindingId: string; detail: string; respond: string; expiresAt: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF = /^[a-f0-9]{64}$/;
const COLLAPSE = /^[a-f0-9]{32}$/;
const GROUP = /^[a-f0-9]{16}$/;
const CATEGORIES: readonly string[] = ["approval", "approval-open", "question", "done", "resolved", "device-job", "call", "call-note"];
export const EXPIRING_CATEGORIES: readonly string[] = ["call", "call-note"];
export const isExpiringCategory = (category: string): boolean => EXPIRING_CATEGORIES.includes(category);
/** The ring's sound, bundled by each app: about 10 s. */
export const CALL_SOUND = { ios: "murage-call.caf", android: "murage_call", seconds: 10 } as const;
/** Calls break through a focus mode (iOS interruption-level time-sensitive). */
export const isTimeSensitive = (category: string): boolean => category === "call";
const KEYS = "bindingId,category,collapseKey,eventRef,revision,workspaceBadge";
const MAX = 2_147_483_647;

export const IOS_CATEGORY: Record<PushCategory, string> = { approval: "APPROVAL", "approval-open": "APPROVAL_OPEN", question: "QUESTION", done: "DONE", resolved: "DONE", "device-job": "DEVICE_JOB", call: "CALL", "call-note": "CALL_NOTE" };
export const IOS_ACTIONS: Record<string, { id: string; title: string; options: string[] }[]> = {
  CALL: [
    { id: "ANSWER", title: "Answer", options: ["foreground", "authenticationRequired"] },
    { id: "NOT_NOW", title: "Not now", options: ["authenticationRequired"] },
  ],
};
export const ANDROID_CHANNEL: Record<PushCategory, string> = { approval: "approvals", "approval-open": "approvals", question: "questions", done: "finished", resolved: "finished", "device-job": "requests", call: "calls_v2", "call-note": "questions" };
export const GENERIC: Record<PushCategory, { title: string; body: string }> = {
  approval: { title: "Murage", body: "Your attention is needed." },
  "approval-open": { title: "Murage", body: "Your attention is needed." },
  question: { title: "Murage", body: "Your attention is needed." },
  done: { title: "Murage", body: "A task has finished." },
  resolved: { title: "Murage", body: "No longer waiting." },
  "device-job": { title: "Murage", body: "A bot is asking to use your phone" },
  call: { title: "Murage is calling", body: "Answer to hear what it is." },
  "call-note": { title: "Murage", body: "Murage has a message for you." },
};
export const FEATURES: { richText: boolean; lockScreenActions: boolean } = features;

function fields(o: Record<string, unknown>, revision: unknown, badge: unknown, expiresAt?: unknown): PushPayload | null {
  const { bindingId, eventRef, category, collapseKey } = o;
  if (typeof bindingId !== "string" || !UUID.test(bindingId) || typeof eventRef !== "string" || !REF.test(eventRef)) return null;
  if (typeof category !== "string" || !CATEGORIES.includes(category) || typeof collapseKey !== "string" || !COLLAPSE.test(collapseKey)) return null;
  const int = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX;
  if (!int(revision, 1) || !int(badge, 0)) return null;
  const base = { bindingId, eventRef, category: category as PushCategory, revision: revision as number, workspaceBadge: badge as number, collapseKey };
  if (!isExpiringCategory(category)) return base;
  return typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > 0 ? { ...base, expiresAt } : null;
}

const keysFor = (category: unknown, extra = ""): string =>
  [...KEYS.split(","), ...(typeof category === "string" && isExpiringCategory(category) ? ["expiresAt"] : []), ...(extra ? [extra] : [])].sort().join(",");

export function parsePayload(v: unknown): PushPayload | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== keysFor(o.category)) return null;
  return fields(o, o.revision, o.workspaceBadge, o.expiresAt);
}

/** FCM data values are strings: a plain decimal with no sign or leading zero. */
export function parseFcmData(d: Record<string, string>): (PushPayload & { threadGroup: string }) | null {
  if (Object.keys(d).sort().join(",") !== keysFor(d.category, "threadGroup")) return null;
  const num = (s: string) => (/^(0|[1-9][0-9]{0,9})$/.test(s) ? Number(s) : NaN);
  // expiresAt is a decimal string: no sign, no leading zero, within a safe integer.
  const stamp = (s: unknown) => (typeof s === "string" && /^[1-9][0-9]{0,15}$/.test(s) ? Number(s) : NaN);
  const payload = fields(d, num(d.revision), num(d.workspaceBadge), stamp(d.expiresAt));
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

/** What a phone does with a call-kind push (contract v2 `callDisplay`): an
 *  expired ring or note is silent, and a resolution for a collapse key the
 *  phone is not showing is silent too. */
export type CallDisplayAction = "ring" | "show" | "replace" | "silent";
export function callDisplayAction(payload: PushPayload, now: number, shown: readonly string[]): CallDisplayAction {
  if (payload.category === "resolved") return shown.includes(payload.collapseKey) ? "replace" : "silent";
  if (payload.expiresAt !== undefined && now >= payload.expiresAt) return "silent";
  return payload.category === "call" ? "ring" : "show";
}
