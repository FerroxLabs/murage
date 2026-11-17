import { assertHumanPrincipal, type HumanPrincipal } from "./human-principals.ts";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { forgetAllVenueReadTurns, forgetVenueReadTurn } from "./venue-read-turns.ts";
import { forgetAllVenuePostTurns, forgetVenuePostTurn } from "./venue-post-turns.ts";
import { forgetAllEmailTurns, forgetEmailTurn } from "./email/email-turns.ts";
import { forgetAllPhoneTurns, forgetPhoneTurn } from "./phone-calls/phone-turns.ts";
import { assertConsumingBinding, type ConsumingTurnBinding } from "./consuming-turn-response.ts";

export type InternalCapabilityKind = "agents" | "connectors" | "computer" | "memory" | "mcp" | "device" | "highlevel" | "turn-release";
export type InternalCapability = Readonly<{
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  kind: InternalCapabilityKind;
  skillAuthoring: boolean;
  expiresAt: number;
  humanPrincipal?: HumanPrincipal;
  /** The turn's words were not proven to be the owner's: memory reads it as
   * a non-owner audience (server/memory/policy.ts). */
  notOwnerAudience?: true;
}>;
type Budget = { committed: number; pending: number };
type Generation = {
  botId: string;
  humanPrincipal?: HumanPrincipal;
  id: string;
  claims: Set<InternalCapability>;
  budgets: Record<"create" | "handoff", Budget>;
  /** A team create_bot refused this turn (1.0.16 TEAM-SECTION): the turn may not then file bots in its own team instead. */
  refusedTeam?: string;
};
type Reservation = { commit(): boolean; release(): void };

/** Which capability kind a /api/internal/ path needs. One place, so the mapping
 * is tested and a new service cannot quietly fall through to "agents". */
export function requiredInternalKind(path: string): InternalCapabilityKind {
  if (path === "/api/internal/turn-release/v1/verdict") return "turn-release";
  if (path.startsWith("/api/internal/memory/")) return "memory";
  if (path.startsWith("/api/internal/connectors/")) return "connectors";
  if (path.startsWith("/api/internal/mcp-remote/")) return "mcp";
  if (path.startsWith("/api/internal/box/v1/")) return "computer";
  if (path.startsWith("/api/internal/device/")) return "device";
  // the native HighLevel CRM host (GAP-HIGHLEVEL-109 section 5.2)
  if (path.startsWith("/api/internal/highlevel/")) return "highlevel";
  if (["/api/internal/computer-control", "/api/internal/computer-activity", "/api/internal/headless-browser", "/api/internal/unified-browser", "/api/internal/host-computer"].includes(path)) return "computer";
  return "agents";
}

/** Ephemeral authority for one dispatched turn. No claim is persisted or logged. */
export class InternalCapabilities {
  // Reader lifetime owner: askcards-flake-b; turn teardown owner: internal capabilities.
  readonly #memoryViews = new WeakMap<InternalCapability, Map<string, () => void>>();
  readonly #releaseControls = new WeakMap<InternalCapability, Readonly<{ binding: ConsumingTurnBinding; instanceId: string }>>();
  readonly #now: () => number;
  readonly #orphanMs: number;
  readonly #tombstoneLimit: number;
  readonly #tokens = new Map<string, InternalCapability>();
  /** 7C P3: dead credentials of retired generations, by token digest, so a stale token can be told from garbage (401, not the sealed binding 409). Bounded, oldest first; holds no live authority. */
  readonly #retired = new Map<string, Readonly<{ threadId: string; generation: string }>>();
  readonly #generations = new Map<string, Generation>();
  readonly #providers = new Map<string, { threadId: string; generation: string }>();
  readonly #completed = new Set<string>();
  /** Which generation dispatched each provider turn. Unlike #providers this
   * outlives the generation's revocation, which a Stop performs at once while
   * the stopped turn's terminal event arrives only when its engine closes. */
  readonly #dispatchedBy = new Map<string, string>();
  /** The reverse: which provider turn each generation dispatched, kept as long
   * as #dispatchedBy and for the same reason (the reply check runs after a Stop). */
  readonly #turnOf = new Map<string, string>();

