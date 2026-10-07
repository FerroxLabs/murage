// Spec §3.5 "Badge and reconciliation" and "Tapping a notification": which
// computer a binding belongs to, one count per binding summed for the app
// badge, the last revision shown per collapse key (older ones are ignored),
// and what to remove when the pending list says it was answered elsewhere.
export const SEEN_LIMIT = 500;
export type Accept = "show" | "stale" | "unknown";

export class PushLedger {
  private bindings = new Map<string, { origin: string; badge: number }>();
  private seen: Array<[string, number]> = [];

  bind(bindingId: string, origin: string): void {
    for (const [id, entry] of this.bindings) if (entry.origin === origin) this.bindings.delete(id);
    this.bindings.set(bindingId, { origin, badge: 0 });
  }
  unbindOrigin(origin: string): string | null {
    for (const [id, entry] of this.bindings) if (entry.origin === origin) { this.bindings.delete(id); return id; }
    return null;
  }
  origin(bindingId: string): string | null { return this.bindings.get(bindingId)?.origin ?? null; }
  get bindingIds(): string[] { return [...this.bindings.keys()]; }
  binding(origin: string): string | null {
    for (const [id, entry] of this.bindings) if (entry.origin === origin) return id;
    return null;
  }
  get total(): number { let sum = 0; for (const e of this.bindings.values()) sum += e.badge; return sum; }

  accept(bindingId: string, collapseKey: string, revision: number, workspaceBadge: number): Accept {
    const entry = this.bindings.get(bindingId);
    if (!entry) return "unknown";
    const at = this.seen.findIndex(([key]) => key === collapseKey);
    if (at >= 0 && this.seen[at][1] >= revision) return "stale";
    if (at >= 0) this.seen.splice(at, 1);
    this.seen.push([collapseKey, revision]);
    while (this.seen.length > SEEN_LIMIT) this.seen.shift();
    entry.badge = Math.max(0, workspaceBadge);
    return "show";
  }
  setBadge(bindingId: string, count: number): void {
    const entry = this.bindings.get(bindingId);
    if (entry) entry.badge = Math.max(0, count);
  }
  /** Pending is the host's truth: a shown key it no longer lists was answered
   *  elsewhere. A pending key at a newer revision raises what counts as seen,
   *  so the older push, if it is still in flight, is ignored when it lands. */
  reconcile(bindingId: string, badge: number, pending: Array<{ collapseKey: string; revision: number }>, shown: string[]): string[] {
    this.setBadge(bindingId, badge);
    const live = new Set(pending.map((p) => p.collapseKey));
    for (const p of pending) {
      const at = this.seen.findIndex(([key]) => key === p.collapseKey);
      if (at < 0 || this.seen[at][1] < p.revision) {
        if (at >= 0) this.seen.splice(at, 1);
        this.seen.push([p.collapseKey, p.revision]);
      }
    }
    while (this.seen.length > SEEN_LIMIT) this.seen.shift();
    return shown.filter((key) => !live.has(key)).sort();
  }

  /** `bindings` is an ordered array of `[bindingId, origin, badge]` triples, not a JSON
   *  object keyed by bindingId: an object's key order is a JS-engine convention, not a
   *  cross-platform guarantee, and `bindingIds` order (the contract) must survive
   *  encode/decode identically on Swift and Java too. */
  encode(): string {
    const bindings: Array<[string, string, number]> = [];
    for (const [id, entry] of this.bindings) bindings.push([id, entry.origin, entry.badge]);
    return JSON.stringify({ bindings, seen: this.seen });
  }
  static decode(text: string): PushLedger {
    const ledger = new PushLedger();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return ledger; }
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    for (const item of Array.isArray(o.bindings) ? o.bindings : []) {
      if (!Array.isArray(item) || item.length !== 3) continue;
      const [id, origin, badgeRaw] = item as unknown[];
      if (typeof id !== "string" || typeof origin !== "string" || !origin.startsWith("https://")) continue;
      const badge = typeof badgeRaw === "number" && Number.isInteger(badgeRaw) && badgeRaw >= 0 ? badgeRaw : 0;
      ledger.bindings.set(id, { origin, badge });
    }
    for (const pair of Array.isArray(o.seen) ? o.seen : []) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && Number.isInteger(pair[1])) ledger.seen.push([pair[0], pair[1]]);
    }
    ledger.seen = ledger.seen.slice(-SEEN_LIMIT);
    return ledger;
  }
}
