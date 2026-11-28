// Murage sends no usage analytics (Sean, standing ruling 11-14). Builds up to
// 1.0.20 carried the upstream fork's PostHog client behind a Settings switch;
// it is gone. This removes what that client could have left in the window's
// storage on an upgraded install: Murage's own switch, install and daily-use
// markers, and the SDK's anonymous id and opt-in/out records. Nothing else is
// touched. No imports and no network on purpose (no-telemetry-1020.test.ts).
const LEGACY_KEYS = new Set(["murage-analytics-opt-out", "murage-analytics-active-day", "murage-installed"]);
// The SDK keys every record by the project token: ph_<token>_posthog (the
// anonymous id), ph_<token>_primary_window_exists, __ph_opt_in_out_<token>.
const SDK_KEY = /^(?:ph_.+_(?:posthog|primary_window_exists|window_id)|__ph_opt_in_out_.+)$/;

type KeyedStorage = { readonly length: number; key(index: number): string | null; removeItem(key: string): void };

/** Deletes the old analytics records from one storage area; returns how many. */
export function purgeLegacyAnalytics(storage: KeyedStorage): number {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && (LEGACY_KEYS.has(key) || SDK_KEY.test(key))) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
  return doomed.length;
}

/** Run once per window start. Storage that cannot be read is left alone. */
export function startupPrivacy(): void {
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = (globalThis as Record<string, unknown>)[area] as KeyedStorage | undefined;
      if (storage) purgeLegacyAnalytics(storage);
    } catch { /* unavailable storage holds nothing to clean */ }
  }
}
