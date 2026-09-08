import { z } from "zod";
/** Reviewed finite catalog. Restricted mode never infers safety from a tool name. */
export const CONNECTED_APP_TOOLS = [
  { toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS", label: "Read emails", writes: false },
  { toolkit: "gmail", tool: "GMAIL_GET_PROFILE", label: "Read account profile", writes: false },
  { toolkit: "gmail", tool: "GMAIL_SEND_EMAIL", label: "Send email", writes: true },
  { toolkit: "slack", tool: "SLACK_SEND_MESSAGE", label: "Send Slack message", writes: true },
  { toolkit: "googlecalendar", tool: "GOOGLECALENDAR_LIST_EVENTS", label: "Read calendar events", writes: false },
] as const;
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
export const accessGrantSchema = z.object({ toolkit: identifier, accountId: identifier, tools: z.array(identifier).min(1).max(30) }).strict();
export const accessRequestSchema = z.object({ id: identifier, requestedBy: identifier, requesterBinding: z.string(), targetBinding: z.string(), createdAt: z.number().int().nonnegative(), grants: z.array(accessGrantSchema).min(1).max(12), allowWrites: z.boolean() }).strict();
export const connectedAppAccessSchema = z.object({ revision: z.number().int().nonnegative(), roleBinding: z.string(), mode: z.enum(["unrestricted", "restricted"]), allowWrites: z.boolean(), grants: z.array(accessGrantSchema).max(30), requests: z.array(accessRequestSchema).max(12) }).strict();
export type AccessGrant = z.infer<typeof accessGrantSchema>;
export type ConnectedAppAccess = z.infer<typeof connectedAppAccessSchema>;
export interface PendingPermissionStatus { kind: "tool" | "question" | "peer" | "connection" | "access"; ageSeconds: number; blockedReason: "Waiting for owner review" | "Access request is stale" | "Connected apps are disabled"; }
