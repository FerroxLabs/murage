// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "./contracts.ts";
import { checkAction } from "./browser-action-checker.ts";
import { FLUX_NO_RETAIN_DEPLOYED } from "./browser-extension-check-availability.ts";
import { resolveCheckerConnection, DEFAULT_CHECKER_MODELS, isPinnedFluxModel, NO_RETAIN_HEADER, type CheckerConnectionEvent } from "./browser-action-checker-connection.ts";

const FLUX_KEY = "flux_test_key_not_real";
const signal = new AbortController().signal;
const bot = (over: Record<string, unknown> = {}) => ({ instanceId: "bot-1", driverKind: "x", displayName: "Bot", enabled: true, ...over }) as unknown as ProviderInstance;
afterEach(() => vi.unstubAllGlobals());

function stubFetch(content: string, status = 200, applied: string | null = "applied") {
  const fn = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status, headers: applied === null ? {} : { [NO_RETAIN_HEADER]: applied } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("resolveCheckerConnection", () => {
  it("flux switch with no Flux key and no usable bot engine resolves to undefined", () => {
    expect(resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [bot()], readKey: () => null })).toBeUndefined();
  });
  it("flux switch that is not live runs on the bot's own engine and says so; it never sends to Flux", async () => {
    const fetchFn = stubFetch("ALLOW");
    const reviewPermission = vi.fn(async (_p: string) => "ALLOW");
    for (const live of [{ noRetainDeployed: false }, { noRetainDeployed: true, readKey: () => null }]) {
      const conn = resolveCheckerConnection({ switch: "flux", instances: [bot({ reviewPermission })], readKey: () => FLUX_KEY, ...live })!;
      expect(conn.source).toBe("bot");
      expect(conn.fallback).toBe(true);
      await conn.transport({ model: "m", system: "s", user: "u", maxTokens: 8, signal });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("flux switch that is live uses Flux, with no fallback flag", () => {
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [bot({ reviewPermission: async () => "ALLOW" })], readKey: () => FLUX_KEY })!;
    expect(conn.source).toBe("flux");
    expect(conn.fallback).toBeUndefined();
  });
  it("the bot switch is never a fallback", () => {
    expect(resolveCheckerConnection({ switch: "bot", instances: [bot({ reviewPermission: async () => "ALLOW" })] })!.fallback).toBeUndefined();
  });
  it("bot switch with no usable bot instance resolves to undefined, flux key notwithstanding", () => {
    expect(resolveCheckerConnection({ switch: "bot", instances: [bot()], readKey: () => FLUX_KEY })).toBeUndefined();
    expect(resolveCheckerConnection({ switch: "bot", instances: [bot({ enabled: false, reviewPermission: async () => "ALLOW" })], readKey: () => FLUX_KEY })).toBeUndefined();
  });
  it("flux transport posts one text-only request with the configured model and counts the call", async () => {
    const fetchFn = stubFetch("ALLOW");
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY, models: { stage1: "flux-pinned-m-fast", stage2: "flux-pinned-m-strong" } })!;
    expect(conn.source).toBe("flux");
    expect(conn.calls()).toBe(0);
    const out = await conn.transport({ model: "flux-pinned-m-fast", system: "sys", user: "usr", maxTokens: 8, signal });
    expect(out).toBe("ALLOW");
    expect(conn.calls()).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toMatch(/\/chat\/completions$/);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("flux-pinned-m-fast");
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "usr" }]);
  });
  it("a failed flux call still counts and throws", async () => {
    stubFetch("x", 500);
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY })!;
    await expect(conn.transport({ model: "flux-pinned-m", system: "s", user: "u", maxTokens: 8, signal })).rejects.toThrow();
    expect(conn.calls()).toBe(1);
  });
  it("flux key is read again at dispatch, a revoked key fails closed", async () => {
    stubFetch("ALLOW");
    let key: string | null = FLUX_KEY;
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => key })!;
    key = null;
    await expect(conn.transport({ model: "flux-pinned-m", system: "s", user: "u", maxTokens: 8, signal })).rejects.toThrow(/unavailable/i);
  });
  it("bot switch with a bot instance gives a text-only transport and counts calls", async () => {
    const reviewPermission = vi.fn(async (_prompt: string) => "FLAG");
    const conn = resolveCheckerConnection({ switch: "bot", instances: [bot({ reviewPermission })], readKey: () => null })!;
    expect(conn.source).toBe("bot");
    const out = await conn.transport({ model: "ignored", system: "SYS", user: "USR", maxTokens: 8, signal });
    expect(out).toBe("FLAG");
    expect(reviewPermission).toHaveBeenCalledTimes(1);
    expect(reviewPermission.mock.calls[0][0]).toContain("SYS");
    expect(reviewPermission.mock.calls[0][0]).toContain("USR");
    expect(conn.calls()).toBe(1);
  });
  it("bot switch falls back to extractMemory when there is no reviewPermission", async () => {
    const extractMemory = vi.fn(async () => "ALLOW");
    const conn = resolveCheckerConnection({ switch: "bot", instances: [bot({ extractMemory })], readKey: () => null })!;
    await conn.transport({ model: "m", system: "SYS", user: "USR", maxTokens: 8, signal });
    expect(extractMemory).toHaveBeenCalledTimes(1);
  });
  it("bot switch can name the bot's own instance", async () => {
    const a = vi.fn(async () => "A"), b = vi.fn(async () => "B");
    const conn = resolveCheckerConnection({ switch: "bot", botInstanceId: "bot-2", instances: [bot({ reviewPermission: a }), bot({ instanceId: "bot-2", reviewPermission: b })], readKey: () => null })!;
    expect(await conn.transport({ model: "m", system: "s", user: "u", maxTokens: 8, signal })).toBe("B");
  });
  it("sends the no-retain header on every Flux call", async () => {
    const fetchFn = stubFetch("ALLOW");
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY })!;
    await conn.transport({ model: DEFAULT_CHECKER_MODELS.stage1, system: "s", user: "u", maxTokens: 4, signal });
    const [, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)[NO_RETAIN_HEADER]).toBe("1");
  });
  it("a reply without the applied confirmation fails closed and is logged", async () => {
    for (const applied of [null, "no", "1"]) {
      stubFetch("ALLOW", 200, applied);
      const events: CheckerConnectionEvent[] = [];
      const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY, record: (e) => events.push(e), requireNoRetainEcho: true })!;
      await expect(conn.transport({ model: DEFAULT_CHECKER_MODELS.stage1, system: "s", user: "u", maxTokens: 4, signal })).rejects.toThrow(/NO_RETAIN/);
      expect(events).toContainEqual({ kind: "no_retain_missing", model: DEFAULT_CHECKER_MODELS.stage1 });
    }
  });
  it("by default (Flux live) every call requires the applied echo, and a reply without it fails closed as unavailable", async () => {
    expect(FLUX_NO_RETAIN_DEPLOYED).toBe(true);
    stubFetch("ALLOW", 200, null);
    const conn = resolveCheckerConnection({ switch: "flux", instances: [], readKey: () => FLUX_KEY })!;
    expect(conn.source).toBe("flux");
    await expect(conn.transport({ model: DEFAULT_CHECKER_MODELS.stage1, system: "s", user: "u", maxTokens: 4, signal })).rejects.toThrow("CHECKER_NO_RETAIN_NOT_APPLIED");
    const v = await checkAction({ ownerInstruction: "x", siteGrant: "g", action: { operation: "click", level: "L2", site: "https://a.example" } }, { transport: conn.transport, models: conn.models });
    expect(v).toMatchObject({ decision: "block", code: "checker_unavailable" });
    stubFetch("ALLOW", 200, "applied");
    await expect(conn.transport({ model: DEFAULT_CHECKER_MODELS.stage1, system: "s", user: "u", maxTokens: 4, signal })).resolves.toBe("ALLOW");
  });
  it("the echo can be switched off explicitly, and the header is still sent", async () => {
    const fetchFn = stubFetch("ALLOW", 200, null);
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, requireNoRetainEcho: false, instances: [], readKey: () => FLUX_KEY })!;
    await expect(conn.transport({ model: DEFAULT_CHECKER_MODELS.stage1, system: "s", user: "u", maxTokens: 4, signal })).resolves.toBe("ALLOW");
    expect(((fetchFn.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Record<string, string>)[NO_RETAIN_HEADER]).toBe("1");
  });
  it("end to end: a missing confirmation makes checkAction block as unavailable", async () => {
    stubFetch("ALLOW", 200, null);
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY, requireNoRetainEcho: true })!;
    const v = await checkAction({ ownerInstruction: "x", siteGrant: "g", action: { operation: "click", level: "L2", site: "https://a.example" } }, { transport: conn.transport, models: conn.models });
    expect(v).toMatchObject({ decision: "block", code: "checker_unavailable" });
  });
  it("the default pair is exactly the live catalogue ids", () => {
    expect(DEFAULT_CHECKER_MODELS).toEqual({ stage1: "flux-pinned-claude-haiku", stage2: "flux-pinned-gpt-5-mini" });
  });
  // Flux's real refusal shapes (flux-router src/model_access_message.py, tests/test_free_tier_model_refusal.py).
  const PLAN_SENTENCE = (m: string) => `${m} is not on the Flux free plan. Upgrade at https://fluxrouter.ai/home/billing to unlock it. Your key can use: flux-auto, flux-fast.`;
  const NOT_PERMITTED = (m: string) => `This key is not permitted to use ${m}. The key itself is valid, but its allowlist does not include this model. Contact support@fluxrouter.ai`;
  const openaiBody = (message: string) => ({ error: { message, type: "auth_error", param: "model", code: "403" } });
  const anthropicBody = (message: string) => ({ type: "error", error: { type: "permission_error", message } });
  const refuse = async (status: number, body: unknown) => {
    const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fn);
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY })!;
    const err = await conn.transport({ model: DEFAULT_CHECKER_MODELS.stage2, system: "s", user: "u", maxTokens: 4, signal }).catch((e) => e);
    expect(fn).toHaveBeenCalledTimes(1);
    return err as { code?: string; status?: number; message: string };
  };
  it("403 'not on the Flux free plan' in both dialects is the plan code, one call", async () => {
    const m = DEFAULT_CHECKER_MODELS.stage2;
    expect(await refuse(403, openaiBody(PLAN_SENTENCE(m)))).toMatchObject({ code: "CHECKER_MODEL_NOT_ALLOWED", status: 403 });
    expect(await refuse(403, anthropicBody(PLAN_SENTENCE(m)))).toMatchObject({ code: "CHECKER_MODEL_NOT_ALLOWED", status: 403 });
  });
  it("403 'not permitted' on a paid key in both dialects is its own code, not the plan one", async () => {
    const m = DEFAULT_CHECKER_MODELS.stage2;
    expect(await refuse(403, openaiBody(NOT_PERMITTED(m)))).toMatchObject({ code: "CHECKER_MODEL_NOT_PERMITTED", status: 403 });
    expect(await refuse(403, anthropicBody(NOT_PERMITTED(m)))).toMatchObject({ code: "CHECKER_MODEL_NOT_PERMITTED", status: 403 });
  });
  it("the OpenAI dialect keys on param == model, not on type", async () => {
    const m = DEFAULT_CHECKER_MODELS.stage2;
    expect(await refuse(403, { error: { message: PLAN_SENTENCE(m), type: "something_else", param: "model", code: "403" } })).toMatchObject({ code: "CHECKER_MODEL_NOT_ALLOWED" });
  });
  it("a 403 without param model or permission_error, a 401 and a 404 are plain request failures", async () => {
    const m = DEFAULT_CHECKER_MODELS.stage2;
    for (const [status, body] of [
      [403, { error: { message: PLAN_SENTENCE(m), type: "auth_error", code: "403" } }],
      [403, { error: { message: "model not allowed for this key" } }],
      [401, openaiBody(PLAN_SENTENCE(m))],
      [401, { error: { message: "invalid api key", type: "auth_error" } }],
      [404, { error: { message: `model ${m} access denied`, param: "model" } }],
    ] as const) {
      const err = await refuse(status, body);
      expect(err.code, `${status} ${JSON.stringify(body)}`).toBeUndefined();
      expect(err.message).toBe("CHECKER_REQUEST_FAILED");
      expect(err.status).toBe(status);
    }
  });
  it("end to end: plan and not-permitted refusals block with their own codes after one call; Flux's words never reach the reason", async () => {
    const m = DEFAULT_CHECKER_MODELS.stage1;
    for (const [body, code] of [[openaiBody(PLAN_SENTENCE(m)), "checker_model_not_allowed"], [anthropicBody(NOT_PERMITTED(m)), "checker_model_not_permitted"]] as const) {
      const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 403 }));
      vi.stubGlobal("fetch", fn);
      const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY })!;
      const v = await checkAction({ ownerInstruction: "x", siteGrant: "g", action: { operation: "click", level: "L2", site: "https://a.example" } }, { transport: conn.transport, models: conn.models });
      expect(v).toMatchObject({ decision: "block", code });
      expect(v.reason).not.toMatch(/free|upgrade|billing|support@|\u2014|safe/i);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
  it("only pinned Flux ids are accepted, never DeepSeek", () => {
    expect(isPinnedFluxModel(DEFAULT_CHECKER_MODELS.stage1)).toBe(true);
    expect(isPinnedFluxModel(DEFAULT_CHECKER_MODELS.stage2)).toBe(true);
    for (const bad of ["flux-fast", "flux-standard", "flux-auto", "claude-haiku-4-5", "flux-pinned-", "flux-pinned-deepseek-v4", "FLUX-PINNED-x y"]) expect(isPinnedFluxModel(bad), bad).toBe(false);
  });
  it("the default pair is two different families", () => {
    const fam = (id: string) => id.replace("flux-pinned-", "").split("-")[0];
    expect(fam(DEFAULT_CHECKER_MODELS.stage1)).not.toBe(fam(DEFAULT_CHECKER_MODELS.stage2));
  });
  it("an unpinned configured id makes the flux path unavailable, no silent fallback", () => {
    expect(resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => FLUX_KEY, models: { stage1: "flux-fast" } })).toBeUndefined();
  });
  it("defaults exist for both stages", () => {
    expect(DEFAULT_CHECKER_MODELS.stage1).toBeTruthy();
    expect(DEFAULT_CHECKER_MODELS.stage2).toBeTruthy();
  });
});
