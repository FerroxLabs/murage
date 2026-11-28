// M9 (BEDROCK-ENGINE-1023 r2 sections 1-2): the binding store. One per desktop server, created in server/index.ts and injected into the
// claude driver as `bindings`. Owner: M9 builder lane. It keeps the in-memory generation counter and the in-flight check; the persisted
// `bedrock` block lives in the instance config and is written through the same writer the account route uses (never to config.json
// directly), so an account rename after a re-bind cannot restore an old block (Opus M1).
import { BEDROCK_PROFILE_RE, BEDROCK_REGION_RE, decodeBedrockBinding, type BedrockBinding } from "./bedrock-env.ts";

export const WRITE_WAIT_MS = 10_000;
export const BEDROCK_BUSY_TEXT = "Engine setup is finishing. Try again shortly.";

export interface BindingDeps {
  /** The live saved `bedrock` block of an instance (undefined: no such instance or no block). */
  readBlock(instanceId: string): unknown;
  /** Set the in-memory instance's config.bedrock, then persist through the account config writer. */
  writeBlock(instanceId: string, block: BedrockBinding): Promise<void>;
  /** providerConfigBusy: held for whole account operations; the store waits while it is set and holds it for its own write only. */
  busy: { get(): boolean; set(held: boolean): void };
  /** STS identity for a profile/region: the account id, or a thrown error whose message is the redacted-by-caller reason. */
  check(input: { instanceId: string; profile: string; region: string; signal?: AbortSignal }): Promise<string>;
  /** Bounded wait granularity, overridable by tests. */
  writeWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SaveResult =
  | { ok: true; binding: BedrockBinding }
  | { ok: false; reason: string; busy?: true; superseded?: true };

export class BedrockBindings {
  private readonly gen = new Map<string, number>();
  private readonly inflight = new Map<string, { gen: number; promise: Promise<unknown> }>();
  private readonly deps: BindingDeps;
  constructor(deps: BindingDeps) { this.deps = deps; }

  /** The persisted binding, or null (UNBOUND) for a missing, partial or hand-edited block. */
  read(instanceId: string): BedrockBinding | null { return decodeBedrockBinding(this.deps.readBlock(instanceId)); }

  /** FENCE source: the epoch from the store, never from a driver's frozen instance config. */
  epoch(instanceId: string): number { return this.read(instanceId)?.epoch ?? 0; }

  checking(instanceId: string): boolean { return this.inflight.has(instanceId); }

  /** Wait until no check for this instance is in flight (bounded by the STS timeout inside the check). */
  async awaitCheck(instanceId: string): Promise<void> {
    for (let slot = this.inflight.get(instanceId); slot; slot = this.inflight.get(instanceId)) {
      await slot.promise.catch(() => {});
      if (this.inflight.get(instanceId) === slot) return;
    }
  }

  /** Save (new profile/region) or Check again (omit both: reuses the bound ones). */
  save(instanceId: string, input?: { profile: string; region: string }, signal?: AbortSignal): Promise<SaveResult> {
    // r3 (ASTRA H1): a new account holds a PENDING block (profile and region only, no accountId or epoch), which read() calls UNBOUND; Check
    // again with no input takes the pending block's own values, so the first bind of a new account reaches IDENTITY.
    const prev = this.read(instanceId) ?? pendingBlock(this.deps.readBlock(instanceId));
    const profile = input?.profile ?? prev?.profile;
    const region = input?.region ?? prev?.region;
    if (!profile || !BEDROCK_PROFILE_RE.test(profile) || !region || !BEDROCK_REGION_RE.test(region)) return Promise.resolve({ ok: false, reason: "Enter an AWS profile name and a region such as us-east-1." });
    const g = (this.gen.get(instanceId) ?? 0) + 1;
    this.gen.set(instanceId, g);
    const run = this.run(instanceId, g, profile, region, signal);
    const slot = { gen: g, promise: run };
    this.inflight.set(instanceId, slot);
    void run.finally(() => { if (this.inflight.get(instanceId) === slot) this.inflight.delete(instanceId); });
    return run;
  }

  private async run(instanceId: string, g: number, profile: string, region: string, signal?: AbortSignal): Promise<SaveResult> {
    let accountId: string;
    try { accountId = await this.deps.check({ instanceId, profile, region, signal }); }
    catch (error) {
      return g === this.gen.get(instanceId) ? { ok: false, reason: error instanceof Error ? error.message : String(error) } : { ok: false, reason: "superseded", superseded: true };
    }
    if (g !== this.gen.get(instanceId)) return { ok: false, reason: "superseded", superseded: true };
    // The write waits while providerConfigBusy is set, for at most writeWaitMs; on expiry the previous state stays.
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const limit = this.deps.writeWaitMs ?? WRITE_WAIT_MS;
    let waited = 0;
    while (this.deps.busy.get()) {
      if (waited >= limit) return { ok: false, reason: BEDROCK_BUSY_TEXT, busy: true };
      await sleep(50); waited += 50;
    }
    if (g !== this.gen.get(instanceId)) return { ok: false, reason: "superseded", superseded: true };
    const binding: BedrockBinding = { profile, region, accountId, epoch: (this.read(instanceId)?.epoch ?? 0) + 1 };
    this.deps.busy.set(true);
    try { await this.deps.writeBlock(instanceId, binding); } finally { this.deps.busy.set(false); }
    return { ok: true, binding };
  }
}

/** The profile and region of a saved block that is not bound yet (a new account): strings only, the caller still checks both patterns. */
function pendingBlock(raw: unknown): { profile?: string; region?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return { ...(typeof o.profile === "string" ? { profile: o.profile } : {}), ...(typeof o.region === "string" ? { region: o.region } : {}) };
}

/** The production read and write of the persisted block, over the live `cfg` and the account config writer (`persist` is
 * `replaceClaudeAccountInstances(persistableClaudeInstances(cfg))` in server/index.ts). The in-memory instance is updated first, so an account
 * rename (PATCH) that reads cfg after a re-bind persists the new block, never an old one (Opus M1, W24). */
export function bedrockCfgDeps(cfg: { instances?: Record<string, { driver: string; config?: unknown }> }, persist: () => void): Pick<BindingDeps, "readBlock" | "writeBlock"> {
  return {
    readBlock: (id) => { const config = cfg.instances?.[id]?.config; return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).bedrock : undefined; },
    writeBlock: async (id, block) => {
      const entry = cfg.instances?.[id];
      if (!entry || entry.driver !== "claudeAgent") throw new Error("Claude account not found.");
      entry.config = { ...(entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config : {}), bedrock: block };
      persist();
    },
  };
}
