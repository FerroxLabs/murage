// Connected apps run through the Flux Router broker (and, for installs that
// still hold a Worker identity, the legacy broker until it is claimed). No key
// a person typed in is ever read here: a stored own key stays on disk, unused.
import { toolSlugsOf, withScopeHint, type ScopeRoute } from "./connector-scope-hint.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import {
  CONNECTED_APP_ACTION_TIMEOUT_MS,
  CONNECTED_APP_OPERATION_LIFETIME_MS,
  CONNECTED_APP_RELAY_GRACE_MS,
  CONNECTED_APP_STATUS_WAIT_MS,
  connectedAppActionCall,
  connectedAppUnprotectedAction,
  connectedAppActionLabel,
  connectedAppCallTimeoutMs,
  connectedAppBusyText,
  connectedAppClearedText,
  connectedAppEffectArgs,
  connectedAppNoRecordText,
  connectedAppNotSentText,
  connectedAppPendingText,
  connectedAppRepeatNote,
  connectedAppToolId,
  connectedAppRequirements,
  isConnectedAppLookup,
  connectedAppUnknownText,
  connectedAppUnrecordedText,
  type ConnectedAppProvenance,
  connectedAppProvenance,
  connectedAppHistoryNote,
  connectedAppReadUnknownText,
  connectedAppNotClearedText,
  isConnectedAppStatusTool,
  LEGACY_BROKER_RETIRED,
  LEGACY_BROKER_RETIRED_FLUX_READY,
  LEGACY_DAILY_LIMIT,
} from "../shared/connected-app-calls.ts";
import {
  ConnectedAppOperations,
  OperationRefused,
  isEventStream,
  answersRequest,
  operationKey,
  replyMessage,
  waitForOperation,
  type ConnectedAppOperation,
  type OperationOutcome,
  type RelayReply,
} from "./connected-app-operations.ts";
import { classifyConnectedAppCall } from "../shared/connected-app-readonly.ts";
import { SqliteOperationJournal, defaultJournalFile } from "./connected-app-journal.ts";
import { devFluxTokenApplies, devFluxTokenInFlight, ensureDevFluxBrokerToken, readDevFluxTokenDocument, resetDevFluxTokenState } from "./flux-composio-dev-token.ts";
import { createHash } from "node:crypto";
import { fluxRetryDelayMs } from "./flux-key-health.ts";
import { z } from "zod";
import { brokerTokenFingerprint } from "../electron/flux-composio-token.mjs";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import {
  clearInventory,
  forgetInventoryMemory,
  hasInventory,
  invalidateInventory,
  rekeyInventory,
  inventoryVersion,
  peekInventory,
  readInventory,
  type InventoryRead,
  type InventoryReadOptions,
  type InventoryServices,
} from "./connected-inventory.ts";
import {
  accountKeyOf,
  clearAllHealth,
  clearNeedsReconnect,
  healthMark,
  markNeedsReconnect,
  needsReconnectSlugs,
  readAppAnswer,
  updateMark,
} from "./connected-app-health.ts";
import { handOverInitialTools } from "./connector-cache-harness.ts";
import { INITIAL_GENERATION, INITIAL_TOOLS_ASK_HARNESS } from "./connector-cache.ts";
import { catalogApp, knownApps, loadCatalog, type CatalogApp, type CatalogBackend, type CatalogView } from "./app-catalog.ts";

export interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
  /** Why the provider ended a sign-in, and when it began: kept so a card can
   * say "expired" or "refused" instead of the provider's status word. */
  statusReason?: string;
  createdAt?: string;
}

export interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  /** A call to this app came back as an authorization failure: the connection
   * exists but needs signing in again. Cleared by a call that succeeds. */
  needsReconnect?: boolean;
  statusReason?: string;
  createdAt?: string;
  accounts: ConnectedAccountSummary[];
}

const connectorServiceSchema = z.object({
  connected: z.boolean(),
  pending: z.boolean().optional(),
  status: z.string().optional(),
  statusReason: z.string().optional(),
  createdAt: z.string().optional(),
  accounts: z.array(z.object({
    id: z.string(),
    alias: z.string().optional(),
    status: z.string(),
    statusReason: z.string().optional(),
    createdAt: z.string().optional(),
  })).optional(),
});
const connectorServicesResponseSchema = z.object({ services: z.record(z.string(), connectorServiceSchema).optional() });
const removalResponseSchema = z.object({ removed: z.number() });
const authUrlResponseSchema = z.object({ url: z.string().optional() });

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
  /** What the bridge files its remembered tool list under and checks it against.
   * `revision` changes with the bot's connected-app access (grants, switches);
   * `initialTools` is the policy-correct list a restricted bot is first shown
   * (only its approved accounts) when the live one is slow. */
  listScope?: { revision: string; initialTools?: unknown[]; /** The connection generation read in the SAME step that built `initialTools` (before any await); explicit, "initial" when none was written yet. */ generation: string };
  /** A private directory under Murage's data folder for the remembered list
   * (see connector-cache-harness.ts: only passed once it is verified private). */
  toolsCacheDir?: string;
  /** Windows: the directory's owner-only ACL was verified by the native helper. */
  toolsCachePrivate?: boolean;
}

/** The largest initial list handed over in the environment. Anything longer
 * goes through a private file, whole: it is never cut down or emptied. */
const INITIAL_TOOLS_ENV_MAX_CHARS = 16_000;
/** With no private file possible, the largest list still passed in the
 * environment (POSIX allows far more; Windows' whole block is 32,767). */
const INITIAL_TOOLS_ENV_LAST_RESORT_CHARS = 100_000;

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
  | "none" | "legacy" | "offered" | "pending" | "claimed" | "claim-conflict" | "abandoned" | "moved-elsewhere" | "legacy-retired";
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
/** The Worker answered 410 legacy_broker_retired: it will not serve this
 * install again, whatever the desktop's own cut-off date says. */
let legacyRetiredObserved = false;

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

/** The credentials the cache's owner depends on, as a string that changes
 * whenever any of them does. Never logged or stored. */
/** Set when a broker rejected the token this process held: the replacement
 * that follows is the same install's re-mint, so the remembered list moves to
 * the new owner instead of being dropped (a rejection is not an owner change). */
let tokenRejectedAwaitingReplacement = false;

/** Called after the managed credentials changed. */
function credentialsChanged(): void {
  if (tokenRejectedAwaitingReplacement && inventoryOwner({} as AppConfig) !== null) {
    tokenRejectedAwaitingReplacement = false;
    toolResponseCache.clear();
    rekeyInventory(inventoryOwner({} as AppConfig));
    return;
  }
  tokenRejectedAwaitingReplacement = false;
  clearInventoryAndToolCache();
}

function managedCredentialMark(): string {
  return JSON.stringify([managedBrokerAccess?.token ?? null, managedFluxAccess?.token ?? null]);
}

let applyingBrokerMessage = false;

export function applyManagedBrokerMessage(message: unknown): boolean {
  const before = managedCredentialMark();
  applyingBrokerMessage = true;
  try {
    return applyManagedBrokerMessageInner(message);
  } finally {
    applyingBrokerMessage = false;
    // A new or removed token is a new owner: the old owner's list goes.
    if (managedCredentialMark() !== before) credentialsChanged();
  }
}

