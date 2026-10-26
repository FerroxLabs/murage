// SPDX-License-Identifier: AGPL-3.0-or-later
// Which engines a Cloud home offers: only those with BOTH a launcher argv rule and an image install.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allInstanceConfigs, instanceConfigs, type AppConfig } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { cloudHomeCopy } from "./copy.ts";
import { ENGINE_LOGIN_ENGINES } from "./engine-login.ts";
import { CLOUD_HIDDEN_ENGINES, CLOUD_RUNNABLE_ENGINES, cloudEngineChoiceRefusal, cloudEngineClientRefusal, isCloudEngineWithheldFromClient, isCloudHiddenEngine, parseClientCapabilities } from "./runnable-engines.ts";
import { CLOUD_ENGINES } from "./turn-process.ts";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const sorted = (values: readonly string[]) => [...values].sort();
/** turn-process.ts names two engines by their short name; the registry's driver kinds carry "Agent". */
const driverKind = (name: string) => (name === "pi" || name === "antigravity" ? `${name}Agent` : name);

describe("the runnable set cannot drift from the launcher or the image", () => {
  it("equals the launcher's ARGV_RULES engines", () => {
    const launcher = read("../../deploy/cloud-home/murage-turn-launch.py");
    const body = launcher.slice(launcher.indexOf("\nARGV_RULES = {"), launcher.indexOf("\nARGV_PROBES"));
    const keys = [...body.matchAll(/^ {4}"(\w+)": ArgvRule\(/gm)].map(match => driverKind(match[1]));
    expect(sorted(keys)).toEqual(sorted(CLOUD_RUNNABLE_ENGINES));
  });
  it("equals the engines the image manifest installs", () => {
    const build = read("../../deploy/cloud-home/build-image.sh");
    const engines = [...build.matchAll(/\("(\w+)", "\/opt\/murage\/bin\/\w+"\)/g)].map(match => driverKind(match[1]));
    expect(sorted(engines)).toEqual(sorted(CLOUD_RUNNABLE_ENGINES));
  });
  it("with the hidden set covers every cloud engine exactly once", () => {
    expect(sorted([...CLOUD_RUNNABLE_ENGINES, ...CLOUD_HIDDEN_ENGINES])).toEqual(sorted(CLOUD_ENGINES.map(driverKind)));
    expect(CLOUD_RUNNABLE_ENGINES.filter(name => (CLOUD_HIDDEN_ENGINES as readonly string[]).includes(name))).toEqual([]);
  });
  it("hides exactly the seven engines the home cannot run", () => {
    expect(sorted(CLOUD_HIDDEN_ENGINES)).toEqual(sorted(["piAgent", "hermesAgent", "geminiAgent", "cursorAgent", "droidAgent", "qwenAgent", "customAcp"]));
  });
  it("keeps engine sign-in to engines a home runs", () => {
    for (const engine of ENGINE_LOGIN_ENGINES) expect(CLOUD_RUNNABLE_ENGINES).toContain(engine);
  });
});

const fleet: InstanceConfigMap = {
  claude: { driver: "claudeAgent" }, codex: { driver: "codex" }, grok: { driver: "grokAgent" }, kimi: { driver: "kimiAgent" },
  opencodeGo: { driver: "opencodeGo" }, fuigo: { driver: "fuigoAgent" },
  pi: { driver: "piAgent" }, hermes: { driver: "hermesAgent" }, gemini: { driver: "geminiAgent" }, cursor: { driver: "cursorAgent" },
  antigravity: { driver: "antigravityAgent" }, droid: { driver: "droidAgent" }, qwen: { driver: "qwenAgent" }, custom: { driver: "customAcp" },
  computer: { driver: "boxAgent" }, openaiCompat: { driver: "openai-compat" },
};
const cfg = { instances: fleet } as unknown as AppConfig;
const drivers = (map: InstanceConfigMap) => Object.values(map).map(entry => entry.driver);

describe("the engine list a home offers", () => {
  it("leaves out the seven hidden engines and keeps the seven it runs", () => {
    const offered = drivers(instanceConfigs(cfg, { MURAGE_CLOUD_ROLE: "home" }));
    for (const hidden of CLOUD_HIDDEN_ENGINES) expect(offered).not.toContain(hidden);
    for (const runnable of CLOUD_RUNNABLE_ENGINES) expect(offered).toContain(runnable);
    expect(offered).toContain("boxAgent");
  });
  it("leaves out hidden engines the default fleet would add", () => {
    const offered = drivers(instanceConfigs({} as AppConfig, { MURAGE_CLOUD_ROLE: "home" }));
    for (const hidden of CLOUD_HIDDEN_ENGINES) expect(offered).not.toContain(hidden);
    expect(offered).toContain("claudeAgent");
  });
  it("is unchanged on the desktop", () => {
    expect(instanceConfigs(cfg, {})).toEqual(allInstanceConfigs(cfg));
    expect(instanceConfigs(cfg, { MURAGE_CLOUD_ROLE: "desktop" })).toEqual(allInstanceConfigs(cfg));
    const offered = drivers(instanceConfigs(cfg, {}));
    for (const hidden of CLOUD_HIDDEN_ENGINES) expect(offered).toContain(hidden);
  });
});

describe("choosing an engine the home hides", () => {
  it("is refused with the plain line on a home, new bot or switch", () => {
    for (const hidden of CLOUD_HIDDEN_ENGINES) expect(cloudEngineChoiceRefusal(true, hidden, true)).toBe(cloudHomeCopy.engineNotOnCloud);
  });
  it("lets a runnable engine through, and a bot that keeps its engine", () => {
    for (const runnable of CLOUD_RUNNABLE_ENGINES) expect(cloudEngineChoiceRefusal(true, runnable, true)).toBeUndefined();
    expect(cloudEngineChoiceRefusal(true, "piAgent", false)).toBeUndefined();
  });
  it("never refuses on the desktop", () => {
    for (const hidden of CLOUD_HIDDEN_ENGINES) expect(cloudEngineChoiceRefusal(false, hidden, true)).toBeUndefined();
    expect(isCloudHiddenEngine(undefined)).toBe(false);
  });
  it("is wired into bot creation and switching, the engine list answer and the unavailable message", () => {
    const index = read("../index.ts");
    expect(index).toContain("cloudEngineChoiceRefusal(cloudHome, allInstanceConfigs(cfg)[selection.instanceId]?.driver, !current || Boolean(changed))");
    expect(index).toContain("{ engineNote: cloudHomeCopy.engineNotOnCloud }");
    expect(index).toContain("isCloudHiddenEngine(allInstanceConfigs(cfg)[instanceId.trim()]?.driver)");
  });
});

describe("the line the picker shows", () => {
  it("is plain and short", () => {
    expect(cloudHomeCopy.engineNotOnCloud).toBe("More engines are coming to Cloud soon. They work in the desktop app today.");
  });
  it("keeps the Pi and Hermes refusals as backstops", () => {
    expect(cloudHomeCopy.piOnHome).toBeTruthy();
    expect(cloudHomeCopy.hermesOnHome).toBeTruthy();
  });
});

describe("Antigravity is offered only to a desktop that can sign it in (capability flag, fail closed)", () => {
  const withFlag = parseClientCapabilities("antigravity-signin");
  it("is runnable on a home but withheld from a client with no flag, a wrong flag or a version string", () => {
    expect(CLOUD_RUNNABLE_ENGINES).toContain("antigravityAgent");
    for (const header of [undefined, "", "other-flag", "1.0.4", "antigravity-signin-not"]) {
      const caps = parseClientCapabilities(header);
      expect(isCloudEngineWithheldFromClient(true, "antigravityAgent", caps), String(header)).toBe(true);
      expect(cloudEngineClientRefusal(true, "antigravityAgent", caps)).toBe("Update Murage to use Antigravity on Cloud");
    }
    expect(isCloudEngineWithheldFromClient(true, "antigravityAgent", undefined)).toBe(true);
  });
  it("is offered with the flag, and the flag never changes other engines or the desktop", () => {
    expect(isCloudEngineWithheldFromClient(true, "antigravityAgent", withFlag)).toBe(false);
    expect(cloudEngineClientRefusal(true, "antigravityAgent", withFlag)).toBeUndefined();
    expect(cloudEngineClientRefusal(true, "claudeAgent", parseClientCapabilities(undefined))).toBeUndefined();
    expect(cloudEngineClientRefusal(false, "antigravityAgent", parseClientCapabilities(undefined))).toBeUndefined();
  });
  it("reads a comma list, ignores junk and is bounded", () => {
    expect([...parseClientCapabilities(" Antigravity-Signin , x y,,a".concat(",b".repeat(200)))].includes("antigravity-signin")).toBe(true);
    expect(parseClientCapabilities("a,".repeat(500)).size).toBeLessThanOrEqual(32);
  });
  it("is wired into the engine list answer and the bot model check", () => {
    const index = read("../index.ts");
    expect(index).toContain("isCloudEngineWithheldFromClient(true, allInstanceConfigs(cfg)[item.instanceId]?.driver, currentClientCapabilities())");
    expect(index).toContain("cloudEngineClientRefusal(cloudHome, allInstanceConfigs(cfg)[selection.instanceId]?.driver, currentClientCapabilities())");
    expect(index).toContain("withClientCapabilities(req.headers");
  });
});
