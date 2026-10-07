import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { deleteEnvNames } from "./config.ts";
import { applyProviderRoute, FUIGO_ALLOW_UPSTREAM_ENV, fuigoBlocksHost, type ProviderTurnRoute } from "./provider-routing.ts";

const base: ProviderTurnRoute = { connectionId: "c1", preset: "xai", protocol: "openai", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-key", model: "grok-4.7", revision: "r1" };
const flux: ProviderTurnRoute = { ...base, connectionId: "c2", preset: "flux", baseUrl: "https://api.fluxrouter.ai/v1", model: "claude-haiku-4-5" };
const gateway: ProviderTurnRoute = { ...base, connectionId: "c3", preset: "supergrok", baseUrl: "http://127.0.0.1:49999/api/model-gateway/c3/v1" };
const contract = (env: NodeJS.ProcessEnv) => createHash("sha256").update(JSON.stringify(Object.entries(env).filter(([k]) => k !== "FUIGO_HOME").sort())).digest("hex");
function route(r: ProviderTurnRoute, seed: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...seed }; const bound = applyProviderRoute("fuigoAgent", env, r, { threadId: "t" });
  bound.cleanup(); return env;
}

describe("Fuigo egress guard and Grok routes", () => {
  it("a route that sends Fuigo to api.x.ai lifts the guard", () => {
    expect(route(base).FUIGO_ALLOW_UPSTREAM_HOSTS).toBe("1");
    expect(route({ ...base, baseUrl: "https://chat.grok.com/v1" }).FUIGO_ALLOW_UPSTREAM_HOSTS).toBe("1");
  });
  it("lifts it only for the API-key route it writes, never for a subscription model (Fuigo 1.0.22 still refuses key routes to xAI)", () => {
    const env: NodeJS.ProcessEnv = {}; const bound = applyProviderRoute("fuigoAgent", env, base, { threadId: "t" });
    try {
      const config = readFileSync(join(env.FUIGO_HOME!, "config.toml"), "utf8");
      expect(env.FUIGO_ALLOW_UPSTREAM_HOSTS).toBe("1");
      expect(config).toContain('env_key = "MURAGE_PROVIDER_API_KEY"');
      expect(config).not.toMatch(/auth_provider|subscription/);
    } finally { bound.cleanup(); }
  });
  it("Flux Router and the loopback plan gateway never lift it, even when the parent env has it", () => {
    expect(route(flux).FUIGO_ALLOW_UPSTREAM_HOSTS).toBeUndefined();
    expect(route(gateway).FUIGO_ALLOW_UPSTREAM_HOSTS).toBeUndefined();
    expect(route(flux, { FUIGO_ALLOW_UPSTREAM_HOSTS: "1" }).FUIGO_ALLOW_UPSTREAM_HOSTS).toBeUndefined();
  });
  it("removes the inherited override under any casing on Windows, and the route still sets it after", () => {
    const env: Record<string, string | undefined> = { Fuigo_Allow_Upstream_Hosts: "1", PATH: "p" };
    deleteEnvNames(env, [FUIGO_ALLOW_UPSTREAM_ENV], "win32");
    expect(env).toEqual({ PATH: "p" });
    expect(route(base, { fuigo_allow_upstream_hosts: "0" }).FUIGO_ALLOW_UPSTREAM_HOSTS).toBe("1");
  });
  it("on Windows, a Flux or gateway route through applyProviderRoute leaves no casing variant of the override", () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      for (const r of [flux, gateway]) {
        const env = route(r, { Fuigo_Allow_Upstream_Hosts: "1", fuigo_allow_upstream_hosts: "1" });
        expect(Object.keys(env).filter((k) => k.toUpperCase() === FUIGO_ALLOW_UPSTREAM_ENV)).toEqual([]);
      }
    } finally { Object.defineProperty(process, "platform", real); }
  });
  it("the spawn contract digest differs between a Grok and a Flux route", () => {
    const a = route(base), b = route(flux);
    for (const e of [a, b]) { delete e.FUIGO_API_BASE_URL; delete e.FUIGO_MODELS_BASE_URL; delete e.MURAGE_PROVIDER_API_KEY; }
    expect(contract(a)).not.toBe(contract(b));
  });
  it("matches the guard's label-boundary rule", () => {
    expect(fuigoBlocksHost("https://api.x.ai/v1")).toBe(true);
    expect(fuigoBlocksHost("https://x.ai")).toBe(true);
    expect(fuigoBlocksHost("https://prefixx.ai/v1")).toBe(false);
    expect(fuigoBlocksHost("https://api.x.ai.evil.example/v1")).toBe(false);
    expect(fuigoBlocksHost("not a url")).toBe(false);
  });
});
