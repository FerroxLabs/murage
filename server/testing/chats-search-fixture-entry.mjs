// Pagination's complete synthetic index must not race a background rebuild.
// Production indexing, admission and foreground reads are unchanged.
import { searchIndexTestHooks } from '../message-search-index.ts';
searchIndexTestHooks.halted = true;
await import('../index.ts');
