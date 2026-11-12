// SPDX-License-Identifier: AGPL-3.0-or-later
import { explicitNoLimits, inheritedPermissions, type PermissionSetting } from './permission-inheritance.ts';
export type NoLimitsOrigin = 'owner' | 'owner-channel' | 'routine' | 'owner-routine' | 'webhook' | 'unattended' | 'other' | 'guest' | 'other-human' | 'unproven';
/** Sean 2026-11-12 02:05/02:50Z and MAIN: external triggers use the bot's
 * effective level. Guests never inherit; a recorded 1.0.19+ No limits selection applies as set. Channel off wins. */
export function noLimitsAppliesTo(origin: NoLimitsOrigin | undefined, bot: (PermissionSetting & {fullAccessChannelMessages?:boolean}) | null | undefined): boolean {
 if (!bot || bot.draftOnly || !origin || origin === 'unproven') return false;
 if (origin === 'owner-channel' && bot.fullAccessChannelMessages === false) return false;
 const guest = origin === 'other' || origin === 'guest' || origin === 'other-human';
 if (guest) return explicitNoLimits(bot);
 const effective = inheritedPermissions(bot);
 return effective?.autoApprove === true && effective.fullAccess === true && effective.noLimits === true;
}
