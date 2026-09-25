// Which Composio account the app is talking to, and whether it says so.
//
// There are two, they hold different connections, and until this the app
// switched between them in silence. The managed broker's credentials arrive
// only from `electron/main.mjs` when `app.isPackaged`, so a person could
// connect eighteen toolkits in dev on their own key and watch every one of
// them disappear the first time they ran the packaged build. Not deleted —
// on the far side of a different Composio project under a different user id,
// showing an empty list identical to never having connected anything.
//
// Source assertions, because the panel is a 900-line component with no render
// harness and the thing worth pinning is the copy itself.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  connectedAppsLockState,
  COMPOSIO_KEY_FIELD_SELECTOR,
  FLUX_KEY_FIELD_SELECTOR,
  focusSettingsField,
  SHOWCASE_APPS,
} from "./ConnectedAppsLock";
import {
  connectedAppsNotices,
  connectorActionLabel,
  connectorPanelFieldsFrom,
  connectorPrimaryAction,
  connectedTabSummary,
  EMPTY_CONNECTOR_PANEL_FIELDS,
  FLUXROUTER_BILLING_URL,
  formatLegacyCutoff,
  mergeCompleteConnectorStatus,
  migrationFromClaim,
  PluginsPanel,
  preloadConnectedApps,
  type ConnectorPanelFields,
} from "./PluginsPanel";

// The panel renders against a stubbed store so each key state can be painted
// without a harness. `api` is a spy: nothing in these renders may call it.
const storeStub = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  api: vi.fn(async () => { throw new Error("no request may leave the locked panel"); }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: storeStub.api,
    useStore: () => ({ state: { ...original.initialState, config: storeStub.config }, dispatch: () => {} }),
  };
});

const here = dirname(fileURLToPath(import.meta.url));
// Source shapes are matched across lines: read them with LF endings whatever
// the checkout wrote (a Windows checkout with core.autocrlf is CRLF).
const source = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const panel = source(join(here, "PluginsPanel.tsx"));
const lockSource = source(join(here, "ConnectedAppsLock.tsx"));
const en = JSON.parse(readFileSync(join(here, "../locales/en.json"), "utf8")) as Record<string, string>;
const composio = source(join(here, "../../server/composio.ts"));

describe("pending OAuth recovery", () => {
  it("checks a pending authorization without a URL and continues only with its retained URL", () => {
    for (const hasAccounts of [false, true]) {
      const pending = { busy: false, included: false, pending: true, hasAccounts, failed: false };
      expect(connectorActionLabel("ready", { ...pending, canContinue: false })).toBe("Check status");
      expect(connectorActionLabel("ready", { ...pending, canContinue: true })).toBe("Continue");
      expect(connectorActionLabel("error", { ...pending, canContinue: false })).toBe("Unavailable");
    }
  });

  it("labels every new account before authorization, including the first, and keeps pending recovery", () => {
    const retained = "https://connect.composio.dev/link/slack";
    expect(connectorPrimaryAction({})).toBe("label-account");
    expect(connectorPrimaryAction({ pending: false, pendingUrl: retained })).toBe("label-account");
    expect(connectorPrimaryAction({ pending: true })).toBe("check-status");
    expect(connectorPrimaryAction({ pending: true, pendingUrl: retained })).toBe("continue");
  });

  it("authorizes a service only from the confirmed label form", () => {
    // Before #758 the first account called connect(card.slug) straight from
    // the button. The only remaining call site carries the confirmed alias.
    expect([...panel.matchAll(/\bconnect\(card\.slug[^)]*\)/g)].map((match) => match[0])).toEqual(["connect(card.slug, alias)"]);
  });

  it("words the first and an additional account label differently", () => {
    expect(panel).toContain('t("connectedApps.alias.firstLabel", { service: card.label })');
    expect(panel).toContain('t("connectedApps.alias.anotherLabel", { service: card.label })');
    expect(en["connectedApps.alias.firstLabel"]).toBe("Label for the new {service} account");
    expect(en["connectedApps.alias.anotherLabel"]).toBe("Label for another {service} account");
  });

  it("keeps the previous account inventory when its current status cannot be read", () => {
    const previous = {
      gmail: { connected: true, pending: true, accounts: [{ id: "fixture-account", status: "ACTIVE" }] },
    };
    expect(mergeCompleteConnectorStatus(previous, {}, new Map(), new Map(), false)).toEqual(previous);
  });
});

