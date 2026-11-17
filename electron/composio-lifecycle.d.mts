import type { ComposioAdmissionStore } from "./composio-admission-store.mjs";
export interface AdmissionStatus {
  outcome: "held" | "completed" | "deferred" | "failed";
  reason: string;
  retryAt?: number;
  status?: number;
  attempted: boolean;
}
export interface LifecycleResult extends AdmissionStatus {
  credentials?: Record<string, unknown>;
  response?: Response;
  preparation?: "complete" | "deferred" | "not-applicable";
  reconnected?: boolean;
  revoked?: boolean;
}
export interface LifecycleConfiguration {
  fluxBrokerUrl?: string;
  legacyBrokerUrl?: string;
  brokerUrl?: string;
  prepareLegacy?: boolean;
  registrationAllowed?: boolean;
  legacyClaimed?: boolean;
  brokerCredentials?: Array<{ url: string; tokenFingerprint: string }>;
  label?: string;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  existingCredentialTimeoutMs?: number;
  registrationTimeoutMs?: number;
}
export type ComposioIntent = {
  operation: "refresh" | "reconnect" | "claim" | "prepare" | "register" | "revoke" | "broker";
  force?: boolean;
  /** Explicit owner Retry only; refresh/restart never reset budgets. */
  retryRecovery?: boolean;
  rejectedTokenFingerprint?: string;
  token?: string;
  tokenFingerprint?: string;
  url?: string;
  init?: RequestInit;
};
export interface PendingRevocation {
  fluxBrokerUrl: string;
  token: string;
  // A protected pre-save record. Reconcile against the stored active token
  // after an ambiguous write or restart before selecting a token to revoke.
  replacement?: boolean;
  previous?: string | null;
  after?: string;
  attempts?: number;
  retryAt?: number;
  exhausted?: boolean;
}
export interface CustodyDelta { previous?: PendingRevocation; entry?: PendingRevocation }
export interface ComposioLifecycle {
  request(intent: ComposioIntent): Promise<LifecycleResult>;
  inspect(url?: string): AdmissionStatus;
  subscribe(listener: (status: AdmissionStatus) => void): () => void;
  dispose(): void;
}
export function createComposioLifecycle(dependencies: {
  getConfiguration(): LifecycleConfiguration;
  getCredentials(): Record<string, unknown>;
  readDurableCredentials?: () => Promise<Record<string, unknown>>;
  requireDurableCustody?: boolean;
  saveCredentials(next: Record<string, unknown>, snapshot: Record<string, unknown>): Promise<boolean | void>;
  store?: ComposioAdmissionStore;
  transport?: typeof fetch;
  lifecycleTransport?: typeof fetch;
  beforeTransport?: (url: string, init?: RequestInit) => Promise<void>;
  onDispatch?: (url: string, init?: RequestInit) => void;
  now?: () => number;
  monotonic?: () => number;
  random?: (operation?: "lifecycle" | "broker") => number;
  policy?: "desktop" | "dev";
  isOnline?: () => boolean;
  isShuttingDown?: () => boolean;
  log?: (line: string) => void;
  onAutomaticReplacement?: (event: { tokenFingerprint: string; at: number }) => void;
  trackRequest?: (work: Promise<LifecycleResult>) => void;
  onRateLimited?: (value?: string) => void;
  onTransientFailure?: (value?: string) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  backgroundCleanup?: boolean;
  pendingRevocationsVersion?: () => unknown;
  getPendingRevocations?: () => Array<PendingRevocation>;
  savePendingCredentialWrite?: (entries: Array<PendingRevocation>, delta?: CustodyDelta[]) => Promise<void | PendingRevocation[]>;
  savePendingRevocations?: (entries: Array<PendingRevocation>, delta?: CustodyDelta[]) => Promise<void | PendingRevocation[]>;
}): ComposioLifecycle;
