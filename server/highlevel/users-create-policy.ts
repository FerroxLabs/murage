// SPDX-License-Identifier: AGPL-3.0-or-later
/** MAIN alone enables this after an authorized live recipient access check. */
export function usersCreateRecipientVerified(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HL_USERSCREATE_RECIPIENT_VERIFIED === 'true';
}
export const USER_CREATE_HANDOFF = 'Add this user in HighLevel to finish setting up their access.';
export const USER_CREATE_OPEN = 'Open HighLevel';
export const USER_CREATE_URL = 'https://app.gohighlevel.com/';