describe("the connectors panel names its account", () => {
  it("says which Composio identity is in use", () => {
    expect(panel).toContain("Connected with your own key");
    expect(en["connectedApps.flux.legacyPlain"]).toBe("Connected through Murage's service.");
  });

  it("stops calling a permanent packaging gate a temporary outage", () => {
    // This is the sentence that sent someone looking for a block that did not
    // exist. Every dev run reaches it, and reaches it forever.
    expect(panel).not.toContain("temporarily unavailable");
    expect(en["connectedApps.flux.notInBuild"]).toContain("aren't available on this launch");
  });
});

describe("a key someone pasted on purpose is the one that gets used", () => {
  it("lets a workspace key beat the managed broker", () => {
    // The single choke point. Every other consumer resolves through it, which
    // is why inverting the rule is one line and why that line has a test.
    expect(composio).toMatch(/function activeBroker[\s\S]{0,200}if \(cfg\.composio\?\.apiKey\) return null;/);
  });

  it("still leaves a managed broker as the default for anyone who configured nothing", () => {
    // After the workspace key, the order is FluxRouter, then the Murage
    // Worker, then nothing — and every one of those branches is inside this
    // one function, so no caller can route around the decision.
    expect(composio).toMatch(/if \(cfg\.composio\?\.apiKey\) return null;[\s\S]{0,400}return null;\n\}/);
    expect(composio).toContain("if (flux && !legacyIdentityLive) return flux;");
    expect(composio).toContain("if (legacy) return legacy;");
  });
});

// ── the move to FluxRouter, in the panel ───────────────────────────────
// These are the sentences a user reads at each stage of a migration they did
// not ask for. Getting one wrong means either a silent move of a device's
// private connections onto an account other people hold keys to, or a person
// staring at an empty list with no idea where their apps went.

const CUTOFF = "2026-12-15T00:00:00Z";

const fields = (over: Partial<ConnectorPanelFields> = {}): ConnectorPanelFields => ({
  ...EMPTY_CONNECTOR_PANEL_FIELDS,
  ...over,
  migration: { ...EMPTY_CONNECTOR_PANEL_FIELDS.migration, ...over.migration },
});

const notices = (
  input: { configured?: boolean; stale?: boolean; mode?: "managed" | "self-hosted" | "unavailable"; consentDismissed?: boolean; now?: number },
  panelFields: ConnectorPanelFields,
) => connectedAppsNotices({
  configured: input.configured ?? true,
  stale: input.stale ?? false,
  mode: input.mode ?? "managed",
  fields: panelFields,
  consentDismissed: input.consentDismissed,
  now: input.now,
});

const texts = (list: ReturnType<typeof connectedAppsNotices>) =>
  list.map((notice) => ("text" in notice ? notice.text : "body" in notice ? notice.body : "")).join(" | ");

describe("the connected-apps caption before the catalog answers", () => {
  // 0.1.60 Mac pass: on a Flux-connected install the Marketplace tab first
  // said "Connected through Murage's service." (read off the empty default
  // fields while the catalog loaded) and the Connected tab then said "through
  // your Flux Router account". Nothing is said until the fields are known.
  it("says nothing about the broker until the catalog has said which one it is", () => {
    expect(connectedAppsNotices({ configured: true, stale: false, mode: "managed", fields: EMPTY_CONNECTOR_PANEL_FIELDS, fieldsKnown: false })).toEqual([]);
    expect(texts(connectedAppsNotices({ configured: true, stale: false, mode: "managed", fields: fields({ broker: "flux", fluxBrokerEnabled: true, fluxConfigured: true }), fieldsKnown: true })))
      .toContain("Connected through your Flux Router account.");
  });
});

