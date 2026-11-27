// SPDX-License-Identifier: AGPL-3.0-or-later
import { setImmediate } from "node:timers/promises";
import type { SqliteCallStore } from "./store.ts";

/** Startup work. Each batch commits its own resume cursor. */
export async function migratePhoneCalls(store: SqliteCallStore, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted && !store.migrateBatch()) {
    await setImmediate();
  }
}
