/** One /api/search hit, resolved to the bot or room that owns it. */
export interface SearchHit {
  botId?: string;
  groupId?: string;
  name: string;
  threadId: string;
  /** Matches in this chat in the searched window. */
  hits?: number;
  task?: string;
  messageId: string;
  role: string;
  kind: string;
  from?: string;
  at: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  onActivePath?: boolean;
}
