// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export interface CloudHomeFetchInit { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | object; signal?: AbortSignal }
export interface CloudHomeClient {
  /** Always false: an unreachable home fails the call at once; nothing is queued. */
  readonly queuesWrites: false;
  /** Step-up aware fetch. `path` is a path+query on the home. Throws CloudHomeError on unreachable / pin / version / cancelled step-up. */
  fetch(homeId: string, path: string, init?: CloudHomeFetchInit): Promise<Response>;
  /** Main-driven step-up for a write the home refused with 403 "step-up required": native confirm, sign over main's bytes, ONE retry. */
  stepUpRetry(homeId: string, path: string, init?: CloudHomeFetchInit): Promise<Response>;
  pairedHomes(): Promise<{ homeId: string; origin: string }[]>;
  /** Pin + version + token check for the Cloud window's banner. Never throws. */
  status(homeId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Main only. Verifies pin + version, refreshes when due, returns the Bearer token. */
  getAccessToken(homeId: string): Promise<string>;
  /** Sync; null until the home has been loaded (call pinnedOrigin or getAccessToken first). */
  homeOrigin(homeId: string): string | null;
  pinnedOrigin(homeId: string): Promise<string>;
  activate(homeId: string): Promise<void>;
  deactivate(homeId: string): void;
  /** WP1 CloudHomeProvider. */
  provider(homeId: string): { homeId: string; origin: string; getAccessToken: () => string | null } | null;
  onAuthFailure(homeId: string): Promise<boolean>;
  unpair(homeId: string): Promise<void>;
  forgetTokens(): void;
  /** Main only. Pin + version check, fresh token and the native step-up confirmation for a GET upgrade to an /api path. */
  authorizeUpgrade(homeId: string, path: string): Promise<{ url: string; origin: string; headers: Record<string, string> }>;
  listHomes(input: { cpToken: string; cpEnvironment?: "staging" | "prod" }): Promise<{ id: string; name: string; status: string; publicOrigin: string | null }[]>;
  pairWithDeviceCode(input: ({ homeId: string; homeOrigin: string; code: string; account: string } | { package: string }) & { cpEnvironment?: "staging" | "prod"; keys: unknown }): Promise<{ homeId: string; deviceId: string; publicOrigin: string; generation: number }>;
  /** ADD DEVICE on an already-paired desktop: mint a code bound to the new device's keys (CP-signed body + home step-up). */
  /** Door v2: make (or reuse) the sealed pending key pair, then open the system browser on the site's connect page. */
  startConnect(input?: { cpEnvironment?: "staging" | "prod" }): Promise<{ pending: true; startedAt: number }>;
  /** Cancel wins over an exchange in flight: a device the home enrolled meanwhile is removed there again (confirmed, or queued until it is). */
  cancelConnect(): Promise<{ pending: false }>;
  /** `open` is false while the selected control plane has no pinned verification key: Cloud is not open on this build yet. */
  /** `attempted`: a redeem was sent and its answer may be lost; the key is kept and reused. `lastResult` stays until the next Connect or ten minutes. */
  connectStatus(input?: { cpEnvironment?: "staging" | "prod" }): Promise<{ pending: boolean; startedAt: number | null; attempted: boolean; paired: boolean; lastResult: { code: string; message: string; at: number; retryAfterMs?: number } | null; disconnected: boolean; open: boolean }>;
  /** Every start and door open: finish an enrolled Connect, then remove the devices still queued for revocation. Never throws. */
  settleUnfinished(): Promise<void>;
  /** Only while a Connect is pending; { ignored: true } otherwise. Throws CloudHomeError (bad-link, other-connect, expired, hold-required, too-many-devices, refused, too-many-tries, home-busy, lost, pin-mismatch). */
  acceptDoorLink(url: string): Promise<{ ignored: true } | { homeId: string; deviceId: string; publicOrigin: string; generation: number }>;
  pasteDoorLink(text: string): Promise<{ ignored: true } | { homeId: string; deviceId: string; publicOrigin: string; generation: number }>;
  /** Silent reattach. A 403 forgets the record and answers { disconnected: true }. */
  resume(homeId: string): Promise<{ ok: true } | { ok: false; disconnected?: true; code: string; message: string }>;
  disconnect(homeId: string): Promise<{ disconnected: true }>;
  mintDeviceCode(input: { homeId: string; cpToken: string; cpEnvironment?: "staging" | "prod"; request: string }): Promise<{ code: string; expiresIn?: number; package: string }>;
}
export class CloudHomeError extends Error { code: string; status?: number }
export const COPY: Readonly<Record<string, string>>;
/** MURAGE_CLOUD_CP wins; otherwise a packaged build is "prod" (murage.ai), a development run "staging". */
export function resolveCloudCpEnvironment(input?: { isPackaged?: boolean; environment?: Record<string, string | undefined> }): "staging" | "prod";
export function createCloudHomeClient(options: {
  store: unknown; fetch?: typeof fetch; appVersion: string;
  confirmStepUp: (input: { homeId: string; method: string; path: string; body: unknown }) => Promise<boolean>;
  cp?: unknown; cpEnvironment?: "staging" | "prod"; schedule?: (fn: () => void, ms: number) => unknown; now?: () => number; refreshAfterMs?: number; healthTtlMs?: number; requestTimeoutMs?: number;
  openExternal?: (url: string) => unknown; generateKeys?: () => any;
}): CloudHomeClient;
export function createNativeStepUpConfirm(options: { systemPreferences: unknown; dialog: unknown; platform?: string; getWindow?: () => unknown; resolveBotName?: (homeId: string, botId: string) => Promise<string | undefined> }): (input: { homeId?: string; method: string; path: string; body?: unknown }) => Promise<boolean>;
export function buildDeviceRequest(keys: { sessionPublicKey: string; assertionPublicKey: string }): string;
export function parseDeviceRequest(text: string): { scope: "owner-desktop"; publicKey: string; assertionKey: string };
export function buildDeviceCodePackage(input: { homeId: string; homeOrigin: string; account: string; code: string }): string;
export function parseDeviceCodePackage(text: string): { homeId: string; homeOrigin: string; account: string; code: string };
export function stepPurpose(method: string, pathWithQuery: string, body: unknown): string;
export function verifyHomeKey(envelope: unknown, jwk: unknown, now?: number): Record<string, unknown>;
