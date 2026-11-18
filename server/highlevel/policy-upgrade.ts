// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ActionContext, ApprovalBasis, HighLevelActions } from './actions.ts';

type Upgrade = (actionId: string, basis: Exclude<ApprovalBasis, 'owner_exact_review'>, current: ActionContext) => void;
const upgrades = new WeakMap<HighLevelActions, Upgrade>();

/** Keep the native host's live-policy transition outside the frozen action API. */
export function registerHighLevelPolicyUpgrade(actions: HighLevelActions, upgrade: Upgrade): void {
  upgrades.set(actions, upgrade);
}
export function upgradeHighLevelAction(actions: HighLevelActions, actionId: string,
  basis: Exclude<ApprovalBasis, 'owner_exact_review'>, current: ActionContext): void {
  const upgrade = upgrades.get(actions);
  if (!upgrade) throw new Error('The HighLevel policy transition is unavailable.');
  upgrade(actionId, basis, current);
}
