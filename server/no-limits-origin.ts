// SPDX-License-Identifier: AGPL-3.0-or-later
import { explicitNoLimits, inheritedPermissions, permissionsForOrigin, type PermissionSetting } from './permission-inheritance.ts';
export const CHANNEL_MESSAGES_OFF = 'Channel messages are off; turn them on in this bot’s Permissions → Channel messages.';
export type NoLimitsOrigin = 'owner' | 'owner-channel' | 'routine' | 'owner-routine' | 'webhook' | 'unattended' | 'other' | 'guest' | 'other-human' | 'unproven';
/** Sean 2026-11-12 02:05/02:50Z and MAIN: external triggers use the bot's
 * effective level. Guests never inherit; a recorded 1.0.19+ No limits selection applies as set. Channel off wins. */
/** Stored 1.0.18 Full access flags do not prove an owner choice for a trigger.
 * Inheritance is resolved before any routine projection can stamp a level. */
export function permissionsForNoLimitsOrigin<T extends PermissionSetting>(origin: NoLimitsOrigin | undefined, bot:T):T {
 const external=origin==='webhook'||origin==='unattended'||origin==='routine'||origin==='owner-routine';
 if(external && bot.fullAccess===true && bot.permissionExplicit===undefined && (bot.permissionRev??0)===0)
  return permissionsForOrigin(bot,false);
 return inheritedPermissions(bot);
}
export function noLimitsAppliesTo(origin: NoLimitsOrigin | undefined, bot: (PermissionSetting & {fullAccessChannelMessages?:boolean}) | null | undefined): boolean {
 if (!bot || bot.draftOnly || !origin || origin === 'unproven') return false;
 if (origin === 'owner-channel' && bot.fullAccessChannelMessages === false) return false;
 const guest = origin === 'other' || origin === 'guest' || origin === 'other-human';
 if (guest) return explicitNoLimits(bot);
 const effective = permissionsForNoLimitsOrigin(origin,bot);
 return effective?.autoApprove === true && effective.fullAccess === true && effective.noLimits === true;
}
