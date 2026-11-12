// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** reason: "superseded" (a newer read or a push overtook this one: read again), "discarded" (the window's state was dropped), "hidden", or a gate refusal. */
export type AttentionResult = { ok: boolean; reason?: string };
export type AttentionItem = {
  cardId: string;
  display: { botName: string; title: string; willRun: string } | null;
  level: string;
  openToken: string;
  actionToken?: string;
  replyFocusToken?: string;
};
export type AttentionItems = AttentionResult & {
  /** Host-wide, strictly increasing per committed read; an older result is never applied over a newer one. */
  rev: number;
  items: AttentionItem[];
  openToken: string;
  running: { botName: string; doing: string }[];
  receipts: { text: string }[];
  chief: { name: string } | null;
  bots?: FloatBot[];
  pill?: { state: "hidden" | "collapsed" | "expanded" | "stacked" | "finished"; count: number; toggleToken: string };
};
export type FloatBot = { key: string; name: string; state: "idle" | "working" | "needs-you"; openToken: string; item: AttentionItem | null };
export interface AttentionWindowBridge {
  items(): Promise<AttentionItems | AttentionResult>;
  act(token: string, action: "allow" | "deny" | "reply", text?: string): Promise<AttentionResult>;
  open(token: string): Promise<AttentionResult>;
  sendToChief(text: string): Promise<AttentionResult>;
  pauseAutomations(): Promise<AttentionResult>;
  sendToPinned(text: string): Promise<AttentionResult>;
  hideForAnHour?(): Promise<AttentionResult>;
  setExpanded?(expanded: boolean): Promise<AttentionResult>;
  onChange(callback: () => void): () => void;
}
declare global {
  interface Window { attentionWindow?: AttentionWindowBridge }
}

export const cleanAttentionText = (value: string) => value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "").trim();
