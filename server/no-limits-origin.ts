// SPDX-License-Identifier: AGPL-3.0-or-later
import { inheritedPermissions, permissionsForOrigin, type PermissionSetting } from './permission-inheritance.ts';
export const CHANNEL_MESSAGES_OFF = 'Channel messages are off; turn them on in this bot’s Permissions → Channel messages.';
export type NoLimitsOrigin = 'owner' | 'owner-channel' | 'routine' | 'owner-routine' | 'webhook' | 'unattended' | 'other' | 'guest' | 'other-human' | 'unproven';
/** Sean 2026-11-12 02:05/02:50Z and MAIN: external triggers use the bot's
 * effective level. Sean 12:40Z: guests and other-person threads always remain Ask. Channel off wins. */
/** Trigger kind does not lower a bot's level. Resolve the live default before
 * applying an explicit routine ceiling or checking the audience. */
export function permissionsForNoLimitsOrigin<T extends PermissionSetting>(origin: NoLimitsOrigin | undefined, bot:T):T {
 const effective = inheritedPermissions(bot);
 // Preserve legacy lower-level trigger behavior after resolving the default.
 // A No limits record, including revision zero, never takes this downgrade.
 const external = origin === 'webhook' || origin === 'unattended' || origin === 'routine';
 if (external && effective.noLimits !== true && effective.fullAccess === true
   && effective.permissionExplicit === undefined && (effective.permissionRev ?? 0) === 0)
  return permissionsForOrigin(effective, false);
 return effective;
}
export function noLimitsAppliesTo(origin: NoLimitsOrigin | undefined, bot: (PermissionSetting & {fullAccessChannelMessages?:boolean}) | null | undefined): boolean {
 if (!bot || bot.draftOnly || !origin || origin === 'unproven') return false;
 if (origin === 'owner-channel' && bot.fullAccessChannelMessages === false) return false;
 const guest = origin === 'other' || origin === 'guest' || origin === 'other-human';
 if (guest) return false;
 const effective = permissionsForNoLimitsOrigin(origin,bot);
 // A legacy routine tag alone is not an owner-selected or resolved ceiling.
 // Dispatch projections and inherited owner defaults carry an explicit marker.
 if (origin === 'routine' && effective.permissionExplicit === undefined) return false;
 return effective?.autoApprove === true && effective.fullAccess === true && effective.noLimits === true;
}

/** Test channel-off against the audience's effective level before applying the
 * switch itself. Guests and task-only Ask keep their ordinary channel route. */
export function noLimitsChannelMessagesOff(origin: NoLimitsOrigin, bot: (PermissionSetting & {fullAccessChannelMessages?:boolean}) | null | undefined): boolean {
 return bot?.fullAccessChannelMessages === false && noLimitsAppliesTo(origin, {...bot, fullAccessChannelMessages: true});
}
