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
import { connectorActionLabel, connectorPrimaryAction, mergeCompleteConnectorStatus } from "./PluginsPanel";

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
  it("says which of the two Composio identities is in use", () => {
    expect(panel).toContain("Connected with your own Composio key");
    expect(panel).toContain("Connected through Murage's service");
  });

  it("stops calling a permanent packaging gate a temporary outage", () => {
    // This is the sentence that sent someone looking for a block that did not
    // exist. Every dev run reaches it, and reaches it forever.
    expect(panel).not.toContain("temporarily unavailable");
    expect(panel).toContain("aren't available on this launch");
  });
});

describe("a key someone pasted on purpose is the one that gets used", () => {
  it("lets a workspace key beat the managed broker", () => {
    // The single choke point. Every other consumer resolves through it, which
    // is why inverting the rule is one line and why that line has a test.
    expect(composio).toMatch(/function activeBroker[\s\S]{0,200}if \(cfg\.composio\?\.apiKey\) return null;/);
  });

  it("still leaves the broker as the default for anyone who configured nothing", () => {
    expect(composio).toMatch(/if \(cfg\.composio\?\.apiKey\) return null;\s*\n\s*return brokerAccess\(\);/);
  });
});
