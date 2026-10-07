import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  applyManagedBrokerMessage,
  connectionMode,
  connectorAccess,
  connectorSystemPrompt,
  normalizeAccountAlias,
  requiredAppsSystemPrompt,
  resetManagedBrokerState,
  setManagedBrokerAccess,
} from "./composio.ts";

// The inventory is remembered per credential; each test starts with none.
beforeEach(() => resetManagedBrokerState());

describe.sequential("managed broker credentials", () => {
  it("rejects broker URL components and invalid tokens from the environment", () => {
    process.env.MURAGE_COMPOSIO_BROKER_TOKEN = "a".repeat(64);
    try {
      for (const url of [
        "https://user:secret@broker.example/root",
        "https://broker.example/root?redirect=evil",
        "https://broker.example/root#fragment",
      ]) {
        process.env.MURAGE_COMPOSIO_BROKER_URL = url;
        expect(() => connectionMode({})).toThrow(/must not include/);
      }
      process.env.MURAGE_COMPOSIO_BROKER_URL = "http://[::1]:3210/root/";
      expect(connectionMode({})).toBe("managed");
      process.env.MURAGE_COMPOSIO_BROKER_TOKEN = "short";
      expect(() => connectionMode({})).toThrow(/token is invalid/);
    } finally {
      delete process.env.MURAGE_COMPOSIO_BROKER_URL;
      delete process.env.MURAGE_COMPOSIO_BROKER_TOKEN;
    }
  });
  it("accepts a private desktop credential update and rejects unsafe broker URLs", () => {
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });
    expect(connectionMode({})).toBe("managed");
    setManagedBrokerAccess({ url: "http://[::1]:3210/", token: "a".repeat(64) });
    expect(connectionMode({})).toBe("managed");
    expect(() =>
      setManagedBrokerAccess({ url: "http://broker.example", token: "a".repeat(64) }),
    ).toThrow(/HTTPS/);
    for (const url of [
      "https://user:secret@broker.example/root",
      "https://broker.example/root?redirect=evil",
      "https://broker.example/root#fragment",
    ]) {
      expect(() => setManagedBrokerAccess({ url, token: "a".repeat(64) })).toThrow(/must not include/);
    }
    expect(() => setManagedBrokerAccess({ url: "https://broker.example", token: "short" })).toThrow();
    setManagedBrokerAccess(null);
  });
  it("ignores credential sync without access and clears only on explicit null", () => {
    const messageType = "murage:managed-composio";
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });

    expect(applyManagedBrokerMessage({ type: messageType })).toBe(false);
    expect(connectionMode({})).toBe("managed");

    expect(applyManagedBrokerMessage({ type: messageType, access: null })).toBe(true);
    expect(connectionMode({})).toBe("unavailable");
  });
  // The broker used to win here, and the cost of that was silent. Its env
  // only arrives when app.isPackaged, so someone could connect eighteen
  // toolkits in dev on their own key and have every one of them disappear the
  // first time they ran the packaged build — a different Composio project,
  // a different user id, and an empty list that looks identical to never
  // having connected anything.
  it("resolves the broker in one place, so no caller can route around it", () => {
    // brokerRequest takes cfg and asks activeBroker rather than reading the
    // broker itself. That is what makes the billing switch a one-line change
    // instead of an audit of every call site.
    const source = readFileSync(new URL("./composio.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function brokerRequest("));
    expect(body.slice(0, body.indexOf("\n}"))).toContain("activeBroker(cfg)");
    // Only the resolver and the label may read it directly.
    expect(source.split("brokerAccess()").length - 1).toBeLessThanOrEqual(3);
  });

  it("validates account aliases before sending them upstream", () => {
    expect(normalizeAccountAlias("  personal gmail  ")).toBe("personal gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
    expect(() => normalizeAccountAlias("x".repeat(65))).toThrow(/1-64/i);
  });
});

