import { randomUUID } from "node:crypto";
import { fluxCredentialRevision, fluxCredentialStatus, planFluxCredentialChange, type FluxCredentialState } from "../electron/flux-credential-policy.mjs";

/** A single idle-workspace reservation, held across the desktop encrypted write. */
export class FluxConnectionTransaction {
  private pending?: { lease: string; before: FluxCredentialState; next: FluxCredentialState; committedRevision?: string; timer: ReturnType<typeof setTimeout> };
  private expiredLease?: string;
  private readonly hooks: { read: () => FluxCredentialState; assertIdle: () => void; fence: (held: boolean) => void; apply: (state: FluxCredentialState, external: boolean, restore: boolean) => Promise<void> };
  constructor(hooks: FluxConnectionTransaction["hooks"]) { this.hooks = hooks; }
  begin(input: unknown) {
    if (this.pending) throw Object.assign(new Error("Flux credentials are already being changed."), { status: 409 });
    this.hooks.assertIdle();
    const before = this.hooks.read(), next = planFluxCredentialChange(before, input), lease = randomUUID();
    this.hooks.fence(true);
    // Before commit, expiry is safe: a late desktop commit refuses and its
    // encrypted transaction restores the prior document. Never expire a commit.
    const timer = setTimeout(() => { if (this.pending?.lease === lease && !this.pending.committedRevision) { this.expiredLease = lease; this.release(); } }, 30_000);
    timer.unref();
    this.pending = { lease, before, next, timer };
    return { lease, next };
  }
  private owned(lease: unknown) {
    if (typeof lease !== "string" || !this.pending || lease !== this.pending.lease) throw Object.assign(new Error("Flux save reservation expired or changed. Refresh before saving."), { status: 409 });
    return this.pending;
  }
  async commit(lease: unknown, external: boolean) {
    const pending = this.owned(lease);
    if (pending.committedRevision) return fluxCredentialStatus(this.hooks.read());
    if (fluxCredentialRevision(this.hooks.read()) !== fluxCredentialRevision(pending.before)) throw Object.assign(new Error("Flux connections changed. Refresh before saving."), { status: 409 });
    clearTimeout(pending.timer);
    // Record ownership even when apply throws after a partial local write, so
    // the caller can compensate while the workspace remains fenced.
    try { await this.hooks.apply(pending.next, external, false); }
    finally { pending.committedRevision = fluxCredentialRevision(this.hooks.read()); }
    return fluxCredentialStatus(this.hooks.read());
  }
  async rollback(lease: unknown, external: boolean) {
    if (lease === this.expiredLease && typeof lease === "string") return { restored: true };
    const pending = this.owned(lease);
    if (pending.committedRevision) {
      if (fluxCredentialRevision(this.hooks.read()) !== pending.committedRevision) throw Object.assign(new Error("Flux runtime changed after save; restart to reconcile credentials."), { status: 409 });
      await this.hooks.apply(pending.before, external, true);
      pending.committedRevision = undefined;
    }
    return { restored: true };
  }
  finish(lease: unknown) { if (lease !== this.expiredLease || typeof lease !== "string") { this.owned(lease); this.release(); } return { finished: true }; }
  private release() { if (this.pending) clearTimeout(this.pending.timer); this.pending = undefined; this.hooks.fence(false); }
}
