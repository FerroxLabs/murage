// A lazy chunk that 404s because the computer updated Murage while this page
// stayed open. Vite reports it as `vite:preloadError` on window; one reload
// fetches the new shell and its new chunk names.
//
// ONE reload. The stamp lives in sessionStorage, and a failure within the
// window after it is left to throw — a chunk that is broken for real must
// reach RootErrorBoundary, not spin the page. No storage, no reload, for
// the same reason.

export const CHUNK_RELOAD_KEY = "murage-chunk-reload-at";
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

export interface ChunkReloadDeps {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  storage: () => Pick<Storage, "getItem" | "setItem"> | undefined;
  reload: () => void;
  now: () => number;
}

export function shouldReloadForChunk(lastAt: string | null, now: number): boolean {
  if (!lastAt) return true;
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last > now) return true;
  return now - last >= CHUNK_RELOAD_WINDOW_MS;
}

export function installChunkReload(deps: ChunkReloadDeps): () => void {
  const onPreloadError = (event: Event) => {
    try {
      const store = deps.storage();
      if (!store || !shouldReloadForChunk(store.getItem(CHUNK_RELOAD_KEY), deps.now())) return;
      store.setItem(CHUNK_RELOAD_KEY, String(deps.now()));
    } catch {
      return;
    }
    event.preventDefault();
    deps.reload();
  };
  deps.target.addEventListener("vite:preloadError", onPreloadError);
  return () => deps.target.removeEventListener("vite:preloadError", onPreloadError);
}

export function browserChunkReloadDeps(): ChunkReloadDeps {
  return {
    target: window,
    storage: () => sessionStorage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  };
}
