// The push contract (apps/mobile/contract/push.json). No imports: the web UI,
// the harness and the relay Worker all load this file. The phone's twins are
// PushContract.swift and PushContract.java (Plan 3b C1).

export const PUSH_CATEGORIES = ["approval", "approval-open", "question", "done", "resolved"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];
export type PushKind = "approval" | "question" | "done" | "routine-failed" | "turn-failed" | "takeover" | "backup-waiting" | "memories-waiting";
export type PushRisk = "low" | "risky" | "unrated";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const EVENT_REF = /^[a-f0-9]{64}$/;
const COLLAPSE = /^[a-f0-9]{32}$/;
const GROUP = /^[a-f0-9]{16}$/;
const token = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
export const TOKEN_PATTERNS = {
  grant: token("murage_pg_"),
  publisher: token("murage_pt_"),
  deviceSecret: token("murage_ds_"),
  detail: token("murage_pd_"),
  respond: token("murage_pr_"),
} as const;

/** R2 and R4: a risky or unrated approval offers only Open and Deny; every
 *  other kind but "done" asks for a person and goes to Questions. */
export function pushCategory(kind: PushKind, risk: PushRisk): PushCategory {
  if (kind === "approval") return risk === "low" ? "approval" : "approval-open";
  if (kind === "done") return "done";
  return "question";
}

/** Held while you are at your desk (R5); "done" is dropped instead. */
export function isAttention(kind: PushKind): boolean {
  return kind !== "done";
}

export interface PushPayload {
  bindingId: string;
  eventRef: string;
  category: PushCategory;
  revision: number;
  workspaceBadge: number;
  collapseKey: string;
}
export interface RelayEvent extends PushPayload {
  threadGroup: string;
  timeSensitive: boolean;
  expiresAt: number;
}

const PAYLOAD_KEYS = ["bindingId", "category", "collapseKey", "eventRef", "revision", "workspaceBadge"];
const RELAY_KEYS = [...PAYLOAD_KEYS, "expiresAt", "threadGroup", "timeSensitive"].sort();
const MAX_INT = 2_147_483_647;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const int = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_INT;

function payloadFields(value: Record<string, unknown>): PushPayload | null {
  const { bindingId, eventRef, category, revision, workspaceBadge, collapseKey } = value;
  if (typeof bindingId !== "string" || !UUID.test(bindingId)) return null;
  if (typeof eventRef !== "string" || !EVENT_REF.test(eventRef)) return null;
  if (typeof category !== "string" || !(PUSH_CATEGORIES as readonly string[]).includes(category)) return null;
  if (!int(revision, 1) || !int(workspaceBadge, 0)) return null;
  if (typeof collapseKey !== "string" || !COLLAPSE.test(collapseKey)) return null;
  return { bindingId, eventRef, category: category as PushCategory, revision, workspaceBadge, collapseKey };
}

export function parsePushPayload(value: unknown): PushPayload | null {
  const object = record(value);
  return object && exactKeys(object, PAYLOAD_KEYS) ? payloadFields(object) : null;
}

export function parseRelayEvent(value: unknown): RelayEvent | null {
  const object = record(value);
  if (!object || !exactKeys(object, RELAY_KEYS)) return null;
  const payload = payloadFields(object);
  const { threadGroup, timeSensitive, expiresAt } = object;
  if (!payload || typeof threadGroup !== "string" || !GROUP.test(threadGroup) || typeof timeSensitive !== "boolean") return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { ...payload, threadGroup, timeSensitive, expiresAt };
}

export type RespondBody = { requestId: string; decision: "allow" | "deny"; revision: number };
export function parseRespondBody(value: unknown): RespondBody | null {
  const object = record(value);
  if (!object || !exactKeys(object, ["decision", "requestId", "revision"])) return null;
  const { requestId, decision, revision } = object;
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 256 || /[\u0000-\u001f\u007f]/.test(requestId)) return null;
  if (decision !== "allow" && decision !== "deny") return null;
  if (!int(revision, 1)) return null;
  return { requestId, decision, revision };
}

export type IssuedTokens = { bindingId: string; detail: string; respond: string; expiresAt: number };
export function parseIssueTokens(value: unknown): IssuedTokens | null {
  const object = record(value);
  if (!object || !exactKeys(object, ["bindingId", "detail", "expiresAt", "respond"])) return null;
  const { bindingId, detail, respond, expiresAt } = object;
  if (typeof bindingId !== "string" || !UUID.test(bindingId)) return null;
  if (typeof detail !== "string" || !TOKEN_PATTERNS.detail.test(detail)) return null;
  if (typeof respond !== "string" || !TOKEN_PATTERNS.respond.test(respond)) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { bindingId, detail, respond, expiresAt };
}

/** What Apple, Google and the relay may carry: no names, no content. The
 *  attention and completion sentences are applyNotificationPreferences'
 *  own, so previews-off and never-fetched read the same. */
export const GENERIC_TEXT: Record<PushCategory, { title: string; body: string }> = {
  approval: { title: "Murage", body: "Your attention is needed." },
  "approval-open": { title: "Murage", body: "Your attention is needed." },
  question: { title: "Murage", body: "Your attention is needed." },
  done: { title: "Murage", body: "A task has finished." },
  resolved: { title: "Murage", body: "No longer waiting." },
};

/** R6. */
export const RESOLVED_TEXT = { desktop: "Answered on desktop.", elsewhere: "Answered on another device.", expired: "No longer waiting.", dismissed: "No longer waiting." } as const;

/** How a request stopped waiting (B10): answered on the desk or on another
 *  device, or settled by nobody (it expired, or was dismissed). */
export type ResolvedBy = keyof typeof RESOLVED_TEXT;
