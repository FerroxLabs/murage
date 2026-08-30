/**
 * Durable payload on a learned-skill confirmation card.
 *
 * The agent stages a SKILL.md; nothing reaches the bot's enabled skill
 * index until the user confirms this card. Keeping the staged id on the
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
  warnings: string[];
  createdAt: number;
}
