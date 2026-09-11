// A project API key (ak_…) creates/reuses one Composio Session. That
// Session owns connection state, auth links and the MCP endpoint.
import { saveConfig, type AppConfig } from "./config.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";

function apiBase() {
  return (process.env.MURAGE_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}

function toolkitBase() {
  return (process.env.MURAGE_COMPOSIO_TOOLKITS_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3`).replace(/\/$/, "");
}

const sessionResponseSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1) }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
    /** toolkit slug → the project's own auth config the Session uses for it */
    auth_configs: z.record(z.string(), z.string()).optional(),
  }).optional(),
});
type SessionResponse = z.infer<typeof sessionResponseSchema>;

// A project's own auth configs (bring-your-own OAuth app, API-key toolkits
// such as twitter that Composio does not manage). A Session only uses one
// when it was created with the config's id under `auth_configs`.
const authConfigItemSchema = z.object({
  id: z.string().optional(),
  status: z.string().nullable().optional(),
  is_composio_managed: z.boolean().optional(),
  is_enabled_for_tool_router: z.boolean().nullable().optional(),
  last_updated_at: z.string().nullable().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
const authConfigsPageSchema = z.object({
  items: z.array(authConfigItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});
/** toolkit slug (lowercase) → auth config id */
type AuthConfigMap = Record<string, string>;
const MAX_AUTH_CONFIG_PAGES = 20;

export interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

export interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;

const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
type ToolkitItem = z.infer<typeof toolkitItemSchema>;
const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});

const connectorServiceSchema = z.object({
  connected: z.boolean(),
  pending: z.boolean().optional(),
  status: z.string().optional(),
  accounts: z.array(z.object({ id: z.string(), alias: z.string().optional(), status: z.string() })).optional(),
});
const connectorServicesResponseSchema = z.object({ services: z.record(z.string(), connectorServiceSchema).optional() });
const removalResponseSchema = z.object({ removed: z.number() });
const authUrlResponseSchema = z.object({ url: z.string().optional() });
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });

const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;

interface SessionCreateRequest {
  user_id: string;
  manage_connections: { enable: boolean; enable_wait_for_connections: boolean; enable_connection_removal: boolean };
  multi_account: typeof MULTI_ACCOUNT_CONFIG;
  /** toolkit slug → the project's own auth config id; named only when the
   * project has its own configs, since a Session cannot be edited afterwards
   * and an empty map would pin "no custom auth" for the Session's lifetime */
  auth_configs?: AuthConfigMap;
}
const MAX_CONNECTED_ACCOUNT_PAGES = 100;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ComposioMcpIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface IntegrationContext {
  harnessUrl: string;
  commsToken: string;
  botId: string;
  threadId: string;
}

export type BrokerKind = "flux" | "legacy";
export interface BrokerAccess { url: string; token: string; kind: BrokerKind }
export type LegacyClaimState = "none" | "offered" | "pending" | "claimed" | "conflict" | "abandoned";
export interface LegacyClaim {
  state: LegacyClaimState;
  code?: string;
  installationId?: string;
  at?: string;
  confirmPending?: boolean;
}
export type AccountKind = "personal" | "shared";
export type ConnectorMigrationState =
  | "none" | "legacy" | "offered" | "pending" | "claimed" | "claim-conflict" | "abandoned" | "moved-elsewhere";
export interface ConnectorMigration {
  state: ConnectorMigrationState;
  legacyUntil: string | null;
  code?: string;
  accountKind?: AccountKind;
  tokenError?: string;
  installationId?: string;
  at?: string;
}

// The Murage Worker broker (legacy), as the desktop shell last sent it.
let managedBrokerAccess: { url: string; token: string } | null | undefined;
// The FluxRouter-hosted broker: its URL (set whenever the release or a QA
// override turns it on) and the harness-only broker token minted from the
// stored Flux key. `undefined` = no desktop message yet, read the env.
let managedFluxBrokerUrl: string | undefined;
let managedFluxAccess: { url: string; token: string } | null | undefined;
let managedLegacyClaim: LegacyClaim | undefined;
let managedAccountKind: AccountKind | null | undefined;
let managedTokenError: string | null | undefined;
let managedLegacyUntil: string | undefined;
/** The Worker answered 410 migrated_to_flux for an install this device never
 * claimed: somebody else moved these connections. */
let legacyMovedElsewhere = false;

const managedBrokerMessageSchema = z.record(z.string(), z.unknown());
const managedBrokerToken = /^[0-9a-f]{64}$/;
const legacyClaimSchema = z.object({
  state: z.enum(["none", "offered", "pending", "claimed", "conflict", "abandoned"]),
  code: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  installationId: z.string().max(64).optional(),
  at: z.string().max(64).optional(),
  confirmPending: z.boolean().optional(),
});
const errorCodeSchema = z.string().regex(/^[a-z_]{1,64}$/);

function normalizeManagedBrokerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The connected-apps service URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The connected-apps service must use HTTPS");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function applyManagedBrokerMessage(message: unknown): boolean {
  const parsed = managedBrokerMessageSchema.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.type !== "murage:managed-composio" ||
    !Object.hasOwn(parsed.data, "access")
  ) {
    return false;
  }
  const data = parsed.data;
  setManagedBrokerAccess(data.access);
  if (Object.hasOwn(data, "fluxBrokerUrl") || Object.hasOwn(data, "fluxAccess")) {
    setFluxBrokerAccess(data.fluxAccess ?? null, typeof data.fluxBrokerUrl === "string" ? data.fluxBrokerUrl : "");
  }
  if (Object.hasOwn(data, "legacyClaim")) {
    const claim = legacyClaimSchema.safeParse(data.legacyClaim);
    managedLegacyClaim = claim.success ? claim.data : { state: "none" };
    if (managedLegacyClaim.state === "claimed") legacyMovedElsewhere = false;
  }
  if (Object.hasOwn(data, "accountKind")) {
    managedAccountKind = data.accountKind === "personal" || data.accountKind === "shared" ? data.accountKind : null;
  }
  if (Object.hasOwn(data, "tokenError")) {
    const code = errorCodeSchema.safeParse(data.tokenError);
    managedTokenError = code.success ? code.data : null;
  }
  if (Object.hasOwn(data, "legacyUntil")) {
    managedLegacyUntil = typeof data.legacyUntil === "string" ? data.legacyUntil.trim() : "";
  }
  return true;
}

/** The Flux broker as the desktop shell sent it: its URL whenever the broker
 * is turned on for this build, and the token once one has been minted. */
export function setFluxBrokerAccess(access: unknown, url: string): void {
  const normalized = url ? normalizeManagedBrokerUrl(url) : "";
  if (access === null || access === undefined) {
    managedFluxBrokerUrl = normalized;
    managedFluxAccess = null;
    return;
  }
  const parsed = z.object({ url: z.string().url(), token: z.string().regex(managedBrokerToken) }).strict().parse(access);
  const accessUrl = normalizeManagedBrokerUrl(parsed.url);
  managedFluxBrokerUrl = normalized || accessUrl;
  managedFluxAccess = { url: accessUrl, token: parsed.token };
}

/** Forget every desktop-sent broker fact; the env becomes authoritative
 * again. For tests and for a restored-profile relaunch. */
export function resetManagedBrokerState(): void {
  managedBrokerAccess = undefined;
  managedFluxBrokerUrl = undefined;
  managedFluxAccess = undefined;
  managedLegacyClaim = undefined;
  managedAccountKind = undefined;
  managedTokenError = undefined;
  managedLegacyUntil = undefined;
  legacyMovedElsewhere = false;
  fluxReadiness = null;
  fluxReadinessProbe = null;
  fluxAccountStatus = null;
}

export function setManagedBrokerAccess(access: unknown): void {
  if (access === null) {
    managedBrokerAccess = null;
    return;
  }
  const parsed = z.object({ url: z.string().url(), token: z.string().regex(managedBrokerToken) }).strict().parse(access);
  managedBrokerAccess = { url: normalizeManagedBrokerUrl(parsed.url), token: parsed.token };
}

function workerBrokerCredential(): { url: string; token: string } | null {
  if (managedBrokerAccess !== undefined) return managedBrokerAccess;
  const url = process.env.MURAGE_COMPOSIO_BROKER_URL?.trim();
  const token = process.env.MURAGE_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedBrokerToken.test(token)) throw new Error("The connected-apps service token is invalid");
  return { url: normalizeManagedBrokerUrl(url), token };
}

/** The Worker cut-off as configured ("" = none). */
function legacyUntil(): string {
  return (managedLegacyUntil ?? process.env.MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL ?? "").trim();
}

/** An unparseable cut-off counts as passed: fail closed, never open-ended. */
function legacyBrokerOpen(now = Date.now()): boolean {
  const until = legacyUntil();
  if (!until) return true;
  const at = Date.parse(until);
  return Number.isFinite(at) && now < at;
}

/** The Murage Worker broker, until the configured cut-off. */
function legacyBrokerAccess(): BrokerAccess | null {
  const access = workerBrokerCredential();
  if (!access || !legacyBrokerOpen()) return null;
  return { ...access, kind: "legacy" };
}

/** The FluxRouter broker URL whenever this build turns it on, token or not. */
function fluxBrokerUrl(): string {
  if (managedFluxBrokerUrl !== undefined) return managedFluxBrokerUrl;
  const url = process.env.MURAGE_FLUX_COMPOSIO_BROKER_URL?.trim();
  if (!url) return "";
  try {
    return normalizeManagedBrokerUrl(url);
  } catch {
    return "";
  }
}

/** A well-formed Flux broker credential, before readiness is considered. The
 * token has the same 64-hex shape as the Worker's; the Flux API key is never
 * a broker credential (it reaches engines, this token never does). */
function fluxBrokerCandidate(): { url: string; token: string } | null {
  if (managedFluxAccess !== undefined) return managedFluxAccess;
  const url = fluxBrokerUrl();
  const token = process.env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token || !managedBrokerToken.test(token)) return null;
  return { url, token };
}

/** The Flux broker, only while its health probe says it is ready. */
function fluxBrokerAccess(): BrokerAccess | null {
  const candidate = fluxBrokerCandidate();
  if (!candidate || !fluxReadiness || fluxReadiness.url !== candidate.url || !fluxReadiness.ready) return null;
  return { ...candidate, kind: "flux" };
}

function legacyClaim(): LegacyClaim {
  if (managedLegacyClaim !== undefined) return managedLegacyClaim;
  const raw = process.env.MURAGE_COMPOSIO_LEGACY_CLAIM;
  if (!raw) return { state: "none" };
  try {
    const parsed = legacyClaimSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { state: "none" };
  } catch {
    return { state: "none" };
  }
}

function accountKind(): AccountKind | undefined {
  const kind = managedAccountKind !== undefined ? managedAccountKind : process.env.MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND;
  return kind === "personal" || kind === "shared" ? kind : undefined;
}

// ── Flux broker readiness ──────────────────────────────────────────────
// `activeBroker` must stay synchronous, so it reads a cache that the async
// routes prime. A healthy answer is trusted for 5 minutes; an unhealthy one
// for only 20 seconds, so a transient blip cannot pull connected apps away
// from every bot for 5 minutes. The initial value is "not ready".
const FLUX_READY_TTL_MS = 5 * 60_000;
const FLUX_NOT_READY_TTL_MS = 20_000;
const FLUX_PROBE_TIMEOUT_MS = 5_000;
let fluxReadiness: { url: string; ready: boolean; at: number } | null = null;
let fluxReadinessProbe: { url: string; promise: Promise<void> } | null = null;

async function probeFluxReadiness(url: string): Promise<void> {
  let ready = false;
  try {
    const response = await fetch(`${url}/health`, { redirect: "error", signal: AbortSignal.timeout(FLUX_PROBE_TIMEOUT_MS) });
    const body = response.status === 200 ? await response.json().catch(() => null) : null;
    ready = body !== null && typeof body === "object" && (body as { ready?: unknown }).ready === true;
  } catch {
    ready = false;
  }
  if (fluxBrokerCandidate()?.url === url) fluxReadiness = { url, ready, at: Date.now() };
}

/** Refresh the Flux broker's readiness when the cache is stale.
 *
 * One probe at a time. A route awaits it (bounded by the 5-second probe
 * timeout). A turn passes `{ turn: true }` and never waits on a probe that is
 * already running, so an offline laptop adds the probe to at most one turn
 * per negative TTL. */
export async function primeBrokerReadiness(options: { turn?: boolean } = {}): Promise<void> {
  const candidate = fluxBrokerCandidate();
  if (!candidate) return;
  const cached = fluxReadiness;
  if (cached && cached.url === candidate.url) {
    const ttl = cached.ready ? FLUX_READY_TTL_MS : FLUX_NOT_READY_TTL_MS;
    if (Date.now() - cached.at < ttl) return;
  }
  if (fluxReadinessProbe && fluxReadinessProbe.url === candidate.url) {
    if (options.turn) return;
    return fluxReadinessProbe.promise;
  }
  const probe = { url: candidate.url, promise: probeFluxReadiness(candidate.url) };
  fluxReadinessProbe = probe;
  try {
    await probe.promise;
  } finally {
    if (fluxReadinessProbe === probe) fluxReadinessProbe = null;
  }
}

/** Forget the readiness answer; the next primed request probes again. */
export function invalidateBrokerReadiness(): void {
  fluxReadiness = null;
}

type BrokerEvent = { type: "murage:flux-composio-token-rejected" };
let brokerEventSink: ((event: BrokerEvent) => void) | null = null;
/** Where broker events go: the desktop main process, over the private port. */
export function setBrokerEventSink(sink: ((event: BrokerEvent) => void) | null): void {
  brokerEventSink = sink;
}

async function responseCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/** What a data call says when no broker holds this workspace's connected
 * apps. It names the two ways out, in the order they are worth taking. */
export const BROKER_UNAVAILABLE =
  "Connected apps need FluxRouter. Connect FluxRouter in Settings → Models, or add your own Composio key.";

/** React to what a broker's answer says about the broker itself. */
async function observeBrokerResponse(broker: BrokerAccess, response: Response): Promise<void> {
  if (broker.kind === "flux") {
    if (response.status === 404 || response.status === 503) {
      // 404 is how the Flux broker answers while it is dark.
      invalidateBrokerReadiness();
    } else if (response.status === 401 && (await responseCode(response)) === "broker_token_revoked") {
      invalidateBrokerReadiness();
      brokerEventSink?.({ type: "murage:flux-composio-token-rejected" });
    }
    return;
  }
  if (response.status === 410 && legacyClaim().state !== "claimed" && (await responseCode(response)) === "migrated_to_flux") {
    legacyMovedElsewhere = true;
  }
}

/** Which broker a request should use, resolved in exactly one place.
 *
 * A workspace key WINS. Somebody who pasted their own Composio key did it on
 * purpose, their connected accounts live on their own project, and honouring
 * it costs Ferrox nothing — it is strictly the cheaper branch. The managed
 * broker remains the default for everyone who configures nothing, which is
 * nearly everyone.
 *
 * This used to be the other way round, and the cost was silent and severe.
 * The broker's env only arrives from `electron/main.mjs` when `app.isPackaged`
 * — so a person could connect eighteen toolkits in dev, on their own key,
 * then run the packaged build and have every one of them vanish. Not deleted:
 * on the far side of a different Composio project under a different user id,
 * with an empty connectors list that looks exactly like never having
 * connected anything. Two identities, no migration path, nothing said.
 *
 * The rule the old comment was protecting — Ferrox eats the cost until
 * connections are something people pay for — still holds, because it only
 * ever concerned the people who have no key of their own.
 *
 * `brokerRequest` takes `cfg` and resolves through here rather than reading
 * the broker itself, so no caller can route around this.
 *
 * Behind a workspace key, the order is FluxRouter, then the Murage Worker,
 * then nothing:
 *   - Flux (broker token present AND the Flux broker healthy) whenever this
 *     install carries no live legacy identity: it was claimed, the claim hit
 *     a terminal conflict, the Worker abandoned it, or it never registered.
 *   - The Worker until its cut-off while the legacy identity is still the one
 *     holding the user's connections (no claim, one offered, one pending),
 *     and as the fallback when Flux is not ready. Both brokers point at the
 *     same Composio user after a claim, so the fallback orphans nothing.
 *   - Neither: connected apps are unavailable and the panel offers FluxRouter.
 * Nothing here depends on whether the build is packaged, so dev and packaged
 * resolve the same broker for the same credentials; the Composio identity
 * itself is chosen by the broker from the account, never by this process. */
function activeBroker(cfg: AppConfig): BrokerAccess | null {
  if (cfg.composio?.apiKey) return null;
  const legacy = legacyBrokerAccess();
  const flux = fluxBrokerAccess();
  const claim = legacyClaim().state;
  const legacyIdentityLive = legacy !== null && (claim === "none" || claim === "offered" || claim === "pending");
  if (flux && !legacyIdentityLive) return flux;
  if (legacy) return legacy;
  return null;
}

/** Which broker data calls use right now; null for a workspace key or none. */
export function connectionBroker(cfg: AppConfig): BrokerKind | null {
  return activeBroker(cfg)?.kind ?? null;
}

/** Whether this build turns the FluxRouter broker on at all. */
export function fluxBrokerEnabled(): boolean {
  return fluxBrokerUrl() !== "";
}

const CLAIM_TO_MIGRATION: Record<LegacyClaimState, ConnectorMigrationState> = {
  none: "none",
  offered: "offered",
  pending: "pending",
  claimed: "claimed",
  conflict: "claim-conflict",
  abandoned: "abandoned",
};

/** Where this install is in the move from the Murage Worker to FluxRouter.
 * Secret-free: the install id is a support reference, never a credential. */
export function connectorMigration(cfg: AppConfig): ConnectorMigration {
  const until = legacyUntil() || null;
  const kind = accountKind();
  const tokenError = managedTokenError !== undefined ? managedTokenError ?? undefined : undefined;
  const base: ConnectorMigration = { state: "none", legacyUntil: until };
  if (kind) base.accountKind = kind;
  if (tokenError) base.tokenError = tokenError;
  if (cfg.composio?.apiKey) return base;
  const claim = legacyClaim();
  if (claim.installationId) base.installationId = claim.installationId;
  if (claim.at) base.at = claim.at;
  if (claim.code) base.code = claim.code;
  if (legacyMovedElsewhere && claim.state !== "claimed") return { ...base, state: "moved-elsewhere" };
  const state = CLAIM_TO_MIGRATION[claim.state];
  if (state === "none" && activeBroker(cfg)?.kind === "legacy") return { ...base, state: "legacy" };
  return { ...base, state };
}

// The last /v1/me from the Flux broker, for the free-allowance line.
const FLUX_ACCOUNT_STATUS_TTL_MS = 60_000;
let fluxAccountStatus: { url: string; token: string; at: number; freeRunsRemainingToday: number | null } | null = null;
const fluxMeSchema = z.object({ freeRunsRemainingToday: z.number().int().min(0).nullable().optional() }).passthrough();

/** Refresh the cached account status when the Flux broker is in use. Never
 * throws; an unreadable answer just leaves the line off. */
export async function refreshFluxAccountStatus(cfg: AppConfig): Promise<void> {
  const broker = activeBroker(cfg);
  if (broker?.kind !== "flux") return;
  const cached = fluxAccountStatus;
  if (cached && cached.url === broker.url && cached.token === broker.token && Date.now() - cached.at < FLUX_ACCOUNT_STATUS_TTL_MS) return;
  try {
    const response = await brokerRequest(cfg, "/v1/me", { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return;
    const body = fluxMeSchema.safeParse(await response.json());
    if (!body.success) return;
    fluxAccountStatus = { url: broker.url, token: broker.token, at: Date.now(), freeRunsRemainingToday: body.data.freeRunsRemainingToday ?? null };
  } catch {
    // leave the previous answer, if any
  }
}

function freeRunsRemainingToday(cfg: AppConfig): number | null {
  const broker = activeBroker(cfg);
  const cached = fluxAccountStatus;
  if (broker?.kind !== "flux" || !cached || cached.url !== broker.url || cached.token !== broker.token) return null;
  return cached.freeRunsRemainingToday;
}

/** The connected-apps facts every panel response carries. `fluxConfigured`
 * is a boolean only; the Flux key never leaves the server. */
export function connectorPanelFields(cfg: AppConfig, fluxIsConfigured: boolean) {
  return {
    broker: connectionBroker(cfg),
    migration: connectorMigration(cfg),
    fluxConfigured: fluxIsConfigured,
    fluxBrokerEnabled: fluxBrokerEnabled(),
    freeRunsRemainingToday: freeRunsRemainingToday(cfg),
  };
}

// Adapted from upstream52cd9563. Credentials are hashed, never duplicated in
// cache/transport keys. The project's own key still takes precedence.
function backendFingerprint(kind: string, endpoint: string, credential: string): string {
  return createHash("sha256").update(JSON.stringify([kind, endpoint, credential])).digest("hex");
}
function selectedBackendIdentity(cfg: AppConfig, catalog = false): string | null {
  const broker = activeBroker(cfg);
  if (broker) return backendFingerprint(catalog ? "managed-catalog" : "managed", broker.url, broker.token);
  const key = cfg.composio?.apiKey;
  return key ? backendFingerprint(catalog ? "project-catalog" : "project", catalog ? toolkitBase() : apiBase(), key) : null;
}
const transportSessionBackends = new Map<string, string>();
function rememberTransportSession(id: string, identity: string) {
  transportSessionBackends.delete(id);
  transportSessionBackends.set(id, identity);
  while (transportSessionBackends.size > 512) transportSessionBackends.delete(transportSessionBackends.keys().next().value!);
}

export function connectionMode(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  if (activeBroker(cfg)) return "managed";
  return cfg.composio?.apiKey ? "self-hosted" : "unavailable";
}

export function configured(cfg: AppConfig): boolean {
  return connectionMode(cfg) !== "unavailable";
}

/** Three answers, not two. The desktop shell sets MURAGE_CREDENTIAL_STORE to
 * "unavailable" when it could not read credentials.bin this launch; without
 * that signal an unreadable store is indistinguishable from a user who never
 * connected anything, and the UI wipes a list it should have kept. */
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";

export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.MURAGE_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}

/** Why THIS turn does or does not carry the user's connected apps.
 *
 * Three separate gates decide it (index.ts, the 1:1 site and the room site):
 * the per-bot grant, whether any broker or project key exists at all, and
 * whether this engine can mount connector tools. Every one of them used to
 * fail the same silent way — `integrations.composio` stayed unset, the
 * paragraph naming the composio tools never rendered, and the assistant
 * then told a user whose Gmail is connected and healthy that it has no
 * access to Gmail. One outcome, several causes, nothing said.
 *
 * `package-off` is the per-bot grant again, narrowed to the case where
 * nobody chose it: every bot installed from a package is switched off at
 * install (the `composio: false` in the team-import handler), deliberately,
 * so that a shared persona cannot reach someone's mail on turn one. That is
 * the right default and is not being changed here — but it is also the most
 * common reason an assistant has no connectors, and the one where the
 * assistant can name both the cause and the single switch that fixes it. */
export type ConnectorAccess = "mounted" | "package-off" | "bot-off" | "unconfigured" | "engine";

/** Precedence when several causes hold at once: the per-bot switch first.
 * It is the fact about THIS assistant, it is true regardless of what the
 * workspace has configured, and it is the gate the user is most likely to
 * have tripped. Workspace-wide absence comes next, and the engine's
 * inability last — a bot that is switched off does not become reachable by
 * changing engines. */
export function connectorAccess(input: {
  cfg: AppConfig;
  /** the bot's own `composio` field; absent/true means allowed */
  botComposio: boolean | undefined;
  /** whether this bot arrived from a bot package (`installedPackage`) */
  installedFromPackage: boolean;
  /** adapter.capabilities.composioMcp === true */
  engineMountsConnectors: boolean;
  /** whether the turn actually received the connector integration */
  mounted: boolean;
}): ConnectorAccess {
  if (input.mounted) return "mounted";
  if (input.botComposio === false) return input.installedFromPackage ? "package-off" : "bot-off";
  if (!configured(input.cfg)) return "unconfigured";
  if (!input.engineMountsConnectors) return "engine";
  // Every gate passed and nothing mounted. `mcpIntegration` only returns
  // null while unconfigured, so this is defensive rather than reachable —
  // and "we could not mount them" is still the honest thing to say.
  return "unconfigured";
}

/** One sentence per outcome, and the assistant is told which one it is.
 *
 * Only the `mounted` copy may name the composio tools; every other branch
 * exists precisely because those tools are NOT there, and each says what is
 * true, what it is not (the service is not necessarily disconnected), and
 * where the user would go to change it. */
export function connectorSystemPrompt(access: ConnectorAccess): string {
  switch (access) {
    case "mounted":
      return " The user's connected apps (Gmail, Calendar, Slack, Notion, and the rest) are reachable through the composio tools — find the right one with COMPOSIO_SEARCH_TOOLS, read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL. Reach for them before telling the user you have no access to a service.";
    case "package-off":
      return " You have no connected-app tools this turn because you were installed from a bot package, and packaged assistants start with connected apps switched off until the user turns them on for you. The workspace's connections may exist and be perfectly healthy — you are simply not mounted on them. If the user asks for work in a connected service, say that your access to connected apps is switched off for you and that they can turn it on in your settings; never tell them the service is disconnected.";
    case "bot-off":
      return " You have no connected-app tools this turn because connected apps are switched off for you specifically — a per-bot setting the user controls. The workspace's connections may exist and be perfectly healthy. If the user asks for work in a connected service, say that your access to connected apps is switched off for you and that they can turn it on in your settings; never tell them the service is disconnected.";
    case "unconfigured":
      return " You have no connected-app tools this turn because this workspace has no connected-apps service set up — connected apps run through FluxRouter and this workspace has neither FluxRouter nor its own Composio key, so no bot here can reach connected apps. If the user asks for work in a connected service, say that connected apps are not set up in this workspace yet and point them at the Connections settings; do not claim a particular service failed or is disconnected.";
    case "engine":
      return " You have no connected-app tools this turn because the engine you are running on cannot mount connector tools. The workspace's connections may exist and be perfectly healthy, and another engine would reach them. If the user asks for work in a connected service, say that this bot's current engine cannot use connected apps and that switching its model/engine would; never tell them the service is disconnected.";
  }
}

/** What a packaged assistant's job actually depends on.
 *
 * A package declares `requirements.apps` and the harness stores them on the
 * bot (`installedPackage.requiredApps`). THIS function is the only thing
 * that puts them in front of the model — the field's other reader,
 * package-export.ts, merely round-trips it back out to a blueprint — so a
 * profile that says "this assistant needs Gmail" tells the assistant so
 * because of the call site in index.ts and nothing else.
 *
 * Structural parameter rather than the store's type so this stays a pure
 * string builder the tests can call directly. */
export function requiredAppsSystemPrompt(
  apps: ReadonlyArray<{ slug: string; label: string; reason: string; optional?: boolean }> | undefined,
): string {
  if (!apps?.length) return "";
  const describe = (app: { label: string; reason: string; optional?: boolean }) =>
    `${app.label}${app.optional ? " (optional)" : ""} — ${app.reason.trim().replace(/\.$/, "")}`;
  return ` The profile you were installed from declares that your work depends on these connected services: ${apps
    .map(describe)
    .join("; ")}. Treat that as the shape of your job, not as proof of access: check whether you actually hold the tools before promising work in one of them, and if a required service is missing, say which one and why you need it.`;
}

/** Takes `cfg` so the own-key-wins decision is made in exactly one place. It
 * used to read the broker directly, which left every caller responsible for
 * gating itself — and a caller that forgot would have quietly spent the
 * broker owner's money on behalf of someone holding their own key. */
async function brokerRequest(cfg: AppConfig, path: string, init?: RequestInit): Promise<Response> {
  const broker = activeBroker(cfg);
  if (!broker) throw new Error(BROKER_UNAVAILABLE);
  const headers = new Headers(init?.headers);
  // Only ever the broker token. The Flux API key reaches engines and must
  // never be what unlocks the user's connected apps.
  headers.set("authorization", `Bearer ${broker.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`${broker.url}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  // What the answer says about the broker itself — readiness, a revoked token,
  // an install that was moved elsewhere — is learned in exactly one place.
  await observeBrokerResponse(broker, response);
  return response;
}

function projectHeaders(apiKey: string, json = false) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function responseError(res: Response, fallback: string) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
}

async function throwBrokerError(res: Response, fallback: string): Promise<never> {
  const status = res.status >= 400 && res.status < 500 ? res.status : 502;
  throw Object.assign(new Error(await responseError(res, fallback)), { status });
}

function trustedAuthUrl(value: string | undefined, slug: string): string {
  if (!value) throw new Error(`Connected-apps service returned no authorization link for ${slug}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Connected-apps service returned an untrusted authorization link");
  }
  return url.toString();
}

function parseSessionResponse(session: SessionResponse): SessionResponse {
  const mcp = new URL(session.mcp.url);
  if (mcp.protocol !== "https:" || (mcp.hostname !== "composio.dev" && !mcp.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted Session MCP URL");
  }
  return { ...session, mcp: { ...session.mcp, url: mcp.toString() } };
}

function supportsMultiAccount(session: SessionResponse): boolean {
  // Only `enable` gates reuse. The cap and selection flags are what we ASK
  // for at creation; if Composio clamps or omits them in the echo, recreating
  // the Session would post the same config and get the same echo back — a
  // strict equality check here can only manufacture a recreate-per-request
  // loop, never fix anything.
  return session.config?.multi_account?.enable === true;
}

/** Session ids this boot already tried to upgrade once. If the fresh Session
 *  STILL doesn't echo multi-account, Composio isn't granting it — run with
 *  what we have (single-account behavior) instead of recreating a Session and
 *  rewriting config.json on every request. */
const multiAccountUpgradeAttempted = new Set<string>();
/** Session id + auth-config map pairs this boot already created a Session
 *  for. Same idea: if Composio does not echo `auth_configs`, recreating the
 *  Session on every check would loop without changing anything. */
const authConfigUpgradeAttempted = new Set<string>();

function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw inputError("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw inputError("Account alias must be 1-64 printable characters");
  }
  return alias;
}

function validAccountId(value: string | undefined): value is string {
  return Boolean(value && ACCOUNT_ID.test(value));
}

async function getProjectSession(apiKey: string, sessionId: string): Promise<SessionResponse | null> {
  const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}`, {
    headers: projectHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await responseError(res, `Composio session: HTTP ${res.status}`));
  return parseSessionResponse(sessionResponseSchema.parse(await res.json()));
}

/** The project's own (non-Composio-managed) auth configs, one per toolkit.
 *  Disabled configs and ones switched off for Sessions are skipped; when a
 *  toolkit has several, the most recently updated wins. Ordinary Session
 *  preparation treats a denied list as "none"; an explicit auth retry surfaces
 *  the denial so it cannot replace a usable Session with an incomplete one. */
export async function listCustomAuthConfigs(apiKey: string): Promise<AuthConfigMap> {
  const chosen = new Map<string, { id: string; updated: string }>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page++) {
    const params = new URLSearchParams({ is_composio_managed: "false", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiBase()}/auth_configs?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(await responseError(res, `Composio auth configs: HTTP ${res.status}`));
    const body = authConfigsPageSchema.parse(await res.json());
    for (const item of body.items ?? []) {
      const slug = item.toolkit?.slug?.toLowerCase();
      if (!slug || !item.id || item.is_composio_managed === true) continue;
      if (item.is_enabled_for_tool_router === false) continue;
      if (item.status && /^(disabled|inactive|expired|deleted)$/i.test(item.status)) continue;
      const updated = item.last_updated_at ?? "";
      const current = chosen.get(slug);
      if (!current || updated > current.updated) chosen.set(slug, { id: item.id, updated });
    }
    const next = body.next_cursor ?? undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return Object.fromEntries([...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([slug, { id }]) => [slug, id]));
}

/** True when the Session already routes every wanted toolkit through the
 *  project's own auth config. Extra configs on the Session are fine; a
 *  missing or different one means the Session predates the config. */
function sessionCoversAuthConfigs(session: SessionResponse, wanted: AuthConfigMap): boolean {
  const have = session.config?.auth_configs ?? {};
  const haveLower = Object.fromEntries(Object.entries(have).map(([slug, id]) => [slug.toLowerCase(), id]));
  return Object.entries(wanted).every(([slug, id]) => haveLower[slug] === id);
}

function authConfigsKey(sessionId: string, wanted: AuthConfigMap): string {
  return `${sessionId}:${JSON.stringify(wanted)}`;
}

/** Validate a project key and return one reusable Session for this install. */
export async function prepareProjectSession(
  apiKey: string,
  current?: { apiKey?: string; userId?: string; sessionId?: string },
  knownAuthConfigs?: AuthConfigMap,
): Promise<{ apiKey: string; userId: string; sessionId: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Enter a Composio project API key");
  if (!trimmed.startsWith("ak_")) throw new Error("Composio project API keys start with ak_");

  // The project's own auth configs must be named at creation — a Session
  // cannot be edited later — so they are read before deciding whether the
  // current Session is still the right one (issue #509: a twitter auth
  // config created after the Session existed was never used).
  const authConfigs = knownAuthConfigs
    ?? await listCustomAuthConfigs(trimmed).catch((): AuthConfigMap => ({}));
  let priorUserId = current?.userId;
  if (trimmed === current?.apiKey && current.sessionId) {
    const existing = await getProjectSession(trimmed, current.sessionId);
    if (
      existing
      && supportsMultiAccount(existing)
      && (sessionCoversAuthConfigs(existing, authConfigs)
        || authConfigUpgradeAttempted.has(authConfigsKey(existing.session_id, authConfigs)))
    ) {
      return {
        apiKey: trimmed,
        userId: existing.config?.user_id ?? current.userId ?? `murage_${randomUUID()}`,
        sessionId: existing.session_id,
      };
    }
    // Connections belong to the Composio user, not the Session. Recreate old
    // single-account Sessions with the same user ID so every existing grant is
    // retained while the new Session opts into explicit multi-account routing.
    priorUserId = existing?.config?.user_id ?? priorUserId;
  }

  const userId = priorUserId ?? `murage_${randomUUID()}`;
  const sessionRequest: SessionCreateRequest = {
    user_id: userId,
    manage_connections: {
      enable: true,
      enable_wait_for_connections: true,
      enable_connection_removal: true,
    },
    multi_account: MULTI_ACCOUNT_CONFIG,
  };
  if (Object.keys(authConfigs).length) sessionRequest.auth_configs = authConfigs;
  const res = await fetch(`${apiBase()}/tool_router/session`, {
    method: "POST",
    headers: projectHeaders(trimmed, true),
    body: JSON.stringify(sessionRequest),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(await responseError(res, `Composio rejected this key (HTTP ${res.status})`));
  const session = parseSessionResponse(sessionResponseSchema.parse(await res.json()));
  // If Composio does not echo the configs back, a later check would ask for
  // the same creation again — remember this attempt so it happens once.
  authConfigUpgradeAttempted.add(authConfigsKey(session.session_id, authConfigs));
  return { apiKey: trimmed, userId, sessionId: session.session_id };
}

async function ensureProjectSession(cfg: AppConfig): Promise<SessionResponse> {
  const composio = cfg.composio;
  if (!composio?.apiKey) throw new Error("No Composio project key configured");
  const key = composio.apiKey, endpoint = apiBase();
  const assertCurrent = () => {
    if (cfg.composio !== composio || composio.apiKey !== key || apiBase() !== endpoint) throw new Error("Connected-app configuration changed; retry the request");
  };
  if (composio.sessionId) {
    const existing = await getProjectSession(key, composio.sessionId);
    assertCurrent();
    if (existing && (supportsMultiAccount(existing) || multiAccountUpgradeAttempted.has(existing.session_id))) {
      return existing;
    }
  }
  // A missing/deleted session is recreated and its non-secret identifiers are
  // persisted so an edited config/env setup does not recreate it every launch.
  const prepared = await prepareProjectSession(key, composio);
  assertCurrent();
  multiAccountUpgradeAttempted.add(prepared.sessionId);
  composio.userId = prepared.userId;
  composio.sessionId = prepared.sessionId;
  saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
  const created = await getProjectSession(key, prepared.sessionId);
  assertCurrent();
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

/** Replace the current Session with a freshly created one — the only way to
 *  pick up an auth config the user added after the Session was made. The
 *  Composio user id is kept, so every existing connection survives. */
async function recreateProjectSession(
  cfg: AppConfig,
  userId: string,
  authConfigs: AuthConfigMap,
): Promise<SessionResponse> {
  const composio = cfg.composio;
  if (!composio?.apiKey) throw new Error("No Composio project key configured");
  const prepared = await prepareProjectSession(
    composio.apiKey,
    { apiKey: composio.apiKey, userId },
    authConfigs,
  );
  multiAccountUpgradeAttempted.add(prepared.sessionId);
  composio.userId = prepared.userId;
  composio.sessionId = prepared.sessionId;
  saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
  const created = await getProjectSession(composio.apiKey, prepared.sessionId);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

/** Composio's wording when a toolkit has no managed auth and the Session was
 *  not told which of the project's own auth configs to use. */
const NEEDS_AUTH_CONFIG = /does not manage auth|auth[_ ]?config/i;

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  // The turn's own readiness refresh. `{ turn: true }` never waits on a probe
  // that is already running, so an offline laptop adds the 5-second probe to
  // at most one turn per negative TTL instead of every turn.
  await primeBrokerReadiness({ turn: true });
  if (!configured(cfg)) return null;
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The provider-facing bridge receives only this boot's loopback token.
      // Project/broker credentials stay in the harness process, so a coding
      // agent that prints its environment cannot export a durable secret.
      MURAGE_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.commsToken}` }),
      MURAGE_HARNESS_URL: context.harnessUrl,
      MURAGE_CONNECTORS_TOKEN: context.commsToken,
      MURAGE_BOT_ID: context.botId,
      MURAGE_THREAD_ID: context.threadId,
    },
  };
}

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
  beforeDispatch?: () => void,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const broker = activeBroker(cfg);
  const selectedIdentity = selectedBackendIdentity(cfg);
  const projectKey = cfg.composio?.apiKey;
  let projectSessionId: string | undefined;
  const assertCurrent = () => {
    if (selectedBackendIdentity(cfg) !== selectedIdentity || (projectSessionId !== undefined && cfg.composio?.sessionId !== projectSessionId)) throw new Error("Connected-app configuration changed; retry the request");
  };
  let url: string;
  let identity: string;
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (broker) {
    url = `${broker.url}/v1/mcp`;
    headers.set("authorization", `Bearer ${broker.token}`);
    identity = backendFingerprint("managed-mcp", url, broker.token);
  } else {
    if (!projectKey) throw new Error(BROKER_UNAVAILABLE);
    const session = await ensureProjectSession(cfg);
    projectSessionId = session.session_id;
    assertCurrent();
    url = session.mcp.url;
    headers.set("x-api-key", projectKey);
    identity = backendFingerprint("project-mcp", url, projectKey);
  }
  const forwarded = transportSessionId && transportSessionBackends.get(transportSessionId) === identity ? transportSessionId : undefined;
  if (forwarded) headers.set("mcp-session-id", forwarded);
  beforeDispatch?.();
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  assertCurrent();
  if (forwarded) rememberTransportSession(forwarded, identity);
  const nextSession = response.headers.get("mcp-session-id") ?? undefined;
  if (nextSession) rememberTransportSession(nextSession, identity);
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    transportSessionId: nextSession,
  };
}