  constructor(options: { now?: () => number; orphanMs?: number; tombstoneLimit?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#orphanMs = options.orphanMs ?? 30 * 24 * 60 * 60_000;
    this.#tombstoneLimit = options.tombstoneLimit ?? 4096;
    if (!(this.#orphanMs > 0) || !Number.isFinite(this.#orphanMs)
      || !Number.isInteger(this.#tombstoneLimit) || this.#tombstoneLimit < 1) {
      throw new Error("invalid internal capability bounds");
    }
  }

  begin(botId: string, threadId: string, generation: string = randomUUID(), humanPrincipal?: HumanPrincipal): string {
    if (!botId || !threadId || !generation) throw new Error("invalid internal turn owner");
    this.revokeThread(threadId);
    this.#generations.set(threadId, {
      botId, humanPrincipal, id: generation, claims: new Set(),
      budgets: { create: { committed: 0, pending: 0 }, handoff: { committed: 0, pending: 0 } },
    });
    return generation;
  }

  mint(input: Omit<InternalCapability, "expiresAt">): string {
    const owner = this.#generations.get(input.threadId);
    if (!owner || owner.id !== input.generation || owner.botId !== input.botId
      || JSON.stringify(owner.humanPrincipal) !== JSON.stringify(input.humanPrincipal)
      || !Number.isInteger(input.depth) || input.depth < 0
      || !["agents", "connectors", "computer", "memory", "mcp", "device", "highlevel"].includes(input.kind)
      || typeof input.skillAuthoring !== "boolean") throw new Error("invalid internal capability owner");
    const claim: InternalCapability = Object.freeze({ ...input, expiresAt: this.#now() + this.#orphanMs });
    const token = randomBytes(24).toString("hex");
    this.#tokens.set(token, claim);
    owner.claims.add(claim);
    return token;
  }

  /** Separate authority: ordinary tool tokens cannot mint or use release verdicts.
   * The binding is retained here by identity, never reconstructed from the body. */
  mintReleaseControl(binding: ConsumingTurnBinding, instanceId: string): string {
    assertConsumingBinding(binding);
    const { botId, threadId, dispatchGeneration: generation } = binding.identity;
    const owner = this.#generations.get(threadId);
    if (!owner || owner.botId !== botId || owner.id !== generation || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error("MEMORY_CONTEXT_REVOKED");
    const claim: InternalCapability = Object.freeze({ botId, threadId, generation, kind: "turn-release", depth: 0,
      skillAuthoring: false, humanPrincipal: owner.humanPrincipal, expiresAt: this.#now() + this.#orphanMs });
    const token = randomBytes(24).toString("hex");
    this.#tokens.set(token, claim); owner.claims.add(claim);
    this.#releaseControls.set(claim, Object.freeze({ binding, instanceId }));
    return token;
  }

  releaseControl(claim: InternalCapability) {
    return claim.kind === "turn-release" && this.isActive(claim) ? this.#releaseControls.get(claim) : undefined;
  }

  resolve(header: string | string[] | undefined): InternalCapability | null {
    if (typeof header !== "string" || !/^Bearer [a-f0-9]{48}$/.test(header)) return null;
    const got = Buffer.from(header);
    for (const [token, claim] of this.#tokens) {
      if (!this.isActive(claim)) {
        this.#tokens.delete(token);
        this.#generations.get(claim.threadId)?.claims.delete(claim);
        continue;
      }
      if (timingSafeEqual(got, Buffer.from(`Bearer ${token}`))) return claim;
    }
    return null;
  }

  isActive(claim: InternalCapability): boolean {
    if (claim.expiresAt <= this.#now()) { forgetVenueReadTurn(claim.generation); forgetVenuePostTurn(claim.generation); forgetEmailTurn(claim.generation); forgetPhoneTurn(claim.generation); }
    if(claim.humanPrincipal){try{assertHumanPrincipal(claim.humanPrincipal);}catch{this.#releaseMemoryViews(claim);return false;}}
    const owner = this.#generations.get(claim.threadId);
    const active = Boolean(owner && owner.id === claim.generation && owner.botId === claim.botId
      && owner.claims.has(claim) && claim.expiresAt > this.#now());
    if (!active) this.#releaseMemoryViews(claim);
    return active;
  }

  /** One lease per claim/view; the turn's existing finally/revocation paths release every lease. */
  retainMemoryView(claim: InternalCapability, key: string, retain: () => () => void): void {
    if (claim.kind !== 'memory' || !this.isActive(claim)) throw new Error('MEMORY_UNAUTHORIZED');
    let views = this.#memoryViews.get(claim);
    if (!views) this.#memoryViews.set(claim, views = new Map());
    if (!views.has(key)) views.set(key, retain());
  }

  #releaseMemoryViews(claim: InternalCapability): void {
    const views = this.#memoryViews.get(claim);
    this.#memoryViews.delete(claim);
    if (views) for (const release of views.values()) release();
  }

  #providerKey(threadId: string, turnId: string): string { return JSON.stringify([threadId, turnId]); }


  bindProviderTurn(threadId: string, generation: string, turnId: string): boolean {
    const key = this.#providerKey(threadId, turnId);
    if (turnId && !this.#dispatchedBy.has(key)) {
      this.#dispatchedBy.set(key, generation);
      while (this.#dispatchedBy.size > this.#tombstoneLimit) {
        this.#dispatchedBy.delete(this.#dispatchedBy.keys().next().value!);
      }
      const turnKey = JSON.stringify([threadId, generation]);
      if (!this.#turnOf.has(turnKey)) {
        this.#turnOf.set(turnKey, turnId);
        while (this.#turnOf.size > this.#tombstoneLimit) {
          this.#turnOf.delete(this.#turnOf.keys().next().value!);
        }
      }
    }
    if (!turnId || this.#completed.has(key)) {
      this.revokeGeneration(threadId, generation);
      return false;
    }
    if (this.#generations.get(threadId)?.id !== generation) return false;
    const existing = this.#providers.get(key);
    if (existing && existing.generation !== generation) return false;
    this.#providers.set(key, { threadId, generation });
    // A later generation that re-binds an already bound turn id is named for that turn too (the dispatcher stays the first).
    const acceptedKey = JSON.stringify([threadId, generation]);
    if (!this.#turnOf.has(acceptedKey)) {
      this.#turnOf.set(acceptedKey, turnId);
      while (this.#turnOf.size > this.#tombstoneLimit) this.#turnOf.delete(this.#turnOf.keys().next().value!);
    }
    return true;
  }

  completeProviderTurn(threadId: string, turnId: string): void {
    if (!turnId) return;
    const key = this.#providerKey(threadId, turnId);
    this.#completed.add(key);
    while (this.#completed.size > this.#tombstoneLimit) {
      this.#completed.delete(this.#completed.values().next().value!);
    }
    const owner = this.#providers.get(key);
    if (owner) this.revokeGeneration(owner.threadId, owner.generation);
  }

  /** The generation that dispatched this provider turn, whether or not it is
   * still active; undefined when the turn was never bound (or has aged out). */
  dispatchingGeneration(threadId: string, turnId: string): string | undefined {
    return turnId ? this.#dispatchedBy.get(this.#providerKey(threadId, turnId)) : undefined;
  }

  /** The provider turn this generation dispatched, whether or not it is still active; undefined before it was bound. */
  providerTurnOf(threadId: string, generation: string): string | undefined {
    return generation ? this.#turnOf.get(JSON.stringify([threadId, generation])) : undefined;
  }

  /** The generation that currently owns `threadId`, or undefined once it was
   * revoked (a bound provider turn completed, or an explicit revocation). */
  activeGeneration(threadId: string): string | undefined {
    return this.#generations.get(threadId)?.id;
  }

  revokeGeneration(threadId: string, generation: string): void {
    // the generation's venue-read record goes with its claims (BOT-VENUE-AWARENESS-106 4.2)
    forgetVenueReadTurn(generation);
    forgetVenuePostTurn(generation);
    // and its email-mount record (BOT-EMAIL-MURAGE-109 3.1)
    forgetEmailTurn(generation);
    // and its phone-mount record (BOT-CALLS-1020 3b)
    forgetPhoneTurn(generation);
    for (const [token, claim] of this.#tokens) {
      if (claim.threadId === threadId && claim.generation === generation) { this.#releaseMemoryViews(claim); this.#tokens.delete(token); this.#retire(token, claim); }
    }
    if (this.#generations.get(threadId)?.id === generation) this.#generations.delete(threadId);
    for (const [key, owner] of this.#providers) {
      if (owner.threadId === threadId && owner.generation === generation) this.#providers.delete(key);
    }
  }

  #retire(token: string, claim: InternalCapability): void {
    this.#retired.set(createHash("sha256").update(token).digest("hex"), Object.freeze({ threadId: claim.threadId, generation: claim.generation }));
    if (this.#retired.size > 4096) this.#retired.delete(this.#retired.keys().next().value!);
  }

  /** The thread and generation a header's token belonged to before its generation was retired; null for live, expired or unknown tokens. Reads no binding. */
  retiredOwner(header: string | string[] | undefined): Readonly<{ threadId: string; generation: string }> | null {
    if (typeof header !== "string" || !/^Bearer [a-f0-9]{48}$/.test(header)) return null;
    return this.#retired.get(createHash("sha256").update(header.slice(7)).digest("hex")) ?? null;
  }

  revokeThread(threadId: string): void {
    const owner = this.#generations.get(threadId);
    if (owner) this.revokeGeneration(threadId, owner.id);
  }

  revokeBot(botId: string): void {
    for (const [threadId, owner] of this.#generations) if (owner.botId === botId) this.revokeThread(threadId);
  }

  revokeAll(): void {
    for (const claim of this.#tokens.values()) this.#releaseMemoryViews(claim);
    forgetAllVenueReadTurns();
    forgetAllVenuePostTurns();
    forgetAllEmailTurns();
    forgetAllPhoneTurns();
    this.#tokens.clear();
    this.#generations.clear();
    this.#providers.clear();
    // Keep bounded terminal tombstones: a late handshake can still resolve.
  }

  /** Remember, for the rest of this turn, that create_bot refused the team it named. */
  markTeamRefused(claim: InternalCapability, team: string): void {
    if (this.isActive(claim)) this.#generations.get(claim.threadId)!.refusedTeam = team;
  }

  /** The team create_bot refused earlier in this turn, if any. */
  teamRefused(claim: InternalCapability): string | undefined {
    return this.isActive(claim) ? this.#generations.get(claim.threadId)!.refusedTeam : undefined;
  }

  reserve(claim: InternalCapability, kind: "create" | "handoff", limit = 4): Reservation | null {
    if (!this.isActive(claim) || !Number.isInteger(limit) || limit < 1) return null;
    const budget = this.#generations.get(claim.threadId)!.budgets[kind];
    if (budget.committed + budget.pending >= limit) return null;
    budget.pending++;
    let state: "pending" | "committed" | "released" = "pending";
    return {
      commit: () => {
        if (state !== "pending") return state === "committed" && this.isActive(claim);
        budget.pending--;
        if (!this.isActive(claim)) { state = "released"; return false; }
        budget.committed++;
        state = "committed";
        return true;
      },
      release: () => {
        if (state !== "pending") return;
        budget.pending--;
        state = "released";
      },
    };
  }
}