function applyManagedBrokerMessageInner(message: unknown): boolean {
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

/** The workspace Flux key changed: the held broker token belongs to the old
 * account, so it stops being sent now rather than when the next mint lands. */
export function dropFluxBrokerToken(): void {
  if (!managedFluxAccess) return;
  const before = managedCredentialMark();
  managedFluxAccess = null;
  if (managedCredentialMark() !== before) credentialsChanged();
}

/** The Flux broker as the desktop shell sent it: its URL whenever the broker
 * is turned on for this build, and the token once one has been minted. */
export function setFluxBrokerAccess(access: unknown, url: string): void {
  const before = managedCredentialMark();
  const nested = applyingBrokerMessage;
  try {
    setFluxBrokerAccessInner(access, url);
  } finally {
    if (!nested && managedCredentialMark() !== before) credentialsChanged();
  }
}

function setFluxBrokerAccessInner(access: unknown, url: string): void {
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
  legacyRetiredObserved = false;
  unreachableLoggedAt.clear();
  lastProbeCause = null;
  clearAllHealth();
  fluxReadiness = null;
  fluxReadinessProbe = null;
  fluxAccountStatus = null;
  fluxAccountStatusFailure = null;
  devTokenRemintDue = false;
  devTokenRejectedFingerprint = undefined;
  tokenRejectedAwaitingReplacement = false;
  resetDevFluxTokenState();
  clearInventoryAndToolCache();
}

export function setManagedBrokerAccess(access: unknown): void {
  const before = managedCredentialMark();
  const nested = applyingBrokerMessage;
  try {
    setManagedBrokerAccessInner(access);
  } finally {
    if (!nested && managedCredentialMark() !== before) credentialsChanged();
  }
}

function setManagedBrokerAccessInner(access: unknown): void {
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

/** The Murage Worker broker, until the configured cut-off or until the
 * Worker itself says it has retired. */
function legacyBrokerAccess(): BrokerAccess | null {
  const access = workerBrokerCredential();
  if (!access || !legacyBrokerOpen() || legacyRetiredObserved) return null;
  return { ...access, kind: "legacy" };
}

/** This install holds a Worker identity the Worker will no longer serve. */
function legacyBrokerRetired(): boolean {
  return workerBrokerCredential() !== null && (legacyRetiredObserved || !legacyBrokerOpen());
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

/** The dev harness's self-minted token (flux-composio-dev-token.ts), only
 * where that module applies: never inside the packaged app, never over an
 * env-pinned token. */
function devFluxTokenEligible(url: string): boolean {
  // A desktop message having arrived is the surest sign this harness is the
  // packaged app's child, whatever its env says.
  return managedFluxBrokerUrl === undefined && devFluxTokenApplies(url);
}

function devFluxToken(url: string): { token?: string; accountKind?: AccountKind; tokenError?: string } {
  if (!devFluxTokenEligible(url)) return {};
  const document = readDevFluxTokenDocument();
  return {
    token: document.fluxComposioBrokerToken,
    accountKind: document.fluxComposioAccountKind,
    tokenError: document.fluxComposioTokenError,
  };
}

/** A well-formed Flux broker credential, before readiness is considered. The
 * token has the same 64-hex shape as the Worker's; the Flux API key is never
 * a broker credential (it reaches engines, this token never does). */
function fluxBrokerCandidate(): { url: string; token: string } | null {
  if (managedFluxAccess !== undefined) return managedFluxAccess;
  const url = fluxBrokerUrl();
  if (!url) return null;
  const token = process.env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN?.trim() || devFluxToken(url).token;
  if (!token || !managedBrokerToken.test(token)) return null;
  return { url, token };
}

/** The Flux broker, only while its health probe says it is ready. */
function fluxBrokerAccess(): BrokerAccess | null {
  const candidate = fluxBrokerCandidate();
  if (candidate) healReadiness(candidate.url);
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
  const kind = managedAccountKind !== undefined
    ? managedAccountKind
    : process.env.MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND || devFluxToken(fluxBrokerUrl()).accountKind;
  return kind === "personal" || kind === "shared" ? kind : undefined;
}

/** Why the last token mint was declined, from whichever process minted. */
function tokenError(): string | undefined {
  if (managedTokenError !== undefined) return managedTokenError ?? undefined;
  return devFluxToken(fluxBrokerUrl()).tokenError;
}

// ── Flux broker readiness ──────────────────────────────────────────────
// `activeBroker` must stay synchronous, so it reads a cache that the async
// routes prime. A healthy answer is trusted for 5 minutes; an unhealthy one
// for only 20 seconds, so a transient blip cannot pull connected apps away
// from every bot for 5 minutes. The initial value is "not ready".
const FLUX_READY_TTL_MS = 5 * 60_000;
const FLUX_NOT_READY_TTL_MS = 20_000;
const FLUX_PROBE_TIMEOUT_MS = 5_000;
/** How long a turn's connector MOUNT waits on a readiness probe another request
 * already started. Without the wait, the turn read the not-yet-updated cache,
 * mounted no Composio, and its first connector call failed with "tools never
 * loaded". Bounded so a slow or hung broker can never hang a turn. */
export const FLUX_MOUNT_WAIT_CAP_MS = 5_000;
let mountWaitCapMs = FLUX_MOUNT_WAIT_CAP_MS;
/** Test hook: shrink (or, with no argument, restore) the mount wait cap. */
export function setMountWaitCapMsForTests(ms?: number): void {
  mountWaitCapMs = ms ?? FLUX_MOUNT_WAIT_CAP_MS;
}

/** Wait for `promise`, but never longer than `ms`; resolves either way. */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
let fluxReadiness: { url: string; ready: boolean; at: number } | null = null;
let fluxReadinessProbe: { url: string; promise: Promise<void> } | null = null;

// Why connected apps read as unreachable. Every path that ends in "unreachable"
// logs one line with the cause (an HTTP status or an error code, never a token,
// header, URL or body), at most once per cause per 5 minutes.
const UNREACHABLE_LOG_THROTTLE_MS = 5 * 60_000;
type UnreachableRoute = "readiness probe" | "tool call" | "session" | "panel";
const unreachableLoggedAt = new Map<string, number>();
let lastProbeCause: string | null = null;

function safeCause(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 120) || "unknown";
}

/** A cause for a failed fetch: its error code (ECONNRESET, ETIMEDOUT, ENOTFOUND)
 * or, failing that, the error's name (TimeoutError). Never the message. */
function errorCause(error: unknown): string {
  const code = (e: unknown): string | undefined => {
    const c = (e as { code?: unknown } | null)?.code;
    return typeof c === "string" ? c : undefined;
  };
  const named = (e: unknown): string | undefined => {
    const n = (e as { name?: unknown } | null)?.name;
    return typeof n === "string" ? n : undefined;
  };
  const cause = (error as { cause?: unknown } | null)?.cause;
  return safeCause(code(error) ?? code(cause) ?? (named(error) === "TypeError" ? named(cause) : undefined) ?? named(error) ?? "unknown");
}

function logUnreachable(route: UnreachableRoute, cause: string): void {
  const safe = safeCause(cause);
  const now = Date.now();
  const last = unreachableLoggedAt.get(safe);
  if (last !== undefined && now - last < UNREACHABLE_LOG_THROTTLE_MS) return;
  unreachableLoggedAt.set(safe, now);
  if (unreachableLoggedAt.size > 64) unreachableLoggedAt.delete(unreachableLoggedAt.keys().next().value!);
  console.warn(`connected apps: unreachable (${route}): ${safe}`);
}

async function probeFluxReadiness(url: string): Promise<void> {
  let ready = false;
  let cause: string | null = null;
  try {
    const response = await fetch(`${url}/health`, { redirect: "error", signal: AbortSignal.timeout(FLUX_PROBE_TIMEOUT_MS) });
    const body = response.status === 200 ? await response.json().catch(() => null) : null;
    ready = body !== null && typeof body === "object" && (body as { ready?: unknown }).ready === true;
    if (!ready) cause = response.status === 200 ? "HTTP 200 health not ready" : `HTTP ${response.status}`;
  } catch (error) {
    ready = false;
    cause = errorCause(error);
  }
  lastProbeCause = cause;
  if (cause !== null) logUnreachable("readiness probe", cause);
  if (fluxBrokerCandidate()?.url === url) fluxReadiness = { url, ready, at: Date.now() };
}

/** Readiness must never be trusted past its lifetime by a reader that does
 * not probe. Every synchronous read of it checks the age, and a stale or
 * missing answer starts a background probe (one at a time, never awaited). The
 * negative answer is the one that matters: with it, an outage that has ended
 * is noticed one negative TTL later by whichever reader asks next, with no
 * restart and nothing pressed. */
function healReadiness(url: string): void {
  const cached = fluxReadiness;
  const ttl = cached && cached.url === url ? (cached.ready ? FLUX_READY_TTL_MS : FLUX_NOT_READY_TTL_MS) : 0;
  if (cached && cached.url === url && Date.now() - cached.at < ttl) return;
  if (fluxReadinessProbe && fluxReadinessProbe.url === url) return;
    void primeBrokerReadiness({ turn: true }).catch(() => {});
}

/** Refresh the Flux broker's readiness when the cache is stale.
 *
 * One probe at a time. A route awaits it (bounded by the 5-second probe
 * timeout). A turn passes `{ turn: true }` and never waits on a probe that is
 * already running, so an offline laptop adds the probe to at most one turn
 * per negative TTL. A connector MOUNT passes `{ turn: true, mount: true }`: it
 * joins a probe already running (the same promise, so no second probe) for at
 * most FLUX_MOUNT_WAIT_CAP_MS, then proceeds with whatever state exists. */
export async function primeBrokerReadiness(options: { turn?: boolean; mount?: boolean; waitMs?: number } = {}): Promise<void> {
  await primeDevFluxToken(options);
  const candidate = fluxBrokerCandidate();
  if (!candidate) return;
  const cached = fluxReadiness;
  if (cached && cached.url === candidate.url) {
    const ttl = cached.ready ? FLUX_READY_TTL_MS : FLUX_NOT_READY_TTL_MS;
    if (Date.now() - cached.at < ttl) return;
  }
  if (fluxReadinessProbe && fluxReadinessProbe.url === candidate.url) {
    if (options.turn && options.mount) return settleWithin(fluxReadinessProbe.promise, options.waitMs ?? mountWaitCapMs);
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

// The dev harness mints its own token (flux-composio-dev-token.ts). It is
// primed exactly where readiness is, with the same turn rule: a turn never
// waits on a mint another request already started. A `broker_token_revoked`
// answer marks a forced re-mint for the next prime, the way the packaged app
// re-mints on the `murage:flux-composio-token-rejected` message.
let devTokenRemintDue = false;
let devTokenRejectedFingerprint: string | undefined;
async function primeDevFluxToken(options: { turn?: boolean }): Promise<void> {
  const url = fluxBrokerUrl();
  if (!devFluxTokenEligible(url)) return;
  if (options.turn && devFluxTokenInFlight()) return;
  const force = devTokenRemintDue;
  const rejectedTokenFingerprint = devTokenRejectedFingerprint;
  devTokenRemintDue = false;
  devTokenRejectedFingerprint = undefined;
  const before = readDevFluxTokenDocument().fluxComposioBrokerToken;
  const next = await ensureDevFluxBrokerToken({ fluxBrokerUrl: url, force, rejectedTokenFingerprint, log: (line) => console.error(`[composio] ${line}`) });
  // A new token is a new credential: probe readiness for it afresh.
  if (next.fluxComposioBrokerToken !== before) {
    fluxReadiness = null;
    credentialsChanged();
  }
}

/** `tokenFingerprint` names the token that was rejected (never the token), so
 * the desktop can tell the one held now from one already replaced; `code` is
 * what Flux said (revoked, or another device took over). */
type BrokerEvent = { type: "murage:flux-composio-token-rejected"; tokenFingerprint: string; code: string };
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

/**
 * What a data call says when no broker holds this workspace's connected apps.
 *
 * REACHES A PERSON, so it obeys the house copy rules the first run obeys, and
 * it used to break three of them in one sentence: it named the broker vendor,
 * it sent somebody to Settings while they were in the middle of something, and
 * it wrote the product's name a way nothing else on screen writes it. Reported
 * live, pressing an app row during the first run.
 *
 * It also has to stay honest about the OTHER way in. Somebody running their
 * own connected-apps key is a real and supported case, so the sentence still
 * says a key of their own will do, without naming whose key it is: the
 * catalogue is "500+ apps", named by example, everywhere a person can read it.
 */
export const BROKER_UNAVAILABLE =
  "Connected apps need Flux Router. Connect Flux Router and 500+ apps come with it, Gmail, Slack, Notion and GitHub among them. Your own connected-apps key works too, if you have one.";

/** What a connector call says while connected apps cannot be reached at the
 * moment (a dropped connection, the service restarting) and a sign-in exists.
 * It is not "not set up": nothing needs fixing, and the model must not say so. */
export const BROKER_UNREACHABLE =
  "Connected apps can't be reached right now. This is usually brief. Try again in a minute.";

// The plain answers to the original service's refusals live beside the
// connected-app call rules, so the stdio bridge can recognise them as refusals.
export { LEGACY_BROKER_RETIRED, LEGACY_BROKER_RETIRED_FLUX_READY, LEGACY_DAILY_LIMIT };

/** React to what a broker's answer says about the broker itself. */
async function observeBrokerResponse(broker: BrokerAccess, response: Response, options: { sessionScoped?: boolean; route?: UnreachableRoute } = {}): Promise<void> {
  if (broker.kind === "flux") {
    if (response.status === 404 && options.sessionScoped) {
      // A 404 to a request that named an MCP session says that session is
      // gone (the Streamable HTTP rule), not that the broker is dark.
      return;
    }
    if (response.status === 404 || response.status === 503) {
      // 404 is how the Flux broker answers while it is dark.
      logUnreachable(options.route ?? "panel", `HTTP ${response.status}`);
      invalidateBrokerReadiness();
    } else if (response.status === 401) {
      logUnreachable(options.route ?? "panel", "HTTP 401 token rejected");
      // EVERY 401 on a Flux data route says this token no longer works, whatever
      // Flux calls the reason: a revocation, an expiry, another device's mint
      // pushing it out. The desktop decides (one forced re-mint, then "another
      // device took over"); known codes are only a fast path.
      const code = (await responseCode(response)) ?? "unknown";
      invalidateBrokerReadiness();
      // Keep what is remembered (stale, so it refreshes) and the file: the
      // panel still opens at once. Only the tool answers go.
      toolResponseCache.clear();
      invalidateInventory(inventoryOwner({} as AppConfig));
      tokenRejectedAwaitingReplacement = true;
      const tokenFingerprint = brokerTokenFingerprint(broker.token);
      if (devFluxTokenEligible(broker.url)) {
        devTokenRemintDue = true;
        devTokenRejectedFingerprint = tokenFingerprint;
      }
      brokerEventSink?.({ type: "murage:flux-composio-token-rejected", tokenFingerprint, code });
    }
    return;
  }
  if (response.status !== 410) return;
  const code = await responseCode(response);
  if (code === "legacy_broker_retired") legacyRetiredObserved = true;
  else if (code === "migrated_to_flux" && legacyClaim().state !== "claimed") legacyMovedElsewhere = true;
}

/** The broker answers a connector call can carry that the person has to act
 * on. Each becomes one plain sentence the model reads as the tool's answer,
 * instead of an HTTP status wrapped in the broker's JSON. Call after
 * `observeBrokerResponse`, so a retirement has already moved `activeBroker`. */
function plainBrokerAnswer(cfg: AppConfig, broker: BrokerAccess, status: number, code: string | undefined): string | null {
  if (broker.kind !== "legacy") return null;
  if (status === 410 && code === "legacy_broker_retired") {
    return activeBroker(cfg)?.kind === "flux" ? LEGACY_BROKER_RETIRED_FLUX_READY : LEGACY_BROKER_RETIRED;
  }
  if (status === 429 && code === "daily_call_ceiling") return LEGACY_DAILY_LIMIT;
  return null;
}

/** A JSON-RPC answer for each request in `payload` carrying `text`: a failed
 * tool result for tools/call, an error for anything else. Null when nothing
 * in the payload expects an answer. */
function jsonRpcFailure(payload: JsonValue, text: string): JsonValue | null {
  const answer = (message: JsonValue): JsonValue | null => {
    if (!message || typeof message !== "object" || Array.isArray(message) || !Object.hasOwn(message, "id")) return null;
    const id = (message as Record<string, JsonValue>).id;
    return (message as Record<string, JsonValue>).method === "tools/call"
      ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } }
      : { jsonrpc: "2.0", id, error: { code: -32000, message: text } };
  };
  if (!Array.isArray(payload)) return answer(payload);
  const answers = payload.map(answer).filter((item): item is JsonValue => item !== null);
  return answers.length ? answers : null;
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
 *     A Worker that has answered 410 `legacy_broker_retired` is past its
 *     cut-off whatever the date here says, so it drops out and a ready Flux
 *     broker takes over even mid-claim: the Worker identity is gone either way.
 *   - Neither: connected apps are unavailable and the panel offers FluxRouter.
 * Nothing here depends on whether the build is packaged, so dev and packaged
 * resolve the same broker for the same credentials; the Composio identity
 * itself is chosen by the broker from the account, never by this process. */
function activeBroker(_cfg: AppConfig): BrokerAccess | null {
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
  const declined = tokenError();
  const base: ConnectorMigration = { state: "none", legacyUntil: until };
  if (kind) base.accountKind = kind;
  if (declined) base.tokenError = declined;
  const claim = legacyClaim();
  if (claim.installationId) base.installationId = claim.installationId;
  if (claim.at) base.at = claim.at;
  if (claim.code) base.code = claim.code;
  if (legacyMovedElsewhere && claim.state !== "claimed") return { ...base, state: "moved-elsewhere" };
  // A claimed install's apps already live on FluxRouter; nobody else has to
  // reconnect anything when the Worker goes.
  if (claim.state !== "claimed" && legacyBrokerRetired()) return { ...base, state: "legacy-retired" };
  const state = CLAIM_TO_MIGRATION[claim.state];
  if (state === "none" && activeBroker(cfg)?.kind === "legacy") return { ...base, state: "legacy" };
  return { ...base, state };
}

// The last /v1/me from the Flux broker, for the free-allowance line.
const FLUX_ACCOUNT_STATUS_TTL_MS = 60_000;
let fluxAccountStatus: { url: string; token: string; at: number; freeRunsRemainingToday: number | null } | null = null;
let fluxAccountStatusFailure: { url: string; token: string; count: number; nextAt: number } | null = null;
const fluxMeSchema = z.object({ freeRunsRemainingToday: z.number().int().min(0).nullable().optional() }).passthrough();

/** Refresh the cached account status when the Flux broker is in use. Never
 * throws; an unreadable answer just leaves the line off. */
export async function refreshFluxAccountStatus(cfg: AppConfig): Promise<void> {
  const broker = activeBroker(cfg);
  if (broker?.kind !== "flux") return;
  const cached = fluxAccountStatus;
  if (cached && cached.url === broker.url && cached.token === broker.token && Date.now() - cached.at < FLUX_ACCOUNT_STATUS_TTL_MS) return;
  // A failed ask is not repeated on every panel request: 1 minute, doubling to
  // 1 hour, and after a 401 not at all until the broker token changes.
  const failed = fluxAccountStatusFailure;
  if (failed && failed.url === broker.url && failed.token === broker.token && Date.now() < failed.nextAt) return;
  const fail = (stop: boolean) => {
    const same = failed && failed.url === broker.url && failed.token === broker.token;
    const count = (same ? failed.count : 0) + 1;
    fluxAccountStatusFailure = { url: broker.url, token: broker.token, count, nextAt: stop ? Number.POSITIVE_INFINITY : Date.now() + fluxRetryDelayMs(count) };
  };
  try {
    const response = await brokerRequest(cfg, "/v1/me", { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(response.status === 401); return; }
    const body = fluxMeSchema.safeParse(await response.json());
    if (!body.success) { fail(false); return; }
    fluxAccountStatusFailure = null;
    fluxAccountStatus = { url: broker.url, token: broker.token, at: Date.now(), freeRunsRemainingToday: body.data.freeRunsRemainingToday ?? null };
  } catch {
    fail(false); // leave the previous answer, if any
  }
}

/** Refresh the allowance line without letting it hold up a route: waits at
 * most `waitMs`, and the refresh finishes behind the answer. */
export async function refreshFluxAccountStatusBriefly(cfg: AppConfig, waitMs = 1_500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([refreshFluxAccountStatus(cfg), new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

function freeRunsRemainingToday(cfg: AppConfig): number | null {
  const broker = activeBroker(cfg);
  const cached = fluxAccountStatus;
  if (broker?.kind !== "flux" || !cached || cached.url !== broker.url || cached.token !== broker.token) return null;
  return cached.freeRunsRemainingToday;
}

/** This person once saved a key of their own. It is kept on disk, untouched
 * and unused; the panel only needs to know it exists so it can say, once and
 * quietly, that connected apps now run through Flux Router. The desktop shell
 * sets the env flag when its secure store holds one. */
function ownKeyRetired(cfg: AppConfig): boolean {
  return Boolean(cfg.composio?.apiKey) || process.env.MURAGE_CONNECTED_APPS_OWN_KEY_RETIRED === "1";
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
    ownKeyRetired: ownKeyRetired(cfg),
  };
}

// Adapted from upstream52cd9563. Credentials are hashed, never duplicated in
// cache/transport keys. The project's own key still takes precedence.
function backendFingerprint(kind: string, endpoint: string, credential: string): string {
  return createHash("sha256").update(JSON.stringify([kind, endpoint, credential])).digest("hex");
}
function selectedBackendIdentity(cfg: AppConfig, catalog = false): string | null {
  const broker = activeBroker(cfg);
  return broker ? backendFingerprint(catalog ? "managed-catalog" : "managed", broker.url, broker.token) : null;
}
const transportSessionBackends = new Map<string, string>();
function rememberTransportSession(id: string, identity: string) {
  transportSessionBackends.delete(id);
  transportSessionBackends.set(id, identity);
  while (transportSessionBackends.size > 512) transportSessionBackends.delete(transportSessionBackends.keys().next().value!);
}

export { forgetInventoryMemory };

export function connectionMode(cfg: AppConfig): "managed" | "unavailable" {
  return activeBroker(cfg) ? "managed" : "unavailable";
}

/** A Flux sign-in exists (a token this install holds) but the broker is not
 * answering. Distinct from "nothing is set up". */
function fluxSignedInButUnreachable(cfg: AppConfig): boolean {
  return fluxBrokerCandidate() !== null && fluxBrokerAccess() === null && activeBroker(cfg) === null;
}

export function configured(cfg: AppConfig): boolean {
  return connectionMode(cfg) !== "unavailable";
}

/** Whether a turn about to start can mount connected apps. It refreshes a
 * stale readiness answer first (never waiting on a probe already running),
 * so one failed probe cannot leave every later turn without connected apps:
 * configured() alone reads the cache, and nothing re-probed it once it said
 * no, until the app restarted or someone opened Connected apps. */
export async function turnConnectedAppsReady(
  cfg: AppConfig,
  options: { expectConnectors?: boolean; waitMs?: number } = {},
): Promise<boolean> {
  // A bot that has connected apps enabled EXPECTS them. Without that, a probe
  // still running at launch was skipped (a turn never waits on one), the cache
  // still said "not ready", and the turn believed it had no connectors and
  // reported ready at once: its first connector call then failed with "no
  // matching deferred tools". An expecting turn joins the probe, bounded.
  await primeBrokerReadiness(options.expectConnectors
    ? { turn: true, mount: true, ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }) }
    : { turn: true });
  return configured(cfg);
}

/** Whether this workspace has connected apps it should be able to reach: a
 * sign-in or key exists even if the broker has not answered yet. */
export function connectedAppsExpected(cfg: AppConfig): boolean {
  return configured(cfg) || fluxBrokerCandidate() !== null || devFluxTokenEligible(fluxBrokerUrl());
}

/** The startup gate for scheduled runs: nothing to wait for when no connected
 * apps are expected; otherwise the broker must have answered ready. */
export async function connectedAppsStartupSettled(cfg: AppConfig, waitMs?: number): Promise<boolean> {
  if (!connectedAppsExpected(cfg)) return true;
  return turnConnectedAppsReady(cfg, { expectConnectors: true, ...(waitMs === undefined ? {} : { waitMs }) });
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
export type ConnectorAccess = "mounted" | "package-off" | "bot-off" | "unconfigured" | "unreachable" | "engine";

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
  if (!configured(input.cfg)) {
    if (!fluxSignedInButUnreachable(input.cfg)) return "unconfigured";
    logUnreachable("session", lastProbeCause ?? "no readiness answer");
    return "unreachable";
  }
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
      return " The user's connected apps (Gmail, Calendar, Slack, Notion, and the rest) are reachable through the connected-app tools. Find the right one with APPS_SEARCH_TOOLS, read its arguments with APPS_GET_TOOL_SCHEMAS, then run it with APPS_MULTI_EXECUTE_TOOL. Reach for them before telling the user you have no access to a service.";
    case "package-off":
      return " You have no connected-app tools this turn because you were installed from a bot package, and packaged assistants start with connected apps switched off until the user turns them on for you. The workspace's connections may exist and be perfectly healthy; you are simply not mounted on them. If the user asks for work in a connected service, say that your access to connected apps is switched off for you and that they can turn it on in your settings; never tell them the service is disconnected.";
    case "bot-off":
      return " You have no connected-app tools this turn because connected apps are switched off for you specifically (a per-bot setting the user controls). The workspace's connections may exist and be perfectly healthy. If the user asks for work in a connected service, say that your access to connected apps is switched off for you and that they can turn it on in your settings; never tell them the service is disconnected.";
    case "unconfigured":
      return " You have no connected-app tools this turn because this workspace has no connected-apps service set up: connected apps run through FluxRouter, and this workspace has not connected FluxRouter yet, so no bot here can reach connected apps. If the user asks for work in a connected service, say that connected apps are not set up in this workspace yet and point them at the Flux Router key in Models settings; do not claim a particular service failed or is disconnected.";
    case "unreachable":
      return " You have no connected-app tools this turn because connected apps can't be reached right now. Connected apps are already working for this workspace and nothing is wrong with the user's connections; the service is briefly unreachable, usually for under a minute. If the user asks for work in a connected service, say that connected apps can't be reached right now, that this is usually brief, and that you can try again in a minute. Never tell them connected apps need to be set up or reconnected, and do not claim a particular service failed or is disconnected.";
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
    `${app.label}${app.optional ? " (optional)" : ""}: ${app.reason.trim().replace(/\.$/, "")}`;
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
  if (!broker) throw new Error(fluxSignedInButUnreachable(cfg) ? BROKER_UNREACHABLE : BROKER_UNAVAILABLE);
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

async function responseError(res: Response, fallback: string) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
}

/** What the Connected apps panel says when checking connection status fails.
 * The service's own text (or a bare "HTTP 503") is for the log, not for a
 * person (0.1.60 audit C3). */
export function connectionStatusFailureSentence(status: number): string {
  if (status === 401 || status === 403) return "Connected apps didn't accept this computer's sign-in, so their status couldn't be checked. Check your connection in Settings, then try again.";
  if (status === 429) return "Connected apps are getting too many requests right now. Wait a minute, then refresh.";
  if (status >= 500 || status === 408) return "Connected apps aren't answering right now, so their status couldn't be checked. Try again in a few minutes.";
  return "Connected apps' status couldn't be checked. Try again in a few minutes.";
}
async function throwStatusFailure(res: Response, source: string): Promise<never> {
  const detail = await responseError(res, "");
  console.warn(`connected apps: ${source} status check failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
  const status = res.status >= 400 && res.status < 500 ? res.status : 502;
  throw Object.assign(new Error(connectionStatusFailureSentence(res.status)), { status });
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

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  // The turn's own readiness refresh. A mount must not skip a probe another
  // request already started (the turn would run with no connected apps), so it
  // joins that probe, bounded by FLUX_MOUNT_WAIT_CAP_MS: an offline laptop's
  // probe is shared, never repeated, and a hung broker cannot hang the turn.
  await primeBrokerReadiness({ turn: true, mount: true });
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
      ...connectorListEnv({ ...context, identity: connectorListIdentity(cfg, context.botId) }),
    },
  };
}

/** The bridge's list identity: stable for the signed-in account and the bot (the
 * rotating turn token is not part of it), never a secret. Null with no account. */
export function connectorListIdentity(cfg: AppConfig, botId: string): string | null {
  const owner = inventoryOwner(cfg);
  return owner ? createHash("sha256").update(`connector-list\0${owner}\0${botId}`).digest("hex").slice(0, 32) : null;
}

function connectorListEnv(context: IntegrationContext & { identity?: string | null }): Record<string, string> {
  const env: Record<string, string> = {};
  if (context.toolsCacheDir) {
    env.MURAGE_CONNECTOR_TOOLS_CACHE_DIR = context.toolsCacheDir;
    if (context.toolsCachePrivate) env.MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE = "1";
  }
  if (context.identity && context.listScope) {
    env.MURAGE_CONNECTOR_IDENTITY = context.identity;
    env.MURAGE_CONNECTOR_REVISION = context.listScope.revision;
    if (context.listScope.initialTools) {
      // The list below was built under this connection generation: the bridge never reuses it after a disconnect.
      // Captured by the caller with the list itself, never here (this runs after awaits). Always passed.
      env.MURAGE_CONNECTOR_INITIAL_GENERATION = context.listScope.generation || INITIAL_GENERATION;
      const text = JSON.stringify(context.listScope.initialTools);
      if (text.length <= INITIAL_TOOLS_ENV_MAX_CHARS) env.MURAGE_CONNECTOR_INITIAL_TOOLS = text;
      else {
        // Too long for the environment: the complete list goes through a private
        // file the bridge reads. Never truncated, never replaced by an empty list.
        const handed = context.toolsCacheDir
          ? handOverInitialTools({ dir: context.toolsCacheDir, windowsPrivate: context.toolsCachePrivate === true }, { identity: context.identity, revision: context.listScope.revision }, context.listScope.initialTools)
          : null;
        if (handed) env.MURAGE_CONNECTOR_INITIAL_TOOLS = handed;
        else if (text.length <= INITIAL_TOOLS_ENV_LAST_RESORT_CHARS) env.MURAGE_CONNECTOR_INITIAL_TOOLS = text;
        // Neither the file nor the environment can carry it: never an empty list
        // and never a pointer to a file that does not exist. The bridge is told to
        // ask the harness for the authoritative approved list before it answers
        // (and to fail the mount recoverably if it cannot).
        else env.MURAGE_CONNECTOR_INITIAL_TOOLS = INITIAL_TOOLS_ASK_HARNESS;
      }
    }
  }
  return env;
}

// Tool search and schemas answer the same thing for the same arguments until
// the user's connections change, and each costs a Flux round trip then a
// Composio one. Cached per owner and per inventory version (any connect or
// disconnect bumps it), briefly. Executing a tool, or asking to connect one,
// is never cached; neither is an error.
const TOOLS_LIST_TTL_MS = 10 * 60_000;
const TOOL_SEARCH_TTL_MS = 2 * 60_000;
const TOOL_SCHEMA_TTL_MS = 5 * 60_000;
const TOOL_CACHE_MAX = 200;
const toolResponseCache = new Map<string, { at: number; ttlMs: number; body: Record<string, JsonValue> }>();

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, JsonValue>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolCachePolicy(payload: JsonValue): { key: string; ttlMs: number } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const message = payload as { id?: JsonValue; method?: JsonValue; params?: JsonValue };
  if (message.id === undefined || message.id === null) return null;
  if (message.method === "tools/list") return { key: "tools/list", ttlMs: TOOLS_LIST_TTL_MS };
  if (message.method !== "tools/call" || !message.params || typeof message.params !== "object" || Array.isArray(message.params)) return null;
  const params = message.params as { name?: JsonValue; arguments?: JsonValue };
  if (params.name === "COMPOSIO_SEARCH_TOOLS") return { key: `search:${stableJson(params.arguments ?? null)}`, ttlMs: TOOL_SEARCH_TTL_MS };
  if (params.name === "COMPOSIO_GET_TOOL_SCHEMAS") return { key: `schemas:${stableJson(params.arguments ?? null)}`, ttlMs: TOOL_SCHEMA_TTL_MS };
  return null;
}

function rememberToolResponse(key: string, ttlMs: number, contentType: string | null, bytes: Uint8Array): void {
  if (!contentType?.includes("application/json")) return;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, JsonValue>;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.error !== undefined || body.result === undefined) return;
    const result = body.result;
    if (result && typeof result === "object" && !Array.isArray(result) && (result as { isError?: JsonValue }).isError === true) return;
    const { id: _id, ...rest } = body;
    toolResponseCache.delete(key);
    toolResponseCache.set(key, { at: Date.now(), ttlMs, body: rest });
    while (toolResponseCache.size > TOOL_CACHE_MAX) toolResponseCache.delete(toolResponseCache.keys().next().value!);
  } catch {
    // not JSON-RPC; leave it uncached
  }
}

/** The last good tools/list per owner, kept past its ten-minute freshness: a
 * turn's mount is answered from it at once and a stale one refreshes behind.
 * The list is the same handful of session tools whatever is connected, so a
 * remembered one is right; before, every mount after a quiet spell waited on
 * a readiness probe and a broker round trip before the engine saw any tool. */
const rememberedToolsList = new Map<string, { at: number; revision: number | string | null; epoch: number; body: Record<string, JsonValue> }>();
/** The list discovery running per owner, access revision and connection epoch: every
 * cold request for the same ones awaits the SAME broker round trip (a retry gets
 * the first request's answer, not a new wait). */
const coldToolsListInFlight = new Map<string, Promise<RelayReply>>();
/** The refresh running per owner, and the revision it was asked under. */
const toolsListRefreshing = new Map<string, number | string | null>();
/** The `_meta` key that marks a tools/list answer provisional: the bundled
 * standard list, or a remembered one from an older revision. A refresh is
 * running whenever one is served, and the connector bridge
 * (connector-proxy.ts followProvisionalList) asks again and tells the engine
 * to list again (`notifications/tools/list_changed`) once the real one lands. */
export const PROVISIONAL_TOOLS_META = "murage/provisional";
/** Set beside it when the answer is the bundled stand-in rather than an older real list (the same key as connector-proxy.ts). */
export const PROVISIONAL_BUNDLED_META = "murage/provisional-bundled";
/** With nothing remembered yet (the first mount after the app starts), how
 * long a mount waits for the broker before it is answered with the session's
 * standard tools; the broker's answer is remembered when it comes. */
export const COLD_TOOLS_LIST_WAIT_MS = 4_000;
let coldToolsListWaitMs = COLD_TOOLS_LIST_WAIT_MS;
/** Test hook: shrink (or, with no argument, restore) the cold wait. */
export function setColdToolsListWaitMsForTests(ms?: number): void {
  coldToolsListWaitMs = ms ?? COLD_TOOLS_LIST_WAIT_MS;
}

export { STANDARD_SESSION_TOOLS } from "./composio-standard-tools.ts";
import { STANDARD_SESSION_TOOLS } from "./composio-standard-tools.ts";

function isToolsList(payload: JsonValue): boolean {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { method?: JsonValue }).method === "tools/list"
    && (payload as { id?: JsonValue }).id !== undefined && (payload as { id?: JsonValue }).id !== null;
}

/** The same answer, marked provisional (PROVISIONAL_TOOLS_META). */
function provisional(body: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = (body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : {}) as Record<string, JsonValue>;
  const meta = (result._meta && typeof result._meta === "object" && !Array.isArray(result._meta) ? result._meta : {}) as Record<string, JsonValue>;
  return { ...body, result: { ...result, _meta: { ...meta, [PROVISIONAL_TOOLS_META]: true } } };
}

/** The revision of this owner's connected apps: any connect or disconnect
 * bumps it, so a list remembered under an older one is refreshed. */
function toolsListRevision(owner: string): number | string | null {
  return inventoryVersion(owner) ?? null;
}

/** Remember a good tools/list answer for this owner, at the revision it was asked under. */
function rememberToolsList(owner: string, reply: RelayReply, revision: number | string | null, epoch: number): void {
  if (reply.status !== 200 || !reply.contentType.includes("application/json")) return;
  // Asked before a disconnect or an access change: never filed (or served) afterwards.
  if (epoch !== connectionEpoch || revision !== toolsListRevision(owner)) return;
  try {
    const body = JSON.parse(new TextDecoder().decode(reply.bytes)) as Record<string, JsonValue>;
    const tools = (body?.result as { tools?: JsonValue } | undefined)?.tools;
    if (!Array.isArray(tools) || !tools.length || body.error !== undefined) return;
    const { id: _id, ...rest } = body;
    rememberedToolsList.set(owner, { at: Date.now(), revision, epoch, body: rest });
  } catch {
    // not JSON-RPC: nothing to remember
  }
}

/** Test seam: the access revision of this install's connected apps changes (a connect or disconnect). */
export function bumpAccessRevisionForTests(cfg: AppConfig): void {
  const owner = inventoryOwner(cfg);
  if (!owner) return;
  void readInventory(owner, async () => ({})).catch(() => {});
  invalidateInventory(owner);
}

/** The bundled stand-in, said so (PROVISIONAL_BUNDLED_META): the bridge holds a
 * first list against this one, because Codex and Grok never list again. */
function bundledProvisionalReply(id: JsonValue): RelayReply {
  const bundled = provisional({ jsonrpc: "2.0", id, result: { tools: STANDARD_SESSION_TOOLS as unknown as JsonValue } });
  const bundledResult = bundled.result as Record<string, JsonValue>;
  return jsonReply({ ...bundled, result: { ...bundledResult, _meta: { ...(bundledResult._meta as Record<string, JsonValue>), [PROVISIONAL_BUNDLED_META]: true } } });
}

/** The same reply addressed to this request (a shared discovery answers several). */
function replyWithId(reply: RelayReply, id: JsonValue): RelayReply {
  if (reply.status !== 200 || !reply.contentType.includes("application/json")) return reply;
  try {
    const body = JSON.parse(new TextDecoder().decode(reply.bytes)) as Record<string, JsonValue>;
    return jsonReply({ ...body, id });
  } catch {
    return reply;
  }
}

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
  beforeDispatch?: () => void,
  options: { timeoutMs?: number } = {},
): Promise<RelayReply> {
  if (!isToolsList(payload)) return relayMcpUpstream(cfg, payload, transportSessionId, beforeDispatch, false, options);
  const owner = inventoryOwner(cfg);
  if (!owner) return relayMcpUpstream(cfg, payload, transportSessionId, beforeDispatch, false, options);
  const id = (payload as { id?: JsonValue }).id ?? null;
  let held = rememberedToolsList.get(owner);
  const revision = toolsListRevision(owner);
  const epoch = connectionEpoch;
  // A list remembered under another access revision or before a disconnect is
  // never served, not even marked provisional: a disconnected account's tools
  // must not reach an engine that lists once. It is dropped and the answer is
  // held for authoritative discovery, like a first list.
  if (held && (held.revision !== revision || held.epoch !== epoch)) {
    rememberedToolsList.delete(owner);
    held = undefined;
  }
  if (held) {
    // Served now. One past its freshness refreshes behind, one refresh per revision at a time.
    if (Date.now() - held.at >= TOOLS_LIST_TTL_MS && (!toolsListRefreshing.has(owner) || toolsListRefreshing.get(owner) !== revision)) {
      toolsListRefreshing.set(owner, revision);
      void relayMcpUpstream(cfg, payload, undefined, beforeDispatch, true, options)
        .then((reply) => { if (inventoryOwner(cfg) === owner) rememberToolsList(owner, reply, revision, epoch); }, () => {})
        .finally(() => { if (toolsListRefreshing.get(owner) === revision) toolsListRefreshing.delete(owner); });
    }
    return jsonReply({ ...held.body, id });
  }
  const flightKey = `${owner}|${revision}|${epoch}`;
  let live = coldToolsListInFlight.get(flightKey);
  if (!live) {
    const started: Promise<RelayReply> = relayMcpUpstream(cfg, payload, transportSessionId, beforeDispatch, false, options).then((reply) => {
      if (inventoryOwner(cfg) === owner) rememberToolsList(owner, reply, revision, epoch);
      return reply;
    }).finally(() => { if (coldToolsListInFlight.get(flightKey) === started) coldToolsListInFlight.delete(flightKey); });
    started.catch(() => {});
    coldToolsListInFlight.set(flightKey, started);
    live = started;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    live.then((reply) => ({ reply })),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), coldToolsListWaitMs); }),
  ]).finally(() => clearTimeout(timer));
  if (raced) {
    // The connections or the access changed while it was asked: this answer is
    // from before, so it is not shown. The bridge holds against the stand-in and asks again.
    if (epoch !== connectionEpoch || revision !== toolsListRevision(owner)) return bundledProvisionalReply(id);
    return replyWithId(raced.reply, id);
  }
  return bundledProvisionalReply(id);
}

async function relayMcpUpstream(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
  beforeDispatch?: () => void,
  bypassCache = false,
  options: { timeoutMs?: number } = {},
): Promise<RelayReply> {
  // Every call re-checks readiness the way a turn start does (never waiting
  // on a probe already running), so a 503 earlier in this turn, which clears
  // it, is repaired here instead of failing every later call in the turn.
  await primeBrokerReadiness({ turn: true });
  const broker = activeBroker(cfg);
  // The "did the configuration change under this call" check compares which
  // credential owns the call, not whether the broker is answering: a 503 that
  // clears readiness mid-call must not read as a configuration change.
  const selectedIdentity = inventoryOwner(cfg);
  const assertCurrent = () => {
    if (inventoryOwner(cfg) !== selectedIdentity) throw new Error("Connected-app configuration changed; retry the request");
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
    if (fluxSignedInButUnreachable(cfg)) {
      logUnreachable("tool call", lastProbeCause ?? "no readiness answer");
      // Say it as the tool's own answer, in plain words, so the model relays
      // "briefly unreachable" rather than an error.
      const answer = jsonRpcFailure(payload, BROKER_UNREACHABLE);
      if (answer !== null) return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(answer)), contentType: "application/json", delivery: "not-sent" };
    }
    throw new Error(fluxSignedInButUnreachable(cfg) ? BROKER_UNREACHABLE : BROKER_UNAVAILABLE);
  }
  const cachePolicy = toolCachePolicy(payload);
  const cacheKey = cachePolicy ? `${identity}|${inventoryVersion(inventoryOwner(cfg))}|${cachePolicy.key}` : null;
  if (cacheKey) {
    const held = toolResponseCache.get(cacheKey);
    if (held && !bypassCache && Date.now() - held.at < held.ttlMs) {
      const id = (payload as { id?: JsonValue }).id;
      return {
        status: 200,
        bytes: new TextEncoder().encode(JSON.stringify({ ...held.body, id })),
        contentType: "application/json",
      };
    }
    if (held) toolResponseCache.delete(cacheKey);
  }
  const forwarded = transportSessionId && transportSessionBackends.get(transportSessionId) === identity ? transportSessionId : undefined;
  if (forwarded) headers.set("mcp-session-id", forwarded);
  beforeDispatch?.();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // A lookup stops a short grace after the bridge gives up. An action runs
      // for its own lifetime (relayConnectedAppCall keeps it going after the
      // bot's wait ends), bounded inside the broker's 285 s upstream cap plus
      // a margin, so a broker that never answers cannot hold a socket forever.
      signal: AbortSignal.timeout(options.timeoutMs ?? (connectedAppActionCall(payload)
        ? CONNECTED_APP_OPERATION_LIFETIME_MS
        : connectedAppCallTimeoutMs(payload) + CONNECTED_APP_RELAY_GRACE_MS)),
    });
  } catch (error) {
    // A dropped connection reads as a plain sentence, and readiness is
    // re-checked one negative TTL later by whoever asks next.
    if (broker?.kind === "flux" && error instanceof TypeError) {
      logUnreachable("tool call", errorCause(error));
      invalidateBrokerReadiness();
      const answer = jsonRpcFailure(payload, BROKER_UNREACHABLE);
      // Refused before anything left is "not sent"; a drop after the request
      // went out may have reached the app, so its outcome is unknown.
      const delivery = neverConnected(error) ? "not-sent" : "unknown";
      if (answer !== null) return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(answer)), contentType: "application/json", delivery };
    }
    throw error;
  }
  // Read before any body is consumed: only the broker saying so, in so many
  // words, makes a 5xx "nothing was sent".
  const refusal = response.ok ? undefined : brokerRefusalDelivery(response.status, await dispatchEvidence(response));
  if (broker) {
    // The hot path learns what the broker says about itself exactly as the
    // panel routes do: a retired Worker must stop being chosen here too.
    await observeBrokerResponse(broker, response, { sessionScoped: forwarded !== undefined, route: forwarded !== undefined ? "session" : "tool call" });
    if (broker.kind === "flux" && response.status === 404 && forwarded !== undefined) {
      // The session is gone: forget it so nothing forwards it again, and let
      // the caller (the stdio bridge) open a new one and retry.
      transportSessionBackends.delete(forwarded);
      await response.body?.cancel().catch(() => {});
      return {
        status: 404,
        bytes: new TextEncoder().encode(JSON.stringify({ error: "session_gone" })),
        contentType: "application/json",
        delivery: refusal ?? "unknown",
      };
    }
    const unreachable = broker.kind === "flux" && (response.status === 503 || response.status === 404);
    const plain = response.ok ? null : unreachable ? BROKER_UNREACHABLE : plainBrokerAnswer(cfg, broker, response.status, await responseCode(response));
    const answer = plain === null ? null : jsonRpcFailure(payload, plain);
    if (answer !== null) {
      await response.body?.cancel().catch(() => {});
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(answer)), contentType: "application/json", delivery: refusal! };
    }
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  assertCurrent();
  if (broker && response.ok) observeAppAnswer(cfg, payload, bytes);
  if (cacheKey && cachePolicy && response.status === 200) rememberToolResponse(cacheKey, cachePolicy.ttlMs, response.headers.get("content-type"), bytes);
  if (forwarded) rememberTransportSession(forwarded, identity);
  const nextSession = response.headers.get("mcp-session-id") ?? undefined;
  if (nextSession) rememberTransportSession(nextSession, identity);
  const delivery = refusal ?? (response.ok && inBandNotDispatched(bytes, (payload as { id?: unknown } | null)?.id) ? "not-sent" as const : undefined);
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    transportSessionId: nextSession,
    ...(delivery ? { delivery } : {}),
  };
}

// ── Which app needs signing in again ────────────────────────────────────
// A tool call that comes back as an authorization failure marks THAT app
// (connected-app-health.ts); a call to it that succeeds clears the mark. The
// broker being dark, its token being rejected and a dropped connection are
// whole-broker cases above and never mark an app. A 403 (a missing permission
// scope, a policy refusal, from the app or from the broker) is not a sign-in
// failure: signing in again would not change it, so it never marks an app
// either; only a 401, a rejected or expired grant, or an explicit reconnect
// signal does.

/** The tool slugs a request names, or none for a lookup or a non-call. */
function toolsNamedBy(payload: JsonValue): string[] {
  const message = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, JsonValue> : null;
  const params = message?.method === "tools/call" && message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Record<string, JsonValue> : null;
  if (!params) return [];
  const name = String(params.name ?? "");
  if (!name || isConnectedAppLookup(name) || isConnectedAppStatusTool(name)) return [];
  const named = connectedAppRequirements(params.arguments, name).map((entry) => entry.tool);
  if (named.length) return named;
  const bare = connectedAppToolId(name);
  return /^COMPOSIO_/.test(bare) ? [] : [bare];
}

function noteNeedsReconnect(cfg: AppConfig, slug: string, cause: string): void {
  const owner = inventoryOwner(cfg);
  if (!owner) return;
  const held = peekInventory(owner);
  const fresh = markNeedsReconnect(owner, slug, cause, held?.[slug] ? accountKeyOf(held[slug]!.accounts) : null);
  if (fresh) console.warn(`connected apps: ${safeCause(slug)} needs reconnecting: ${safeCause(cause)}`);
}

function observeAppAnswer(cfg: AppConfig, payload: JsonValue, bytes: Uint8Array): void {
  const tools = toolsNamedBy(payload);
  if (!tools.length) return;
  const requestId = (payload as { id?: unknown } | null)?.id;
  const reading = readAppAnswer(tools, requestId, bytes);
  const owner = inventoryOwner(cfg);
  for (const [slug, cause] of reading.failed) noteNeedsReconnect(cfg, slug, cause);
  if (owner) for (const slug of reading.ok) if (!reading.failed.has(slug)) clearNeedsReconnect(owner, slug);
}

/** The inventory with each app that needs signing in again marked so. A mark
 * ends when the person signs in again (the set of active accounts changed).
 * A mark made before any inventory was held takes the first active set seen,
 * so a later sign-in still ends it. When a Reconnect named the account it
 * replaces, that account is retired only now, once a NEW active account for
 * the app exists: never before the new sign-in has finished. */
function withAppHealth<T extends { connected: boolean; status?: string; needsReconnect?: boolean; accounts?: Array<{ id: string; status: string }> }>(
  cfg: AppConfig,
  owner: string | null,
  services: Record<string, T>,
): Record<string, T> {
  if (!owner) return services;
  const slugs = needsReconnectSlugs(owner);
  if (!slugs.length) return services;
  const out = { ...services };
  for (const slug of slugs) {
    const service = out[slug];
    const mark = healthMark(owner, slug);
    if (!service || !mark) continue;
    if (!service.connected) { clearNeedsReconnect(owner, slug); continue; }
    const key = accountKeyOf(service.accounts);
    if (mark.accountKey === null) updateMark(owner, slug, { accountKey: key });
    else if (key !== mark.accountKey) {
      const before = new Set(mark.accountKey.split(",").filter(Boolean));
      const gained = key.split(",").some((id) => id !== "" && !before.has(id));
      const present = new Set((service.accounts ?? []).map((account) => account.id));
      const retire = gained ? (mark.replaces ?? []).filter((id) => present.has(id)) : [];
      clearNeedsReconnect(owner, slug);
      if (retire.length) void retireReplacedAccounts(cfg, slug, retire);
      continue;
    }
    out[slug] = { ...service, status: "NEEDS_RECONNECT", needsReconnect: true };
  }
  return out;
}

/** Remove the accounts a finished Reconnect replaced. Never throws. */
async function retireReplacedAccounts(cfg: AppConfig, slug: string, ids: ReadonlyArray<string>): Promise<void> {
  let removed = false;
  for (const id of ids) {
    if (!validAccountId(id)) continue;
    try {
      const response = await brokerRequest(cfg, `/v1/connectors/${encodeURIComponent(slug)}/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (response.ok) removed = true;
    } catch { /* the old account stays; the person can remove it in Connected apps */ }
  }
  if (removed) { invalidateConnected(cfg, { drop: true }); connectionsRemoved(); }
}

/** The name the bot and the chat show for an app: the curated or monogram
 * label (never one the broker supplied), letters, digits and spaces only. */
function reconnectLabel(slug: string): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 40).trim();
  return clean(knownApps(null, [slug])[slug]?.label ?? "") || clean(slug) || "A connected app";
}

/** The apps that need signing in again, with what the person needs to act:
 * the label to show and the accounts to sign in again. */
export function appsNeedingReconnect(cfg: AppConfig): Array<{ slug: string; label: string; accounts: Array<{ id: string; alias?: string }> }> {
  const owner = inventoryOwner(cfg);
  if (!owner || !needsReconnectSlugs(owner).length) return [];
  const held = peekInventory(owner);
  const services = held ? withAppHealth(cfg, owner, held as Record<string, InventoryServices[string] & { needsReconnect?: boolean }>) : {};
  return Object.entries(services)
    .filter(([, service]) => (service as { needsReconnect?: boolean }).needsReconnect)
    .map(([slug, service]) => ({
      slug,
      label: reconnectLabel(slug),
      accounts: (service.accounts ?? []).filter((account) => /^active$/i.test(account.status)).map((account) => ({ id: account.id, ...(account.alias ? { alias: account.alias } : {}) })),
    }));
}

/** What a bot is told when an app's sign-in no longer works: that app needs
 * reconnecting and the owner does it in Connected apps. It is not the
 * brief-outage line, and it names only the apps in this state. */
export function reconnectSystemPrompt(cfg: AppConfig): string {
  return reconnectPromptFor(appsNeedingReconnect(cfg).map((app) => app.label));
}

export function reconnectPromptFor(labels: ReadonlyArray<string>): string {
  if (!labels.length) return "";
  const one = labels.length === 1;
  const list = one ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const verb = one ? "needs" : "need";
  return ` ${list} ${verb} reconnecting: ${one ? "its" : "their"} sign-in has stopped working, so calls to ${one ? "it" : "them"} fail until the owner reconnects ${one ? "it" : "them"} in Connected apps, where there is a Reconnect button. If the user asks for work in ${one ? "that app" : "those apps"}, say plainly that ${list} ${verb} reconnecting and ask the owner to do it; do not say the service is briefly unreachable, and do not retry the call until it is reconnected. Other connected apps are unaffected.`;
}

const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
/** A fetch failure that happened before the request could have left. */
function neverConnected(error: TypeError): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" && NEVER_CONNECTED.has(cause.code);
}

