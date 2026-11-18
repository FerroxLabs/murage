// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';
/** An approved writer owns immutable origin facts. A later turn on the same conversation cannot supply them. */
export type FrozenMemoryWriteOrigin = Readonly<{ outside: boolean; email: boolean }>;
const applyOrigin = new AsyncLocalStorage<FrozenMemoryWriteOrigin>();
export const frozenMemoryWriteOrigin = () => applyOrigin.getStore();
export function withFrozenMemoryWriteOrigin<T>(origin: FrozenMemoryWriteOrigin, operation: () => T): T {
  return applyOrigin.run(Object.freeze({ ...origin }), operation);
}
