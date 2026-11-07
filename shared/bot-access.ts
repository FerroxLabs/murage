import { z } from "zod";
/** Reviewed finite catalog. Restricted mode never infers safety from a tool name. */
export const CONNECTED_APP_TOOLS = [
  { toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS", label: "Read emails", writes: false },
  { toolkit: "gmail", tool: "GMAIL_GET_PROFILE", label: "Read account profile", writes: false },
  { toolkit: "gmail", tool: "GMAIL_SEND_EMAIL", label: "Send email", writes: true },
  { toolkit: "slack", tool: "SLACK_SEND_MESSAGE", label: "Send Slack message", writes: true },
  { toolkit: "googlecalendar", tool: "GOOGLECALENDAR_LIST_EVENTS", label: "Read calendar events", writes: false },
] as const;
/** Requests are review proposals, not standing grants. The server binds a fixed
 * review window; legacy proposals without expiresAt use createdAt + this TTL. */
export const ACCESS_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export function accessRequestExpiresAt(request: { createdAt: number; expiresAt?: number }): number {
  return Math.min(request.expiresAt ?? Infinity, request.createdAt + ACCESS_REQUEST_TTL_MS);
}
export function accessRequestExpired(request: { createdAt: number; expiresAt?: number }, now = Date.now()): boolean {
  return now < request.createdAt || now >= accessRequestExpiresAt(request);
}
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
export const accessGrantSchema = z.object({ toolkit: identifier, accountId: identifier, tools: z.array(identifier).min(1).max(30) }).strict();
export const accessRequestSchema = z.object({ id: identifier, requestedBy: identifier, requesterBinding: z.string(), targetBinding: z.string(), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative().optional(), grants: z.array(accessGrantSchema).min(1).max(12), allowWrites: z.boolean() }).strict();
export const connectedAppAccessSchema = z.object({ revision: z.number().int().nonnegative(), roleBinding: z.string(), mode: z.enum(["unrestricted", "restricted"]), allowWrites: z.boolean(), grants: z.array(accessGrantSchema).max(30), requests: z.array(accessRequestSchema).max(12) }).strict();
export type AccessGrant = z.infer<typeof accessGrantSchema>;
export type ConnectedAppAccess = z.infer<typeof connectedAppAccessSchema>;
export interface PendingPermissionStatus { kind: "tool" | "question" | "peer" | "connection" | "access"; ageSeconds: number; blockedReason: "Waiting for owner review" | "Access request is stale" | "Access request expired" | "Connected apps are disabled"; }
/** B43 grant presets: owner shortcuts that tick one account's checkboxes. A preset
 * expands to explicit catalog slugs only (never `*`), and it never touches the
 * bot-wide `allowWrites` switch: writes stay blocked by the relay until the owner
 * turns that switch on. The owner still presses Save; the server checks as before. */
export const GRANT_PRESETS = { read: "read", all: "all" } as const;
export type GrantPreset = keyof typeof GRANT_PRESETS;
type CatalogEntry = { readonly toolkit: string; readonly tool: string; readonly writes: boolean };
/** `read` = every catalog tool of `toolkit` with `writes:false`; `all` = every tool of `toolkit`. */
export function presetTools(toolkit: string, preset: GrantPreset, catalog: ReadonlyArray<CatalogEntry> = CONNECTED_APP_TOOLS): string[] {
  return catalog.filter((entry) => entry.toolkit === toolkit && (preset === "all" || entry.writes === false)).map((entry) => entry.tool);
}
/** Sets one account's tools to exactly `tools`. Every row for that account is replaced
 * by one row at the first row's place; an empty list REMOVES the row, because
 * `accessGrantSchema` refuses `tools: []`. Other accounts' rows are left as they are. */
export function withAccountTools(grants: readonly AccessGrant[], account: { toolkit: string; accountId: string }, tools: readonly string[]): AccessGrant[] {
  const mine = (grant: AccessGrant) => grant.toolkit === account.toolkit && grant.accountId === account.accountId;
  const at = grants.findIndex(mine);
  const rest = grants.filter((grant) => !mine(grant));
  if (!tools.length) return rest;
  const row: AccessGrant = { toolkit: account.toolkit, accountId: account.accountId, tools: [...new Set(tools)] };
  const place = at < 0 ? rest.length : grants.slice(0, at).filter((grant) => !mine(grant)).length;
  return [...rest.slice(0, place), row, ...rest.slice(place)];
}
