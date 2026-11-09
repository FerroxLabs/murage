import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launcherRig, type Rig } from "./engine-launch-fixture.ts";
import { TURN_RENDER } from "./turn-process.ts";
import { OpenCodeDestinationResolver } from "../opencode-destination.ts";
import { fluxDestination } from "../flux-destination.ts";
import { opencodeConfigOverlay } from "../flux-memory-headers.ts";
let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-x4-cloud-"); vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(() => { rig.dispose(); vi.unstubAllEnvs(); });
const route = (provider: string, baseUrl: string) => ({ provider, baseUrl, model: "m", apiKey: "fixture", protocol: "openai" });
async function turn(model: string, selectedRoute?: ReturnType<typeof route>) {
  const probe = vi.fn(async () => { throw new Error("Cloud must never probe"); });
  const resolver = new OpenCodeDestinationResolver(probe);
  const env: Record<string, string> = { HOME: rig.home("opencodeGo"), [TURN_RENDER]: JSON.stringify({ route: selectedRoute }) };
  const answer = await resolver.resolve({ env, cwd: rig.home("opencodeGo"), cli: rig.command, signal: new AbortController().signal, model, memoryOff: true });
  const result = fluxDestination(answer, "flux");
  expect(probe).not.toHaveBeenCalled();
  if (result.startsWith("refuse")) return { result, plan: undefined };
  if (result === "connector") env.OPENCODE_CONFIG_CONTENT = opencodeConfigOverlay("flux", { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" });
  const plan = rig.plan(rig.request("opencodeGo", { env, render: { route: selectedRoute }, unit: "murage-turn-0123456789abcdef.scope" }));
  expect(plan.error).toBeUndefined();
  expect(plan.ok?.args).toEqual(["acp"]);
  expect(plan.ok?.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  return { result, plan: plan.ok };
}
it("(a) refuses a local-host Flux alias before handing a launch to the launcher", async () => {
  const out = await turn("host/m", route("host", "https://api.fluxrouter.ai/v1"));
  expect(out.result).toBe("refuse-alias"); expect(out.plan).toBeUndefined();
});
it("(b) renders the non-Flux local route without Flux headers", async () => {
  const out = await turn("host/m", route("host", "https://fixture.example/v1"));
  expect(out.result).toBe("other");
  expect(JSON.stringify(out.plan?.files)).toContain("fixture.example");
  expect(out.plan?.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
});
it("(c) the connector route and memory-off overlay reach the launcher config", async () => {
  const out = await turn("flux/m", route("flux", "https://api.fluxrouter.ai/v1"));
  expect(out.result).toBe("connector");
  const config = JSON.parse(out.plan!.files[join(rig.home("opencodeGo"), ".config/opencode/opencode.json")]);
  expect(config.provider.flux.options.baseURL).toBe("https://api.fluxrouter.ai/v1");
  expect(JSON.parse(out.plan!.env.OPENCODE_CONFIG_CONTENT).provider.flux.options.headers["x-flux-memory-inject"]).toBe("off");
});
it("(d) the launcher continues to refuse debug config", () => {
  expect(rig.plan(rig.request("opencodeGo", { args: ["debug", "config"] })).error).toBeTruthy();
});
it.each([true, false])("(e) a native model carries no headers, connector route present=%s", async present => {
  const out = await turn("opencode/native", present ? route("flux", "https://api.fluxrouter.ai/v1") : undefined);
  expect(out.result).toBe("other"); expect(out.plan?.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
});
it("the launcher refuses a typed URL overlay and excludes a planted home config", async () => {
  const home = rig.home("opencodeGo"); mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.json"), '{"provider":{"evil":{"options":{"baseURL":"https://api.fluxrouter.ai"}}}}');
  const out = await turn("opencode/native");
  expect(JSON.stringify(out.plan?.files)).not.toContain('"evil"');
  expect(out.plan?.staged).not.toHaveProperty(".config/opencode/opencode.json");
  const rejected = rig.plan(rig.request("opencodeGo", { env: { OPENCODE_CONFIG_CONTENT: '{"provider":{"evil":{"options":{"baseURL":"https://api.fluxrouter.ai"}}}}' } }));
  expect(rejected.ok).toBeUndefined();
  expect(rejected.error).toContain("OPENCODE_CONFIG_CONTENT");
});
