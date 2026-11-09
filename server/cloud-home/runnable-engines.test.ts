// SPDX-License-Identifier: AGPL-3.0-or-later
// Which engines a Cloud home offers: only those with BOTH a launcher argv rule and an image install.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allInstanceConfigs, instanceConfigs, type AppConfig } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { cloudHomeCopy } from "./copy.ts";
import { ENGINE_LOGIN_ENGINES } from "./engine-login.ts";
import { CLOUD_DESKTOP_ONLY_ENGINES, CLOUD_HIDDEN_ENGINES, CLOUD_LOCAL_ONLY_ENGINES, CLOUD_RUNNABLE_ENGINES, cloudEngineChoiceRefusal, cloudLocalOnlyEngineNames, isCloudHiddenEngine } from "./runnable-engines.ts";
import { CLOUD_ENGINES } from "./turn-process.ts";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const sorted = (values: readonly string[]) => [...values].sort();
/** turn-process.ts names two engines by their short name; the registry's driver kinds carry "Agent". */
const driverKind = (name: string) => (name === "pi" || name === "antigravity" ? `${name}Agent` : name);

describe("the runnable set cannot drift from the launcher or the image", () => {
  it("equals the launcher's ARGV_RULES engines", () => {
    const launcher = read("../../deploy/cloud-home/murage-turn-launch.py");
    const body = launcher.slice(launcher.indexOf("\nARGV_RULES = {"), launcher.indexOf("\nARGV_PROBES"));
    const keys = [...body.matchAll(/^ {4}"(\w+)": ArgvRule\(/gm)].map(match => match[1]);
    expect(sorted(keys)).toEqual(sorted(CLOUD_RUNNABLE_ENGINES));
  });
  it("equals the engines the image manifest installs", () => {
    const build = read("../../deploy/cloud-home/build-image.sh");
    const engines = [...build.matchAll(/\("(\w+)", "\/opt\/murage\/bin\/\w+"\)/g)].map(match => match[1]);
    expect(sorted(engines)).toEqual(sorted(CLOUD_RUNNABLE_ENGINES));
  });
  it("with the hidden set covers every cloud engine exactly once", () => {
    const launcherHidden = CLOUD_HIDDEN_ENGINES.filter(name => !(CLOUD_DESKTOP_ONLY_ENGINES as readonly string[]).includes(name));
    expect(sorted([...CLOUD_RUNNABLE_ENGINES, ...launcherHidden])).toEqual(sorted(CLOUD_ENGINES.map(driverKind)));
    for (const name of CLOUD_DESKTOP_ONLY_ENGINES) expect(CLOUD_HIDDEN_ENGINES).toContain(name);
    expect(CLOUD_DESKTOP_ONLY_ENGINES.filter(name => (CLOUD_ENGINES as readonly string[]).includes(name))).toEqual([]);
    expect(CLOUD_RUNNABLE_ENGINES.filter(name => (CLOUD_HIDDEN_ENGINES as readonly string[]).includes(name))).toEqual([]);
  });
  it("hides exactly the nine engines the home cannot run", () => {
    expect(sorted(CLOUD_HIDDEN_ENGINES)).toEqual(sorted(["piAgent", "hermesAgent", "geminiAgent", "cursorAgent", "antigravityAgent", "droidAgent", "qwenAgent", "customAcp", "museCode"]));
  });
  it("keeps Muse Code desktop only, launcher and image included", () => {
    expect(isCloudHiddenEngine("museCode")).toBe(true);
    expect(cloudEngineChoiceRefusal(true, "museCode", true)).toBe(cloudHomeCopy.engineNotOnCloud);
    expect(read("../../deploy/cloud-home/murage-turn-launch.py")).not.toMatch(/muse/i);
    expect(read("../../deploy/cloud-home/build-image.sh")).not.toMatch(/muse/i);
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
  muse: { driver: "museCode" },
  computer: { driver: "boxAgent" }, openaiCompat: { driver: "openai-compat" },
};
const cfg = { instances: fleet } as unknown as AppConfig;
const drivers = (map: InstanceConfigMap) => Object.values(map).map(entry => entry.driver);

describe("the engine list a home offers", () => {
  it("leaves out the nine hidden engines and keeps the six it runs", () => {
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

describe("Cline and Copilot run only on the person's computer", () => {
  const LOCAL_ONLY = Object.keys(CLOUD_LOCAL_ONLY_ENGINES);
  const product = { instances: { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } } } as unknown as AppConfig;
  it("are exactly Cline and Copilot, and no cloud engine", () => {
    expect(sorted(LOCAL_ONLY)).toEqual(["clineAgent", "copilotAgent"]);
    for (const engine of LOCAL_ONLY) {
      expect(CLOUD_ENGINES.map(driverKind)).not.toContain(engine);
      expect(CLOUD_RUNNABLE_ENGINES as readonly string[]).not.toContain(engine);
      expect(CLOUD_HIDDEN_ENGINES as readonly string[]).not.toContain(engine);
    }
  });
  it("a home never puts them in its engine list, so no turn can start on either", () => {
    expect(drivers(allInstanceConfigs(product))).toEqual(expect.arrayContaining(LOCAL_ONLY));
    for (const config of [product, {} as AppConfig, { instances: { ...fleet, cline: { driver: "clineAgent" }, githubCopilot: { driver: "copilotAgent" } } } as unknown as AppConfig]) {
      const offered = drivers(instanceConfigs(config, { MURAGE_CLOUD_ROLE: "home" }));
      for (const engine of LOCAL_ONLY) expect(offered).not.toContain(engine);
      expect(offered).toContain("claudeAgent");
    }
  });
  it("a home refuses a new bot on, or a switch to, either one", () => {
    for (const engine of LOCAL_ONLY) {
      expect(isCloudHiddenEngine(engine)).toBe(true);
      expect(cloudEngineChoiceRefusal(true, engine, true)).toBe(cloudHomeCopy.engineNotOnCloud);
    }
  });
  it("the desktop is unchanged: both stay offered and are never refused", () => {
    expect(instanceConfigs(product, {})).toEqual(allInstanceConfigs(product));
    expect(drivers(instanceConfigs(product, {}))).toEqual(expect.arrayContaining(LOCAL_ONLY));
    for (const engine of LOCAL_ONLY) expect(cloudEngineChoiceRefusal(false, engine, true)).toBeUndefined();
  });
  it("names each once, in fleet order, for the picker's line", () => {
    expect(cloudLocalOnlyEngineNames(["claudeAgent", "copilotAgent", undefined, "clineAgent", "copilotAgent"])).toEqual(["GitHub Copilot", "Cline"]);
    expect(cloudLocalOnlyEngineNames(drivers(allInstanceConfigs(product)))).toEqual(expect.arrayContaining(["Cline", "GitHub Copilot"]));
    expect(cloudLocalOnlyEngineNames(["claudeAgent", "toString", "hasOwnProperty"])).toEqual([]);
  });
  it("the home sends the names with its engine list, and leaves out ones the person hid", () => {
    const index = read("../index.ts");
    expect(index).toContain("const localOnlyEngines = cloudHome ? cloudLocalOnlyEngineNames(Object.values(allInstanceConfigs(cfg)).filter(entry => entry.hidden !== true).map(entry => entry.driver)) : [];");
    expect(index).toContain("...(localOnlyEngines.length ? { localOnlyEngines } : {})");
  });
});