async function listConnectedAccounts(
  apiKey: string,
  userId: string,
  slugs: string[],
): Promise<ConnectedAccountResponse[]> {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  // Five accounts per toolkit can exceed one provider page when a user has
  // many apps. Follow Composio's cursor instead of silently dropping entries.
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${apiBase()}/connected_accounts?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(await responseError(response, `Composio accounts: HTTP ${response.status}`));
    const body = connectedAccountsPageSchema.parse(await response.json());
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio account inventory exceeded the pagination safety limit");
}

async function listSessionToolkits(
  apiKey: string,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // The unfiltered endpoint contains the entire Composio marketplace and is
    // cursor-paginated in 50-item pages. The Connected tab only needs the
    // user's connected toolkits, so avoid scanning hundreds of unrelated apps.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(
      `${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
      { headers: projectHeaders(apiKey), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(await responseError(response, `Composio toolkits: HTTP ${response.status}`));
    const body = toolkitPageSchema.parse(await response.json());
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio toolkit inventory exceeded the pagination safety limit");
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map<string, Array<ConnectedAccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug?.toLowerCase();
    if (!slug || (requested.size && !requested.has(slug)) || !validAccountId(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: ConnectedAccountSummary & { updatedAt: string } = {
      id: account.id,
      status: account.status || "UNKNOWN",
      updatedAt: account.updated_at ?? "",
    };
    if (printableAliasSchema.safeParse(alias).success) summary.alias = alias;
    const list = bySlug.get(slug) ?? [];
    list.push(summary);
    bySlug.set(slug, list);
  }
  for (const list of bySlug.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return bySlug;
}

function publicAccount({ id, alias, status }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(
  accounts: ConnectedAccountSummary[],
): ConnectorServiceState {
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  const selected = active ?? pending ?? accounts[0];
  return {
    connected: Boolean(active),
    pending: Boolean(pending),
    status: selected?.status ?? "not_connected",
    accounts: accounts.map(publicAccount),
  };
}

function allServiceStates(
  accountsBySlug: ReadonlyMap<string, ConnectedAccountSummary[]>,
  toolkits: ToolkitItem[],
): Record<string, ConnectorServiceState> {
  const services = new Map(
    [...accountsBySlug].map(([slug, accounts]) => [slug, serviceStateFromAccounts(accounts)]),
  );
  for (const toolkit of toolkits) {
    const slug = toolkit.slug?.toLowerCase();
    const selected = toolkit.connected_account;
    const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
    if (!slug || (!toolkit.is_no_auth && !selectedId)) continue;
    const existingAccounts = accountsBySlug.get(slug) ?? [];
    const accounts = [...existingAccounts];
    if (selectedId && !accounts.some((account) => account.id === selectedId)) {
      accounts.push({ id: selectedId, status: selected?.status ?? "ACTIVE" });
    }
    const accountState = serviceStateFromAccounts(accounts);
    const status = toolkit.is_no_auth ? "ACTIVE" : selected?.status ?? accountState.status;
    services.set(slug, {
      connected: toolkit.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    });
  }
  return Object.fromEntries(services);
}

/**
 * Enumerate the user's complete connected-account inventory without depending
 * on marketplace ordering or catalog pagination.
 */
export async function connectedServices(cfg: AppConfig): Promise<Record<string, ConnectorServiceState>> {
  if (activeBroker(cfg)) {
    const response = await brokerRequest(cfg, "/v1/connectors/connected");
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.parse(await response.json());
    return Object.fromEntries(
      Object.entries(body.services ?? {}).map(([slug, state]) => [slug, {
        connected: state.connected,
        pending: state.pending ?? false,
        status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
        accounts: state.accounts ?? [],
      }]),
    );
  }
  if (!cfg.composio?.apiKey) throw new Error(BROKER_UNAVAILABLE);
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio.userId;
  if (!userId) throw new Error("Composio Session returned no user ID");
  const [toolkits, accounts] = await Promise.all([
    listSessionToolkits(cfg.composio.apiKey, session.session_id),
    // Scoped project keys can grant Session reads without granting the raw
    // connected-account list. The Session still proves which selected/no-auth
    // toolkits belong to this installation, so retain that safe fallback.
    listConnectedAccounts(cfg.composio.apiKey, userId, []).catch(() => []),
  ]);
  return allServiceStates(summarizeAccounts(accounts, []), toolkits);
}

export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  if (activeBroker(cfg) || !cfg.composio?.apiKey) {
    const response = await brokerRequest(cfg, `/v1/connectors?${new URLSearchParams({ services: slugs.join(",") })}`);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.parse(await response.json());
    return body.services ?? {};
  }
  const session = await ensureProjectSession(cfg);
  const params = new URLSearchParams({ limit: "50" });
  if (slugs.length) params.set("toolkits", slugs.join(","));
  const userId = session.config?.user_id ?? cfg.composio.userId;
  const [res, accounts] = await Promise.all([
    fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`, {
      headers: projectHeaders(cfg.composio.apiKey),
      signal: AbortSignal.timeout(15_000),
    }),
    // Session toolkits only include an account once it is usable. Read the
    // account lifecycle too so the UI can distinguish an OAuth flow that is
    // still waiting in the browser from one that expired or failed. Scoped
    // keys may omit connected-account read permission, so this is additive:
    // the normal session result remains the fallback.
    userId
      ? listConnectedAccounts(cfg.composio.apiKey, userId, slugs).catch(() => [])
      : Promise.resolve([]),
  ]);
  if (!res.ok) throw new Error(await responseError(res, `Composio toolkits: HTTP ${res.status}`));
  const body = toolkitPageSchema.parse(await res.json());
  const bySlug = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
  const accountsBySlug = summarizeAccounts(accounts, slugs);
  return Object.fromEntries(
    slugs.map((slug) => {
      const item = bySlug.get(slug.toLowerCase());
      const serviceAccounts = accountsBySlug.get(slug.toLowerCase()) ?? [];
      // Mirror allServiceStates: a scoped key can be denied the raw account
      // list while the Session still names its selected account. Synthesize
      // that account here too, so a status poll never wipes the row the
      // inventory paths render (merge replaces a slug's state wholesale).
      const selected = item?.connected_account;
      const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
      const withSelected = selectedId && !serviceAccounts.some((account) => account.id === selectedId)
        ? [...serviceAccounts, { id: selectedId, status: selected?.status ?? "ACTIVE" }]
        : serviceAccounts;
      const accountState = serviceStateFromAccounts(withSelected);
      const state = item?.connected_account?.status
        ?? (item?.is_no_auth ? "ACTIVE" : accountState.status);
      return [slug, {
        connected: item?.is_no_auth === true || accountState.connected || /^active$/i.test(state),
        pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(state),
        status: state,
        accounts: accountState.accounts,
      }];
    }),
  );
}

