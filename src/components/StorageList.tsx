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
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { loadFirst, loadMore, removeFile, type StorageListAnswer, type StorageListState, type StorageOrder } from "@/lib/storage-list";
import { StorageListView } from "./StorageListView";

const get = (url: string) => api(url) as Promise<StorageListAnswer>;
const post = (url: string, body: unknown) => api(url, { method: "POST", body: JSON.stringify(body) });

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
  // Remove (1.0.4 SL-H): this computer only, never a Cloud home.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);
  const remove = useCallback((name: string) => {
    setRemoving(name);
    void removeFile(post, name).then(result => {
      setRemoving(null);
      setConfirming(null);
      setRemoveNotice(result.line);
      if (result.removed) reload(order);
    });
  }, [order, reload]);
  const removable = !isCloudOrigin();
  return (
    <StorageListView state={state} order={order} onOrder={reload} onMore={more} onReload={() => reload(order)}
      {...(removable ? {
        remove: { confirming, removing, notice: removeNotice, onAsk: (name: string) => { setRemoveNotice(null); setConfirming(name); }, onCancel: () => setConfirming(null), onConfirm: remove },
      } : {})} />
  );
}