describe("the connected-apps call to action", () => {
  it("leaves the no-key state to the lock rather than a notice line", () => {
    // Sean 2026-09-11: the whole panel is locked until a key exists. The
    // notices never see this state, because the locked panel does not fetch
    // the catalog they are derived from.
    expect(notices({ configured: false }, fields({ fluxBrokerEnabled: true }))).toEqual([]);
    expect(panel).not.toContain("flux-cta");
    // "enable-flux" must still land on Models, where FluxRouter actually lives.
    expect(panel).toContain('{ type: "toggleAppSettings", open: true, section: "models" }');
  });

  it("does not offer a door this build does not have", () => {
    // Every dev run, and any release where the URL constant is still empty.
    const [only] = notices({ configured: false }, fields());
    expect(only).toMatchObject({ kind: "line", tone: "warning" });
    expect(texts([only])).toContain("aren't available on this launch");
  });

  it("says 'not reachable', not 'not set up', when FluxRouter is connected but down", () => {
    const [line] = notices({ configured: false }, fields({ fluxBrokerEnabled: true, fluxConfigured: true }));
    expect(texts([line])).toBe(en["connectedApps.flux.unreachable"]);
  });

  it("stays quiet while the panel is showing a remembered inventory", () => {
    // The stale banner above already explains this launch; a second notice
    // about the same fact is one too many.
    expect(notices({ configured: false, stale: true }, fields({ fluxBrokerEnabled: true }))).toEqual([]);
  });

  it("says nothing extra for a workspace running its own key", () => {
    expect(notices({ mode: "self-hosted" }, fields({ fluxBrokerEnabled: true }))).toEqual([]);
  });
});

describe("each FluxRouter key problem gets its own sentence", () => {
  it.each([
    // The ceiling is a ceiling: this line no longer promises that buying
    // credit lifts it, only where to look.
    ["flux_key_budget_exhausted", "used its allowance for this month", "billing"],
    ["flux_key_expired", "Reconnect Flux Router", "enable-flux"],
    ["flux_key_invalid", "Reconnect Flux Router", "enable-flux"],
    ["flux_key_blocked", "support@fluxrouter.ai", undefined],
  ])("explains %s", (tokenError, fragment, action) => {
    const [notice] = notices({ configured: false }, fields({ fluxBrokerEnabled: true, fluxConfigured: true, migration: { state: "none", legacyUntil: null, tokenError } }));
    expect(texts([notice])).toContain(fragment);
    expect("action" in notice ? notice.action?.id : undefined).toBe(action);
  });

  it("points the budget case at the billing page rather than at settings", () => {
    expect(FLUXROUTER_BILLING_URL).toBe("https://fluxrouter.ai/dashboard/billing");
  });
});

