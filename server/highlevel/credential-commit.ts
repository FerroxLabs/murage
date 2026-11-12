// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/u);
const secret = z.string().min(32).max(4096).regex(/^[\x21-\x7e]+$/u);
export const highLevelRuntimeGrantSchema = z.object({
  connectionId: id, credentialVersion: z.number().int().positive(), grantId: id,
  enrollmentId: id, runtimeCapability: secret, grantCapability: secret,
}).strict();
export type HighLevelRuntimeGrant = z.infer<typeof highLevelRuntimeGrantSchema>;
/** Access leases and provider refresh credentials never belong in this bank. */
export const highLevelSecretBankSchema = z.object({
  schema: z.literal(1), revision: z.number().int().positive(),
  locatorKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  connection: highLevelRuntimeGrantSchema.nullable(),
}).strict();
export type HighLevelSecretBank = z.infer<typeof highLevelSecretBankSchema>;
export const highLevelCredentialIntentSchema = z.object({ flowId: id, versionId: id }).strict();
export type HighLevelCredentialIntent = z.infer<typeof highLevelCredentialIntentSchema>;
export const highLevelActiveMetadataSchema = z.object({
  connectionId: id, credentialVersion: z.number().int().positive(), grantId: id,
  locationId: id, connectionEpoch: z.number().int().nonnegative(),
  scopes: z.array(z.string().min(1).max(160)).max(200), provenance: z.literal("oauth-token-response"),
  bankRevision: z.number().int().positive(), bankDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type HighLevelActiveMetadata = z.infer<typeof highLevelActiveMetadataSchema>;
export type HighLevelProposedMetadata = Omit<HighLevelActiveMetadata, "bankRevision" | "bankDigest">;
export interface HighLevelCredentialProposal extends HighLevelCredentialIntent {
  commitId: string;
  expectedRevision: number;
  initializeKey: boolean;
  connection: HighLevelRuntimeGrant | null;
}
export interface HighLevelCredentialBootstrap {
  schema: 1;
  commitCredential: string;
  bank: HighLevelSecretBank | null;
}
export interface HighLevelCredentialCommitOptions {
  bootstrap: HighLevelCredentialBootstrap;
  /** True includes an unreadable/uncertain recovery inventory. */
  hasRecoveryState(): boolean;
  readMetadata(): HighLevelActiveMetadata | null;
  readConnectionEpoch(): number;
  /** Must durably CAS the existing monotonic epoch. Never write any bank values. */
  activateMetadata(metadata: HighLevelActiveMetadata | null, expectedEpoch: number): Promise<void>;
  now?: () => number;
}
export interface HighLevelCredentialStage extends HighLevelCredentialIntent {
  expectedRevision: number;
  expectedEpoch: number;
  connection: HighLevelRuntimeGrant | null;
  metadata: HighLevelProposedMetadata | null;
}
export function highLevelBankDigest(bank: HighLevelSecretBank): string {
  return createHash("sha256").update(JSON.stringify(highLevelSecretBankSchema.parse(bank))).digest("hex");
}
export function highLevelCommitAuthorized(authorization: unknown, credential: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(credential) || typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${credential}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function highLevelBankMatchesMetadata(bank: unknown, metadata: unknown): boolean {
  const b = highLevelSecretBankSchema.safeParse(bank), m = highLevelActiveMetadataSchema.safeParse(metadata);
  return b.success && m.success && b.data.connection !== null
    && b.data.revision === m.data.bankRevision && highLevelBankDigest(b.data) === m.data.bankDigest
    && b.data.connection.connectionId === m.data.connectionId && b.data.connection.grantId === m.data.grantId
    && b.data.connection.credentialVersion === m.data.credentialVersion;
}
/** Source stages only after owner confirmation. Only main may prepare/commit.
 * Pending stages expire after ten minutes and never survive a launch. */
export class HighLevelCredentialCommit {
  readonly #options: HighLevelCredentialCommitOptions;
  #bank: HighLevelSecretBank | null;
  #pending: { stage: HighLevelCredentialStage; proposal: HighLevelCredentialProposal; expiresAt: number } | null = null;
  #committing = false;
  #uncertain = false;
  #settled: { commitId: string; digest: string } | null = null;
  constructor(options: HighLevelCredentialCommitOptions) {
    if (options.bootstrap.schema !== 1 || !/^[a-f0-9]{64}$/u.test(options.bootstrap.commitCredential)) throw Error("invalid bootstrap");
    this.#options = options;
    this.#bank = options.bootstrap.bank === null ? null : highLevelSecretBankSchema.parse(options.bootstrap.bank);
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #assertCurrent(stage: HighLevelCredentialStage): void {
    if (this.#uncertain || stage.expectedRevision !== (this.#bank?.revision ?? 0)
      || stage.expectedEpoch !== this.#options.readConnectionEpoch()) throw Error("stale credential intent");
    if (this.#bank === null && (this.#options.hasRecoveryState() || this.#options.readMetadata() !== null)) throw Error("locator key unavailable");
    if (this.#options.readMetadata() !== null && !highLevelBankMatchesMetadata(this.#bank, this.#options.readMetadata())) throw Error("bank metadata mismatch");
  }
  stage(input: HighLevelCredentialStage): HighLevelCredentialIntent {
    if (this.#committing) throw Error("credential commit in progress");
    const intent = highLevelCredentialIntentSchema.parse({ flowId: input.flowId, versionId: input.versionId });
    const connection = input.connection === null ? null : highLevelRuntimeGrantSchema.parse(input.connection);
    const stage = structuredClone({ ...input, connection, ...intent });
    this.#assertCurrent(stage);
    if (stage.metadata === null) {
      if (connection !== null) throw Error("missing metadata");
    } else {
      const metadata = highLevelActiveMetadataSchema.parse({ ...stage.metadata, bankRevision: stage.expectedRevision + 1, bankDigest: "0".repeat(64) });
      if (connection === null || metadata.connectionEpoch !== stage.expectedEpoch + 1
        || metadata.connectionId !== connection.connectionId || metadata.grantId !== connection.grantId
        || metadata.credentialVersion !== connection.credentialVersion) throw Error("metadata version mismatch");
    }
    this.#pending = { stage, proposal: { ...intent, commitId: randomUUID(), expectedRevision: stage.expectedRevision,
      initializeKey: this.#bank === null, connection }, expiresAt: this.#now() + 600_000 };
    return intent;
  }
  prepare(authorization: unknown, input: unknown): HighLevelCredentialProposal {
    if (!highLevelCommitAuthorized(authorization, this.#options.bootstrap.commitCredential)) throw Error("unauthorized credential commit");
    const intent = highLevelCredentialIntentSchema.parse(input), pending = this.#pending;
    if (!pending || this.#committing || this.#now() >= pending.expiresAt
      || intent.flowId !== pending.stage.flowId || intent.versionId !== pending.stage.versionId) throw Error("stale credential intent");
    this.#assertCurrent(pending.stage);
    return structuredClone(pending.proposal);
  }
  async commit(authorization: unknown, input: unknown): Promise<{ ok: true }> {
    if (!highLevelCommitAuthorized(authorization, this.#options.bootstrap.commitCredential)) throw Error("unauthorized credential commit");
    const value = z.object({ commitId: id, bank: highLevelSecretBankSchema }).strict().parse(input);
    const digest = highLevelBankDigest(value.bank);
    if (this.#settled?.commitId === value.commitId && this.#settled.digest === digest) return { ok: true };
    const pending = this.#pending;
    if (!pending || this.#committing || this.#now() >= pending.expiresAt || value.commitId !== pending.proposal.commitId) throw Error("stale credential intent");
    this.#assertCurrent(pending.stage);
    if (value.bank.revision !== pending.stage.expectedRevision + 1
      || JSON.stringify(value.bank.connection) !== JSON.stringify(pending.proposal.connection)
      || (this.#bank !== null && value.bank.locatorKey !== this.#bank.locatorKey)) throw Error("bank version mismatch");
    const metadata = pending.stage.metadata === null ? null : highLevelActiveMetadataSchema.parse({ ...pending.stage.metadata, bankRevision: value.bank.revision, bankDigest: digest });
    this.#committing = true;
    // Once durable activation begins a rejection can mean an uncertain write.
    // Do not admit a replacement or repeat activation in this launch.
    this.#uncertain = true;
    try {
      await this.#options.activateMetadata(metadata, pending.stage.expectedEpoch);
      this.#bank = structuredClone(value.bank);
      this.#settled = { commitId: value.commitId, digest };
      this.#pending = null;
      this.#uncertain = false;
      return { ok: true };
    } finally { this.#committing = false; }
  }
  activeBank(): HighLevelSecretBank | null {
    const metadata = this.#options.readMetadata();
    if (this.#uncertain || metadata?.connectionEpoch !== this.#options.readConnectionEpoch() || !highLevelBankMatchesMetadata(this.#bank, metadata)) return null;
    return structuredClone(this.#bank);
  }
}

export interface HighLevelPrivateParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  removeListener(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: unknown): void;
}
/** Register before asking main, so startup ordering cannot lose the bank.
 * This accepts only an actual utility parent port supplied by the source owner;
 * no environment/config/HTTP bootstrap transport is supported. */
export function requestHighLevelCredentialBootstrap(port: HighLevelPrivateParentPort, timeoutMs = 15_000): Promise<HighLevelCredentialBootstrap> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (value?: unknown) => {
      clearTimeout(timer); port.removeListener("message", receive);
      const parsed = z.object({ schema: z.literal(1), commitCredential: z.string().regex(/^[a-f0-9]{64}$/u), bank: highLevelSecretBankSchema.nullable() }).strict().safeParse(value);
      if (parsed.success) resolve(parsed.data); else reject(Error("HighLevel secure bootstrap unavailable"));
    };
    const receive = (event: { data?: unknown }) => {
      const message = event.data as Record<string, unknown> | undefined;
      if (message?.type === "murage:highlevel-bootstrap" && message.requestId === requestId) finish(message.bootstrap);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    port.on("message", receive);
    try { port.postMessage({ type: "murage:highlevel-bootstrap-request", requestId }); } catch { finish(); }
  });
}
