import { cachedConnectorStatus, cachedConnectorStatusAuthoritative, inventoryApps, preloadConnectedApps, pendingConnectedApps, isCredentialStoreUnreadable, rememberConnectedApps, type ConnectorStatus } from "@/lib/connected-apps-preload";
export { preloadConnectedApps, pendingConnectedApps, isCredentialStoreUnreadable, type ConnectorStatus, type ConnectorInventory } from "@/lib/connected-apps-preload";
// Connected apps marketplace, backed by Composio Sessions. The catalog is
// 1,500+ apps (server/app-catalog.ts): first paint is the featured apps
// from the copy on disk, typing searches the whole catalog, and "All apps"
// is a windowed, paged list. Icons resolve logo → favicon → monogram.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
// The MCP servers tab is desktop-only and heavy (the paste parser rides with it),
// so it loads when the tab is opened, not with the first paint.
const McpServersPanel = lazy(() => import("./McpServersPanel").then((module) => ({ default: module.McpServersPanel })));
import {
  APPS_CLAIM,
  ConnectedAppsLock,
  connectedAppsLockState,
  FLUX_KEY_FIELD_SELECTOR,
  focusSettingsField,
  OwnKeyRetiredLine,
  showOwnKeyRetiredLine,
} from "./ConnectedAppsLock";
import { useDesktopSurface } from "@/lib/use-surface";
import { t } from "@/lib/i18n";
import { openExternalPage } from "@/lib/open-external";
import {
  appCountLabel,
  appsClaimFor,
  catalogNotice,
  connectedCards,
  isConnection,
  matchesSearch,
  NEEDS_OWN_SIGN_IN_SHORT,
  type AppCard,
  type CatalogFallbackReason,
} from "@/lib/app-catalog";
import { VirtualRows } from "./VirtualRows";
import { returnFocus } from "@/lib/return-focus";

type ToolkitCard = AppCard;

/**
 * What the Connected tab's count says, and the line under it.
 *
 * It counted every status entry with an account in any state, including the
 * connection service's own plumbing that the list never shows, so the tab
 * said 12 while a bot, asked, listed the 11 apps it could use (0.1.60 Linux
 * customer pass). The count is now the apps a bot can use; an app whose only
 * account is expired, failed or half connected is told apart in words.
 *
 * It counts the inventory, never the loaded cards: in 0.1.60 an app missing
 * from the loaded list (six of the owner's thirteen, with the curated list
 * showing) was left out of both the count and the tab (0.1.61 L17 Part B).
 */
export function connectedTabSummary(
  status: Record<string, ConnectorStatus>,
): { ready: number; notReady: number; note: string } {
  let ready = 0;
  let notReady = 0;
  for (const [slug, service] of Object.entries(status)) {
    if (!isConnection(slug, service)) continue;
    if (service.connected) ready++;
    else notReady++;
  }
  const note = notReady === 0
    ? ""
    : notReady === 1
      ? "1 more app is not ready yet. Finish connecting it or reconnect it below."
      : `${notReady} more apps are not ready yet. Finish connecting them or reconnect them below.`;
  return { ready, notReady, note };
}

/** How often, and how many times, the panel asks again while the server
 * checks its copy of the catalog: 80 seconds, past the 45-second walk. */
export const CATALOG_POLL_MS = 4_000;
export const CATALOG_POLLS = 20;
/** How long the panel keeps asking while the connection backend comes up. */
const BACKEND_WAIT_MS = 1_500;
const BACKEND_WAIT_TRIES = 10;
/** Asking again for the checked list while the server refreshes behind a remembered one. */
/** How often connected apps that cannot be reached are asked again. */
const RECOVERY_POLL_MS = 20_000;
const REVALIDATE_POLLS = 8;
/** Five seconds a try for ten minutes: at least the sign-in link's whole life. */
const PANEL_SIGN_IN_POLLS = 120;
const REVALIDATE_POLL_MS = 2_500;

/** What GET /api/connectors/catalog answers about the catalog itself. */
export interface CatalogAnswer {
  source: "api" | "cache" | "curated";
  reason?: CatalogFallbackReason;
  detail?: { loaded: number; total: number | null };
  total: number | null;
  revalidating: boolean;
  allApps: boolean;
}

export function catalogAnswerFrom(response: Record<string, unknown> | null | undefined): CatalogAnswer {
  const source = response?.source === "api" || response?.source === "cache" ? response.source : "curated";
  const detail = response?.detail as CatalogAnswer["detail"] | undefined;
  return {
    source,
    ...(typeof response?.reason === "string" ? { reason: response.reason as CatalogFallbackReason } : {}),
    ...(detail && typeof detail.loaded === "number" ? { detail } : {}),
    total: typeof response?.total === "number" ? response.total : null,
    revalidating: response?.revalidating === true,
    // An older harness never sent it: All apps needs the new routes.
    allApps: response?.allApps === true,
  };
}

export function disconnectAccountConfirmation(
  service: string,
  account: { id: string; alias?: string },
) {
  const identity = account.alias ? `“${account.alias}” (${account.id})` : `“${account.id}”`;
  return `Disconnect ${identity} from ${service}? Only this ${service} account will be revoked. Your other ${service} accounts will stay connected.`;
}

export function requiresAccountAlias(message: string) {
  return /account alias.*existing connection.*not replaced/i.test(message);
}

/** What the server says about which broker holds the user's connected apps
 * (see `connectorPanelFields` in server/composio.ts). Secret-free. */
export interface ConnectorPanelFields {
  broker: "flux" | "legacy" | null;
  migration: {
    state: "none" | "legacy" | "offered" | "pending" | "claimed" | "claim-conflict" | "abandoned" | "moved-elsewhere" | "legacy-retired";
    legacyUntil: string | null;
    code?: string;
    accountKind?: "personal" | "shared";
    tokenError?: string;
    installationId?: string;
    at?: string;
  };
  fluxConfigured: boolean;
  fluxBrokerEnabled: boolean;
  freeRunsRemainingToday: number | null;
}

export const EMPTY_CONNECTOR_PANEL_FIELDS: ConnectorPanelFields = {
  broker: null,
  migration: { state: "none", legacyUntil: null },
  fluxConfigured: false,
  fluxBrokerEnabled: false,
  freeRunsRemainingToday: null,
};

export function connectorPanelFieldsFrom(response: Partial<ConnectorPanelFields> | null | undefined): ConnectorPanelFields {
  return {
    broker: response?.broker === "flux" || response?.broker === "legacy" ? response.broker : null,
    migration: response?.migration && typeof response.migration.state === "string"
      ? response.migration
      : EMPTY_CONNECTOR_PANEL_FIELDS.migration,
    fluxConfigured: response?.fluxConfigured === true,
    fluxBrokerEnabled: response?.fluxBrokerEnabled === true,
    freeRunsRemainingToday: typeof response?.freeRunsRemainingToday === "number" ? response.freeRunsRemainingToday : null,
  };
}

const CLAIM_TO_MIGRATION_STATE = {
  none: "none", offered: "offered", pending: "pending", claimed: "claimed",
  conflict: "claim-conflict", abandoned: "abandoned",
} as const;

