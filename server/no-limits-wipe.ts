// SPDX-License-Identifier: AGPL-3.0-or-later
// Included-file journals are accepted only for source compatibility and ignored.
// Compatibility entry point. No limits has one narrow catastrophe breaker.
import { wipeBreaker, type WipeContext } from './wipe-breaker.ts';
import type { UnseenOptions } from './always-ask.ts';
export function noLimitsWipe(text: string, options: WipeContext & { unread?: boolean; unseen?: UnseenOptions; scriptDepth?: number; writtenScripts?: ReadonlySet<string> } = {}) {
  return wipeBreaker(text, options);
}
