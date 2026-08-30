/**
 * Durable payload on a learned-skill confirmation card.
 *
 * The agent stages a SKILL.md; nothing reaches the bot's enabled skill
 * index until the user confirms this card. Keeping the staged id on the
 * card lets confirmation survive a restart without asking the model again.
 */
export type SkillRequestAction = "create";

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