/** The claim state the main process just returned, in the shape the panel's
 * migration field already uses, so the button's result paints immediately
 * instead of waiting for the next connectors response. */
export function migrationFromClaim(
  claim: { state: keyof typeof CLAIM_TO_MIGRATION_STATE; code?: string; installationId?: string; at?: string } | null | undefined,
  legacyUntil: string | null,
): ConnectorPanelFields["migration"] {
  const state = claim && CLAIM_TO_MIGRATION_STATE[claim.state];
  if (!state) return { state: "none", legacyUntil };
  const migration: ConnectorPanelFields["migration"] = { state, legacyUntil };
  if (claim?.code) migration.code = claim.code;
  if (claim?.installationId) migration.installationId = claim.installationId;
  if (claim?.at) migration.at = claim.at;
  return migration;
}

export type ConnectedAppsNoticeAction = "enable-flux" | "open-settings" | "billing" | "claim" | "keep-legacy" | "retry" | "reconnect";
export type ConnectedAppsNotice =
  | { kind: "consent"; body: string; actions: Array<{ id: ConnectedAppsNoticeAction; label: string }> }
  | { kind: "line"; tone: "warning" | "muted"; text: string; action?: { id: ConnectedAppsNoticeAction; label: string } };

export const FLUXROUTER_BILLING_URL = "https://fluxrouter.ai/dashboard/billing";
const CLAIMED_NOTICE_MS = 24 * 60 * 60 * 1000;

/** The cut-off date as people read it; null when absent or unparseable. */
export function formatLegacyCutoff(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(at);
}

function tokenErrorNotice(code: string | undefined): ConnectedAppsNotice | null {
  if (!code) return null;
  if (code === "flux_key_budget_exhausted") {
    return { kind: "line", tone: "warning", text: t("connectedApps.flux.tokenBudget"), action: { id: "billing", label: t("connectedApps.flux.tokenBudgetButton") } };
  }
  if (code === "token_taken_over") {
    return { kind: "line", tone: "warning", text: t("connectedApps.flux.takenOver"), action: { id: "reconnect", label: t("connectedApps.flux.reconnect") } };
  }
  if (code === "flux_key_blocked") return { kind: "line", tone: "warning", text: t("connectedApps.flux.tokenBlocked") };
  if (code === "flux_key_expired" || code === "flux_key_invalid" || code === "composio_no_account") {
    return { kind: "line", tone: "warning", text: t("connectedApps.flux.tokenReconnect"), action: { id: "enable-flux", label: t("connectedApps.flux.openSettings") } };
  }
  return null;
}

function conflictText(code: string | undefined, date: string | null, installationId: string | undefined): string {
  const id = installationId ?? "";
  switch (code) {
    case "account_already_claimed":
      return date ? t("connectedApps.flux.conflict.accountAlreadyClaimed", { date }) : t("connectedApps.flux.conflict.accountAlreadyClaimedNoDate");
    case "account_has_connections":
      return date ? t("connectedApps.flux.conflict.accountHasConnections", { date }) : t("connectedApps.flux.conflict.accountHasConnectionsNoDate");
    case "install_already_claimed":
      return t("connectedApps.flux.conflict.installAlreadyClaimed", { installationId: id });
    case "claims_closed":
      return t("connectedApps.flux.conflict.claimsClosed");
    default:
      return t("connectedApps.flux.conflict.other");
  }
}

/** Every connected-apps notice the panel shows, in order, from what the
 * server reported. Pure, so each branch is testable without a renderer. */
export function connectedAppsNotices(input: {
  configured: boolean;
  stale: boolean;
  mode?: "managed" | "unavailable";
  fields: ConnectorPanelFields;
  consentDismissed?: boolean;
  now?: number;
  /** False until the catalog has answered: the fields are still the empty
   * defaults, which read as the old Murage service, so nothing is said. */
  fieldsKnown?: boolean;
}): ConnectedAppsNotice[] {
  const { configured, stale, fields } = input;
  if (input.fieldsKnown === false) return [];
  const now = input.now ?? Date.now();
  const migration = fields.migration;
  const date = formatLegacyCutoff(migration.legacyUntil);
  const notices: ConnectedAppsNotice[] = [];
  const tokenNotice = tokenErrorNotice(migration.tokenError);

  if (!configured) {
    if (stale) return notices;
    if (!fields.fluxBrokerEnabled) {
      // No FluxRouter broker in this build at all: every dev run, and any
      // release where the URL constant is still empty. Offering to "enable
      // FluxRouter" here would point at a door this build does not have.
      notices.push({ kind: "line", tone: "warning", text: t("connectedApps.flux.notInBuild") });
    } else if (!fields.fluxConfigured) {
      // No FluxRouter key and no key of the person's own: the panel is
      // locked (ConnectedAppsLock) and never reaches these notices, because
      // it does not fetch the catalog they are derived from. Nothing to add.
    } else if (tokenNotice) {
      notices.push(tokenNotice);
    } else {
      if (migration.state === "legacy-retired") notices.push({ kind: "line", tone: "warning", text: t("connectedApps.flux.legacyRetired") });
      notices.push({ kind: "line", tone: "warning", text: t("connectedApps.flux.unreachable"), action: { id: "retry", label: t("connectedApps.flux.retry") } });
    }
    return notices;
  }
  if (migration.state === "claimed" && migration.at && now - Date.parse(migration.at) < CLAIMED_NOTICE_MS) {
    notices.push({ kind: "line", tone: "muted", text: t("connectedApps.flux.claimed") });
  }
  if (fields.broker === "flux") {
    notices.push({ kind: "line", tone: "muted", text: t("connectedApps.flux.modeFlux") });
    // The Worker identity is gone and the apps on it did not move: they have
    // to be connected again, here, on FluxRouter.
    if (migration.state === "legacy-retired") notices.push({ kind: "line", tone: "warning", text: t("connectedApps.flux.legacyRetired") });
    if (migration.accountKind === "shared") notices.push({ kind: "line", tone: "muted", text: t("connectedApps.flux.shared") });
    if (fields.freeRunsRemainingToday !== null) {
      notices.push({ kind: "line", tone: "muted", text: t("connectedApps.flux.freeRuns", { count: fields.freeRunsRemainingToday }) });
    }
    if (tokenNotice) notices.push(tokenNotice);
    return notices;
  }

  // The Murage Worker broker.
  if (migration.state === "moved-elsewhere") {
    notices.push({ kind: "line", tone: "warning", text: t("connectedApps.flux.movedElsewhere", { installationId: migration.installationId ?? "" }) });
    return notices;
  }
  if (migration.state === "claim-conflict") {
    notices.push({ kind: "line", tone: "warning", text: conflictText(migration.code, date, migration.installationId) });
    return notices;
  }
  if (migration.state === "offered" && !input.consentDismissed) {
    notices.push({
      kind: "consent",
      body: t("connectedApps.flux.consent"),
      actions: [
        { id: "claim", label: t("connectedApps.flux.consentButton") },
        { id: "keep-legacy", label: date ? t("connectedApps.flux.consentKeep", { date }) : t("connectedApps.flux.consentKeepNoDate") },
      ],
    });
    return notices;
  }
  if (migration.state === "pending") notices.push({ kind: "line", tone: "muted", text: t("connectedApps.flux.claimPending") });
  if (!fields.fluxBrokerEnabled) {
    // This build has no FluxRouter broker at all (0.1.52 behaviour, or the
    // release constant still empty). Naming a move that cannot happen here
    // would only send people looking for a button that is not there.
    notices.push({ kind: "line", tone: "muted", text: t("connectedApps.flux.legacyPlain") });
    return notices;
  }
  notices.push({
    kind: "line",
    tone: "muted",
    text: date ? t("connectedApps.flux.legacyUntil", { date }) : t("connectedApps.flux.legacyNoDate"),
    ...(fields.fluxConfigured ? {} : { action: { id: "enable-flux" as const, label: t("connectedApps.flux.legacyConnect") } }),
  });
  if (tokenNotice) notices.push(tokenNotice);
  return notices;
}

