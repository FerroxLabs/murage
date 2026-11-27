// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 polish (Settings > Models & engines, from a read-only walk of a live 1.0.20 install): Flux Router leads the page
// and Fuigo leads the engines; an engine row shows no raw file path; engines that are not installed fold behind one
// "More engines" row with their install commands out of sight; a connection never reads "0 chat models listed"; the
// page never sends the owner to itself; and the Grok sign-in carries no uppercase "Unofficial" badge.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import type { PublicProviderConnection } from "../../shared/provider-connections";

const { store, mode } = vi.hoisted(() => ({
  store: { instances: [] as unknown[], refreshInstances: async () => {}, dispatch: () => {} },
  mode: { value: "simple" as "simple" | "advanced" },
}));
// A static render always reads Simple (the store's server snapshot), so the test names the mode itself.
vi.mock("@/lib/settings-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/settings-mode")>(),
  useSettingsMode: () => mode.value,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: store.instances, shellEnvironment: null }, dispatch: store.dispatch, refreshInstances: store.refreshInstances, flushBotPatches: async () => {} }),
    api: async () => { throw new Error("no network in this test"); },
  };
});
import { EnginesSettings } from "./EnginesSettings";
import { AdvancedHost } from "./SettingsPrimitives";
import { modelsCards, modelsCardsFor } from "./settings/pages/ModelsPage";
import { connectionStatusLine } from "./ModelsSettings";
import { ProviderRow } from "./SubscriptionSignIn";

const ready = (instanceId: string, driverKind: string, displayName: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName, enabled: true, cliDefault: driverKind,
  snapshot: { state: "available", authenticated: true, version: "1.0.0" },
  models: { default: "m", options: [{ id: "m", label: "Model" }] }, ...extra,
} as InstanceInfo);
const missing = (instanceId: string, driverKind: string, displayName: string, command: string): InstanceInfo => ({
  instanceId, driverKind, displayName, enabled: true, cliDefault: driverKind,
  snapshot: { state: "unavailable", reason: `${displayName} is not installed.` },
  install: { command: { darwin: command, linux: command, win32: command }, platform: "darwin" },
} as InstanceInfo);
const render = () => renderToStaticMarkup(createElement(AdvancedHost, null, createElement(EnginesSettings)));

afterEach(() => { store.instances = []; mode.value = "simple"; });

describe("Flux Router and Fuigo lead Models & engines", () => {
  it("puts the Flux Router card (models.providers) first in Simple and in Advanced", () => {
    expect(modelsCards({ desktop: true })[0]!.id).toBe("models.providers");
    expect(modelsCardsFor("advanced", { desktop: true })[0]!.id).toBe("models.providers");
    expect(modelsCardsFor("simple", { desktop: true })[0]!.id).toBe("models.providers");
  });

  it("lists Fuigo first among the engines, wherever the server sends it", () => {
    store.instances = [ready("codex", "codex", "Codex"), ready("claude", "claudeAgent", "Claude"), ready("fuigo", "fuigoAgent", "Fuigo")];
    const markup = render();
    const fuigo = markup.indexOf('data-engine-row="Fuigo"'), codex = markup.indexOf('data-engine-row="Codex"');
    expect(fuigo).toBeGreaterThanOrEqual(0);
    expect(codex).toBeGreaterThan(fuigo);
  });
});

describe("an engine row", () => {
  it("shows no raw file path, even in Advanced", () => {
    mode.value = "advanced";
    store.instances = [ready("codex", "codex", "Codex", { cli: "/opt/tools/bin/codex-cli" })];
    const markup = render();
    const row = markup.slice(markup.indexOf('data-engine-row="Codex"'));
    const rowEnd = row.indexOf("</div>");
    expect(row.slice(0, rowEnd)).not.toContain("/opt/tools/bin/codex-cli");
    expect(markup).not.toContain("font-mono text-[11.5px] text-accent");
  });
});

describe("engines that are not installed", () => {
  const instances = () => [
    ready("fuigo", "fuigoAgent", "Fuigo"), ready("codex", "codex", "Codex"),
    missing("kimi", "kimiAgent", "Kimi", "curl -fsSL https://example.invalid/kimi.sh | bash"),
    missing("qwen", "qwenAgent", "Qwen", "npm install -g @example/qwen-cli"),
  ];

  it("fold behind one More engines row, closed, with no install command on screen", () => {
    store.instances = instances();
    const markup = render();
    expect(markup).toContain('data-more-engines="2"');
    expect(markup).toMatch(/data-more-engines="2"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-more-engines="2"/);
    expect(markup).toContain("More engines");
    expect(markup).not.toContain('data-engine-row="Kimi"');
    expect(markup).not.toContain('data-engine-row="Qwen"');
    expect(markup).not.toContain("curl -fsSL");
    expect(markup).not.toContain("npm install");
    // The installed ones stay on the first screen.
    expect(markup).toContain('data-engine-row="Fuigo"');
    expect(markup).toContain('data-engine-row="Codex"');
  });

  it("draws no More engines row when every engine is installed", () => {
    store.instances = [ready("fuigo", "fuigoAgent", "Fuigo"), ready("codex", "codex", "Codex")];
    expect(render()).not.toContain("data-more-engines");
  });
});

describe("a model connection's status line", () => {
  const connection = (state: PublicProviderConnection["state"], extra: Partial<PublicProviderConnection> = {}) => ({
    id: "c1", preset: "anthropic", label: "Anthropic", enabled: true, revision: "r", baseUrl: "", protocol: "anthropic", configured: true, state,
    catalog: { connectionId: "c1", models: [], stale: false, fetchedAt: 1, assurance: "catalog-only" }, ...extra,
  }) as PublicProviderConnection;

  it("never says 0 chat models listed", () => {
    const line = connectionStatusLine(connection("catalog-ready"), 0);
    expect(line).not.toMatch(/\b0 chat models/);
    expect(line).toMatch(/no chat models/i);
    expect(connectionStatusLine(connection("catalog-ready"), 12)).toBe("12 chat models listed");
    expect(connectionStatusLine(connection("catalog-ready"), 1)).toBe("1 chat model listed");
  });

  it("says what needs doing on a connection that needs attention, without sending the owner to this same page", () => {
    const line = connectionStatusLine(connection("needs-attention"), 0);
    expect(line).not.toMatch(/Models & engines|Models and engines/);
    expect(line).not.toBe("Model list needs attention");
  });

  it("the server's sentence for an unknown saved address does not point at Models & engines (the page it shows on)", () => {
    const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    const at = source.indexOf("This saved address is not one of the AI services Murage knows by name");
    expect(at).toBeGreaterThan(0);
    const sentence = source.slice(at, source.indexOf('"', at));
    expect(sentence).not.toContain("Manage it in Models & engines");
    expect(sentence).toMatch(/Existing\/default connections/);
  });
});

describe("the Grok plan sign-in", () => {
  it("carries no uppercase Unofficial badge, only the plain sentence", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(ProviderRow, { status: { provider: "supergrok", enabled: true, state: "signed-out", acceptsCode: false }, connection: undefined, busy: false, onStart: noop, onSignOut: noop, onCancel: noop }));
    expect(html).not.toContain("uppercase");
    expect(html).not.toMatch(/>Unofficial</);
    expect(html).toContain("xAI has not published this sign-in for other apps yet");
  });
});
