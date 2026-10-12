// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A tiny bus so the things that know the server just came back (the live-events stream opening again, the shell's lifecycle notice) can ask the
// upgrade feed to look now, without importing it (the feed imports the store, which would make a cycle).
export type WakeKind = "LIFECYCLE" | "RECONNECT" | "VISIBLE";
const listeners = new Set<(kind: WakeKind) => void>();
export function onMemoryWake(listener: (kind: WakeKind) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function requestMemoryWake(kind: WakeKind): void { for (const listener of [...listeners]) { try { listener(kind); } catch { /* a listener never blocks another */ } } }
