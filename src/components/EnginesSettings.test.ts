// EnginesSettings renders ClaudeAccountsSettings under the Claude engine
// family (or once, standalone, when no Claude engine is listed) and hands it
// the store's refreshInstances as onChanged: the "fleet" the section refreshes
// after each of its own changes (CLAC3). This pins that wiring by rendering
// the page over a fake store and reading the props the section received,
// not by matching the component's source text (FOLLOW4, CLAC3 verifier).
// The interactive half of the contract — busy spans only the section's own
// request, the fleet refresh runs after busy clears, serialized, and a failed
// fleet refresh is reported — is proven in the browser by
// src/e2e/claude-accounts.human.spec.ts ("stays usable while the engine list
// re-probes", "reports an engine list that could not refresh"); the renderer
// suite has no DOM to click in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const { store, sections } = vi.hoisted(() => ({
  store: { instances: [] as unknown[], refreshInstances: async () => {}, dispatch: () => {} },
  sections: [] as Array<{ onChanged?: () => Promise<void> }>,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: store.instances }, dispatch: store.dispatch, refreshInstances: store.refreshInstances, flushBotPatches: async () => {} }),
    api: async () => { throw new Error("no network in this test"); },
  };
});
vi.mock("./ClaudeAccountsSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ClaudeAccountsSettings")>();
  return {
    ...original,
    ClaudeAccountsSettings: (props: { onChanged?: () => Promise<void> }) => { sections.push(props); return createElement("section", { "aria-label": "Claude accounts" }); },
  };
});
import { EnginesSettings } from "./EnginesSettings";

const instance = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
  instanceId, driverKind, displayName, enabled: true, cliDefault: driverKind,
  snapshot: { state: "available", authenticated: true, version: "1.0.0" },
  models: { default: "m", options: [{ id: "m", label: "Model" }] },
} as InstanceInfo);

afterEach(() => { sections.length = 0; store.instances = []; });

describe("EnginesSettings", () => {
  it("renders one Claude accounts section under the Claude family, with the store's refreshInstances as its fleet", () => {
    const refreshInstances = vi.fn(async () => {});
    store.refreshInstances = refreshInstances;
    store.instances = [instance("claude", "claudeAgent", "Claude"), instance("claude-work", "claudeAgent", "Work"), instance("codex", "codex", "Codex")];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup.match(/aria-label="Claude accounts"/g)).toHaveLength(1);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.onChanged).toBe(refreshInstances);
    // Inside the Claude family's section, after its rows, not after Codex.
    const claude = markup.indexOf(">Claude<"), codex = markup.indexOf(">Codex<"), accounts = markup.indexOf('aria-label="Claude accounts"');
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(accounts).toBeGreaterThan(claude);
    expect(codex).toBeGreaterThan(accounts);
  });

  it("renders the section once, standalone, when no Claude engine is listed", () => {
    const refreshInstances = vi.fn(async () => {});
    store.refreshInstances = refreshInstances;
    store.instances = [instance("codex", "codex", "Codex")];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup.match(/aria-label="Claude accounts"/g)).toHaveLength(1);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.onChanged).toBe(refreshInstances);
    expect(markup.indexOf('aria-label="Claude accounts"')).toBeGreaterThan(markup.indexOf(">Codex<"));
  });
});