describe("while the Murage Worker still holds the apps", () => {
  const legacy = (over: Partial<ConnectorPanelFields["migration"]> = {}) =>
    fields({ broker: "legacy", fluxBrokerEnabled: true, migration: { state: "legacy", legacyUntil: CUTOFF, ...over } });

  it("names the deadline and the way to keep the apps past it", () => {
    const text = texts(notices({}, legacy()));
    expect(text).toContain("Connected through Murage's service, which ends");
    expect(text).toContain(formatLegacyCutoff(CUTOFF)!);
    const [line] = notices({}, legacy());
    expect("action" in line ? line.action?.id : undefined).toBe("enable-flux");
  });

  it("drops the deadline clause rather than printing a broken date", () => {
    expect(formatLegacyCutoff(null)).toBeNull();
    expect(formatLegacyCutoff("next tuesday")).toBeNull();
    expect(texts(notices({}, legacy({ legacyUntil: null })))).toContain(en["connectedApps.flux.legacyNoDate"]);
  });

  it("asks before moving a shared account, and says what sharing means", () => {
    // This is the consent gate. A dashboard-minted team key names an account
    // every key holder can use, and the move cannot be undone from the app.
    const [consent] = notices({}, legacy({ state: "offered", accountKind: "shared" }));
    expect(consent).toMatchObject({ kind: "consent" });
    expect(texts([consent])).toBe(
      "Move your connected apps to Flux Router. Anyone using this Flux Router account's keys will be able to use them. This can't be undone from the app.",
    );
    expect("actions" in consent ? consent.actions.map((a) => a.id) : []).toEqual(["claim", "keep-legacy"]);
    // The button is the only trigger, and it runs in the main process.
    expect(panel).toContain("claimLegacyComposio");
  });

  it("lets someone put the consent block away without moving anything", () => {
    const [first] = notices({}, legacy({ state: "offered" }));
    expect(first.kind).toBe("consent");
    const kept = notices({ consentDismissed: true }, legacy({ state: "offered" }));
    expect(kept.every((notice) => notice.kind !== "consent")).toBe(true);
    expect(texts(kept)).toContain("Connected through Murage's service");
  });

  it("says a failed move is being retried rather than leaving it silent", () => {
    expect(texts(notices({}, legacy({ state: "pending" })))).toContain("Murage will keep trying");
  });

  it.each([
    ["account_already_claimed", "already holds connected apps from another install"],
    ["account_has_connections", "already has its own connected apps"],
    ["install_already_claimed", "support@fluxrouter.ai"],
    ["claims_closed", "window to move connected apps has closed"],
    [undefined, "couldn't be moved to this Flux Router account"],
  ])("explains the %s conflict and what still works", (code, fragment) => {
    const list = notices({}, legacy({ state: "claim-conflict", code, installationId: "install-1" }));
    expect(texts(list)).toContain(fragment);
    expect(list[0]).toMatchObject({ kind: "line", tone: "warning" });
  });

  it("quotes the install id so support can find the row", () => {
    const text = texts(notices({}, legacy({ state: "claim-conflict", code: "install_already_claimed", installationId: "install-77" })));
    expect(text).toContain("install-77");
  });

  it("tells the victim of a stolen install token where their apps went", () => {
    const list = notices({}, legacy({ state: "moved-elsewhere", installationId: "install-77" }));
    expect(texts(list)).toContain("moved to a Flux Router account that isn't this one");
    expect(texts(list)).toContain("install-77");
    // Nothing else: the apps are not reachable here, so a deadline for them
    // would be beside the point.
    expect(list).toHaveLength(1);
  });

  it("keeps the deadline line plain in a build with no FluxRouter broker", () => {
    const text = texts(notices({}, fields({ broker: "legacy", migration: { state: "legacy", legacyUntil: CUTOFF } })));
    expect(text).toBe("Connected through Murage's service.");
  });
});

describe("once FluxRouter holds the apps", () => {
  const flux = (over: Partial<ConnectorPanelFields> = {}) =>
    fields({ broker: "flux", fluxBrokerEnabled: true, fluxConfigured: true, ...over });

  it("names the account, and warns when other people can use it", () => {
    const shared = texts(notices({}, flux({ migration: { state: "claimed", legacyUntil: null, accountKind: "shared" } })));
    expect(shared).toContain("Connected through your Flux Router account.");
    expect(shared).toContain("Anyone using this Flux Router account's keys can use these connected apps.");

    const personal = texts(notices({}, flux({ migration: { state: "claimed", legacyUntil: null, accountKind: "personal" } })));
    expect(personal).not.toContain("Anyone using");
  });

  it("shows what is left of the free daily allowance, and nothing when funded", () => {
    expect(texts(notices({}, flux({ freeRunsRemainingToday: 12 })))).toContain("12 free runs left today.");
    expect(texts(notices({}, flux({ freeRunsRemainingToday: 0 })))).toContain("0 free runs left today.");
    expect(texts(notices({}, flux({ freeRunsRemainingToday: null })))).not.toContain("free runs left");
  });

  it("confirms a completed move for a day and then stops mentioning it", () => {
    const at = "2026-09-11T00:00:00Z";
    const migration = { state: "claimed" as const, legacyUntil: null, at };
    const fresh = texts(notices({ now: Date.parse(at) + 3_600_000 }, flux({ migration })));
    expect(fresh).toContain("Your connected apps moved to Flux Router.");
    const later = texts(notices({ now: Date.parse(at) + 25 * 3_600_000 }, flux({ migration })));
    expect(later).not.toContain("moved to Flux Router");
  });
});