/** Backward-compatible service disconnect: removes the Session-selected account. */
export async function removeService(cfg: AppConfig, slug: string) {
  if (activeBroker(cfg) || !cfg.composio?.apiKey) {
    const response = await brokerRequest(cfg, `/v1/connectors/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    return removalResponseSchema.parse(await response.json());
  }
  const session = await ensureProjectSession(cfg);
  const params = new URLSearchParams({ limit: "50", toolkits: slug });
  const list = await fetch(
    `${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`,
    { headers: projectHeaders(cfg.composio.apiKey), signal: AbortSignal.timeout(15_000) },
  );
  if (!list.ok) throw new Error(await responseError(list, `Composio toolkits: HTTP ${list.status}`));
  const body = toolkitPageSchema.parse(await list.json());
  const id = body.items?.find((item) => item.slug?.toLowerCase() === slug.toLowerCase())?.connected_account?.id;
  if (!id) return { removed: 0 };
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(cfg.composio.apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
  return { removed: 1 };
}

/** Disconnect exactly one account after proving it belongs to this user/toolkit. */
export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  if (!validAccountId(accountId)) throw inputError("Invalid connected-account ID");
  if (activeBroker(cfg) || !cfg.composio?.apiKey) {
    const response = await brokerRequest(
      cfg,
      `/v1/connectors/${encodeURIComponent(slug)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    return removalResponseSchema.parse(await response.json());
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  const accounts = await listConnectedAccounts(cfg.composio.apiKey, userId, [slug]);
  const owned = accounts.some((account) =>
    account.id === accountId && account.toolkit?.slug?.toLowerCase() === slug.toLowerCase()
  );
  if (!owned) return { removed: 0 };
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(cfg.composio.apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
  return { removed: 1 };
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null) {
  const alias = normalizeAccountAlias(requestedAlias);
  if (activeBroker(cfg) || !cfg.composio?.apiKey) {
    const request: RequestInit = { method: "POST" };
    if (alias) request.body = JSON.stringify({ alias });
    const response = await brokerRequest(cfg, `/v1/connectors/${encodeURIComponent(slug)}/authorize`, request);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = authUrlResponseSchema.parse(await response.json());
    return { url: trustedAuthUrl(body.url, slug) };
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  // A scoped key may be denied account listing — authorization must still
  // work (it always did pre-multi-account), so the alias guardrails degrade
  // to first-account behavior, the same fallback every inventory path takes.
  const accounts = await listConnectedAccounts(cfg.composio.apiKey, userId, [slug]).catch(() => []);
  const serviceAccounts = accounts.filter((account) => account.toolkit?.slug?.toLowerCase() === slug.toLowerCase());
  const usableAccounts = serviceAccounts.filter((account) => /^(active|initiated|initializing|pending)$/i.test(account.status ?? ""));
  if (usableAccounts.length >= MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit) {
    throw inputError(`${slug} already has the maximum of ${MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit} accounts`, 409);
  }
  if (usableAccounts.length > 0 && !alias) {
    throw inputError("Add an account alias so the existing connection is not replaced");
  }
  if (alias && serviceAccounts.some((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase())) {
    throw inputError(`Account alias "${alias}" is already in use for ${slug}`, 409);
  }
  const linkRequest: AccountLinkRequest = { toolkit: slug };
  if (alias) linkRequest.alias = alias;
  const apiKey = cfg.composio.apiKey;
  const link = (sessionId: string) =>
    fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
      method: "POST",
      headers: projectHeaders(apiKey, true),
      body: JSON.stringify(linkRequest),
      signal: AbortSignal.timeout(30_000),
    });
  let res = await link(session.session_id);
  if (!res.ok) {
    const message = await responseError(res, `Composio authorization: HTTP ${res.status}`);
    if (!NEEDS_AUTH_CONFIG.test(message)) throw new Error(message);
    // The toolkit needs one of the project's own auth configs. The Session
    // names those only at creation, so an auth config the user created after
    // the Session existed is invisible to it: rebuild the Session once and
    // retry. If the project has no config for this toolkit, say what to do
    // instead of echoing Composio's "auth_config_override" hint.
    const slugLower = slug.toLowerCase();
    const authConfigs = await listCustomAuthConfigs(apiKey);
    const covered = Object.keys(authConfigs).some((key) => key.toLowerCase() === slugLower);
    if (!covered) {
      throw inputError(
        `${slug} has no Composio-managed sign-in. In your Composio project, create an auth config for "${slug}" `
          + "(Auth Configs → Create) with your own app credentials, then click Connect again.",
      );
    }
    const fresh = await recreateProjectSession(cfg, userId, authConfigs);
    res = await link(fresh.session_id);
    if (!res.ok) throw new Error(await responseError(res, `Composio authorization: HTTP ${res.status}`));
  }
  const body = linkResponseSchema.parse(await res.json());
  return { url: trustedAuthUrl(body.redirect_url, slug) };
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[]; identity: string } | null = null;
let toolkitRequestGeneration = 0;
const MAX_CATALOG_PAGES = 20;
const MAX_CATALOG_ITEMS = 10_000;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig, options: { signal?: AbortSignal } = {}): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  const generation = ++toolkitRequestGeneration;
  const identity = selectedBackendIdentity(cfg, true);
  if (options.signal?.aborted) return { cards: CURATED, source: "curated" };
  if (identity && toolkitCache?.identity === identity && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = activeBroker(cfg) ? undefined : cfg.composio?.apiKey;
  if (backendKey || activeBroker(cfg)) {
    // One budget for the whole catalog, rather than multiplying latency by
    // the page ceiling. Cancellation/identity changes never publish old data.
    const deadline = AbortSignal.timeout(15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const cardsBySlug = new Map<string, ToolkitCard>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let itemCount = 0;
    let complete = false;
    for (let page = 0; page < MAX_CATALOG_PAGES && itemCount < MAX_CATALOG_ITEMS; page += 1) {
      if (signal.aborted || selectedBackendIdentity(cfg, true) !== identity) return { cards: CURATED, source: "curated" };
      try {
        const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
        if (cursor) params.set("cursor", cursor);
        const res = backendKey
          ? await fetch(`${toolkitBase()}/toolkits?${params}`, { headers: { "x-api-key": backendKey }, signal })
          : await brokerRequest(cfg, cursor ? `/v1/catalog?${new URLSearchParams({ cursor })}` : "/v1/catalog", { signal });
        if (!res.ok) break;
        const json: any = await res.json();
        if (signal.aborted || selectedBackendIdentity(cfg, true) !== identity) return { cards: CURATED, source: "curated" };
        const items = json.items ?? json.data ?? [];
        if (!Array.isArray(items)) break;
        const boundedItems = items.slice(0, MAX_CATALOG_ITEMS - itemCount);
        itemCount += boundedItems.length;
        for (const t of boundedItems) {
          if (!t || typeof t !== "object") continue;
          const slug = String(t.slug ?? t.key ?? t.name ?? "").trim().toLowerCase();
          if (!slug || cardsBySlug.has(slug)) continue;
          cardsBySlug.set(slug, {
            slug,
            label: String(t.name ?? t.slug ?? ""),
            blurb: String(t.meta?.description ?? t.description ?? "").slice(0, 90),
            logo: t.meta?.logo ?? t.logo ?? null,
            noAuth: t.no_auth === true,
            domain: null,
          });
        }
        const next = typeof json.next_cursor === "string" ? json.next_cursor.trim() : "";
        if (!next) { complete = boundedItems.length === items.length; break; }
        if (!/^[A-Za-z0-9+/_=-]{1,256}$/.test(next) || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      } catch {
        // Fail below without leaking upstream details or presenting a partial
        // catalog as complete. First-page failures retain the curated fallback.
        break;
      }
    }
    if (signal.aborted || selectedBackendIdentity(cfg, true) !== identity) return { cards: CURATED, source: "curated" };
    if (!complete && cardsBySlug.size) throw new Error("The app catalog could not be loaded completely. Please retry.");
    if (cardsBySlug.size) {
      const cards = [...cardsBySlug.values()];
      if (complete && identity && generation === toolkitRequestGeneration) toolkitCache = { at: Date.now(), cards, identity };
      return { cards, source: "api" };
    }
  }
  return { cards: CURATED, source: "curated" };
}

export async function toolkitCard(cfg: AppConfig, slug: string): Promise<ToolkitCard> {
  const normalized = slug.toLowerCase();
  const { cards } = await listToolkits(cfg);
  return cards.find((card) => card.slug.toLowerCase() === normalized)
    ?? CURATED.find((card) => card.slug === normalized)
    ?? {
      slug: normalized,
      label: normalized.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      blurb: "Connect this app so your bot can continue",
      logo: null,
      domain: null,
    };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