export type ConnectorInventoryPhase = "loading" | "ready" | "error";

/** The panel's own poll for a sign-in ran out while the app was still pending:
 * end the wait as an expired link (the row already says "Authorization
 * expired. Try again.") instead of stopping silently on a spinner. */
export function expirePendingSignIn(
  status: Record<string, ConnectorStatus>,
  slug: string,
): Record<string, ConnectorStatus> {
  const current = status[slug];
  if (!current || current.connected || !current.pending) return status;
  return { ...status, [slug]: { ...current, pending: false, status: "EXPIRED" } };
}

/** The inventory without one disconnected account, as soon as the server says
 * it is gone, so a remembered "connected" never outlives it (the copy kept
 * for the next launch is rewritten from this). */
export function withoutAccount(
  status: Record<string, ConnectorStatus>,
  slug: string,
  accountId: string,
): Record<string, ConnectorStatus> {
  const current = status[slug];
  if (!current) return status;
  const accounts = (current.accounts ?? []).filter((account) => account.id !== accountId);
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  if (!accounts.length) {
    const { [slug]: _gone, ...rest } = status;
    return rest;
  }
  return {
    ...status,
    [slug]: { connected: Boolean(active), pending: Boolean(pending), status: (active ?? pending ?? accounts[0]).status, accounts },
  };
}

/** A remembered inventory, from this window or from disk, is usable: the
 * panel opens ready (and quietly refreshes) rather than "Checking…" with
 * every action disabled until the broker answers. */
export function initialInventoryPhase(moduleCache: unknown | null, remembered: unknown | null): ConnectorInventoryPhase {
  return moduleCache !== null || remembered !== null ? "ready" : "loading";
}

/** Where the phase lands after an inventory answer. An answer that does not
 * know (an unreadable store, a broker that has not answered) only blocks the
 * panel when there is nothing remembered to show. */
export function inventoryPhaseAfterAnswer(input: { authoritative: boolean; hasRemembered: boolean }): ConnectorInventoryPhase {
  return input.authoritative || input.hasRemembered ? "ready" : "error";
}

/** What the primary connector button does. A pending authorization continues
 * with its retained URL or only re-checks status; every other click, for the
 * first account as well as another one, opens the label form before any
 * authorization request is sent. Adapted from OpenMausBot PR #758 (merge
 * 86b19df10a0aaebdc66f9da41c46f42d26dd3843, Apache-2.0). */
export function connectorPrimaryAction(state: { pending?: boolean; pendingUrl?: string }): "continue" | "check-status" | "label-account" {
  if (state.pending) return state.pendingUrl ? "continue" : "check-status";
  return "label-account";
}

export function connectorActionLabel(
  phase: ConnectorInventoryPhase,
  state: { busy: boolean; included: boolean; canContinue: boolean; pending?: boolean; hasAccounts: boolean; failed: boolean },
) {
  if (state.busy) return null;
  if (state.included) return "Included";
  if (phase === "loading") return "Checking…";
  if (phase === "error") return "Unavailable";
  if (state.canContinue) return "Continue";
  if (state.pending) return "Check status";
  if (state.hasAccounts) return "Add account";
  if (state.failed) return "Retry";
  return "Connect";
}

export function connectedInventoryCopy(phase: ConnectorInventoryPhase) {
  if (phase === "loading") return {
    title: "Checking connected apps…",
    description: "Your accounts will appear here as soon as the secure connection check finishes.",
  };
  if (phase === "error") return {
    title: "Couldn’t load connected apps",
    description: "Retry the connection check before adding another account.",
  };
  return {
    title: "No connected apps yet",
    description: "Connect an app from Marketplace and it will appear here.",
  };
}

export function mergeCurrentConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
) {
  const next = { ...current };
  for (const [slug, state] of Object.entries(incoming)) {
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = state;
  }
  return next;
}

export function mergeCompleteConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
  /** Did the server actually KNOW the full picture? A response sent while the
   * credential store was unreadable carries no information about what is
   * connected, so it must not be allowed to clear anything — an empty list
   * from an ignorant server is exactly how a connected app became a Connect
   * button. Disconnection still shows up on the next authoritative answer. */
  authoritative = true,
) {
  const next = { ...current };
  if (!authoritative) return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
  for (const [slug, state] of Object.entries(current)) {
    if (incoming[slug]) continue;
    if (!state.connected && !state.accounts?.length) continue;
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = { connected: false, pending: false, status: "not_connected", accounts: [] };
  }
  return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
}

export function onlyLatestConnectorResponses(
  incoming: Record<string, ConnectorStatus>,
  latestRequests: ReadonlyMap<string, number>,
  requestIds: ReadonlyMap<string, number>,
) {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([slug]) => (latestRequests.get(slug) ?? 0) === (requestIds.get(slug) ?? 0),
    ),
  );
}

