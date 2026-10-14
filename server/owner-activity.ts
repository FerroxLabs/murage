// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner-idle clock counts what the owner does (sends, edits, card answers, settings changes), never what the app does by itself. The
// desktop reports presence every 30 s while the Mac is in use; if that beat counted, the owner would never be "idle" at the Mac.

/** Requests the app and the desktop shell send on their own. A write to one of these says nothing about the owner. */
const BACKGROUND_WRITES: ReadonlySet<string> = new Set([
  "/api/presence",
  "/api/backup-failure-notice",
  "/api/automation-admission",
  "/api/diagnostics/incident",
]);

/** True when this request is an owner action: it changes something and is not one of the app's own beats. */
export function countsAsOwnerAction(method: string | undefined, rawUrl: string | undefined): boolean {
  if (!method || method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const path = (rawUrl ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";
  return !BACKGROUND_WRITES.has(path);
}

/** The clock itself, injectable for tests. */
export class OwnerIdleClock {
  private last: number;
  private readonly now: () => number;
  // No parameter property: the server runs under Node's type-stripping, which rejects one.
  constructor(now: () => number = Date.now) { this.now = now; this.last = now(); }
  note(method: string | undefined, rawUrl: string | undefined): void { if (countsAsOwnerAction(method, rawUrl)) this.last = this.now(); }
  touch(): void { this.last = this.now(); }
  idleMs(): number { return this.now() - this.last; }
}
