// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { createItemsReader, type ItemDraft, type ItemsState } from "./items-reader.mjs";

const initial: ItemsState = { data: null, refreshing: true, failed: false, stalled: false, drafts: {} };

export function useAttentionItems(surface: "panel" | "pill" | "float") {
  const [state, setState] = useState<ItemsState>(initial);
  const reader = useRef<ReturnType<typeof createItemsReader> | null>(null);
  const refresh = useCallback(() => reader.current?.refresh() ?? Promise.resolve(null), []);
  const setDraft = useCallback((cardId: string, draft: ItemDraft) => { reader.current?.setDraft(cardId, draft); }, []);
  const clearDraft = useCallback((cardId: string) => { reader.current?.clearDraft(cardId); }, []);
  useEffect(() => {
    const bridge = window.attentionWindow;
    if (!bridge) { setState({ ...initial, refreshing: false, failed: true }); return; }
    const current = createItemsReader({
      read: () => bridge.items(),
      valid: data => surface === "pill" ? Boolean(data.pill) : surface === "float" ? Array.isArray(data.bots) : true,
      publish: setState,
    });
    reader.current = current;
    const unsubscribe = bridge.onChange(() => { void current.refresh(); });
    void current.refresh();
    return () => { current.dispose(); reader.current = null; unsubscribe(); };
  }, [surface]);
  return { ...state, refresh, setDraft, clearDraft };
}
