import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./cloud-home/turn-process.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./cloud-home/turn-process.ts")>();
  return { ...actual, cloudEngineHome: (engine: string) => join(fixture.root, engine) };
});
import { DATA_DIR } from "./config.ts";
import { applyProviderRoute, grokResumeBinding, type ProviderTurnRoute } from "./provider-routing.ts";
import { TURN_RENDER, TURN_SCRATCH } from "./cloud-home/turn-process.ts";
import { claudeEnvironment } from "./drivers/claude.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
/** A path as a literal inside a RegExp, in the platform's spelling (a Windows path is full of backslashes). */
const literal = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const route: ProviderTurnRoute = { connectionId: "cloud-test", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "fixture-cloud-key", model: "fixture-model", revision: "r1" };
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "murage-cloud-route-"));
  for (const engine of ["grokAgent", "fuigoAgent", "hermesAgent", "claudeAgent"]) mkdirSync(join(fixture.root, engine));
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
});
afterEach(() => { vi.unstubAllEnvs(); removeTempDirSync(fixture.root); });
function diskText(path: string): string {
  return readdirSync(path, { withFileTypes: true }).map(entry => entry.isDirectory() ? diskText(join(path, entry.name)) : readFileSync(join(path, entry.name), "utf8")).join("\n");
}
describe("cloud provider route custody", () => {
  it("refuses Claude Flux routing on a home without adding Anthropic credentials", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyProviderRoute("claudeAgent", env, { ...route, preset: "flux", protocol: "anthropic" })).toThrow(cloudHomeCopy.claudeFluxOnHome);
    expect(Object.keys(env).filter(key => key.startsWith("ANTHROPIC_"))).toEqual([]);
  });
  it("refuses Grok provider homes on a home before touching the engine home", () => {
    expect(() => grokResumeBinding("thread", null, null)).toThrow(cloudHomeCopy.grokRouteOnHome);
  });
  it("preserves desktop Claude Flux endpoint and authentication", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const env: NodeJS.ProcessEnv = {};
    applyProviderRoute("claudeAgent", env, { ...route, preset: "flux", protocol: "anthropic" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:49999/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(route.apiKey);
  });
  it("strips a source OAuth token from the actual home Claude turn environment", () => {
    const env = claudeEnvironment(undefined, { CLAUDE_CODE_OAUTH_TOKEN: "fixture-native-token" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  it("refuses legacy Flux model selection before a Claude home environment can be routed", () => {
    expect(() => claudeEnvironment("flux-auto", {})).toThrow(cloudHomeCopy.claudeFluxOnHome);
  });
  it("keeps a routed Fuigo turn within its selected engine mount and its key out of every file", () => {
    const env: NodeJS.ProcessEnv = {};
    const binding = applyProviderRoute("fuigoAgent", env, route, { threadId: "cloud-thread" });
    try {
      expect(env.FUIGO_HOME).toMatch(new RegExp(`^${literal(join(fixture.root, "fuigoAgent"))}[\\\\/]`));
      expect(diskText(fixture.root)).not.toContain(route.apiKey);
      expect(env.MURAGE_PROVIDER_API_KEY).toBe(route.apiKey);
    } finally { binding.cleanup(); }
  });
  it("refuses a routed Hermes turn on a home: the launcher renders no Hermes config", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyProviderRoute("hermesAgent", env, route, { threadId: "cloud-thread" })).toThrow(cloudHomeCopy.hermesOnHome);
    expect(env[TURN_RENDER]).toBeUndefined();
    expect(readdirSync(join(fixture.root, "hermesAgent"))).toEqual([]);
  });
  it("sends a routed Codex turn's provider as a typed route, never as -c argv", () => {
    const env: NodeJS.ProcessEnv = {};
    const binding = applyProviderRoute("codex", env, { ...route, preset: "openai", protocol: "responses" });
    expect(binding.args).toEqual([]);
    const render = JSON.parse(env[TURN_RENDER]!);
    expect(render.route).toEqual({ provider: binding.modelProvider, baseUrl: route.baseUrl, model: route.model, apiKey: route.apiKey, label: "Selected provider" });
    expect(env.MURAGE_PROVIDER_API_KEY).toBe(route.apiKey);
  });
  it("refuses a routed Grok turn on a home and creates nothing in its engine home", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyProviderRoute("grokAgent", env, route, { threadId: "resume-thread" })).toThrow(cloudHomeCopy.grokRouteOnHome);
    expect(env.GROK_HOME).toBeUndefined();
    expect(existsSync(join(fixture.root, "grokAgent", "native"))).toBe(false);
  });
  it("creates nothing under the Fuigo engine home and asks the launcher for a tmpfs and a typed route", () => {
    const driver = "fuigoAgent";
    const env: NodeJS.ProcessEnv = {};
    const binding = applyProviderRoute(driver, env, route, { threadId: "cloud-thread", memoryTools: true });
    const home = env.FUIGO_HOME!;
    expect(readdirSync(join(fixture.root, driver))).toEqual([]);
    expect(existsSync(home)).toBe(false);
    expect(home).toMatch(new RegExp(`^${literal(join(fixture.root, driver, "native", "provider-turns"))}[\\\\/]${driver}-[a-f0-9]{24}$`));
    expect(JSON.parse(env[TURN_SCRATCH]!)).toEqual([home.slice(join(fixture.root, driver).length + 1).replace(/\\/g, "/")]); // the launcher's relative form uses '/'
    const render = JSON.parse(env[TURN_RENDER]!);
    expect(render).toEqual({ route: { provider: expect.stringMatching(/^murage_[0-9a-f]{16}$/u), baseUrl: route.baseUrl, model: route.model, apiKey: route.apiKey, protocol: "openai" }, memoryTools: true });
    expect(() => binding.cleanup()).not.toThrow();
    expect(readdirSync(join(fixture.root, driver))).toEqual([]);
  });
  it("keeps desktop routed homes in DATA_DIR on disk, removed by cleanup", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const env: NodeJS.ProcessEnv = {};
    const binding = applyProviderRoute("fuigoAgent", env, route, { threadId: "t" });
    const home = env.FUIGO_HOME!;
    expect(home.startsWith(join(DATA_DIR, "native", "provider-turns", "fuigoAgent-"))).toBe(true);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("[model.murage_selected]");
    expect(env[TURN_SCRATCH]).toBeUndefined();
    binding.cleanup();
    expect(existsSync(home)).toBe(false);
  });
});
