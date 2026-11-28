// Final gate/primitive owner: skills lane. Durable begin/receipt owner: decision lane.
import { checkSkillSwitchSnapshot, type SwitchInput } from './skill-switch.ts';
import { readSkillSwitchTarget, prepareSkillSwitch, applySkillSwitchTarget } from './skills.ts';
import { automaticSettlement, SkillSwitchRefused, type OwnerSettlementToken, type SkillDeliveryContext } from './skill-switch-settlement.ts';
import type { PendingQueueApproval } from './decision/types.ts';

export interface SkillOwnerProof {
  validate(token: OwnerSettlementToken, item: PendingQueueApproval): boolean;
  consume(token: OwnerSettlementToken, item: PendingQueueApproval): string | undefined;
}
export function inspectSkillSwitch(botId: string, input: SwitchInput) {
  const target = readSkillSwitchTarget(botId, input.name);
  const refusal = checkSkillSwitchSnapshot(target?.listing, input);
  if (!target || refusal)
    throw new SkillSwitchRefused('changed', refusal ?? 'The skill changed after the request. Nothing was changed.');
  const previewHash = target.previewSha256;
  if (previewHash !== input.previewSha256) throw new SkillSwitchRefused('changed', 'The skill changed after the request. Nothing was changed.');
  return target;
}

/** Every queued and immediate automatic mutation uses this same synchronous boundary. */
export function createSkillSwitchExecutor(proof: SkillOwnerProof, policy: {
  automatic(item: PendingQueueApproval, cause: string): boolean;
  owner(item: PendingQueueApproval): boolean;
}) {
  return (botId: string, input: SwitchInput, delivery?: SkillDeliveryContext): void => {
    if (!delivery || delivery.item.call.input !== input && JSON.stringify(delivery.item.call.input) !== JSON.stringify(input))
      throw new SkillSwitchRefused('unauthorized', 'The registered skill delivery is unavailable. Nothing was changed.');
    const target = inspectSkillSwitch(botId, input);
    const settlement = delivery.settlement ?? automaticSettlement();
    const owner = settlement.kind === 'owner' && proof.validate(settlement.token, delivery.item) && policy.owner(delivery.item);
    const automatic = () => policy.automatic(delivery.item, settlement.kind === 'automatic' ? settlement.cause : 'unspecified');
    if (!owner && !automatic()) throw new SkillSwitchRefused('unauthorized', 'This skill change needs a current permission. Nothing was changed.');
    if (!owner && (target.listing.scan?.verdict === 'review' || input.action === 'turn_on' && target.listing.scan?.verdict !== 'clean'))
      throw new SkillSwitchRefused('needs-review', 'This skill needs review in Skills. Nothing was changed.');
    if (input.action === 'turn_on' && target.listing.scan?.verdict === 'blocked')
      throw new SkillSwitchRefused('needs-review', 'This skill is blocked. Nothing was changed.');
    prepareSkillSwitch(target, input.action);
    delivery.beginEffect(owner ? {kind:'owner',principal:'owner'} : {kind:'automatic',cause:settlement.kind === 'automatic' ? settlement.cause : 'unspecified'});
    // The barrier is synchronous. Recheck live authority, consume, and enter the primitive without an await.
    if (owner) {
      if (settlement.kind !== 'owner' || !policy.owner(delivery.item) || !proof.consume(settlement.token, delivery.item))
        throw new Error('The owner response expired before execution.');
    } else if (!automatic()) throw new Error('The skill permission changed before execution.');
    applySkillSwitchTarget(target, input.action, owner && input.action === 'turn_on' ? {acknowledged:target.listing.scan!.contentHash} : {});
  };
}
