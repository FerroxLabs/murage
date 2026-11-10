// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttentionItems, AttentionResult } from "./bridge";

export type ItemsState = { data: AttentionItems | null; refreshing: boolean; failed: boolean };
export function createItemsReader(options: {
  read: () => Promise<AttentionItems | AttentionResult>;
  valid: (data: AttentionItems) => boolean;
  publish: (state: ItemsState) => void;
}): { refresh: () => Promise<AttentionItems | null>; dispose: () => void };
