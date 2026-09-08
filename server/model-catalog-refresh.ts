/** Metadata discovery only: never reload a provider, start a turn or change a selection. */
export const MODEL_CATALOG_REFRESH_MS = 24 * 60 * 60_000;
const POLL_MS = 60_000;
export function startModelCatalogRefresh(refresh: (signal: AbortSignal) => Promise<void>): () => Promise<void> {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (controller.signal.aborted || pending) return;
    pending = Promise.resolve().then(() => refresh(controller.signal)).catch(() => {
      // Services retain their last good rows and typed catalog errors.
    }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, POLL_MS); timer.unref?.();
  tick();
  return async () => { clearInterval(timer); controller.abort(); await pending; };
}