describe("reading what the server sent", () => {
  it("falls back to a safe shape for a response from an older harness", () => {
    expect(connectorPanelFieldsFrom(undefined)).toEqual(EMPTY_CONNECTOR_PANEL_FIELDS);
    expect(connectorPanelFieldsFrom({ broker: "nonsense" } as never)).toEqual(EMPTY_CONNECTOR_PANEL_FIELDS);
    expect(connectorPanelFieldsFrom({ broker: "flux", fluxConfigured: true, freeRunsRemainingToday: 3 })).toMatchObject({
      broker: "flux",
      fluxConfigured: true,
      freeRunsRemainingToday: 3,
    });
  });

  it("paints the claim button's own answer without waiting for a refetch", () => {
    expect(migrationFromClaim({ state: "claimed", at: "2026-09-11T00:00:00Z" }, CUTOFF)).toEqual({
      state: "claimed",
      legacyUntil: CUTOFF,
      at: "2026-09-11T00:00:00Z",
    });
    expect(migrationFromClaim({ state: "conflict", code: "account_has_connections", installationId: "install-1" }, null)).toEqual({
      state: "claim-conflict",
      legacyUntil: null,
      code: "account_has_connections",
      installationId: "install-1",
    });
    expect(migrationFromClaim(null, CUTOFF)).toEqual({ state: "none", legacyUntil: CUTOFF });
  });
});

// ── the lock ──────────────────────────────────────────────────────────
// Sean 2026-09-11: the connected-apps screen is greyed out until a FluxRouter
// key or a Composio key of the person's own exists, and the grey is the
// offer. What is pinned: the three key states, the exact copy, the static
// showcase, and that the locked panel sends nothing anywhere.

const noKeys = { composio: { configured: false, mode: "unavailable" as const }, flux: { configured: false } };
const fluxKey = { composio: { configured: false, mode: "unavailable" as const }, flux: { configured: true } };
const ownKey = { composio: { configured: true, mode: "self-hosted" as const }, flux: { configured: false } };

const render = (config: typeof storeStub.config) => {
  storeStub.config = config;
  storeStub.api.mockClear();
  return renderToStaticMarkup(createElement(PluginsPanel));
};

