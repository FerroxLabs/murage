// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory settings, the two places the later upgrade work shows itself: what the strip says, in a little more detail (which step, how far, how
// long), and the owner's choice to hand back the disk space the smaller memory freed. Handing back rewrites the file, so it is never done
// by itself: it runs only when the owner presses the button, and says first that it takes a few minutes.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { useMemoryDetail, useUpgradeContext } from "@/lib/memory-integrity-feed";
import type { StripView } from "@/lib/memory-integrity-view";

export interface LineageStorage { state: "idle" | "converting" | "reclaim-available" | "waiting-for-disk"; freeBytes?: number; legacyIndexPending?: boolean; message?: string }

/** The amount is named only when it was measured: free pages alone, with no index still waiting to be dropped (that index frees an amount nobody has measured). */
export const reclaimSizeKnown = (storage: LineageStorage): boolean => (storage.freeBytes ?? 0) > 0 && storage.legacyIndexPending !== true;

/** "1.4 GB" / "640 MB", rounded up. */
export function spaceLabel(bytes: number): string {
  const mb = Math.max(1, Math.ceil(bytes / 1048576));
  return mb >= 1024 ? `${(Math.ceil(bytes / 107374182.4) / 10).toFixed(1)} GB` : `${mb} MB`;
}

export function MemoryUpgradeDetailView({ view }: { view: StripView | null }) {
  if (!view || view.kind === "done") return null;
  if (view.kind === "hold") return <p role="alert" className="text-[13px] text-danger" data-testid="memory-upgrade-detail">{view.text}</p>;
  const progress = view.phaseLabel && view.percent !== null ? t("memoryStrip.detail.progress", { phase: view.phaseLabel, percent: view.percent }) : view.phaseLabel;
  return (
    <section aria-label={t("memoryStrip.detail.title")} className="rounded-lg bg-raised px-3 py-2 text-[13px]" data-testid="memory-upgrade-detail">
      <h3 className="font-medium">{t("memoryStrip.detail.title")}</h3>
      {progress && <p className="text-ink-secondary">{progress}{view.left ? ` ${view.left.charAt(0).toUpperCase()}${view.left.slice(1)}.` : ""}{view.slow ? ` ${t("memoryStrip.slow")}` : ""}</p>}
      {view.counter && <p className="text-ink-secondary" data-testid="memory-upgrade-counter">{view.counter}</p>}
      {!view.counter && view.elapsed && <p className="text-ink-secondary" data-testid="memory-upgrade-elapsed">{view.elapsed}</p>}
    </section>
  );
}

export function MemoryUpgradeDetail() { return <MemoryUpgradeDetailView view={useMemoryDetail()} />; }

export function MemoryStorageReclaimView({ storage, running, failed, onReclaim, onRetry }: { storage: LineageStorage | null; running: boolean; failed: boolean; onReclaim: () => void; onRetry?: () => void }) {
  if (!storage) return null;
  if (running) return <p role="status" className="text-[13px] text-ink-secondary" data-testid="memory-reclaim">{t("memoryStorage.running")}</p>;
  // the server's own sentence is never shown: the state maps to the app's words, and the owner can ask again once there is room
  if (storage.state === "waiting-for-disk") return (
    <section aria-label={t("memoryStorage.title")} className="space-y-1 rounded-lg bg-raised px-3 py-2 text-[13px]" data-testid="memory-reclaim">
      <h3 className="font-medium">{t("memoryStorage.title")}</h3>
      <p role="status" className="text-ink-secondary">{t("memoryStorage.waiting")}</p>
      {failed && <p role="alert" className="text-danger">{t("memoryStorage.failed")}</p>}
      <button type="button" className="rounded-lg bg-card px-3 py-1.5 text-[13px] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={onRetry ?? onReclaim}>{t("memoryStorage.retry")}</button>
    </section>
  );
  if (storage.state !== "reclaim-available") return null;
  const known = reclaimSizeKnown(storage);
  const size = known ? spaceLabel(storage.freeBytes ?? 0) : "";
  return (
    <section aria-label={t("memoryStorage.title")} className="space-y-1 rounded-lg bg-raised px-3 py-2 text-[13px]" data-testid="memory-reclaim">
      <h3 className="font-medium">{t("memoryStorage.title")}</h3>
      <p className="text-ink-secondary">{known ? t("memoryStorage.available", { size }) : t("memoryStorage.availableUnknown")} {t("memoryStorage.note")}</p>
      {failed && <p role="alert" className="text-danger">{t("memoryStorage.failed")}</p>}
      <button type="button" className="rounded-lg bg-card px-3 py-1.5 text-[13px] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={onReclaim}>{known ? t("memoryStorage.button", { size }) : t("memoryStorage.buttonUnknown")}</button>
    </section>
  );
}