/** Codes the Flux broker answers a 503 with only when it turned the request
 * away before dispatching anything (flux-router 523958cb). */
const FLUX_PRE_SEND_CODES = new Set(["apps_unavailable", "composio_unavailable", "capability_unavailable"]);

/** What the broker's error body says about whether anything was dispatched. */
async function dispatchEvidence(response: Response): Promise<{ dispatched?: boolean; code?: string }> {
  try {
    const body = (await response.clone().json()) as { dispatched?: unknown; code?: unknown } | null;
    return {
      ...(body?.dispatched === false ? { dispatched: false } : {}),
      ...(typeof body?.code === "string" ? { code: body.code } : {}),
    };
  } catch {
    return {};
  }
}

/** A failed broker answer is "unknown" (it may have reached the app) unless
 * the broker said, in so many words, that nothing was dispatched: a top-level
 * `dispatched:false`, or (503 only) one of the codes Flux uses for exactly
 * that. No status alone is evidence, 4xx included: Flux's own 400/402/403/
 * 413/429 refusals carry no flag today, and the app's own 4xx pass through. */
function brokerRefusalDelivery(status: number, evidence: { dispatched?: boolean; code?: string } = {}): "not-sent" | "unknown" {
  if (evidence.dispatched === false) return "not-sent";
  if (status === 503 && evidence.code !== undefined && FLUX_PRE_SEND_CODES.has(evidence.code)) return "not-sent";
  return "unknown";
}