describe("the connected-apps lock", () => {
  it("locks with no key, and opens for either key", () => {
    expect(connectedAppsLockState(noKeys)).toBe("locked");
    expect(connectedAppsLockState(fluxKey)).toBe("unlocked");
    expect(connectedAppsLockState(ownKey)).toBe("unlocked");
    // A FluxRouter key whose broker is not ready yet is still a key: the
    // panel's own "not reachable" line owns that case, not the lock.
    expect(connectedAppsLockState({ composio: { configured: false, mode: "unavailable" }, flux: { configured: true } })).toBe("unlocked");
    // The Murage Worker still holding the apps counts as configured.
    expect(connectedAppsLockState({ composio: { configured: true, mode: "managed" } })).toBe("unlocked");
  });

  it("does not guess before GET /api/config has answered", () => {
    expect(connectedAppsLockState(null)).toBe("unknown");
    expect(connectedAppsLockState(undefined)).toBe("unknown");
  });

  it("stands down when the credential store could not be read, so a remembered inventory stays visible", () => {
    expect(connectedAppsLockState(noKeys, { stale: true })).toBe("unlocked");
    expect(connectedAppsLockState(noKeys, { stale: false })).toBe("locked");
  });

  it("says exactly what unlocking buys, in English, under connectedApps.lock.*", () => {
    // No count is claimed that the code can prove: "500+" was never verified
    // against the live catalogue, so the copy names apps instead of a number.
    expect(en["connectedApps.lock.title"]).toBe("Connect your apps");
    expect(en["connectedApps.lock.body"]).toBe(
      "Hundreds of apps, including Gmail, Slack, Notion and GitHub — your bots can use them. Add your Flux Router key to unlock them, with a free daily allowance included.",
    );
    expect(Object.values(en).some(value => /\d+\+ (?:more |)apps|and \d+\+ more/.test(value))).toBe(false);
    expect(en["connectedApps.lock.button"]).toBe("Add Flux Router key");
    expect(en["connectedApps.lock.ownKey"]).toBe("Have your own Composio key? Add it under Advanced.");
    // The old notice-line CTA strings stay in en.json unreferenced until the locale
    // regeneration lane prunes them; the "flux-cta" notice kind itself is gone (see above).
  });

  it("paints the offer over a dimmed, inert showcase when there is no key", () => {
    const html = render(noKeys);
    expect(html).toContain('data-connected-apps-lock=""');
    expect(html).toContain("Connect your apps");
    expect(html).toContain("Add Flux Router key");
    expect(html).toContain("Have your own Composio key? Add it under Advanced.");
    // One headline, one line, one primary action.
    expect(html.match(/data-connected-apps-lock-primary/g)).toHaveLength(1);
    expect(html.match(/<h3 /g)).toHaveLength(1);
    // The showcase is scenery: hidden from assistive tech, out of the tab
    // order, and it takes no pointer.
    expect(html).toMatch(/aria-hidden="true" inert="" class="pointer-events-none select-none opacity-35 blur-\[1\.5px\]"/);
    for (const app of SHOWCASE_APPS) expect(html).toContain(`>${app.label}<`);
    // Nothing of the live panel is behind the glass: no catalog loading
    // line, no search, no marketplace tabs, no refresh button.
    expect(html).not.toContain("Loading catalog");
    expect(html).not.toContain("Search apps");
    expect(html).not.toContain("Marketplace");
    expect(html).not.toContain("Refresh connection status");
  });

  it("is the normal panel once either key exists", () => {
    for (const config of [fluxKey, ownKey]) {
      const html = render(config);
      expect(html).not.toContain("data-connected-apps-lock");
      expect(html).toContain("Search apps");
      expect(html).toContain("Refresh connection status");
    }
  });

  it("waits, and fetches nothing, until the config answer exists", () => {
    const html = render(null);
    expect(html).not.toContain("data-connected-apps-lock");
    expect(html).toContain(en["connectedApps.lock.loading"]);
    expect(html).not.toContain("Search apps");
  });

  it("never fetches the catalog or the inventory while locked", () => {
    // The showcase is a static list: no request of any kind leaves the lock.
    expect(SHOWCASE_APPS).toHaveLength(24);
    expect(SHOWCASE_APPS.map((app) => app.label)).toEqual([
      "Gmail", "Google Calendar", "Google Drive", "Slack", "Notion", "GitHub", "Linear", "Jira", "Trello", "HubSpot",
      "Salesforce", "Stripe", "Shopify", "Airtable", "Discord", "Telegram", "X", "LinkedIn", "YouTube", "Dropbox",
      "Zoom", "Calendly", "Asana", "Todoist",
    ]);
    expect(lockSource).not.toMatch(/\bfetch\(|\bapi\(|https?:\/\/|<img/);
    // The panel's two requests — the catalog and the inventory — sit behind
    // the one gate, in the one effect, and that effect re-runs when a key
    // is saved (the config frame flips `lockState`).
    expect(panel).toMatch(
      /useEffect\(\(\) => \{\n\s+if \(lockState !== "unlocked"\) return;\n\s+let alive = true;\n\s+void loadConnectionInventory\(\);\n\s+api\("\/api\/connectors\/catalog"\)[\s\S]*?\}, \[lockState, loadConnectionInventory\]\);/,
    );
    expect(panel.match(/api\("\/api\/connectors\/catalog"\)/g)).toHaveLength(1);
    // The locked panel listens for the app's own warm-up request; it never
    // starts one. `pendingConnectedApps` only returns what is in flight.
    expect(panel).toMatch(/if \(lockState === "unlocked"\) return;[\s\S]{0,200}pendingConnectedApps\(\)\?\.then/);
    expect(panel).toMatch(/export function pendingConnectedApps\(\)[^{]*\{\n\s+return connectorStatusRequest;\n\}/);
    // The header refresh button, which would fetch, is not offered while locked.
    expect(panel).toContain('{surface === "apps" && lockState === "unlocked" && (');
    // And the render did not call `api` at all (effects do not run in a
    // static render, so this pins the render path, not the effect gate).
    render(noKeys);
    expect(storeStub.api).not.toHaveBeenCalled();
  });

  it("lands the cursor in the key field the button names", () => {
    expect(FLUX_KEY_FIELD_SELECTOR).toBe('input[name="flux-router-key"]:not([disabled])');
    expect(COMPOSIO_KEY_FIELD_SELECTOR).toBe('input[aria-label="Connected apps key"]:not([disabled])');
    // The primary goes to Models (where the Flux key lives) and the secondary
    // to Tools & Connections (where the Composio key row lives), each with
    // the field focus queued behind the dialog opening.
    expect(panel).toMatch(/const addFluxKey = useCallback[\s\S]*?section: "models" \}\);\n\s+focusSettingsField\(FLUX_KEY_FIELD_SELECTOR\);/);
    expect(panel).toMatch(/const addOwnKey = useCallback[\s\S]*?section: "connections" \}\);\n\s+focusSettingsField\(COMPOSIO_KEY_FIELD_SELECTOR\);/);
    // The lock's button is the first thing the keyboard reaches.
    expect(panel).toContain('dialog?.querySelector<HTMLElement>("[data-connected-apps-lock-primary]")');
  });

  it("focuses a field that already exists, and gives up quietly where there is no document", () => {
    const focused: string[] = [];
    const field = { focus: () => focused.push("field"), scrollIntoView: () => focused.push("scroll") };
    const doc = { querySelector: (selector: string) => (selector === FLUX_KEY_FIELD_SELECTOR ? field : null), body: null } as unknown as Document;
    const stop = focusSettingsField(FLUX_KEY_FIELD_SELECTOR, { doc });
    expect(focused).toEqual(["scroll", "field"]);
    stop();
    // Nothing found and no body to observe: a bounded timer, then nothing.
    const cancel = focusSettingsField(COMPOSIO_KEY_FIELD_SELECTOR, { doc, timeoutMs: 1 });
    cancel();
    expect(focused).toEqual(["scroll", "field"]);
  });
});

