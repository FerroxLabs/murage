// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttentionItems, AttentionResult } from "./bridge";

export type ItemDraft = { text: string; replying: boolean };
export type ItemsState = {
  data: AttentionItems | null; refreshing: boolean; failed: boolean;
  /** Eight reads in a row were superseded; the last data is kept, controls stay disabled, the reader keeps retrying. */
  stalled: boolean;
  /** Unsent drafts by cardId, kept outside the card component. */
  drafts: Readonly<Record<string, ItemDraft>>;
};
export function createItemsReader(options: {
  read: () => Promise<AttentionItems | AttentionResult>;
  valid: (data: AttentionItems) => boolean;
  publish: (state: ItemsState) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: any) => void;
}): {
  refresh: () => Promise<AttentionItems | null>;
  dispose: () => void;
  setDraft: (cardId: string, draft: ItemDraft) => void;
  clearDraft: (cardId: string) => void;
};
