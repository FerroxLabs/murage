/**
 * Durable payload on a learned-skill confirmation card.
 *
 * The agent stages a SKILL.md; none of the proposed bytes reach the bot's
 * enabled skill index until the user confirms this card. During an update,
 * the previously approved version stays live. Keeping the staged id on the
 * card lets confirmation survive a restart without asking the model again.
 */
export type SkillRequestAction = "create" | "update";

export interface SkillRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  stagedId: string;
  action: SkillRequestAction;
  name: string;
  gist: string;
  /** Human-readable provenance retained with the installed skill. Optional
   * while old persisted cards are still present in a user's transcript. */
  source?: string;
  /** Exact, secret-scrubbed SKILL.md shown as plain text before approval. */
  preview?: string;
  /** Binds approval to the exact bytes shown in preview. */
  sha256?: string;
  warnings: string[];
  createdAt: number;
}

/** The hash a current client may echo after it displayed the complete
 * proposal. Old cards deliberately return undefined and remain deny-only. */
export function reviewedSkillSha256(request: SkillRequestCardData): string | undefined {
  if (!request.preview || !request.sha256 || !/^[a-f0-9]{64}$/i.test(request.sha256)) return undefined;
  return request.sha256;
}

/** True when the displayed preview hashes (SHA-256 of its UTF-8 text) to the sha256 it carries. The phone runs
 * this before signing an approval of a skill request, so a preview altered in transit never gets a proof. A
 * card with no skill request is not this check's business and passes. */
export async function skillPreviewMatchesHash(card: { skillRequest?: unknown }): Promise<boolean> {
  const request = card.skillRequest as Partial<SkillRequestCardData> | null | undefined;
  if (!request || typeof request !== "object") return true;
  if (typeof request.preview !== "string" || typeof request.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(request.sha256)) return false;
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.preview)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") === request.sha256.toLowerCase();
}

/** Map the server-authored affirmative labels explicitly and fail closed for
 * anything else. This keeps new Update/Apply wording working without turning
 * an unknown or corrupted card answer into approval. */
export function skillRequestBehavior(answer: string): "allow" | "deny" {
  const normalized = answer.trim().toLowerCase();
  return ["enable", "update", "apply", "allow", "allow once", "confirm", "yes"].includes(normalized)
    ? "allow"
    : "deny";
}
