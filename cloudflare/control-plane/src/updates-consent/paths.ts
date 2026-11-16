// Updates consent paths (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1, 4.1 and 4.2). No imports, so customer-identity.ts can read them.
export const UPDATES_BASE = "/v1/updates-consent";
export const MEMBERS_HISTORY_ROUTE = `${UPDATES_BASE}/history`;
/** The two member paths (Cloud scope, Supabase bearer). The anonymous paths under UPDATES_BASE/ are not member paths. */
export const isUpdatesMembersPath = (path: string): boolean => path === UPDATES_BASE || path === MEMBERS_HISTORY_ROUTE;
/** The member paths whose GET resolves the account read-only (resolveCloudAccountReadOnly, 4.2). */
export const isUpdatesMembersReadOnly = (method: string, path: string): boolean => method === "GET" && isUpdatesMembersPath(path);
