// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Storage: the list of attachment files Murage keeps (1.0.3, list
// only): size, date, kind and where each is used. A self-contained block, so it
// renders inside the Storage card wherever that card lives (its own page or the
// Backups page).
//
// Rendering it asks for no file's bytes (R1.9): the only request is the list
// route. Opening a file from here is not offered.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { loadFirst, loadMore, type StorageListAnswer, type StorageListState, type StorageOrder } from "@/lib/storage-list";
import { StorageListView } from "./StorageListView";

const get = (url: string) => api(url) as Promise<StorageListAnswer>;

export function StorageList() {
  const [state, setState] = useState<StorageListState>({ phase: "loading" });
  const [order, setOrder] = useState<StorageOrder>("size");
  const generation = useRef(0);
  const reload = useCallback((next: StorageOrder) => {
    const mine = ++generation.current;
    setOrder(next);
    setState({ phase: "loading" });
    void loadFirst(get, next).then(result => { if (generation.current === mine) setState(result); });
  }, []);
  useEffect(() => reload("size"), [reload]);
  const more = useCallback(() => {
    if (state.phase !== "ready" || state.loadingMore) return;
    const mine = generation.current;
    setState({ ...state, loadingMore: true });
    void loadMore(get, state).then(result => { if (generation.current === mine) setState(result); });
  }, [state]);
  return <StorageListView state={state} order={order} onOrder={reload} onMore={more} onReload={() => reload(order)} />;
}
