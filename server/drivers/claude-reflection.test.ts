// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { ClaudeDriver } from "./claude.ts";
import { claudeTextOnlyTurn } from "./headless-text-only.ts";
import { createResolveRoute } from "../memory/pip-reflect-host.ts";
import * as transport from "../memory/pip-transport.ts";
// the CLI version probe (claude-guards, 6e766d759 keeps ENOENT for a missing binary) is not what this test is about: "fixture-cli" is not a real file
vi.mock("./claude-guards.ts", async original => ({ ...await original<typeof import("./claude-guards.ts")>(), requireClaudeCliVersion: async () => {} }));
vi.mock("./headless-text-only.ts", () => ({ claudeTextOnlyTurn: vi.fn(async () => ({ text: "{}" })) }));
vi.mock("./local-inject.ts", async original => ({
  ...await original<typeof import("./local-inject.ts")>(),
  mergeLocalInject: async () => ({ default: "local::fixture", options: [{ id: "local::fixture", label: "Fixture" }] }),
  applyClaudeInject: (env: NodeJS.ProcessEnv, selection: string) => { env.ANTHROPIC_MODEL = "fixture-model"; env.ANTHROPIC_BASE_URL = "http://fixture.invalid"; return { model: selection === "local::fixture" ? "fixture-model" : selection, injected: true }; },
}));
it("14/22: Claude reflection freezes its ordinary injected model in the route and transport", async () => {
  vi.spyOn(transport, "preflightRoute").mockReturnValue({ ok: true, identity: "fixture" });
  vi.spyOn(transport, "binaryIdentity").mockResolvedValue("fixture-binary");
  const instance = await ClaudeDriver.create({ instanceId: "fixture", displayName: "Fixture", environment: {}, enabled: true, config: { cli: "fixture-cli", permissionMode: "default" } });
  try {
    const route = await createResolveRoute({ modelSelectionOf: () => ({ instanceId: "fixture", model: "local::fixture" }), turnRouting: () => ({ instance, providerRoute: undefined }), binaryPath: () => "wrong-cli", connectionRevision: () => null })({ id: "bot", continuity: true, threadIds: ["thread"], options: { reflect: true } }, "thread");
    expect(route.model).toBe("fixture-model");
    await route.textOnlyTurn!({ model: route.model } as transport.TextOnlyTurnInput);
    expect(vi.mocked(claudeTextOnlyTurn).mock.calls[0][0].model).toBe("fixture-model");
    expect(vi.mocked(claudeTextOnlyTurn).mock.calls[0][1]).toMatchObject({ cli: "fixture-cli", env: { ANTHROPIC_MODEL: "fixture-model" } });
    await instance.adapter.textOnlyTurn!({ model: "local::fixture" } as transport.TextOnlyTurnInput);
    expect(vi.mocked(claudeTextOnlyTurn).mock.calls[1][0].model).toBe("fixture-model");
  } finally { await instance.dispose(); vi.restoreAllMocks(); }
});