// The Murage Worker's retirement. Once it has ended, people whose apps lived
// there have to reconnect them through FluxRouter, and every surface they can
// land on has to say so in plain words instead of "try again shortly".
describe("when Murage's original connected-apps service has retired", () => {
  const retired = { state: "legacy-retired" as const, legacyUntil: CUTOFF };

  it("tells a FluxRouter user to reconnect their apps here", () => {
    const list = notices({}, fields({ broker: "flux", fluxBrokerEnabled: true, fluxConfigured: true, migration: retired }));
    expect(texts(list)).toContain(en["connectedApps.flux.legacyRetired"]);
    expect(list.find((notice) => "text" in notice && notice.text === en["connectedApps.flux.legacyRetired"])).toMatchObject({ tone: "warning" });
  });

  it("says the old service has ended, not only that FluxRouter is unreachable", () => {
    const list = notices({ configured: false }, fields({ fluxBrokerEnabled: true, fluxConfigured: true, migration: retired }));
    expect(texts(list)).toBe(`${en["connectedApps.flux.legacyRetired"]} | ${en["connectedApps.flux.unreachable"]}`);
  });

  it("puts the retirement on the lock when there is no FluxRouter key yet", () => {
    const html = render({ ...noKeys, composio: { ...noKeys.composio, migration: retired } }).replaceAll("&#x27;", "'");
    expect(html).toContain('data-connected-apps-lock=""');
    expect(html).toContain(en["connectedApps.lock.retiredTitle"]);
    expect(html).toContain(en["connectedApps.lock.retiredBody"]);
    expect(html).not.toContain(en["connectedApps.lock.title"]);
    // Still one way forward: the FluxRouter key.
    expect(html).toContain("Add Flux Router key");
    expect(html.match(/data-connected-apps-lock-primary/g)).toHaveLength(1);
  });

  it("keeps the ordinary offer on the lock for everyone else", () => {
    expect(render(noKeys)).toContain(en["connectedApps.lock.title"]);
  });

  it("says it in one or two plain sentences that name Flux Router", () => {
    for (const key of ["connectedApps.flux.legacyRetired", "connectedApps.lock.retiredBody"]) {
      const copy = en[key];
      expect(copy).toContain("Flux Router");
      expect(copy).toMatch(/retired/);
      expect(copy.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
    }
  });
});

// Linux customer pass, 0.1.60: the Connected tab said 12 while the bot,
// asked, listed 11 apps. The tab counted every status entry with an account
// in any state, plus plumbing the list never shows; the bot can use only the
// apps with an account that works.
describe("the Connected tab's count", () => {
  const card = (slug: string) => ({ slug, label: slug, blurb: "", logo: null, domain: null });
  const cards = ["gmail", "github", "slack", "notion"].map(card);
  it("counts the apps a bot can use, and says how many more are not ready", () => {
    const summary = connectedTabSummary(cards, {
      gmail: { connected: true, accounts: [{ id: "a", status: "ACTIVE" }, { id: "b", status: "ACTIVE" }] },
      github: { connected: true, accounts: [{ id: "c", status: "ACTIVE" }] },
      slack: { connected: false, status: "EXPIRED", accounts: [{ id: "d", status: "EXPIRED" }] },
      composio_search: { connected: true },
      notion: { connected: false },
    });
    expect(summary).toEqual({ ready: 2, notReady: 1, note: "1 more app is not ready yet. Finish connecting it or reconnect it below." });
  });
  it("says nothing extra when every connection works", () => {
    expect(connectedTabSummary(cards, { gmail: { connected: true } }).note).toBe("");
    expect(connectedTabSummary(null, { gmail: { connected: true }, composio: { connected: true } }).ready).toBe(1);
  });
});

// Windows customer pass, 0.1.60 (D9): the first open after an update said
// "No connected apps yet" and the Marketplace offered Connect on apps that
// were connected, until Refresh. The inventory had been warmed before the
// connection backend was ready, and its empty answer was kept as the truth.
describe("an inventory read before the connection backend is ready", () => {
  it("is not kept as the truth, so the next open asks again", async () => {
    const answers = [
      { configured: false, credentialStore: "ok", services: {} },
      { configured: true, credentialStore: "ok", services: { gmail: { connected: true, accounts: [{ id: "a", status: "ACTIVE" }] } } },
    ];
    storeStub.api.mockImplementation(async () => answers.shift() as never);
    try {
      const early = await preloadConnectedApps(true);
      expect(early).toMatchObject({ authoritative: false, backendReady: false });
      const next = await preloadConnectedApps();
      expect(next.authoritative).toBe(true);
      expect(Object.keys(next.services)).toEqual(["gmail"]);
    } finally {
      storeStub.api.mockImplementation(async () => { throw new Error("no request may leave the locked panel"); });
    }
  });

  it("keeps the panel checking, not empty, while it waits for the backend", () => {
    expect(panel).toMatch(/backendReady === false[\s\S]{0,400}setInventoryPhase\("loading"\)/);
  });
});
