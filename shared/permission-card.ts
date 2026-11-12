// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared by the SQL seam, guards, renderer and inventory. S0 contract. */
export const PERMISSION_CARD_KINDS = Object.freeze(['options'] as const);
export const PERMISSION_CARD_KEYS = Object.freeze([
  'requestId', 'publish', 'mcpEnable', 'emailSend', 'browserSetup',
  'routineRequest', 'skillRequest', 'folderTrust', 'approvalScope',
] as const);
export const CARD_TERMINAL_FIELDS = Object.freeze(['answered', 'answeredAt', 'dismissed', 'orphaned'] as const);
export const CARD_DISPLAY_FIELDS = Object.freeze(['title', 'subtitle', 'detail'] as const);
/** Queue producers must preserve the exact queue identity at this path. */
export const QUEUE_REF_PATHS = Object.freeze({
  email: '$.card.emailSend.sendId', routine: '$.card.routineRequest.id', publish: '$.card.publish.opId',
  skill: '$.card.skillRequest.id', mcp: '$.card.requestId', browser: '$.card.requestId',
  'host-computer': '$.card.requestId', peer: '$.card.requestId', 'event-limit': '$.card.requestId',
  image: '$.card.requestId', 'bot-access': '$.card.requestId', phone: '$.card.requestId',
  'room-share': '$.card.requestId', memory: '$.card.requestId', 'folder-trust': '$.card.requestId',
} as const);
/** The hash excludes mutable presentation fields and itself. Unknown fields
 * remain action-bearing. Canonical serialization and hashing belong to S1. */
export function actionProjection(card: Readonly<object>): Record<string, unknown> {
  const omitted = new Set<string>([...CARD_TERMINAL_FIELDS, ...CARD_DISPLAY_FIELDS, 'actionHash']);
  return Object.fromEntries(Object.entries(card).filter(([key]) => !omitted.has(key)));
}