/** While the storage conversion is known to be running (the storage read says so) but the health feed is not the one reporting it (an older server, or
 * a reading that cannot be used), the storage state is looked at again every so often, a bounded number of times, so the offer still appears when the
 * conversion ends. Returns a stop function. */
export const STORAGE_REFRESH_MS = 15_000;
export const STORAGE_REFRESH_MAX = 80;
export function watchStorageWhileConverting(
  read: () => Promise<LineageStorage>, apply: (next: LineageStorage) => void,
  { intervalMs = STORAGE_REFRESH_MS, maxTries = STORAGE_REFRESH_MAX, setTick = (fn: () => void, ms: number): unknown => setInterval(fn, ms), clearTick = (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) } = {},
): () => void {
  let tries = 0, busy = false, stopped = false;
  const handle = setTick(async () => {
    if (stopped || busy) return;
    if (++tries > maxTries) { stopped = true; clearTick(handle); return; }
    busy = true;
    try { const next = await read(); if (!stopped) apply(next); } catch { /* try again at the next tick */ } finally { busy = false; }
  }, intervalMs);
  return () => { stopped = true; clearTick(handle); };
}
/** Whether the component should look at the storage state itself: it is converting, and the health feed is not already saying so. */
export function storageNeedsOwnRefresh(storage: LineageStorage | null, feedStorage: string): boolean { return storage?.state === "converting" && feedStorage !== "converting"; }

/** The owner's "hand back the space": reads /api/memory/storage, and POSTs /api/memory/storage/reclaim only on the button. It looks again whenever
 * the background work moves on (a step finishes, the work ends), so the offer appears when conversion is over and stays when it is not. */
export function MemoryStorageReclaim() {
  const [storage, setStorage] = useState<LineageStorage | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  // The storage state comes from the one upgrade feed (the health answer keeps being read while the conversion runs, so there is no poll of its own):
  // /api/memory/storage is read again whenever that state changes, so the offer appears the moment the conversion is over, with or without any other detail.
  const backgroundKey = useUpgradeContext().storage;
  const load = useCallback(async (): Promise<LineageStorage | null> => { try { const next = await api("/api/memory/storage") as LineageStorage; setStorage(next); return next; } catch { return null; /* the section just stays as it was */ } }, []);
  useEffect(() => { void load(); }, [load, backgroundKey]);
  // conversion known to be running with no usable report from the health feed: a bounded refresh of its own
  const needsOwn = storageNeedsOwnRefresh(storage, backgroundKey);
  useEffect(() => {
    if (!needsOwn) return;
    return watchStorageWhileConverting(() => api("/api/memory/storage") as Promise<LineageStorage>, setStorage);
  }, [needsOwn]);
  // while the hand-back runs, look every few seconds until the state moves on
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      try { const next = await api("/api/memory/storage") as LineageStorage; setStorage(next); if (next.state !== "reclaim-available") setRunning(false); } catch { /* try again */ }
    }, 5000);
    return () => clearInterval(id);
  }, [running]);
  const reclaim = useCallback(async () => {
    setFailed(false);
    try { await api("/api/memory/storage/reclaim", { method: "POST", body: "{}" }); setRunning(true); } catch { setFailed(true); }
  }, []);
  // after the owner has made room: look again. If the space can now be handed back the normal offer (with its note) shows; if the request is
  // still waiting for room, the owner's press asks again, an explicit request like the first.
  const retry = useCallback(async () => { const next = await load(); if (next?.state === "waiting-for-disk") await reclaim(); }, [load, reclaim]);
  return <MemoryStorageReclaimView storage={storage} running={running} failed={failed} onReclaim={() => void reclaim()} onRetry={() => void retry()} />;
}
