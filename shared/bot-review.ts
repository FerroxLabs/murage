import type { DigestCard } from './approval-digest.ts';
import type { ModelSelection } from '../server/contracts.ts';
import type { StagedBot, PendingBotRevision } from '../server/bot-staging-types.ts';
export interface BotReviewSpec {
  id: string; name: string; role: string; instructions: string; modelSelection: ModelSelection;
  section: string; lead: boolean; archived: boolean; autoApprove: boolean; fullAccess: boolean; noLimits: boolean;
  alwaysAllow: string[];
  tasks: Array<{ threadId: string; autoApprove: boolean; fullAccess: boolean; noLimits: boolean; alwaysAllow: string[] }>;
  staged: StagedBot | null; pendingRevision: PendingBotRevision | null;
}
export interface BotReviewView { spec: BotReviewSpec; digest: string; surface: string }
/** Both sides bind the exact displayed item digests through the existing attested approval protocol. */
export function botReviewCard(items: ReadonlyArray<{ id: string; digest: string }>): DigestCard {
  return { title: 'Review bots', tool: 'Activate reviewed bots', summary: JSON.stringify(items.map(({ id, digest }) => ({ id, digest }))), toolInputTruncated: false };
}
