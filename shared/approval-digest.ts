/** What the owner reviews on an approval card, reduced to one SHA-256.
 * The page digests the card it rendered; the harness digests the live card.
 * A proof signs the harness's digest, so an Allow is bound to exactly what
 * was on screen (SEC-006, SEC-007). Field order is part of the contract:
 * add a field only with a new version tag (v2 has not shipped to a phone, so it was extended in place). */
export interface DigestCard {
  title?: unknown; subtitle?: unknown; tool?: unknown; summary?: unknown; held?: unknown;
  toolInputTruncated?: unknown; approvalScope?: unknown; taskAllowKey?: unknown;
  /** The displayed skill proposal: source, preview, sha256, name, action and warnings are bound. */
  skillRequest?: unknown;
  /** The displayed routine proposal: only its operation is bound. */
  routineRequest?: unknown;
  /** The displayed email card (BOT-EMAIL-MURAGE-109 4.3): its payload hash, held-id set and row revision are bound, so a phone Send proves
   *  the exact message. Appended only for email cards: every other card hashes exactly as before. */
  emailSend?: unknown;
}
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

const skillValue = (card: DigestCard, key: string): unknown => {
  const request = card.skillRequest;
  return request && typeof request === "object" ? (request as Record<string, unknown>)[key] : undefined;
};
const skillField = (card: DigestCard, key: "source" | "preview" | "sha256" | "name" | "action"): string | null => text(skillValue(card, key));
/** The warnings list as shown, or null when absent or not a list of strings. */
const skillWarnings = (card: DigestCard): string[] | null => {
  const list = skillValue(card, "warnings");
  return Array.isArray(list) && list.every((item) => typeof item === "string") ? (list as string[]) : null;
};

/** JSON with every object's keys sorted, so key order never moves the digest. */
function canonicalJson(value: unknown): string | null {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return value === undefined ? null : JSON.stringify(sort(value)) ?? null;
}
const routineOperation = (card: DigestCard): string | null => {
  const request = card.routineRequest;
  return request && typeof request === "object" ? canonicalJson((request as Record<string, unknown>).operation) : null;
};

const emailBinding = (card: DigestCard): [string | null, string[] | null, number | null] | null => {
  const email = card.emailSend;
  if (!email || typeof email !== "object") return null;
  const record = email as Record<string, unknown>;
  const held = Array.isArray(record.heldIds) && record.heldIds.every((id) => typeof id === "string") ? [...(record.heldIds as string[])].sort() : null;
  return [text(record.payloadHash), held, typeof record.revision === "number" ? record.revision : null];
};

export function approvalDigestInput(threadId: string, requestId: string, card: DigestCard): string {
  const email = emailBinding(card);
  return JSON.stringify([
    "murage-approval-digest/2", threadId, requestId,
    text(card.tool), text(card.title), text(card.subtitle), text(card.summary), text(card.held),
    card.toolInputTruncated === true, text(card.approvalScope), text(card.taskAllowKey),
    skillField(card, "source"), skillField(card, "preview"), skillField(card, "sha256"),
    skillField(card, "name"), skillField(card, "action"), skillWarnings(card), routineOperation(card),
    ...(email ? [email] : []),
  ]);
}

export async function approvalDigest(threadId: string, requestId: string, card: DigestCard): Promise<string> {
  const bytes = new TextEncoder().encode(approvalDigestInput(threadId, requestId, card));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** APPROVE-ALL (design 7.2): the reserved thread id an Approve all batch proof is held and signed under. No conversation
 *  may use it: both respond routes and the Approve all routes refuse it as a thread id. */
export const APPROVE_ALL_THREAD = "approve-all-batch";
/** One ticked card in a batch: its thread, its request and the card digest taken at preview. */
export type BatchLine = readonly [threadId: string, requestId: string, cardDigest: string];

/** What an Approve all batch proof signs: the batch id, the device that asked and exactly the ticked cards, each with the
 *  digest of the card as previewed. Sorted, so the order the cards were ticked in never moves the digest. Its tag differs
 *  from a card's (`murage-approval-digest/2`), so a batch digest can never equal a single card's. */
export function approvalBatchDigestInput(batchId: string, deviceId: string, lines: readonly BatchLine[]): string {
  const sorted = lines.map((line) => [line[0], line[1], line[2]] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return JSON.stringify(["murage-approval-batch/1", batchId, deviceId, sorted]);
}

export async function approvalBatchDigest(batchId: string, deviceId: string, lines: readonly BatchLine[]): Promise<string> {
  const bytes = new TextEncoder().encode(approvalBatchDigestInput(batchId, deviceId, lines));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