/** An answer carried in a 200 (plain JSON or an event stream) that is, for
 * THIS request's JSON-RPC id, an in-band -32000 error saying
 * `data.dispatched` is false: nothing was sent. A frame for any other id is
 * somebody else's answer and says nothing about this request. */
function inBandNotDispatched(bytes: Uint8Array, requestId: unknown): boolean {
  if (requestId === undefined || requestId === null) return false;
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return false;
  const frames: unknown[] = [];
  const parse = (value: string) => { try { frames.push(JSON.parse(value)); } catch { /* not a frame */ } };
  if (text.startsWith("{") || text.startsWith("[")) parse(text);
  else for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) parse(line.slice(5).trim());
  const list = frames.flatMap((frame) => Array.isArray(frame) ? frame : [frame])
    .filter((frame) => !!frame && typeof frame === "object" && (frame as { id?: unknown }).id === requestId);
  const errors = list.filter((frame): frame is { error: { code?: unknown; data?: { dispatched?: unknown } } } =>
    !!frame && typeof frame === "object" && "error" in frame && !!(frame as { error: unknown }).error && typeof (frame as { error: unknown }).error === "object");
  if (!errors.length || list.some((frame) => !!frame && typeof frame === "object" && "result" in frame)) return false;
  return errors.every((frame) => frame.error.code === -32000 && frame.error.data?.dispatched === false);
}

