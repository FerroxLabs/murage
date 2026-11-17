// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** B0 contracts: r2 plus r3–r3.3, latest amendment wins. No runtime activation. */
export interface SignalBinding {
  connectionId: string;
  generation: number;
  /** Canonical lowercase UUID, never a phone number or a namespaced PNI. */
  ownAci: string;
  ownDeviceId: number;
  linkedAt: number;
  chiefBotId: string;
}

export type SignalControl = { kind: "delete"; target: number } | { kind: "timer"; seconds: number };
interface SignalEventFields {
  sourceAci: string;
  /** Positive integer; validated by B4 before constructing an event. */
  sourceDevice: number;
  destinationAci: string | null;
  envelopeDestination: string | null;
  /** Integer milliseconds from sentMessage; envelope equality is G0-dependent. */
  timestamp: number;
  group: boolean;
  /** Nonnegative integer seconds; zero disables expiry. */
  expiresInSeconds: number | null;
  longText: boolean;
}
export type SignalEvent = SignalEventFields & (
  | { variant: "sync-sent"; body: string | null; control: null }
  | { variant: "sync-control"; body: null; control: SignalControl }
  | { variant: "other"; body: null; control: null }
);

/** Both hooks receive the same persisted reply attempt, incremented before reserve. */
export type DeliveryAttempt = { deliveryId: string } & (
  | { purpose: "reply"; attempt: number }
  | { purpose: "notice"; attempt: 1 }
);
export type OutboxChunk =
  | { state: "reserved" | "written"; timestamp?: number }
  | { state: "confirmed"; timestamp: number };
/** Persist under (deliveryId, purpose, attempt); prune with the seven-day ledger window. */
export type OutboxEntry = DeliveryAttempt & { occurredAt: number; chunks: OutboxChunk[] };

export type ResendResult = "resent" | "already" | "full";
/** The service checks the persisted cooldown before calling the atomic ledger resend. */
export type ServiceResendResult = ResendResult | "too-early" | "not-resendable";
export type ReviewState = { deliveryId: string } & (
  | { state: "uncertain"; reason: "rate-limit"; response: string; partial: boolean; resendAfter: number }
  | { state: "uncertain"; reason: "delivery-unknown"; response: string; partial: boolean }
  | { state: "rejected"; reason: "invalid-request"; response?: string }
  | { state: "needs-review"; reason: "run-receipt-missing"; runId?: string; response?: never }
);
export type SignalProblem =
  | "link-required" | "identity-unavailable" | "identity-mismatch" | "needs-update"
  | "storage-permissions" | "storage-owner" | "revoke-recovery-required"
  | "kept-check" | "kept-busy" | "disk-full" | "storage-slow" | "ledger-write-failed" | "notes-stuck" | "reply-lost";
export interface SignalPreservation {
  progress: "check" | "busy" | "adoption" | "pending" | "durability" | "ready";
  canKeepBoth: boolean; canLink: boolean; dualCopy?: boolean;
}
export type ChannelState = { kept?: { kind: "earlier" | "moved" | "unreadable"; folder: string }; preservation?: SignalPreservation } & (
  | { state: "not-linked"; removeDeviceOnPhone?: boolean }
  | { state: "linking"; uri: string; expiresAt: number }
  | { state: "linked"; binding: SignalBinding; maskedNumber: string;
      reviews: ReviewState[]; reviewCount: number; repairedStorageOwner?: boolean }
  | { state: "blocked"; reason: SignalProblem; path?: string; scope?: "data-dir" | "signal";
      noteCount?: number; reviews?: ReviewState[]; reviewCount?: number });

/** UI payloads; routes must authenticate the owner and validate these at runtime. */
export type SignalAction =
  | { action: "link"; chiefBotId: string }
  | { action: "connect-again"; chiefBotId: string; removedDeviceOnPhone: boolean }
  | { action: "resend" | "leave-it" | "dismiss"; deliveryId: string }
  | { action: "disconnect" | "finish-revocation" | "fix-permissions" | "retry-notes"
      | "review" | "check-for-updates" | "open-storage" | "keep-both-and-link" }
  | { action: "show-folder"; path: string }
  | { action: "open-in-murage"; deliveryId: string };

export type RpcId = string | number;
/** Link/receive wire values are validated by source-derived adapters.ts schemas.
 * Unknown at this generic seam does not authorize a request. The unlink
 * contract requires reviewed proof bound to the implementation and device role.
 * Post-link requests use single-account process mode; no account parameter is allowed.
 */
export interface RpcParams {
  version: Record<string, never>;
  startLink: unknown;
  finishLink: unknown;
  listAccounts: Record<string, never>;
  subscribeReceive: Record<string, never>;
  send: { noteToSelf: true; message: string; timestamp?: number };
  unregister: unknown;
}
/** G0-dependent: known source shapes still require the real pinned-runtime fixtures. */
export interface RpcResults {
  version: { version: string };
  startLink: unknown;
  finishLink: unknown;
  listAccounts: Array<{ number: string; aci: string }>;
  subscribeReceive: unknown;
  send: SendResponse;
  unregister: unknown;
}
export type RpcMethod = keyof RpcParams;
export type RpcRequest<M extends RpcMethod = RpcMethod> = {
  [K in M]: { jsonrpc: "2.0"; id: RpcId; method: K; params: RpcParams[K] }
}[M];
export interface RpcError { code: number; message: string; data?: unknown }
export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | { jsonrpc: "2.0"; id: RpcId; result: RpcResults[M]; error?: never }
  | { jsonrpc: "2.0"; id: RpcId | null; error: RpcError; result?: never };
