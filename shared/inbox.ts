export type InboxView = "needs-you" | "results" | "all";
export interface InboxLink { threadId: string; messageId: string; runId?: string; artifactId?: string }
export interface InboxItem {
  id: string;
  version: string;
  kind: "request" | "connection" | "error" | "routine" | "goal" | "artifact";
  status: string;
  needsYou: boolean;
  title: string;
  summary: string;
  sourceLabel: string;
  botId?: string;
  at: number;
  read: boolean;
  snoozedUntil: number | null;
  duplicates: number;
  link: InboxLink;
}
export interface InboxQuery { view?: InboxView; query?: string; page?: number; pageSize?: number; includeSnoozed?: boolean }
export interface InboxPage {
  items: InboxItem[]; total: number; page: number; pageSize: number;
  unread: number; needsYou: number;
}
export interface InboxStateUpdate { id: string; version: string; read?: boolean; snoozedUntil?: number | null }
