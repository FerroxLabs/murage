import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type InternalCapabilityKind = "agents" | "connectors" | "computer";
export type InternalCapability = Readonly<{
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  kind: InternalCapabilityKind;
  skillAuthoring: boolean;
  expiresAt: number;
}>;
type Budget = { committed: number; pending: number };
type Generation = {
  botId: string;
  id: string;
  claims: Set<InternalCapability>;
  budgets: Record<"create" | "handoff", Budget>;
};
type Reservation = { commit(): boolean; release(): void };

/** Ephemeral authority for one dispatched turn. No claim is persisted or logged. */
export class InternalCapabilities {
  readonly #now: () => number;
  readonly #orphanMs: number;
  readonly #tombstoneLimit: number;
  readonly #tokens = new Map<string, InternalCapability>();
  readonly #generations = new Map<string, Generation>();
  readonly #providers = new Map<string, { threadId: string; generation: string }>();
  readonly #completed = new Set<string>();

  constructor(options: { now?: () => number; orphanMs?: number; tombstoneLimit?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#orphanMs = options.orphanMs ?? 30 * 24 * 60 * 60_000;
    this.#tombstoneLimit = options.tombstoneLimit ?? 4096;
    if (!(this.#orphanMs > 0) || !Number.isFinite(this.#orphanMs)
      || !Number.isInteger(this.#tombstoneLimit) || this.#tombstoneLimit < 1) {
      throw new Error("invalid internal capability bounds");
    }
  }

  begin(botId: string, threadId: string, generation: string = randomUUID()): string {
    if (!botId || !threadId || !generation) throw new Error("invalid internal turn owner");
    this.revokeThread(threadId);
    this.#generations.set(threadId, {
      botId, id: generation, claims: new Set(),
      budgets: { create: { committed: 0, pending: 0 }, handoff: { committed: 0, pending: 0 } },
    });
    return generation;
  }

  mint(input: Omit<InternalCapability, "expiresAt">): string {
    const owner = this.#generations.get(input.threadId);
    if (!owner || owner.id !== input.generation || owner.botId !== input.botId
      || !Number.isInteger(input.depth) || input.depth < 0
      || !["agents", "connectors", "computer"].includes(input.kind)
      || typeof input.skillAuthoring !== "boolean") throw new Error("invalid internal capability owner");
    const claim: InternalCapability = Object.freeze({ ...input, expiresAt: this.#now() + this.#orphanMs });
    const token = randomBytes(24).toString("hex");
    this.#tokens.set(token, claim);
    owner.claims.add(claim);
    return token;
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
    const owner = this.#generations.get(claim.threadId);
    return Boolean(owner && owner.id === claim.generation && owner.botId === claim.botId
      && owner.claims.has(claim) && claim.expiresAt > this.#now());
  }

  #providerKey(threadId: string, turnId: string): string { return JSON.stringify([threadId, turnId]); }

  bindProviderTurn(threadId: string, generation: string, turnId: string): boolean {
    const key = this.#providerKey(threadId, turnId);
    if (!turnId || this.#completed.has(key)) {
      this.revokeGeneration(threadId, generation);
      return false;
    }
    if (this.#generations.get(threadId)?.id !== generation) return false;
    const existing = this.#providers.get(key);
    if (existing && existing.generation !== generation) return false;
    this.#providers.set(key, { threadId, generation });
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

  revokeGeneration(threadId: string, generation: string): void {
    for (const [token, claim] of this.#tokens) {
      if (claim.threadId === threadId && claim.generation === generation) this.#tokens.delete(token);
    }
    if (this.#generations.get(threadId)?.id === generation) this.#generations.delete(threadId);
    for (const [key, owner] of this.#providers) {
      if (owner.threadId === threadId && owner.generation === generation) this.#providers.delete(key);
    }
  }

  revokeThread(threadId: string): void {
    const owner = this.#generations.get(threadId);
    if (owner) this.revokeGeneration(threadId, owner.id);
  }

  revokeBot(botId: string): void {
    for (const [threadId, owner] of this.#generations) if (owner.botId === botId) this.revokeThread(threadId);
  }

  revokeAll(): void {
    this.#tokens.clear();
    this.#generations.clear();
    this.#providers.clear();
    // Keep bounded terminal tombstones: a late handshake can still resolve.
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