export interface RecipientAddress { uuid: string; number: string | null }
/** G0-dependent result tags; B5 validates the source fixture, B6 requires explicit success. */
export interface SendResponse {
  timestamp: number;
  results: Array<{ recipientAddress: RecipientAddress; type: string; retryAfterSeconds?: number }>;
}
/** r3.1 corrected wire shape: results live under error.data.response, not data. */
export interface RateLimitError {
  code: -5;
  message: string;
  data: { response: { timestamp: number; results: Array<{
    recipientAddress: RecipientAddress; type: "RATE_LIMIT_FAILURE"; retryAfterSeconds?: number;
  }> } };
}
export interface RpcNotification {
  jsonrpc: "2.0";
  method: "receive";
  /** G0-dependent: raw frames stay unknown until B4's safeParse. */
  params: unknown;
}

export interface ProcessHost {
  readonly generation: number;
  /** account = null only for linking; storage and runtime checks precede every spawn. */
  spawn(input: { generation: number; account: string | null }): Promise<void>;
  request<M extends RpcMethod>(request: RpcRequest<M>, options: {
    generation: number;
    /** Called synchronously at stdin.write, after all awaits; false means no write. */
    beforeWrite?: () => boolean;
  }): Promise<RpcResponse<M>>;
  onNotification(listener: (frame: { generation: number; notification: RpcNotification }) => void): () => void;
  pauseReading(): void;
  resumeReading(): void;
  /** Await exit; old-generation callbacks remain fenced after stop. */
  stop(): Promise<void>;
}
export type StorageVerdict = { state: "ok" } | {
  state: "blocked"; reason: "storage-owner" | "storage-permissions";
  scope: "data-dir" | "signal"; path: string;
};
export interface StorageGuard {
  check(): Promise<StorageVerdict>;
  /** Recheck after one permission repair; never change owners or repair DATA_DIR. */
  repair(): Promise<StorageVerdict>;
}
export type SendNoteToSelfInput = DeliveryAttempt & {
  text: string;
  signal?: AbortSignal;
  reserved?: string[];
  /** Missing/reclaimed ledger records count as redacted. Check before EVERY write,
   * with no await before stdin.write. Already-written chunks cannot be recalled. */
  isRedacted: () => boolean;
};
export interface Transport {
  /** Host-generated timestamp strings only; fsync reservations before any write. */
  reserve(input: DeliveryAttempt & { text: string }): Promise<string[]>;
  sendNoteToSelf(input: SendNoteToSelfInput): Promise<{ timestamps: number[] }>;
}
export interface SignalService {
  keepBothAndLinkAgain?(): Promise<ChannelState>;
  status(): ChannelState;
  link(input: { chiefBotId: string; removedDeviceOnPhone?: boolean }): Promise<ChannelState>;
  disconnect(): Promise<ChannelState>;
  /** Atomic replacement + settlement; never settle the original first. */
  resend(deliveryId: string): Promise<ServiceResendResult>;
  settle(deliveryId: string): Promise<void>;
  retryNotes(): Promise<void>;
  finishRevocation(): Promise<ChannelState>;
  fixPermissions(): Promise<ChannelState>;
}

export interface RateLimitNotSentProof { signalCliVersion: string; citation: string; reviewedBy: string }
export interface RuntimeArtifact { sha256: string }
export interface RuntimeTarget {
  jars: Array<RuntimeArtifact & { path: string }>;
  jre: RuntimeArtifact & { build: string };
  libsignal: RuntimeArtifact & { version: string; provenance:
    | { kind: "upstream-jar"; jar: string; entry: string }
    | { kind: "source-build"; tag: string; buildLog: string } };
}
/** Mirrors runtime-pin.schema.json. R owns values; B0 supplies no verified runtime.
 * Schema validation does not establish evidence, live-version equality, artifact
 * hashes, or the single-owner result gate: B5/B6 and G0 must verify those.
 */
export interface RuntimePin {
  contract: "murage-signal-runtime-pin/1.0";
  signalCliVersion: string;
  /** Required null for 1.0.19. Non-null needs a separate reviewed design change. */
  rateLimitNotSentProof: RateLimitNotSentProof | null;
  g0: { signalCliVersion: string; citation: string; signalCliCommit: string;
    manifestSha256: string; artifactSha256: string; reviewedBy: string; review: string } | null;
  releaseInputs: Record<"darwin-arm64" | "win32-x64" | "linux-x64", { url: string; sha256: string; layout: "prelinked-jre" }>;
  signalNetwork: RuntimeArtifact & {
    coordinate: "com.github.turasa:signal-network";
    version: string;
    syncProof: { authenticatedSenderDiscard: string; pniEndpointDiscard: string; sourceIdentityTrace: string[] } | null;
  };
  targets: Record<"darwin-arm64" | "win32-x64" | "linux-x64", RuntimeTarget>;
}
