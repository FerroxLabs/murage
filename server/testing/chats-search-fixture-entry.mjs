// Pagination's complete synthetic index must not race a background rebuild.
// Production indexing, admission and foreground reads are unchanged.
import { searchIndexTestHooks } from '../message-search-index.ts';
// MAIN RULING INT-CONFLICT-DEFAULT 5d5a791f19: allow the real initial
// owner/reset handshake before pausing steps for the frozen fixture index.
const observe = searchIndexTestHooks.event;
searchIndexTestHooks.halted = false;
searchIndexTestHooks.event = event => {
  observe?.(event);
  if (event.type === 'ready') searchIndexTestHooks.halted = true;
};
await import('../index.ts');
