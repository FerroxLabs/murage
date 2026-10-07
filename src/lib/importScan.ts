// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How far the import check has got, for the dialogs that import a package,
// a team or a template. The server reads the package off its main thread and
// answers /api/packages/scan-progress for the check named by `scanId`; the
// request itself carries that id, and aborting it ends the check.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";

export interface ImportScanProgress { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number }

const newScanId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, "");

/** `url` with this check's id added. */
export function withScanId(url: string, scanId: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}scanId=${encodeURIComponent(scanId)}`;
}

export function isCheckStopped(cause: unknown): boolean {
  return (cause as { name?: string } | null)?.name === "AbortError";
}

/** One import check at a time for a dialog. `begin()` starts a check (ending
 * any earlier one) and gives the id and abort signal to send with the request;
 * `stop()` ends it, and runs when the dialog goes away. */
export function useImportScan(active: boolean) {
  const current = useRef<{ id: string; controller: AbortController } | null>(null);
  const [progress, setProgress] = useState<ImportScanProgress | null>(null);
  const stop = useCallback(() => { current.current?.controller.abort(); current.current = null; }, []);
  const begin = useCallback(() => {
    current.current?.controller.abort();
    const next = { id: newScanId(), controller: new AbortController() };
    current.current = next;
    setProgress(null);
    return { scanId: next.id, signal: next.controller.signal };
  }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const poll = async () => {
      const scan = current.current;
      if (!scan) return;
      try {
        const next = await api(`/api/packages/scan-progress?id=${encodeURIComponent(scan.id)}`) as Partial<ImportScanProgress> & { state?: string };
        if (live && current.current === scan && typeof next.filesTotal === "number" && typeof next.filesDone === "number") {
          setProgress({ filesDone: next.filesDone, filesTotal: next.filesTotal, bytesDone: next.bytesDone ?? 0, bytesTotal: next.bytesTotal ?? 0 });
        }
      } catch { /* the next look tries again */ }
    };
    const timer = setInterval(() => void poll(), 400);
    return () => { live = false; clearInterval(timer); };
  }, [active]);
  return useMemo(() => ({ begin, stop, progress }), [begin, stop, progress]);
}