// ── One identity per connected-app action ───────────────────────────────
// (server/connected-app-operations.ts explains the ledger.)
// The journal is written before an action is sent, so a restart cannot forget
// one that was on its way.
const operationJournal = new SqliteOperationJournal(defaultJournalFile(DATA_DIR));
let connectedAppOperations = new ConnectedAppOperations(Date.now, operationJournal);

/** Tests only: forget every kept operation, in memory and in the journal. */
export function resetConnectedAppOperations(): void {
  connectedAppOperations.reset();
}

/** Tests only: as if Murage had stopped and started again. Memory is lost; the
 * journal is what the new process reads. */
export function restartConnectedAppOperations(): void {
  connectedAppOperations = new ConnectedAppOperations(Date.now, operationJournal);
}

function jsonReply(message: unknown): RelayReply {
  return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(message)), contentType: "application/json" };
}

function textReply(id: unknown, text: string, isError = false): RelayReply {
  return jsonReply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
}

/** A kept answer handed to a later request: its id, with a note first. */
function keptReply(op: ConnectedAppOperation, reply: RelayReply, id: unknown, now: number): RelayReply {
  const ago = Math.max(0, Math.round((now - op.startedAt) / 1000));
  const note = op.fresh ? connectedAppHistoryNote(op.label, op.handle, ago) : connectedAppRepeatNote(op.label, op.handle, ago);
  // Only the frame that answers the request that started the operation: a
  // stored stream may carry answers to other requests.
  const message = replyMessage(reply, op.requestId);
  if (!message) {
    const raw = new TextDecoder().decode(reply.bytes);
    const readable = !isEventStream(reply) && !/^\s*[{[]/.test(raw);
    return readable
      ? textReply(id, `${note}\n\n${raw.slice(0, 20_000)}`)
      : textReply(id, `${note}\n\nThe app's answer to this request could not be read back. Check in the app for the outcome.`, true);
  }
  const result = message.result;
  if (result && typeof result === "object" && !Array.isArray(result) && Array.isArray((result as { content?: unknown }).content)) {
    const content = (result as { content: unknown[] }).content;
    return jsonReply({ ...message, id, result: { ...result, content: [{ type: "text", text: note }, ...content] } });
  }
  if (message.error !== undefined) {
    const error = message.error as { message?: unknown };
    return textReply(id, `${note}\n\n${String(error?.message ?? JSON.stringify(message.error))}`, true);
  }
  return jsonReply({ ...message, id });
}

/** Which connection a call goes through, for the missing-permission note. Both brokers hold the connected-apps account for the person, so
 *  reconnecting changes nothing there (managed); with no broker the account is the person's own, where reconnecting can grant the access. */
export function scopeRouteFor(broker: BrokerKind | null): ScopeRoute {
  return broker === null ? "own" : "managed";
}

/** The reply with the missing-permission note added when the app refused for that reason; the very same reply otherwise. */
function withScopeRefusalNote(op: ConnectedAppOperation, reply: RelayReply): RelayReply {
  const call = operationCalls.get(op);
  const bytes = withScopeHint(reply.bytes, reply.contentType, toolSlugsOf(call?.name, call?.args), call?.route ?? "managed");
  return bytes === reply.bytes ? reply : { ...reply, bytes };
}

/** What a request receives once an operation has an outcome. `first` is the
 * request that started it, which gets the broker's own bytes unchanged. */
function outcomeReply(op: ConnectedAppOperation, outcome: OperationOutcome, id: unknown, first: boolean): RelayReply {
  if (outcome.kind === "answered") {
    connectedAppOperations.delivered(op);
    // The journal keeps the broker's raw answer; the note is added here, on the way to the bot, every time it is read.
    const answer = withScopeRefusalNote(op, outcome.reply);
    return first ? answer : keptReply(op, answer, id, Date.now());
  }
  if (outcome.kind === "unknown") return textReply(id, op.fresh ? connectedAppReadUnknownText(op.label) : connectedAppUnknownText(op.label, op.handle, outcome.cause), true);
  if (first) {
    if (outcome.reply) return outcome.reply;
    throw outcome.error;
  }
  const reason = outcome.error instanceof Error ? outcome.error.message : "the app could not be reached";
  return textReply(id, connectedAppNotSentText(op.label, reason), true);
}

const provenanceOf = (op: ConnectedAppOperation): ConnectedAppProvenance => ({ requirements: op.requirements, complete: op.requirementsComplete });

/** The call each operation in this process was started with, for the receipt
 * of what the app completed (server/connected-app-receipts.ts). Not journaled. */
const operationCalls = new WeakMap<ConnectedAppOperation, { name: string; args: unknown; route: ScopeRoute; origin?: ConnectedAppOrigin }>();
/** (above) the call and who made it; the operation itself names the receipt (handle) and when it was dispatched. */
/** The turn whose bridge made the call that started an action. A status check or a repeat that collects the answer later
 * is another turn's call, but the action, and so its receipt, belongs to this one. */
export interface ConnectedAppOrigin { threadId: string; botId: string; generation: string; /** The provider turn that generation dispatched, when it is known yet. */ turnId?: string }
export type ConnectedAppAnswered = (call: { name: string; args: unknown; origin?: ConnectedAppOrigin; key: string; dispatchedAt: number }, answer: Record<string, unknown> | null) => void;

/** Tell the caller an operation's answer reached the bot. Never throws into the relay. */
function reportAnswered(op: ConnectedAppOperation, outcome: OperationOutcome | undefined, onAnswered: ConnectedAppAnswered | undefined): void {
  if (!onAnswered || outcome?.kind !== "answered") return;
  const call = operationCalls.get(op);
  if (!call) return;
  try { onAnswered({ ...call, key: op.handle, dispatchedAt: op.startedAt }, replyMessage(outcome.reply, op.requestId)); } catch (error) {
    console.warn("connected app receipt failed:", error instanceof Error ? error.message : String(error));
  }
}

async function statusReply(scope: string, id: unknown, args: unknown, waitMs: number, authorizeStored?: (used: ConnectedAppProvenance) => void, onAnswered?: ConnectedAppAnswered): Promise<RelayReply> {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as { handle?: unknown; run_again?: unknown } : {};
  const handle = typeof input.handle === "string" ? input.handle.trim() : "";
  const op = handle ? connectedAppOperations.byHandle(scope, handle) : undefined;
  if (!op) return textReply(id, connectedAppNoRecordText(handle || "(none)"));
  // The handle proves which bot asked, not that it may still see this: the
  // bot's grants as they are now must cover what the action used.
  authorizeStored?.(provenanceOf(op));
  if (input.run_again === true) {
    if (!op.outcome) return textReply(id, connectedAppPendingText(op.label, op.handle, true));
    try {
      connectedAppOperations.clear(op);
    } catch {
      return textReply(id, connectedAppNotClearedText(op.label), true);
    }
    return textReply(id, connectedAppClearedText(op.label));
  }
  const outcome = await waitForOperation(op, waitMs);
  // Grants can change while this waited (up to the status wait): look again,
  // immediately before anything of the action is handed over.
  authorizeStored?.(provenanceOf(op));
  if (!outcome) return textReply(id, connectedAppPendingText(op.label, op.handle, true));
  reportAnswered(op, outcome, onAnswered);
  return outcomeReply(op, outcome, id, false);
}

/**
 * The connected-apps relay for one bot's call. Lookups and the tool list go
 * straight through (a lookup that runs out of time is a plain error). An
 * action gets an operation identity: the bot waits at most `waitMs`, then is
 * told it is still running, with a handle; the action carries on and its
 * outcome is kept. The same action made again joins it rather than running
 * twice. The bridge's status tool (CHECK_CONNECTED_APP_ACTION) collects it.
 */
export async function relayConnectedAppCall(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId: string | undefined,
  beforeDispatch: (() => void) | undefined,
  options: {
    botId: string; waitMs?: number; lifetimeMs?: number; statusWaitMs?: number;
    /** Throws when the bot may no longer use what a stored action used. */
    authorizeStored?: (used: ConnectedAppProvenance) => void;
    /** Called when an action's answer from the app is handed to the bot (first, joined or collected). */
    onAnswered?: ConnectedAppAnswered;
    /** Who is making this call; kept with an action it starts, for its receipt. */
    origin?: ConnectedAppOrigin;
  },
): Promise<RelayReply> {
  const message = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, JsonValue> : null;
  const params = message?.method === "tools/call" && message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Record<string, JsonValue> : null;
  const scope = `${options.botId}|${inventoryOwner(cfg) ?? "none"}`;
  if (params && isConnectedAppStatusTool(String(params.name ?? "")) && message!.id !== undefined) {
    beforeDispatch?.();
    return statusReply(scope, message!.id, params.arguments, Math.min(options.statusWaitMs ?? CONNECTED_APP_STATUS_WAIT_MS, options.waitMs ?? Infinity), options.authorizeStored, options.onAnswered);
  }
  // An action that cannot be given an identity (no usable request id, or inside
  // a batch) is never forwarded: nothing would record it or stop its repeat.
  if (connectedAppUnprotectedAction(payload)) {
    beforeDispatch?.();
    const rawId = message && "id" in message ? message.id : null;
    return jsonReply({
      jsonrpc: "2.0",
      id: typeof rawId === "string" || typeof rawId === "number" ? rawId : null,
      error: { code: -32600, message: "An app action needs a request id so Murage can keep track of it. Send it as a single request with an id." },
    });
  }
  const action = connectedAppActionCall(payload);
  if (!action) return relayMcp(cfg, payload, transportSessionId, beforeDispatch);
  const waitMs = Math.max(0, Math.min(options.waitMs ?? CONNECTED_APP_ACTION_TIMEOUT_MS, CONNECTED_APP_ACTION_TIMEOUT_MS));
  // Identity is the tool and its effect-bearing arguments; the model's
  // commentary (`thought`, step labels) changes on every retry and is left out.
  const key = operationKey(connectedAppToolId(action.name), connectedAppEffectArgs(action.args));
  // Only a call whose every action is a verified read runs fresh each time;
  // writes, unknown tools, mixed batches and code tools keep the one-send guard.
  const fresh = classifyConnectedAppCall(action.name, action.args) === "read";
  const existing = fresh ? undefined : connectedAppOperations.blocking(scope, key);
  if (existing) {
    // Same tool, same arguments, same bot and account: never a second send.
    beforeDispatch?.();
    const outcome = await waitForOperation(existing, waitMs);
    // The wait may have outlasted the bot's grants.
    options.authorizeStored?.(provenanceOf(existing));
    reportAnswered(existing, outcome, options.onAnswered);
    return outcome ? outcomeReply(existing, outcome, action.id, false) : textReply(action.id, connectedAppPendingText(existing.label, existing.handle, true));
  }
  let sent = false;
  let op: ConnectedAppOperation;
  try {
    op = connectedAppOperations.start(
      scope,
      key,
      connectedAppActionLabel(action.args),
      // Only a result or error frame carrying THIS request's id is an answer;
      // anything else that came back (foreign ids, empty, malformed) leaves the
      // outcome unknown, so repeats stay blocked until CHECK or run_again.
      async () => {
        const reply = await relayMcp(cfg, payload, transportSessionId, () => { beforeDispatch?.(); sent = true; }, { timeoutMs: options.lifetimeMs ?? CONNECTED_APP_OPERATION_LIFETIME_MS });
        return reply.delivery || answersRequest(reply, action.id) ? reply : { ...reply, delivery: "unknown" as const };
      },
      () => sent,
      (() => {
        const provenance = connectedAppProvenance(action.name, action.args);
        return { requestId: action.id, requirements: provenance.requirements, requirementsComplete: provenance.complete, fresh };
      })(),
    );
  } catch (error) {
    if (!(error instanceof OperationRefused)) throw error;
    beforeDispatch?.();
    const label = connectedAppActionLabel(action.args);
    return textReply(action.id, error.reason === "busy" ? connectedAppBusyText(label) : connectedAppUnrecordedText(label), true);
  }
  operationCalls.set(op, { name: action.name, args: action.args, route: scopeRouteFor(connectionBroker(cfg)), ...(options.origin ? { origin: options.origin } : {}) });
  // The receipt is kept when the app answers, not when someone collects: a slow action that finishes after the bot's wait
  // ran out, then a restart before any status check, still leaves its record (the same key is never kept twice).
  void op.done.then((settled) => reportAnswered(op, settled, options.onAnswered), () => undefined);
  const outcome = await waitForOperation(op, waitMs);
  reportAnswered(op, outcome, options.onAnswered);
  return outcome ? outcomeReply(op, outcome, action.id, true) : textReply(action.id, connectedAppPendingText(op.label, op.handle, false));
}

/** Who owns the remembered inventory: the credential identity that would be
 * asked, whether or not the broker is answering right now. A hash, never a
 * credential; null when nothing is configured at all. */
function inventoryOwner(_cfg: AppConfig): string | null {
  // The same choice `activeBroker` makes between the two managed identities,
  // minus the broker's current readiness: an outage must not flip the owner
  // (and so drop the remembered list) just when it matters most. Only a
  // definitive change (the claim, the Worker's retirement, a new token) does.
  const flux = fluxBrokerCandidate();
  const legacy = legacyBrokerAccess();
  const claim = legacyClaim().state;
  const legacyIdentityLive = legacy !== null && (claim === "none" || claim === "offered" || claim === "pending");
  const access = flux && !legacyIdentityLive ? flux : legacy ?? flux ?? workerBrokerCredential();
  return access ? backendFingerprint("inventory-managed", access.url, access.token) : null;
}

function loadInventory(cfg: AppConfig, owner: string): () => Promise<InventoryServices> {
  return async () => {
    // A background refresh re-checks the broker first, so an outage that has
    // ended is noticed without anyone opening a panel.
    await primeBrokerReadiness({ turn: true });
    const services = await fetchConnectedServices(cfg);
    // The key or token may have changed while this was in flight: what came
    // back belongs to whoever owns the call NOW, so it is not this owner's.
    if (inventoryOwner(cfg) !== owner) throw new Error("Connected-app configuration changed; retry the request");
    return services;
  };
}

/** The remembered inventory, answered at once when there is one (stale ones
 * refresh behind it). With nothing remembered it waits up to `waitMs` and then
 * answers `services: null, revalidating: true`. */
export async function connectedInventory(cfg: AppConfig, options: InventoryReadOptions = {}): Promise<InventoryRead> {
  const owner = inventoryOwner(cfg);
  if (!owner) throw new Error(BROKER_UNAVAILABLE);
  const read = await readInventory(owner, loadInventory(cfg, owner), { waitMs: 3_000, ...options });
  return read.services ? { ...read, services: withAppHealth(cfg, owner, read.services) } : read;
}

export type PanelInventory =
  | { kind: "unavailable"; availability: ConnectorAvailability }
  | { kind: "ok"; read: InventoryRead };

/** What `GET /api/connectors/connected` answers with. A remembered list is
 * served without waiting on a readiness probe (so a cached open makes no
 * broker call before its first paint) and refreshes behind it; only a first
 * ever open, or the panel's own Retry (`force`), waits, and then for at most
 * three seconds. */
export async function connectedPanelInventory(cfg: AppConfig, options: { force?: boolean } = {}): Promise<PanelInventory> {
  const owner = inventoryOwner(cfg);
  const remembered = owner !== null && hasInventory(owner);
  if (!remembered || options.force) await primeBrokerReadiness();
  const availability = connectorAvailability(cfg);
  if (!remembered && availability !== "configured") return { kind: "unavailable", availability };
  return { kind: "ok", read: await connectedInventory(cfg, { force: options.force }) };
}

/** True when a connected-apps list is already remembered, so a view can show it without a broker call. */
export function hasRememberedConnected(cfg: AppConfig): boolean {
  const owner = inventoryOwner(cfg);
  return owner !== null && hasInventory(owner);
}

/** The inventory for a view or a count: one shared, single-flight read. Waits
 * only when nothing is remembered (or `fresh` is set). */
export async function connectedServices(cfg: AppConfig, options: { fresh?: boolean } = {}): Promise<Record<string, ConnectorServiceState>> {
  const owner = inventoryOwner(cfg);
  if (!owner) throw new Error(BROKER_UNAVAILABLE);
  const read = await readInventory(owner, loadInventory(cfg, owner), { fresh: options.fresh });
  return withAppHealth(cfg, owner, read.services ?? {});
}

/** Something this app did may have changed the list: refetch it. `drop` for a
 * removal, so a disconnected app is never shown as connected again. */
function invalidateConnected(cfg: AppConfig, options: { drop?: boolean } = {}): void {
  const owner = inventoryOwner(cfg);
  invalidateInventory(owner, options);
}

function clearInventoryAndToolCache(): void {
  clearInventory();
  toolResponseCache.clear();
  rememberedToolsList.clear();
  connectionsRemoved();
}

// The bridge's on-disk tool lists name accounts and carry upstream
// descriptions. When an account is disconnected, or the person signs out, they
// go at once, and the epoch below (part of every bot's list revision) changes so
// a warm bridge stops serving what it still remembers in memory.
let connectionEpoch = 0;
let toolsCachePurger: (() => void) | null = null;
/** The index installs the purge for its data folder. */
export function setToolsCachePurger(purge: (() => void) | null): void { toolsCachePurger = purge; }
/** Changes whenever connected accounts were removed in this process. */
export function connectedAppsEpoch(): number { return connectionEpoch; }
function connectionsRemoved(): void {
  connectionEpoch += 1;
  try { toolsCachePurger?.(); } catch { /* best effort: the revision change already retires every remembered list */ }
}

/**
 * Enumerate the user's complete connected-account inventory without depending
 * on marketplace ordering or catalog pagination. Always a broker round trip;
 * the cached readers below are what views use.
 */
async function fetchConnectedServices(cfg: AppConfig): Promise<Record<string, ConnectorServiceState>> {
  if (activeBroker(cfg)) {
    const response = await brokerRequest(cfg, "/v1/connectors/connected");
    if (!response.ok) await throwStatusFailure(response, "managed inventory");
    const body = connectorServicesResponseSchema.parse(await response.json());
    // A 200 without a services map is not an inventory: it must never read as "nothing connected" (bot calls free/busy r1).
    if (!body.services) throw new Error("Connected-app inventory answer had no services list");
    return Object.fromEntries(
      Object.entries(body.services).map(([slug, state]) => [slug, {
        connected: state.connected,
        pending: state.pending ?? false,
        status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
        accounts: state.accounts ?? [],
        ...(state.statusReason ? { statusReason: state.statusReason } : {}),
        ...(state.createdAt ? { createdAt: state.createdAt } : {}),
      }]),
    );
  }
  throw new Error(BROKER_UNAVAILABLE);
}

export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  const owner = inventoryOwner(cfg);
  const key = `${owner}|${[...slugs].sort().join(",")}`;
  const running = statusFlights.get(key);
  if (running) return running;
  const flight = fetchConnectionStatus(cfg, slugs).then((states) => {
    // A poll that sees a sign-in finish, fail or expire changes the list:
    // refetch it rather than trusting a remembered "pending".
    if (owner && statesDiffer(owner, states)) invalidateInventory(owner);
    return withAppHealth(cfg, owner, states);
  }).finally(() => { statusFlights.delete(key); });
  statusFlights.set(key, flight);
  return flight;
}
type StatusStates = Record<string, z.infer<typeof connectorServiceSchema>>;
const statusFlights = new Map<string, Promise<StatusStates>>();

function statesDiffer(owner: string, states: StatusStates): boolean {
  const remembered = peekInventory(owner);
  if (!remembered) return false;
  return Object.entries(states).some(([slug, state]) => {
    const before = remembered[slug];
    if (!before) return state.connected || (state.pending ?? false);
    return before.connected !== state.connected || (before.pending ?? false) !== (state.pending ?? false);
  });
}

async function fetchConnectionStatus(cfg: AppConfig, slugs: string[]): Promise<StatusStates> {
  const response = await brokerRequest(cfg, `/v1/connectors?${new URLSearchParams({ services: slugs.join(",") })}`);
  if (!response.ok) await throwStatusFailure(response, "managed");
  const body = connectorServicesResponseSchema.parse(await response.json());
  return body.services ?? {};
}

/** Backward-compatible service disconnect: removes the Session-selected account. */
export async function removeService(cfg: AppConfig, slug: string) {
  const response = await brokerRequest(cfg, `/v1/connectors/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
  const answer = removalResponseSchema.parse(await response.json());
  invalidateConnected(cfg, { drop: true });
  connectionsRemoved();
  return answer;
}

/** Disconnect exactly one account after proving it belongs to this user/toolkit. */
export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  if (!validAccountId(accountId)) throw inputError("Invalid connected-account ID");
  const response = await brokerRequest(
    cfg,
    `/v1/connectors/${encodeURIComponent(slug)}/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
  const answer = removalResponseSchema.parse(await response.json());
  invalidateConnected(cfg, { drop: true });
  connectionsRemoved();
  return answer;
}

/** An attempt that ended without connecting. Only these are ever cleared: a
 * disabled (INACTIVE) connection is a real one the person may want back. */
const DEAD_ATTEMPT = /^(failed|expired)$/i;

/** Remove the attempts for `slug` labelled `alias` that are no longer usable
 * (failed or expired). Returns whether any was removed. Never throws. */
async function clearDeadAttempts(cfg: AppConfig, slug: string, alias: string): Promise<boolean> {
  try {
    const services = await connectedServices(cfg, { fresh: true });
    const dead = (services[slug]?.accounts ?? []).filter((account) =>
      validAccountId(account.id)
      && account.alias?.trim().toLowerCase() === alias.toLowerCase()
      // Never an active account, even one whose app refused its sign-in: it
      // is the person's only working link until a new sign-in finishes.
      && DEAD_ATTEMPT.test(account.status));
    let removed = false;
    for (const account of dead) {
      const response = await brokerRequest(cfg, `/v1/connectors/${encodeURIComponent(slug)}/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (response.ok) removed = true;
    }
    if (removed) { invalidateConnected(cfg, { drop: true }); connectionsRemoved(); }
    return removed;
  } catch {
    return false;
  }
}

/** Mint a browser auth link for one service. Returns { url } or throws.
 * `reconnect` names the active account a Reconnect replaces: the new sign-in
 * is made next to it (under the same label, or the label with a number when
 * the broker holds that label), and the old account is retired only once the
 * new one is active (withAppHealth). Nothing is deleted here. */
export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null, options: { reconnect?: string } = {}) {
  const alias = normalizeAccountAlias(requestedAlias);
  const owner = inventoryOwner(cfg);
  let replaces: string[] = [];
  if (owner && options.reconnect && validAccountId(options.reconnect) && healthMark(owner, slug)) {
    const services = await connectedServices(cfg, { fresh: true }).catch(() => null);
    const account = services?.[slug]?.accounts.find((entry) => entry.id === options.reconnect);
    if (account && /^active$/i.test(account.status)) replaces = [account.id];
  }
  const post = (label: string | undefined) => {
    const request: RequestInit = { method: "POST" };
    if (label) request.body = JSON.stringify({ alias: label });
    return brokerRequest(cfg, `/v1/connectors/${encodeURIComponent(slug)}/authorize`, request);
  };
  let response = await post(alias);
  if (response.status === 409 && alias && await clearDeadAttempts(cfg, slug, alias)) {
    // The broker counts a failed or expired attempt as a label in use. It
    // was dead, so it is gone now: try the same label once more.
    response = await post(alias);
  }
  // A Reconnect under the label the active account still holds: sign in next
  // to it under a numbered label rather than removing the account first.
  for (let n = 2; response.status === 409 && alias && replaces.length && n <= 9; n++) {
    response = await post(`${alias.slice(0, 60)} ${n}`);
  }
  if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
  const body = authUrlResponseSchema.parse(await response.json());
  const url = trustedAuthUrl(body.url, slug);
  if (owner && replaces.length) updateMark(owner, slug, { replaces });
  invalidateConnected(cfg);
  return { url };
}

// ── marketplace catalog ────────────────────────────────────────────────
// The catalog itself lives in app-catalog.ts; this file only says which
// backend it is read from, so the broker choice stays in one place.
export type ToolkitCard = CatalogApp;
export { CURATED_SLUGS, type CatalogFallbackReason } from "./app-catalog.ts";

/** Where the catalog is read from right now; null when there is nowhere. */
export function catalogBackend(cfg: AppConfig): CatalogBackend | null {
  const identity = selectedBackendIdentity(cfg, true);
  if (!identity) return null;
  const current = () => selectedBackendIdentity(cfg, true);
  const broker = activeBroker(cfg);
  if (broker) {
    return {
      kind: "broker",
      identity,
      // the same catalog whichever token fetched it
      cacheKey: backendFingerprint("managed-catalog-cache", broker.url, ""),
      current,
      request: (query, signal) => brokerRequest(cfg, `/v1/catalog${query.size ? `?${query}` : ""}`, { signal }),
    };
  }
  return null;
}

/** Which catalog the copy on disk belongs to, known before the broker's
 * readiness is: the broker in use, else the Flux broker this build names,
 * else the Murage Worker. Never a credential. */
export function catalogCacheTarget(cfg: AppConfig): { cacheKey: string; identity: string } | null {
  const ready = catalogBackend(cfg);
  if (ready) return { cacheKey: ready.cacheKey, identity: ready.identity };
  const url = fluxBrokerUrl() || legacyBrokerAccess()?.url || "";
  return url ? { cacheKey: backendFingerprint("managed-catalog-cache", url, ""), identity: "" } : null;
}

/**
 * The whole catalog (every card held), or the curated set with the reason it
 * fell back. Waits for a walk when nothing is held yet; `waitMs` bounds that.
 */
export async function listToolkits(
  cfg: AppConfig,
  options: { signal?: AbortSignal; waitMs?: number; force?: boolean } = {},
): Promise<CatalogView> {
  return loadCatalog(catalogBackend(cfg), options);
}

/** The card for one slug. Never walks the whole catalog: a bot asking to
 * connect an app must not wait on 1,500 cards. */
export async function toolkitCard(cfg: AppConfig, slug: string): Promise<ToolkitCard> {
  return catalogApp(catalogBackend(cfg), slug);
}
