// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Allows belong to one turn and session. An execution binds one allow for the
 * rest of that turn, including its terminal reports. Rejects are never stored. */
export class ToolTripwire {
  private allows: Array<{ id: string | undefined; identity: string | undefined; input: string | undefined; session: string; binding?: string }> = [];

  record(id: unknown, identity: string | undefined, input: unknown, session: string): () => void {
    const allow = { id: validId(id) ? id : undefined, identity, input: JSON.stringify(input), session };
    this.allows.push(allow);
    return () => { const at = this.allows.indexOf(allow); if (at >= 0) this.allows.splice(at, 1); };
  }

  accepts(id: unknown, identity: string | undefined, input: unknown, session: string): boolean {
    if (!validId(id)) return false;
    const bound = this.allows.find(a => a.session === session && a.binding === id);
    if (bound) return true;
    const exact = this.allows.find(a => a.session === session && a.id === id && a.binding === undefined);
    if (exact) { exact.binding = id; return true; }
    if (!identity?.trim()) return false;
    const serialized = JSON.stringify(input);
    const candidates = this.allows.filter(a => a.session === session && a.binding === undefined && a.identity?.trim() && a.identity === identity && a.input === serialized);
    if (candidates.length !== 1) return false;
    candidates[0]!.binding = id;
    return true;
  }
}

function validId(id: unknown): id is string { return typeof id === 'string' && id.trim().length > 0; }