function ServiceIcon({ card }: { card: ToolkitCard }) {
  // 0 = official logo, 1 = favicon by domain, 2 = monogram
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return <img src={card.logo} alt="" loading="lazy" className="size-11 rounded-xl object-contain" onError={() => setStage(1)} />;
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        loading="lazy"
        className="size-11 rounded-xl object-contain"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary">
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Which half of the dialog is showing: the Composio marketplace, or the
  // person's own MCP commands. Two different things behind one door.
  // Settings > Connected apps can ask for the MCP half directly.
  const [surface, setSurface] = useState<"apps" | "mcp">(() => (state.pluginsSurface === "mcp" && desktop === true ? "mcp" : "apps"));
  // Featured apps: the curated set plus the most used, from the copy on disk.
  // Nothing is carried over from an earlier open: the backend may have
  // changed since, and the server's held copy answers in milliseconds.
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogAnswer | null>(null);
  const [knownApps, setKnownApps] = useState<Record<string, ToolkitCard>>(() => inventoryApps);
  const [searchResults, setSearchResults] = useState<{ query: string; items: ToolkitCard[]; total: number; loading: boolean; partial?: boolean; failed?: boolean }>({ query: "", items: [], total: 0, loading: false });
  const [browseAll, setBrowseAll] = useState(false);
  const [allApps, setAllApps] = useState<{ items: ToolkitCard[]; next: string | null; total: number | null; loading: boolean; done: boolean; failed?: boolean }>({ items: [], next: null, total: null, loading: false, done: false });
  const [twoColumns, setTwoColumns] = useState(() => typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [configured, setConfigured] = useState(true);
  const [mode, setMode] = useState<"managed" | "unavailable">("unavailable");
  // Which broker holds these apps, and where this install is in the move from
  // Murage's own service to FluxRouter. Every connector response carries it.
  const [panelFields, setPanelFields] = useState<ConnectorPanelFields>(EMPTY_CONNECTOR_PANEL_FIELDS);
  const [panelFieldsKnown, setPanelFieldsKnown] = useState(false);
  const [consentDismissed, setConsentDismissed] = useState(false);
  const [claiming, setClaiming] = useState(false);
  /** the last inventory answer said the credential store could not be read */
  const [storeUnreadable, setStoreUnreadable] = useState(isCredentialStoreUnreadable);
  // Paint what we last knew before any request goes out: the module cache if
  // this window already fetched, otherwise the inventory saved on disk. An
  // empty panel is never the first thing a connected user sees.
  const [status, setStatus] = useState<Record<string, ConnectorStatus>>(
    () => cachedConnectorStatus ?? readCachedInventory()?.services ?? {},
  );
  /** true when what is on screen is remembered rather than confirmed */
  const [stale, setStale] = useState(
    cachedConnectorStatus !== null && !cachedConnectorStatusAuthoritative,
  );
  const [pendingUrls, setPendingUrls] = useState<Record<string, string>>({});
  const [aliasSlug, setAliasSlug] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryPhase, setInventoryPhase] = useState<ConnectorInventoryPhase>(
    () => initialInventoryPhase(cachedConnectorStatus, readCachedInventory()),
  );
  /** the server answered from what it last knew and is refreshing it */
  const [revalidating, setRevalidating] = useState(false);
  const revalidateTimer = useRef<{ tries: number; timer?: ReturnType<typeof setTimeout> }>({ tries: 0 });
  useEffect(() => () => clearTimeout(revalidateTimer.current.timer), []);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");

  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());

  const refreshStatus = useCallback((slugs: string[]): Promise<Record<string, ConnectorStatus>> => {
    if (!slugs.length) return Promise.resolve({});
    const requestGenerations = new Map(slugs.map((slug) => [slug, statusGenerations.current.get(slug) ?? 0]));
    const requestIds = new Map(slugs.map((slug) => {
      const requestId = (latestStatusRequests.current.get(slug) ?? 0) + 1;
      latestStatusRequests.current.set(slug, requestId);
      return [slug, requestId];
    }));
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => {
        if (r.credentialStore === "unavailable") {
          setStale(true);
          setInventoryPhase("error");
          throw new Error("Connection status could not be checked because the credential store is unavailable. Showing the previous account status.");
        }
        const services = onlyLatestConnectorResponses(
          r.services ?? {},
          latestStatusRequests.current,
          requestIds,
        );
        // A one-service OAuth poll must not erase every other app's state.
        // A request that began before Connect must also not erase the newer
        // local INITIATED state when its stale not_connected result arrives.
        setStatus((current) => mergeCurrentConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && state.connected && !state.pending) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return {};
      });
  }, []);

  const backendWait = useRef<{ tries: number; timer?: ReturnType<typeof setTimeout> }>({ tries: 0 });
  const refreshConnectedStatusRef = useRef<((force?: boolean, serverForce?: boolean) => Promise<Record<string, ConnectorStatus>>) | null>(null);
  useEffect(() => () => clearTimeout(backendWait.current.timer), []);
  const refreshConnectedStatus = useCallback((force = false, serverForce = force): Promise<Record<string, ConnectorStatus>> => {
    const requestGenerations = new Map(statusGenerations.current);
    setRefreshing(true);
    return preloadConnectedApps(force, serverForce)
      .then(({ services, authoritative, backendReady, apps, revalidating: stillRefreshing }) => {
        if (apps) setKnownApps((current) => ({ ...current, ...apps }));
        clearTimeout(backendWait.current.timer);
        if (backendReady === false && backendWait.current.tries < BACKEND_WAIT_TRIES) {
          // Asked too early, just after a launch or an update: keep saying
          // "Checking" and ask again, rather than painting "No connected apps
          // yet" and a Connect button on apps that are connected.
          backendWait.current.tries++;
          setInventoryPhase("loading");
          backendWait.current.timer = setTimeout(() => void refreshConnectedStatusRef.current?.(true), BACKEND_WAIT_MS);
          return services;
        }
        if (backendReady !== false) backendWait.current.tries = 0;
        setStale(!authoritative);
        setInventoryPhase(inventoryPhaseAfterAnswer({
          authoritative,
          hasRemembered: Object.keys(statusRef.current).length > 0 || readCachedInventory() !== null,
        }));
        // The server's last-known list is on screen; ask again shortly for
        // the checked one instead of leaving the panel to guess.
        clearTimeout(revalidateTimer.current.timer);
        setRevalidating(stillRefreshing === true);
        if (stillRefreshing === true && revalidateTimer.current.tries < REVALIDATE_POLLS) {
          revalidateTimer.current.tries += 1;
          revalidateTimer.current.timer = setTimeout(() => {
            void refreshConnectedStatusRef.current?.(true, false);
          }, REVALIDATE_POLL_MS);
        } else if (stillRefreshing !== true) {
          revalidateTimer.current.tries = 0;
        }
        setStatus((current) => mergeCompleteConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
          authoritative,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && state.connected && !state.pending) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .finally(() => setRefreshing(false));
  }, []);

  refreshConnectedStatusRef.current = refreshConnectedStatus;

  const loadConnectionInventory = useCallback((force = false) => {
    const hadCachedInventory = cachedConnectorStatus !== null;
    if (!hadCachedInventory) setInventoryPhase("loading");
    setError(null);
    return refreshConnectedStatus(force)
      .catch((cause) => {
        if (!hadCachedInventory) setInventoryPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
        return {};
      });
  }, [refreshConnectedStatus]);

  useEffect(() => () => {
    for (const timer of pollTimers.current.values()) clearInterval(timer);
    pollTimers.current.clear();
  }, []);

  const notices = connectedAppsNotices({ configured, stale, mode, fields: panelFields, consentDismissed, fieldsKnown: panelFieldsKnown });

  // Locked until a FluxRouter key or a Composio key of the person's own
  // exists. Decided from what GET /api/config already told the store, never
  // from a connector response: the locked panel sends no connector request
  // at all, and the config frame flips it open the moment a key is saved.
  const lockState = connectedAppsLockState(state.config, { stale: stale || storeUnreadable });
  const locked = lockState === "locked";

  /** The lock's one button: Settings → Models, cursor in the Flux key field. */
  const addFluxKey = useCallback(() => {
    dispatch({ type: "togglePlugins", open: false });
    dispatch({ type: "toggleAppSettings", open: true, section: "models" });
    focusSettingsField(FLUX_KEY_FIELD_SELECTOR);
  }, [dispatch]);

  /** What each notice's button does. Moving connected apps is the only one
   * that changes anything, and it runs in the main process (it holds the
   * credentials); the rest just open the right settings section. */
  const loadCatalogRef = useRef<((retry?: boolean) => Promise<void>) | null>(null);
  const runNoticeAction = useCallback((action: ConnectedAppsNoticeAction) => {
    if (action === "reconnect") {
      // The one manual mint: another computer took over, and nothing here
      // retries by itself. Mint first, then end this computer's old token.
      const reconnect = window.muragebox?.reconnectConnectedApps;
      if (!reconnect) return;
      setError(null);
      void reconnect()
        .then(() => Promise.all([loadCatalogRef.current?.(true), loadConnectionInventory(true)]))
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    if (action === "retry") {
      void loadCatalogRef.current?.(true);
      void loadConnectionInventory(true);
      return;
    }
    if (action === "billing") {
      window.open(FLUXROUTER_BILLING_URL, "_blank", "noopener,noreferrer");
      return;
    }
    if (action === "keep-legacy") {
      setConsentDismissed(true);
      return;
    }
    if (action === "claim") {
      const claimLegacy = window.muragebox?.claimLegacyComposio;
      if (!claimLegacy) return;
      setClaiming(true);
      setError(null);
      void claimLegacy()
        .then((state) => {
          setPanelFields((previous) => ({ ...previous, migration: { ...previous.migration, ...migrationFromClaim(state, previous.migration.legacyUntil) } }));
          void loadConnectionInventory(true);
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setClaiming(false));
      return;
    }
    dispatch({ type: "togglePlugins", open: false });
    // "enable-flux" lands on Models, where FluxRouter lives; "open-settings"
    // lands on Connected apps. They used to open whichever section was open
    // last.
    dispatch({ type: "toggleAppSettings", open: true, section: action === "enable-flux" ? "models" : "connections" });
  }, [dispatch, loadConnectionInventory]);

  const catalogRetry = useRef<{ tries: number; timer?: ReturnType<typeof setTimeout> }>({ tries: 0 });
  // Only the newest catalog request may paint, and only while mounted.
  const catalogRequest = useRef(0);
  const catalogAnswered = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Ask for the catalog; `retry` is the notice's Retry button. */
  const loadCatalog = useCallback((retry = false): Promise<void> => {
    clearTimeout(catalogRetry.current.timer);
    if (retry) catalogRetry.current.tries = 0;
    const request = ++catalogRequest.current;
    return api(`/api/connectors/catalog${retry ? "?retry=1" : ""}`)
      .then((r) => {
        if (!mounted.current || request !== catalogRequest.current) return;
        catalogAnswered.current = true;
        const answer = catalogAnswerFrom(r);
        setCards(r.cards ?? []);
        setCatalog(answer);
        setConfigured(Boolean(r.configured));
        setMode(r.mode ?? "unavailable");
        setPanelFields(connectorPanelFieldsFrom(r));
        setPanelFieldsKnown(true);
        // Still walking, or a stale copy being checked: ask again shortly.
        // The server's walk may take up to 45 seconds: keep asking past it.
        if (answer.revalidating && catalogRetry.current.tries < CATALOG_POLLS) {
          catalogRetry.current.tries++;
          catalogRetry.current.timer = setTimeout(() => void loadCatalog(), CATALOG_POLL_MS);
        }
      })
      .catch((e) => {
        if (mounted.current && request === catalogRequest.current) setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  loadCatalogRef.current = loadCatalog;

  // Connected apps that cannot be reached are asked again without anyone
  // pressing anything: when the network returns, when the window wakes, and
  // every 20 seconds while the line is up.
  useEffect(() => {
    if (lockState !== "unlocked" || configured) return;
    const again = () => {
      void loadCatalogRef.current?.();
      void refreshConnectedStatusRef.current?.(true, false);
    };
    const wake = () => { if (document.visibilityState !== "hidden") again(); };
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", wake);
    const timer = setInterval(again, RECOVERY_POLL_MS);
    return () => {
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", wake);
      clearInterval(timer);
    };
  }, [lockState, configured]);

  useEffect(() => {
    if (inventoryPhase !== "ready") return;
    rememberConnectedApps(status, !stale);
  }, [inventoryPhase, stale, status]);

  // Locked, or not yet known: no catalog, no inventory. The only thing the
  // panel does is listen for the app's own warm-up request, already in
  // flight, so an unreadable credential store still shows the remembered
  // inventory instead of the lock.
  useEffect(() => {
    if (lockState === "unlocked") return;
    let alive = true;
    void pendingConnectedApps()?.then(() => {
      if (alive) setStoreUnreadable(isCredentialStoreUnreadable());
    });
    return () => {
      alive = false;
    };
  }, [lockState]);

  useEffect(() => {
    if (lockState !== "unlocked") return;
    let alive = true;
    void loadConnectionInventory();
    // First paint: whatever the server holds on disk, before any readiness
    // probe; then the checked answer, asked again while it revalidates.
    const firstRequest = catalogRequest.current;
    api("/api/connectors/catalog/cached")
      .then((r) => {
        // only while the checked answer has not arrived
        if (!alive || !r?.held || catalogRequest.current !== firstRequest || catalogAnswered.current) return;
        setCards(r.cards ?? []);
        setCatalog({ ...catalogAnswerFrom(r), allApps: false });
      })
      .catch(() => {});
    void loadCatalog();
    return () => {
      alive = false;
      clearTimeout(catalogRetry.current.timer);
    };
  }, [lockState, loadConnectionInventory, loadCatalog]);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(min-width: 768px)");
    const change = () => setTwoColumns(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);

  // Typing searches the whole catalog (the service, or the copy on this
  // computer when the service does not search), after a short pause.
  const query = search.trim();
  const searchAgain = `${catalog?.source ?? ""}:${catalog?.total ?? ""}`;
  useEffect(() => {
    if (lockState !== "unlocked" || tab !== "marketplace" || !query) {
      setSearchResults((current) => current.query || current.loading ? { query: "", items: [], total: 0, loading: false } : current);
      return;
    }
    let alive = true;
    setSearchResults((current) => ({ ...current, query, loading: true }));
    const timer = setTimeout(() => {
      api(`/api/connectors/catalog/search?q=${encodeURIComponent(query)}`)
        .then((r) => {
          if (!alive) return;
          const items: ToolkitCard[] = Array.isArray(r?.items) ? r.items : [];
          // A search over the featured apps only (the full list is still
          // loading, or the service could not answer) says so.
          setSearchResults({ query, items, total: typeof r?.total === "number" ? r.total : items.length, loading: false, partial: r?.source === "curated" || typeof r?.reason === "string" });
          setKnownApps((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.slug, item])) }));
        })
        .catch(() => {
          if (alive) setSearchResults({ query, items: [], total: 0, loading: false, failed: true });
        });
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // asked again when the catalog itself changes (a walk finished, a Retry)
  }, [lockState, tab, query, searchAgain]);

  // One page request at a time, decided outside any state updater (an
  // updater may run twice in development and must not send requests).
  const allAppsRef = useRef(allApps);
  allAppsRef.current = allApps;
  const allAppsLoading = useRef(false);
  const loadMoreApps = useCallback(() => {
    const current = allAppsRef.current;
    if (allAppsLoading.current || current.done) return;
    allAppsLoading.current = true;
    setAllApps((latest) => ({ ...latest, loading: true }));
    const cursor = current.next;
    api(`/api/connectors/catalog/page?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      .then((r) => {
        const items: ToolkitCard[] = Array.isArray(r?.items) ? r.items : [];
        if (r?.source === "curated") {
          // Not the whole catalog yet: show why, never a short list as "all".
          setAllApps((latest) => ({ ...latest, loading: false, done: true, failed: true }));
          return;
        }
        setAllApps((latest) => {
          const held = new Set(latest.items.map((item) => item.slug));
          // A cursor that did not move ends the list rather than looping.
          const next = typeof r?.nextCursor === "string" && r.nextCursor !== cursor ? r.nextCursor : null;
          return {
            items: [...latest.items, ...items.filter((item) => !held.has(item.slug))],
            next,
            total: typeof r?.total === "number" ? r.total : latest.total,
            loading: false,
            done: next === null,
          };
        });
      })
      .catch((cause) => {
        // Stop asking on every scroll; "Featured" then "Browse all" asks again.
        setAllApps((latest) => ({ ...latest, loading: false, done: true, failed: true }));
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        allAppsLoading.current = false;
      });
  }, []);

  // A finished walk or a Retry starts All apps again from the top.
  useEffect(() => {
    setAllApps((current) => current.failed ? { items: [], next: null, total: null, loading: false, done: false } : current);
  }, [searchAgain]);

  useEffect(() => {
    if (browseAll && !allApps.items.length && !allApps.done) loadMoreApps();
  }, [browseAll, allApps.items.length, allApps.done, loadMoreApps]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    // Locked, the offer's button is the first thing the keyboard reaches;
    // otherwise the search field, as before.
    (dialog?.querySelector<HTMLElement>("[data-connected-apps-lock-primary]")
      ?? dialog?.querySelector<HTMLElement>("input")
      ?? focusable()[0]
      ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "togglePlugins", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus(opener);
    };
  }, [dispatch]);

  // The dialog places focus once, on mount, and the apps surface may not be
  // decided yet then (config answered late). Once it is, put focus where the
  // mount would have — the lock's button, or the search field — unless the
  // person has already moved it somewhere on purpose. Switching surfaces
  // does not re-run this.
  useEffect(() => {
    if (lockState === "unknown") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    const parked = !active || active === document.body || active === dialog || active === dialog.querySelector('[aria-label="Close connected apps"]');
    if (!parked) return;
    (dialog.querySelector<HTMLElement>("[data-connected-apps-lock-primary]")
      ?? dialog.querySelector<HTMLElement>('input[aria-label="Search apps"]'))?.focus();
  }, [lockState]);

  const openConnectUrl = async (url: string) => {
    // If a popup blocker rejects the first asynchronous open, the visible
    // Continue button retries from a direct user gesture using the URL
    // retained in pendingUrls.
    await openExternalPage(url, "Your browser blocked the connection page. Click Continue to open it.");
  };

  const startPolling = (slug: string) => {
    const old = pollTimers.current.get(slug);
    if (old) clearInterval(old);
    let tries = 0;
    const timer = setInterval(() => {
      void refreshStatus([slug]).then((services) => {
        const state = services[slug];
        const ended = (state?.connected && !state.pending) || (state?.status && /^(expired|failed)$/i.test(state.status));
        if (++tries >= PANEL_SIGN_IN_POLLS || ended) {
          clearInterval(timer);
          pollTimers.current.delete(slug);
          // Out of budget with the sign-in still unfinished: say so.
          if (!ended) {
            setStatus((current) => expirePendingSignIn(current, slug));
            setPendingUrls((current) => {
              if (!current[slug]) return current;
              const next = { ...current };
              delete next[slug];
              return next;
            });
          }
        }
      });
    }, 5000);
    pollTimers.current.set(slug, timer);
  };

  const connect = async (slug: string, alias?: string) => {
    if (desktop !== true) return;
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    try {
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const { url } = await api(`/api/connectors/${slug}/authorize`, request);
      setPendingUrls((current) => ({ ...current, [slug]: url }));
      setStatus((current) => ({
        ...current,
        [slug]: {
          ...current[slug],
          connected: current[slug]?.connected ?? false,
          pending: true,
          status: "INITIATED",
        },
      }));
      setAliasSlug(null);
      setAliasDraft("");
      startPolling(slug);
      await openConnectUrl(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (requiresAccountAlias(message)) {
        // Recover gracefully if an existing account was discovered after the
        // button rendered. Show the label field and refresh only this app.
        setAliasSlug(slug);
        setAliasDraft("");
        setError("This app already has an account. Add a label such as work or personal to connect another.");
        void refreshStatus([slug]);
      } else {
        setError(message);
      }
    } finally {
      setBusySlug(null);
    }
  };

  /** Close the label form without authorizing and return focus to its button. */
  const cancelAlias = (slug: string) => {
    dialogRef.current?.querySelector<HTMLButtonElement>(`[data-connector-action="${CSS.escape(slug)}"]`)?.focus();
    setAliasSlug((current) => (current === slug ? null : current));
    setAliasDraft("");
  };

  const disconnectAccount = (slug: string, accountId: string) => {
    if (desktop !== true) return;
    setBusySlug(slug);
    api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      .then(() => {
        const next = withoutAccount(statusRef.current, slug, accountId);
        writeCachedInventory(next, Date.now());
        setStatus(next);
        return refreshStatus([slug]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  // Marketplace: featured apps, or the whole catalog's matches while typing
  // (featured matches show at once while the search is on its way). The
  // Connected tab is built from the inventory, never from loaded cards.
  const featuredMatches = (cards ?? []).filter((card) => matchesSearch(card, query));
  const visible = tab === "connected"
    ? connectedCards(status, [knownApps, cards, allApps.items, searchResults.items]).filter((card) => matchesSearch(card, query))
    : query
      ? (searchResults.query === query && !searchResults.loading ? searchResults.items : featuredMatches)
      : cards ?? [];
  const browsing = tab === "marketplace" && browseAll && !query && catalog?.allApps === true;
  const columns = twoColumns ? 2 : 1;
  const connectedSummary = connectedTabSummary(status);
  const connectedCount = connectedSummary.ready;
  const countLabel = appCountLabel(catalog?.total);
  const notice = catalogNotice({ source: catalog?.source, reason: catalog?.reason, detail: catalog?.detail });
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });

  const appRow = (card: ToolkitCard) => {
              const serviceStatus = status[card.slug];
              const pending = serviceStatus?.pending;
              const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
              const accounts = serviceStatus?.accounts ?? [];
              // connected with no accounts and nothing in flight = a no-auth
              // toolkit: there is no OAuth to run, so "Connect" would mint a
              // pointless authorize. It ships included.
              const included = card.noAuth === true
                || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
              const addingAccount = aliasSlug === card.slug && !pending;
              const busy = busySlug === card.slug;
              return (
                <div
                  key={card.slug}
                  className="min-h-[88px] border-b border-hairline/35 px-1 py-4"
                >
                  <div className="flex items-center gap-3">
                    <ServiceIcon card={card} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
                      <div className={cn("mt-0.5 text-[12.5px] text-ink-secondary", !(pending && !pendingUrls[card.slug]) && "truncate")}>
                        {pending
                          ? pendingUrls[card.slug]
                            ? "Finish setup in your browser"
                            : "Finish setup in your browser, or disconnect the pending account below to start again"
                          : failed && !accounts.length
                            ? /^failed$/i.test(serviceStatus?.status ?? "")
                              ? "Authorization failed. Try again."
                              : "Authorization expired. Try again."
                            : card.blurb}
                      </div>
                      {card.signIn === "own" && !accounts.length && !pending && (
                        <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary" title="Connecting opens a page where you enter them.">
                          {NEEDS_OWN_SIGN_IN_SHORT}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      data-connector-action={card.slug}
                      disabled={desktop !== true || !configured || inventoryPhase !== "ready" || busy || included}
                      title={desktop !== true ? "Manage connections in the desktop app" : undefined}
                      onClick={() => {
                        const action = connectorPrimaryAction({ pending, pendingUrl: pendingUrls[card.slug] });
                        if (action === "label-account") {
                          // Every new account, the first one included, is
                          // labelled before OAuth starts; nothing is
                          // authorized until the label is confirmed.
                          setAliasSlug((current) => current === card.slug ? null : card.slug);
                          setAliasDraft("");
                          return;
                        }
                        setAliasSlug(null);
                        setError(null);
                        if (action === "continue") {
                          void openConnectUrl(pendingUrls[card.slug]).catch((e) => setError(e.message));
                        } else {
                          void refreshStatus([card.slug]);
                          startPolling(card.slug);
                        }
                      }}
                      className="flex min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                    >
                      {busy ? (
                        <Loader2 size={13} className="mx-auto animate-spin" />
                      ) : (
                        connectorActionLabel(inventoryPhase, {
                          busy,
                          included,
                          canContinue: Boolean(pending && pendingUrls[card.slug]),
                          pending,
                          hasAccounts: accounts.length > 0,
                          failed: Boolean(failed),
                        })
                      )}
                    </button>
                  </div>
                  {accounts.length > 0 && (
                    <div className="ml-14 mt-3 space-y-2">
                      {accounts.map((account) => {
                        const active = /^active$/i.test(account.status);
                        return (
                          <div key={account.id} className="flex items-center gap-2 rounded-lg bg-raised/45 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                                {active && <Check size={13} className="shrink-0 text-success" />}
                                <span className="truncate">{account.alias || account.id}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">
                                {account.alias ? `${account.id} · ` : ""}{account.status.toLowerCase()}
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={desktop !== true || busy}
                              onClick={() => {
                                if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                                disconnectAccount(card.slug, account.id);
                              }}
                              className="rounded-md px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                              aria-label={`Disconnect ${account.alias || account.id} from ${card.label}`}
                            >
                              Disconnect
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {desktop === true && addingAccount && (
                    <form
                      className="ml-14 mt-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const alias = aliasDraft.trim();
                        if (!alias) {
                          setError("Enter a label for the account, such as work or personal.");
                          return;
                        }
                        void connect(card.slug, alias);
                      }}
                    >
                      <p id={`connector-alias-hint-${card.slug}`} className="mb-2 text-[11.5px] leading-snug text-ink-secondary">
                        {accounts.length > 0 ? t("connectedApps.alias.anotherHint") : t("connectedApps.alias.firstHint")}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          autoFocus
                          value={aliasDraft}
                          maxLength={64}
                          onChange={(event) => setAliasDraft(event.target.value)}
                          onKeyDown={(event) => {
                            // Cancel only the label form; the dialog stays open.
                            if (event.key !== "Escape") return;
                            event.preventDefault();
                            event.stopPropagation();
                            cancelAlias(card.slug);
                          }}
                          placeholder="Account label (work, personal…)"
                          aria-label={accounts.length > 0
                            ? t("connectedApps.alias.anotherLabel", { service: card.label })
                            : t("connectedApps.alias.firstLabel", { service: card.label })}
                          aria-describedby={`connector-alias-hint-${card.slug}`}
                          className="min-w-0 flex-1 basis-40 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                        <button
                          type="submit"
                          disabled={busy || !aliasDraft.trim()}
                          className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40"
                        >
                          Continue
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => cancelAlias(card.slug)}
                          className="rounded-lg px-3 py-2 text-[12px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
                        >
                          {t("connectedApps.alias.cancel")}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
  };

  return (
    <div
      className="overlay-inset fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(var(--vvh,100dvh)-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="plugins-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Connected apps</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{desktop === true ? `One Flux Router key connects ${appsClaimFor(catalog?.total, APPS_CLAIM)}. You can add your own MCP tools too.` : "View connected apps. Manage connections and MCP tools in the desktop app."}</p>
          </div>
          <div className="flex items-center gap-1">
            {surface === "apps" && lockState === "unlocked" && (
              <button
                onClick={() => void loadConnectionInventory(true)}
                disabled={refreshing}
                className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                title="Refresh connection status"
              >
                <RefreshCw size={17} className={cn((refreshing || revalidating) && "animate-spin")} />
              </button>
            )}
            <button
              onClick={close}
              aria-label="Close connected apps"
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        <div className="border-b border-hairline/40 px-6 sm:px-8">
          <div className="flex gap-6" role="tablist" aria-label="Connected apps and MCP servers">
            {(desktop === true ? ["apps", "mcp"] as const : ["apps"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={surface === item}
                onClick={() => setSurface(item)}
                className={cn(
                  "border-b-2 px-0.5 pb-3 pt-1 text-[13.5px] font-medium transition-colors",
                  surface === item ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
                )}
              >
                {item === "apps" ? "Connected apps" : "MCP servers"}
              </button>
            ))}
          </div>
        </div>

        {surface !== "mcp" && showOwnKeyRetiredLine(state.config, { anyConnected: state.config?.composio?.broker === "flux" && Object.values(status).some((entry) => entry.connected) }) && <OwnKeyRetiredLine />}
        {desktop === true && surface === "mcp" ? (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("mcp.panel.loading")}</div>}>
            <McpServersPanel />
          </Suspense>
        ) : lockState === "unknown" ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {t("connectedApps.lock.loading")}
          </div>
        ) : locked ? (
          <ConnectedAppsLock onAddFluxKey={addFluxKey} retired={state.config?.composio?.migration?.state === "legacy-retired"} />
        ) : <>

        {stale && (
          // Say which of the two things is true. Silence here is what makes a
          // remembered list indistinguishable from a confirmed one.
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning sm:mx-8">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            <span>
              Showing the previous account inventory; connection status could not be checked just now.
              Refresh connection status before adding another account.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex w-fit rounded-xl bg-raised/70 p-1" role="tablist" aria-label="Connected apps view">
            <button
              role="tab"
              aria-selected={tab === "marketplace"}
              onClick={() => setTab("marketplace")}
              className={cn(
                "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                tab === "marketplace" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              Marketplace
            </button>
            <button
              role="tab"
              aria-selected={tab === "connected"}
              onClick={() => setTab("connected")}
              className={cn(
                "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                tab === "connected" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              Connected{connectedCount > 0 ? ` ${connectedCount}` : ""}
            </button>
          </div>
          <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
            <Search size={17} className="shrink-0 text-ink-secondary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search apps"
              aria-label="Search apps"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </label>
        </div>

        {/* Two notices about the same fact is one too many: the stale banner
            above already explains this launch, and "configure your own
            connection service" is advice for someone who never set one up. */}
        {/* "Temporarily unavailable" was a lie for the most common way to see
            this. The managed broker's credentials only arrive from
            electron/main.mjs when `app.isPackaged`, so EVERY dev run and every
            `node server/index.ts` lands here permanently — and the copy sent
            people hunting for an outage that did not exist. It says what is
            actually true now, and stays true for a packaged user whose broker
            really is down. */}
        {/* WHICH Composio account this is talking to, said out loud, and — for
            an install whose apps still live on Murage's own service — where
            they are in the move to FluxRouter. There are several possible
            accounts, they hold different connections, and the app used to
            switch between them in silence: connecting apps in dev on your own
            key and then running the release used to empty the list, because
            the accounts are on the far side of a different project under a
            different user id and nothing said so.

            Every branch comes from `connectedAppsNotices`, which is pure and
            takes only what the server reported, so the copy for each state is
            tested without a renderer. */}
        {notices.map((notice, index) => {
          if (notice.kind === "consent") {
            return (
              <div key={`consent-${index}`} className="mx-6 mb-1 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-ink sm:mx-8">
                <div>{notice.body}</div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {notice.actions.map((action) => (
                    <button
                      key={action.id}
                      disabled={claiming && action.id === "claim"}
                      className="font-medium underline underline-offset-2 disabled:opacity-60"
                      onClick={() => runNoticeAction(action.id)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div
              key={`line-${index}`}
              className={cn(
                "mx-6 mb-1 text-[12px] sm:mx-8",
                notice.tone === "warning" ? "rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning" : "text-ink-secondary",
              )}
            >
              {notice.text}
              {notice.action && (
                <>
                  {" "}
                  <button className="font-medium underline underline-offset-2" onClick={() => runNoticeAction(notice.action!.id)}>
                    {notice.action.label}
                  </button>
                </>
              )}
            </div>
          );
        })}
        {/* Why this is not the whole catalog, in every mode, with Retry
            (0.1.61 L17 Part A). The managed path used to fall back to the
            featured apps without a word. */}
        {notice && (
          <div
            role="status"
            className={cn(
              "mx-6 mb-1 flex flex-wrap items-center gap-x-2 text-[12px] sm:mx-8",
              notice.tone === "warning" ? "rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning" : "text-ink-secondary",
            )}
          >
            <span>{notice.text}</span>
            {notice.retry && (
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => void loadCatalog(true)}>
                Retry
              </button>
            )}
          </div>
        )}
        {error && <div role="alert" className="mx-6 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger sm:mx-8">{error}</div>}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
          {cards === null && tab === "marketplace" ? (
            <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : browsing ? (
            <div>
              <div className="mb-3 flex items-center gap-3 text-[12px] font-medium text-ink-secondary">
                <button type="button" onClick={() => { setBrowseAll(false); if (allApps.failed) setAllApps({ items: [], next: null, total: null, loading: false, done: false }); }} className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-raised hover:text-ink">
                  <ArrowLeft size={13} /> Featured
                </button>
                <span>All apps{allApps.total ? ` (${allApps.total.toLocaleString("en-US")})` : ""}</span>
              </div>
              {allApps.failed && (
                <div role="status" className="mb-3 flex flex-wrap items-center gap-x-2 rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning">
                  <span>The full list of apps is not available yet.</span>
                  <button
                    type="button"
                    className="font-medium underline underline-offset-2"
                    onClick={() => {
                      setAllApps({ items: [], next: null, total: null, loading: false, done: false });
                      void loadCatalog(true);
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}
              <VirtualRows
                count={Math.ceil(Math.max(allApps.items.length, allApps.done ? 0 : allApps.items.length + 1) / columns)}
                scrollRef={scrollRef}
                onRange={(_first, last) => {
                  if (!allApps.done && last * columns >= allApps.items.length - 40) loadMoreApps();
                }}
                renderRow={(line) => (
                  <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                    {Array.from({ length: columns }, (_unused, column) => {
                      const card = allApps.items[line * columns + column];
                      if (card) return <div key={card.slug}>{appRow(card)}</div>;
                      return allApps.done ? null : (
                        <div key={`loading-${column}`} className="flex min-h-[88px] items-center gap-2 border-b border-hairline/35 px-1 py-4 text-[12.5px] text-ink-secondary">
                          <Loader2 size={13} className="animate-spin" /> Loading apps…
                        </div>
                      );
                    })}
                  </div>
                )}
              />
            </div>
          ) : (
            <div>
              <div className="mb-3 flex items-center justify-between gap-3 text-[12px] font-medium text-ink-secondary">
                <span>
                  {tab === "connected" ? "Your connections" : query ? (searchResults.loading ? "Searching all apps…" : `Search results${searchResults.total > visible.length ? ` (${searchResults.total.toLocaleString("en-US")})` : ""}`) : "Featured apps"}
                </span>
                {tab === "marketplace" && !query && catalog?.allApps && (
                  <button type="button" onClick={() => setBrowseAll(true)} className="rounded-md px-1.5 py-1 text-accent hover:bg-raised">
                    Browse all {countLabel ?? "apps"}
                  </button>
                )}
              </div>
              {tab === "marketplace" && query && !searchResults.loading && (searchResults.partial || searchResults.failed) && (
                <p role="status" className="mb-3 text-[12.5px] text-ink-secondary">
                  {searchResults.failed ? "Search could not reach the full list of apps." : "Searching featured apps only while the full list loads."}{" "}
                  <button type="button" className="font-medium underline underline-offset-2" onClick={() => void loadCatalog(true)}>Retry</button>
                </p>
              )}
              {tab === "connected" && connectedSummary.note && (
                <p role="status" className="mb-3 text-[12.5px] text-ink-secondary">{connectedSummary.note}</p>
              )}
              <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                {visible.map((card) => <div key={card.slug}>{appRow(card)}</div>)}
              </div>
            </div>
          )}
          {!browsing && (cards !== null || tab === "connected") && visible.length === 0 && !(query && searchResults.loading) && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <div className="text-[14px] font-medium text-ink">
                {tab === "connected" ? connectedEmptyCopy.title : "No apps found"}
              </div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">
                {tab === "connected" ? connectedEmptyCopy.description : "Try a different search."}
              </div>
              {tab === "connected" && inventoryPhase === "error" && (
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void loadConnectionInventory(true)}
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
                >
                  <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
                  Retry
                </button>
              )}
            </div>
          )}
        </div>

        </>}
      </div>
    </div>
  );
}
