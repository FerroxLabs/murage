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

export function approvalDigestInput(threadId: string, requestId: string, card: DigestCard): string {
  return JSON.stringify([
    "murage-approval-digest/2", threadId, requestId,
    text(card.tool), text(card.title), text(card.subtitle), text(card.summary), text(card.held),
    card.toolInputTruncated === true, text(card.approvalScope), text(card.taskAllowKey),
    skillField(card, "source"), skillField(card, "preview"), skillField(card, "sha256"),
    skillField(card, "name"), skillField(card, "action"), skillWarnings(card), routineOperation(card),
  ]);
}

export async function approvalDigest(threadId: string, requestId: string, card: DigestCard): Promise<string> {
  const bytes = new TextEncoder().encode(approvalDigestInput(threadId, requestId, card));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
