// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export type AttentionResult = { ok: boolean; reason?: string };
export type AttentionItem = {
  display: { botName: string; title: string; willRun: string } | null;
  level: string;
  openToken: string;
  actionToken?: string;
};
export type AttentionItems = AttentionResult & {
  items: AttentionItem[];
  openToken: string;
  running: { botName: string; doing: string }[];
  receipts: { text: string }[];
  chief: { name: string } | null;
};
export interface AttentionWindowBridge {
  items(): Promise<AttentionItems | AttentionResult>;
  act(token: string, action: "allow" | "deny" | "reply", text?: string): Promise<AttentionResult>;
  open(token: string): Promise<AttentionResult>;
  sendToChief(text: string): Promise<AttentionResult>;
  pauseAutomations(): Promise<AttentionResult>;
  sendToPinned(text: string): Promise<AttentionResult>;
  onChange(callback: () => void): () => void;
}
declare global {
  interface Window { attentionWindow?: AttentionWindowBridge }
}

export const cleanAttentionText = (value: string) => value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "").trim();
