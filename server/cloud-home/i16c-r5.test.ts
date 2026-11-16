// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra r4 mediums on the Cloud line: Flux attribution, the birth fallback's freshness, and taking an Always back on a home.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeBirthFallback } from "./engine-signins.ts";
import { pickDefaultEngine } from "../default-engine.ts";
import { creditsUsedMessage, SERVICE_HOLD_MESSAGE, classifyFluxRefusalFromRpcError } from "./flux-credit-refusal.ts";
import { isCloudFluxLine, FLUX_NOT_READY_COPY } from "../../shared/provider-error.ts";
import { mayTakeAlwaysBack } from "../cloud-owner-surface.ts";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { botAlwaysAllowUndo } from "../approval-grant-routes.ts";

afterEach(() => { vi.unstubAllEnvs(); });

describe("Flux attribution: a 401 or 403 is Flux's only for a Fuigo turn that went to Flux", () => {
  const refused = (status: number) => ({ data: { http_status: status, message: "Unauthorized" } });
  it("a customer's own engine 401 and 403 is not a Flux refusal; a Fuigo-on-Flux one is", () => {
    for (const status of [401, 403]) {
      expect(classifyFluxRefusalFromRpcError(refused(status), { fromRouter: false, owned: false })).toBeNull();
      expect(classifyFluxRefusalFromRpcError(refused(status), { fromRouter: false, owned: true })?.message).toBe(FLUX_NOT_READY_COPY);
    }
  });
  it("the acp turn hands `owned` only when the Fuigo turn reached Flux", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../drivers/acp/core.ts", import.meta.url), "utf8");
    expect(source).toContain('const ownedByFlux = support.displayName === "Fuigo" && fluxRoutedTurn;');
    expect(source).toContain("acpRpcErrorMessage(msg.error, ownedByFlux)");
    expect(source).toContain("acpIsFluxRefusal(msg.error, ownedByFlux)");
  });
  it("the chat recognises exactly the lines the server words (not ready, held service, used-up month), and nothing else", () => {
    expect(isCloudFluxLine(FLUX_NOT_READY_COPY)).toBe(true);
    expect(isCloudFluxLine(SERVICE_HOLD_MESSAGE)).toBe(true);
    for (const options of [{}, { carryOn: false }, { resetsAt: "2026-12-01T00:00:00Z" }, { resetsAt: "2026-12-01T00:00:00Z", carryOn: false }]) expect(isCloudFluxLine(creditsUsedMessage(options))).toBe(true);
    expect(isCloudFluxLine("Request failed.")).toBe(false);
    expect(isCloudFluxLine(`${SERVICE_HOLD_MESSAGE} Add an API key.`)).toBe(false);
  });
});

describe("the Cloud birth fallback uses each instance's current state and models", () => {
  const model = (id: string) => ({ default: id, options: [{ id }] });
  const readings = [
    { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available" }, models: model("boot-claude") },
    { instanceId: "codex", driverKind: "codexAgent", snapshot: { state: "available" }, models: model("boot-codex") },
  ];
  it("a survivor that is no longer ready is skipped, and the survivors rank on their current models", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    let now = new Map<string, { snapshot: { state: string }; models: ReturnType<typeof model> }>([
      ["claude", { snapshot: { state: "available" }, models: model("live-claude") }],
      ["codex", { snapshot: { state: "available" }, models: model("live-codex") }],
    ]);
    const fallback = homeBirthFallback(() => readings, pickDefaultEngine, () => now);
    expect(fallback()).toMatchObject({ instanceId: "codex", model: "live-codex" });
    now = new Map([["codex", { snapshot: { state: "unavailable" }, models: model("live-codex") }], ["claude", now.get("claude")!]]);
    expect(fallback()).toMatchObject({ instanceId: "claude", model: "live-claude" });
    now = new Map([["claude", { snapshot: { state: "unavailable" }, models: model("live-claude") }]]);
    expect(fallback().instanceId).not.toBe("claude");
    expect(fallback().instanceId).not.toBe("codex");
  });
});

describe("taking an Always back on a Cloud home", () => {
  const keys = () => { const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); return k.publicKey.export({ format: "pem", type: "spki" }).toString(); };
  const device = (over: Record<string, unknown>) => ({ id: "d", account: "a", scope: "owner-desktop", publicKey: "", assertionKey: "", revoked: 0, factor: false, ...over }) as never;
  const request = (over: Record<string, unknown>) => { const headers = {}; setCloudIdentity(headers, device(over)); return headers; };
  it("the desktop app and an owner browser may; a phone, a chat-only browser, a revoked device and a shell may not", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const key = keys();
    expect(mayTakeAlwaysBack(request({ scope: "owner-desktop" }))).toBe(true);
    expect(mayTakeAlwaysBack(request({ scope: "browser", factor: "remembered-owner", publicKey: key, assertionKey: key }))).toBe(true);
    expect(mayTakeAlwaysBack(request({ scope: "owner-phone" }))).toBe(false);
    expect(mayTakeAlwaysBack(request({ scope: "browser", factor: false, publicKey: key, assertionKey: key }))).toBe(false);
    expect(mayTakeAlwaysBack(request({ scope: "owner-desktop", revoked: 1 }))).toBe(false);
    expect(mayTakeAlwaysBack({})).toBe(false);
  });
  it("the undo handler answers 200 for that caller and 404 for a refused one", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const deps = (desktop: boolean) => ({ desktop, readBody: async () => ({ bot: ["Bash(ls)"], task: [] }), botName: () => "Dax", isTask: () => true,
      remove: () => ({ removed: { bot: ["Bash(ls)"], task: [] } }), publish: () => ({}) });
    expect((await botAlwaysAllowUndo(deps(mayTakeAlwaysBack(request({ scope: "owner-desktop" }))), "b1")).status).toBe(200);
    expect((await botAlwaysAllowUndo(deps(mayTakeAlwaysBack(request({ scope: "owner-phone" }))), "b1")).status).toBe(404);
  });
  it("off a home the computer still may, and the handlers use the one check", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toContain("desktop: mayTakeAlwaysBack(req.headers, url.searchParams),\n        readBody: () => readBody(req),\n        botName: (botId) => store.bot(botId)?.name,\n        isTask: (botId, threadId) => store.tasks(botId).some((task) => task.threadId === threadId),\n        remove:");
    expect(source).toContain('if (!mayTakeAlwaysBack(req.headers, url.searchParams)) return json(res, 404, { error: "no such route" });');
  });
});
