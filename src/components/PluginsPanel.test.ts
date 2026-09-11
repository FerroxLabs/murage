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
import { describe, expect, it } from "vitest";
import {
  connectedAppsNotices,
  connectorActionLabel,
  connectorPanelFieldsFrom,
  connectorPrimaryAction,
  EMPTY_CONNECTOR_PANEL_FIELDS,
  FLUXROUTER_BILLING_URL,
  formatLegacyCutoff,
  mergeCompleteConnectorStatus,
  migrationFromClaim,
  type ConnectorPanelFields,
} from "./PluginsPanel";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "PluginsPanel.tsx"), "utf8");
const en = JSON.parse(readFileSync(join(here, "../locales/en.json"), "utf8")) as Record<string, string>;
const composio = readFileSync(join(here, "../../server/composio.ts"), "utf8");

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
    expect(panel).toContain("Connected with your own Composio key");
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

describe("the connected-apps call to action", () => {
  it("offers FluxRouter first and a pasted key second when nothing is set up", () => {
    const [cta] = notices({ configured: false }, fields({ fluxBrokerEnabled: true }));
    expect(cta).toMatchObject({
      kind: "flux-cta",
      title: "Connect 500+ apps — enable FluxRouter",
      actions: [
        { id: "enable-flux", label: "Enable FluxRouter" },
        { id: "own-key", label: "Use my own Composio key (Advanced)" },
      ],
    });
    // "enable-flux" must land on Models, where FluxRouter actually lives.
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
    ["flux_key_budget_exhausted", "Add credit", "billing"],
    ["flux_key_expired", "Reconnect FluxRouter", "enable-flux"],
    ["flux_key_invalid", "Reconnect FluxRouter", "enable-flux"],
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
      "Move your connected apps to FluxRouter. Anyone using this FluxRouter account's keys will be able to use them. This can't be undone from the app.",
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
    [undefined, "couldn't be moved to this FluxRouter account"],
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
    expect(texts(list)).toContain("moved to a FluxRouter account that isn't this one");
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
    expect(shared).toContain("Connected through your FluxRouter account.");
    expect(shared).toContain("Anyone using this FluxRouter account's keys can use these connected apps.");

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
    expect(fresh).toContain("Your connected apps moved to FluxRouter.");
    const later = texts(notices({ now: Date.parse(at) + 25 * 3_600_000 }, flux({ migration })));
    expect(later).not.toContain("moved to FluxRouter");
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
