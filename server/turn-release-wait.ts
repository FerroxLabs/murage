// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** How long one mount frame's release may wait on the server before the mount is treated as lost.
 *
 * Leaf module (no imports): every spawned proxy loads it before it answers `initialize`.
 *
 * This is a hang guard, never an authority check. The verdict, the upstream reserve and the envelope acknowledgement are all
 * answered by the server's main loop, and a loaded server (a dispatch burst, a ledger lock hold, a re-import) answers them
 * late, not never. A late answer delays that frame; it does not seal the mount for the rest of the turn. Nothing is released
 * early by waiting: a frame still needs its permit, and final delivery rechecks the turn. A server that is really gone ends
 * the wait at once through the child's own channel (IPC disconnect, stdin end, a refused or failed request).
 *
 * It must stay above the pending memory check a held reply waits for (memory/fence-pending.ts PENDING_FENCE_WAIT_MS, 65 s,
 * plus the server's 5 s re-armed permit): the child is waiting for its acknowledgement all through that hold. The relation
 * is pinned in turn-release-slow-verdict-1021.test.ts; this module stays import-free. */
export const TURN_RELEASE_WAIT_MS = 90_000;
