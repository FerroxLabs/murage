// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { createResolveRoute, type RouteHost } from "./pip-reflect-host.ts";
import * as transport from "./pip-transport.ts";
import type { ReflectBot } from "./pip-reflect.ts";

const bot: ReflectBot = { id: "bot", threadIds: ["thread"], continuity: true, options: { reflect: true, reflectModel: "override" } };
const route = { connectionId: "conn", model: "speaking", revision: "1", protocol: "openai", preset: "openai", baseUrl: "http://fixture.invalid", apiKey: "fixture" };
function host(kind = "openai-chat") {
  const call = vi.fn(async (input: transport.TextOnlyTurnInput) => ({ text: "", verdict: { state: "validated" as const, structured: {} }, isolation: { exited: true, initLine: true, mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [] }, model: input.providerRoute?.model }));
  const adapter = { capabilities: { textOnlyTurn: true }, textOnlyTurn: call, textOnlyExecutable: () => join(DATA_DIR, "exact-engine") };
  const instance = { driverKind: kind, instanceId: "instance", models: { options: [{ id: "speaking" }, { id: "override" }] }, adapter };
  const deps = { modelSelectionOf: () => ({ instanceId: "instance", model: "speaking", connectionId: "conn" }), turnRouting: () => ({ instance, providerRoute: route }), connectionRevision: () => "1", connectionModels: () => ["speaking", "override"], binaryPath: () => { throw new Error("generic discovery must not run"); } } as unknown as RouteHost;
  return { deps, call };
}
beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(join(DATA_DIR, "exact-engine"), "fixture binary bytes"); });
afterEach(() => { vi.restoreAllMocks(); rmSync(join(DATA_DIR, "exact-engine"), { force: true }); });

describe("Astra audit2 route resolution", () => {
  it("21: preflight refusal precedes binary fingerprinting and dispatch", async () => {
    vi.spyOn(transport, "preflightRoute").mockReturnValue({ ok: false, identity: "held", verdict: { state: "unsupported", reason: "managed-config", detail: "plugins" }, paths: [] });
    const identity = vi.spyOn(transport, "binaryIdentity"); const { deps, call } = host("fuigoAgent");
    const got = await createResolveRoute(deps)(bot, "thread");
    expect(got.unsupported?.detail).toBe("plugins"); expect(identity).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it("21: the fingerprint names the adapter executable and requires its probe", async () => {
    vi.spyOn(transport, "preflightRoute").mockReturnValue({ ok: true, identity: "clear" });
    const identity = vi.spyOn(transport, "binaryIdentity"); const { deps } = host("grokAgent");
    expect((await createResolveRoute(deps)(bot, "thread")).probeRequired).toBe(true);
    expect(identity).toHaveBeenCalledWith(join(DATA_DIR, "exact-engine"));
  });
  it.each(["openai-chat", "fuigoAgent", "grokAgent", "claudeAgent"])("14/22: %s receives one validated connection model", async kind => {
    vi.spyOn(transport, "preflightRoute").mockReturnValue({ ok: true, identity: "clear" });
    const { deps, call } = host(kind), got = await createResolveRoute(deps)(bot, "thread");
    expect(got.model).toBe("override"); expect(got.providerRoute?.model).toBe("override");
    await got.textOnlyTurn!({ model: got.model, providerRoute: got.providerRoute } as transport.TextOnlyTurnInput);
    expect(call.mock.calls[0][0]).toMatchObject({ model: "override", providerRoute: { connectionId: "conn", model: "override" } });
    await expect(createResolveRoute(deps)({ ...bot, options: { reflect: true, reflectModel: "foreign" } }, "thread")).rejects.toThrow("connection");
  });
});
