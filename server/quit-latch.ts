// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: the server's shutdown (graceful-shutdown.ts sets it at entry). Readers: any stop that may wait longer than the shutdown
// allowance leaves it (today the chat MCP descendant snapshot, drivers/chat-mcp-client.ts ChatMcpDescendants.ready).
//
// Quit has begun. The latch is set synchronously at shutdown entry, before any cleanup job runs, and is never cleared: the
// process ends with it. A wait that only serves a later confirmation (a process listing) is given up the moment it is set, so
// the stop itself (stdin end, the process-group signal) is sent while the server is still there to send it.
let quitting = false;
const waiters = new Set<() => void>();

export function beginServerQuit(): void {
  if (quitting) return;
  quitting = true;
  for (const waiter of [...waiters]) { try { waiter(); } catch { /* a waiter never stops the shutdown */ } }
  waiters.clear();
}

export function serverQuitting(): boolean { return quitting; }

/** `callback` runs once, synchronously, when Quit begins (never if it had already begun: read serverQuitting first). The answer
 *  removes it. */
export function onServerQuit(callback: () => void): () => void {
  waiters.add(callback);
  return () => { waiters.delete(callback); };
}

export function resetServerQuitForTest(): void { quitting = false; waiters.clear(); }