// Three gates decide whether a turn carries the user's connected apps, and
// all three used to fail into the same silence: no integration, no prompt
// paragraph, and an assistant that then told a user with Gmail connected
// that it has no access to Gmail. These pin that each cause is DISTINCT and
// that only the mounted case is ever told the tool names.
describe.sequential("connector access reporting", () => {
  // An old own key is saved but unused, so it must not change any answer here.
  const withKey: AppConfig = { composio: { apiKey: "ak_mine" } } as never;
  const noService: AppConfig = {};
  const base = {
    botComposio: undefined as boolean | undefined,
    installedFromPackage: false,
    engineMountsConnectors: true,
    mounted: false,
  };

  it("names the cause instead of failing silently", () => {
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });
    expect(connectorAccess({ ...base, cfg: withKey, mounted: true })).toBe("mounted");
    // switched off for this bot, workspace perfectly healthy
    expect(connectorAccess({ ...base, cfg: withKey, botComposio: false })).toBe("bot-off");
    // ... and the same switch, thrown by the installer rather than the user
    expect(
      connectorAccess({ ...base, cfg: withKey, botComposio: false, installedFromPackage: true }),
    ).toBe("package-off");
    // broker present, bot allowed, engine cannot mount connector tools
    expect(
      connectorAccess({ ...base, cfg: withKey, engineMountsConnectors: false }),
    ).toBe("engine");
    // no broker: nothing in this workspace can reach connected apps, and an
    // old own key does not change that
    setManagedBrokerAccess(null);
    expect(connectorAccess({ ...base, cfg: noService })).toBe("unconfigured");
    expect(connectorAccess({ ...base, cfg: withKey })).toBe("unconfigured");
  });

  it("lets the managed broker count as configured, like every other reader", () => {
    setManagedBrokerAccess({ url: "http://127.0.0.1:3210/", token: "a".repeat(64) });
    try {
      // configured() is the single source of truth for "a service exists",
      // so a broker-only workspace is not "unconfigured" — with no key of
      // its own it still reports the engine as the thing in the way, which
      // it could only do by counting the broker.
      expect(connectorAccess({ ...base, cfg: noService, engineMountsConnectors: false })).toBe("engine");
      // and without the broker the same workspace has no service at all
      setManagedBrokerAccess(null);
      expect(connectorAccess({ ...base, cfg: noService, engineMountsConnectors: false })).toBe("unconfigured");
    } finally {
      setManagedBrokerAccess(null);
    }
  });

  it("says something different for every cause, and names the tools only when they exist", () => {
    const causes = ["mounted", "package-off", "bot-off", "unconfigured", "engine"] as const;
    const notices = causes.map((cause) => connectorSystemPrompt(cause));
    for (const notice of notices) expect(notice.trim().length).toBeGreaterThan(0);
    // a vague shared sentence is the bug, not the fix
    expect(new Set(notices).size).toBe(causes.length);
    for (const [index, cause] of causes.entries()) {
      // Only a turn that actually mounted them may be told to call them —
      // telling an assistant with no connector tools to run
      // COMPOSIO_SEARCH_TOOLS is how the denial got invented in the first
      // place.
      expect(/COMPOSIO_[A-Z_]+/.test(notices[index]!)).toBe(cause === "mounted");
    }
  });

  it("carries the profile's declared services into the prompt", () => {
    const apps = [
      { slug: "gmail", label: "Gmail", reason: "Read and reply to the inbox." },
      { slug: "notion", label: "Notion", reason: "File the notes", optional: true },
    ];
    const prompt = requiredAppsSystemPrompt(apps);
    // the contract is that every declared service, its stated reason, and
    // the optionality of an optional one all survive into the prompt
    for (const app of apps) {
      expect(prompt).toContain(app.label);
      expect(prompt).toContain(app.reason.replace(/\.$/, ""));
    }
    expect(prompt).toMatch(/optional/i);
    // nothing declared, nothing said
    expect(requiredAppsSystemPrompt([])).toBe("");
    expect(requiredAppsSystemPrompt(undefined)).toBe("");
  });
});
