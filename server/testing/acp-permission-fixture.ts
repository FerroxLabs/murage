// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive permission fixture owner: c4-misc-a. ACP session-fence producer owner: c3-drivers.
const permissionModes = new Set(['permission', 'permission-session-first', 'permission-edit-file', 'permission-always-only', 'question-tool']);

/** A positive permission fixture names the session actually opened by its fake
 * ACP peer. Raw and explicitly unbound peers keep exercising the real fence.
 * This peer connects the actual handed MCP servers and waits for all real
 * catalogs before its native readiness announcement. Model negotiation,
 * admission, authority and deadlines keep the production path.
 */
export function sessionBoundAcpPermissionEnvironment<T extends Record<string, string>>(environment: T) {
  if (!permissionModes.has(environment.FAKE_ACP_MODE)) throw new Error('fixture is not an ACP permission peer');
  return { ...environment,
    FAKE_ACP_PERMISSION_SESSION: environment.FAKE_ACP_PERMISSION_SESSION ?? '1',
    FAKE_ACP_MCP_CONNECT: environment.FAKE_ACP_MCP_CONNECT ?? '1',
    FAKE_ACP_MCP_READY: environment.FAKE_ACP_MCP_READY ?? '1',
    FAKE_ACP_MCP_READY_AFTER_LIST: environment.FAKE_ACP_MCP_READY_AFTER_LIST ?? '1',
  };
}
