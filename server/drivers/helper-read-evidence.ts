// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HelperRow } from '../turn-settle.ts';
/** Per-turn evidence from the driver's helper stream. Unknown or torn frames can never prove complete reads. */
export class HelperReadEvidence {
  private children = new Map<string, { ended: boolean; count: number }>();
  private torn = false;
  private outside = false;
  spawn(id: unknown) {
    if (typeof id !== 'string' || !id || this.children.has(id)) { this.torn = true; return; }
    this.children.set(id, { ended: false, count: 0 });
  }
  progress(id: unknown, count: unknown) {
    const child = typeof id === 'string' ? this.children.get(id) : undefined;
    if (!child || child.ended || !Number.isSafeInteger(count) || (count as number) < child.count) { this.torn = true; return; }
    child.count = count as number;
    // A count without item-by-item provenance is outside, even if no streamed read event arrived.
    if (child.count > 0) this.outside = true;
  }
  read() { this.outside = true; }
  unknown() { this.torn = true; }
  finish(id: unknown, ok: boolean) {
    const child = typeof id === 'string' ? this.children.get(id) : undefined;
    if (!child || !ok) { this.torn = true; return; }
    child.ended = true;
  }
  terminal(name: string, site: string, interrupted: boolean): HelperRow {
    return { name, site, recorded: true, readsComplete: !this.torn && this.children.size > 0 && [...this.children.values()].every(c => c.ended), outsideRead: this.outside, interrupted };
  }
}
