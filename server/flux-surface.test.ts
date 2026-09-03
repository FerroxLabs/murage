// The per-engine Flux gate (Kimi finding D). One table, and every consumer of
// it: the catalog build, the registry backstop, and the spawn refusal. A
// UI-only filter is not a gate, so each of the three is exercised here — and
// so is the specific shape that made finding D dangerous, a bare `flux-auto`
// on codex, which decodeCodexSelection maps onto api.openai.com.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelCatalog } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { QwenAgentDriver } from "./drivers/acp/qwen.ts";
import { readCodexModelCatalog } from "./drivers/codex-catalog.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { FLUX_SURFACE as ROUTING_FLUX_SURFACE } from "./flux-routing.ts";
import {
  FLUX_SURFACE,
  FLUX_TIERS,
  filterFluxRows,
  fluxCatalogId,
  fluxIdIsRoutable,
  fluxModelId,
  fluxSelectionRefusal,
  fluxSurfaceFor,
  isFluxModel,
  mergeFluxCatalog,
} from "./flux-surface.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** Shape only — never a live credential. */
const FLUX_KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEYED = { FLUX_API_KEY: FLUX_KEY } as NodeJS.ProcessEnv;
const UNKEYED = {} as NodeJS.ProcessEnv;

const TIER_LABELS = ["Flux Auto", "Flux Reasoning", "Flux Standard", "Flux Fast"];

const scratchDirs: string[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.FLUX_API_KEY;
  delete process.env.FLUX_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.FLUX_API_KEY;
  else process.env.FLUX_API_KEY = savedKey;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const claudeCatalog = (): ModelCatalog => ({
  default: "claude-sonnet-5",
  options: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "ollama::llama3", label: "llama3 (Ollama)", custom: true },
  ],
});

describe("FLUX_SURFACE — the one table", () => {
  it("names only engines whose surface is implemented", () => {
    expect(FLUX_SURFACE).toEqual({
      claudeAgent: "anthropic",
      qwenAgent: "openai",
      codex: "responses",
      hermesAgent: "openai",
      opencodeGo: "openai",
    });
  });

  it("is literally the same object flux-routing.ts dispatches on", () => {
    // Two hand-synced copies of this table is one table with a bug in it. The
    // identity check is the only assertion that cannot rot.
    expect(FLUX_SURFACE).toBe(ROUTING_FLUX_SURFACE);
  });

  it("uses driverKinds that actually exist on built-in drivers", () => {
    const kinds = new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    for (const kind of Object.keys(FLUX_SURFACE)) expect(kinds).toContain(kind);
    expect(ClaudeDriver.driverKind).toBe("claudeAgent");
    expect(QwenAgentDriver.driverKind).toBe("qwenAgent");
    // codex-catalog.ts hard-codes "codex" (it cannot import codex.ts without a
    // cycle) — this is the pin that keeps the two in step.
    expect(CodexDriver.driverKind).toBe("codex");
  });

  it("leaves every engine with no Flux surface out (spec §4.4)", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      if (["claudeAgent", "qwenAgent", "codex", "hermesAgent", "opencodeGo"].includes(driver.driverKind)) continue;
      expect(fluxSurfaceFor(driver.driverKind)).toBeNull();
    }
    expect(fluxSurfaceFor("droidAgent")).toBeNull();
    expect(fluxSurfaceFor("geminiAgent")).toBeNull();
  });
});

describe("recognising a Flux id", () => {
  it("accepts a bare tier id and the codex provider-qualified form", () => {
    expect(fluxModelId("flux-auto")).toBe("flux-auto");
    expect(fluxModelId("flux::flux-auto")).toBe("flux-auto");
    expect(isFluxModel("flux-pinned-claude-opus-5")).toBe(true);
  });

  it("does not claim a local model that merely happens to be named flux-*", () => {
    // encodeInjectId uses the same "::" separator — `ollama::flux-auto` is a
    // model an Ollama host is serving, not Flux Router.
    expect(fluxModelId("ollama::flux-auto")).toBeNull();
    expect(fluxModelId("openai::flux-auto")).toBeNull();
    expect(fluxModelId("gpt-5.6-sol")).toBeNull();
    expect(fluxModelId("flux::gpt-4o")).toBeNull();
    expect(isFluxModel(undefined)).toBe(false);
  });

  it("routes a bare id on claude and a flux:: id on codex, never the reverse", () => {
    expect(fluxCatalogId("claudeAgent", "flux-auto")).toBe("flux-auto");
    expect(fluxCatalogId("codex", "flux-auto")).toBe("flux::flux-auto");
    expect(fluxIdIsRoutable("flux-auto", "claudeAgent")).toBe(true);
    expect(fluxIdIsRoutable("flux::flux-auto", "claudeAgent")).toBe(false);
    // finding D itself: a bare id on codex decodes to OFFICIAL_CODEX_PROVIDER
    expect(fluxIdIsRoutable("flux-auto", "codex")).toBe(false);
    expect(fluxIdIsRoutable("flux::flux-auto", "codex")).toBe(true);
  });
});

describe("mergeFluxCatalog — the picker gate", () => {
  it("adds nothing when no key is configured", () => {
    expect(mergeFluxCatalog(claudeCatalog(), "claudeAgent", UNKEYED)).toEqual(claudeCatalog());
  });

  it("adds nothing on an engine with no Flux surface, key or not", () => {
    expect(mergeFluxCatalog(claudeCatalog(), "opencodeGo", KEYED)).toEqual(claudeCatalog());
    expect(mergeFluxCatalog(claudeCatalog(), "droidAgent", KEYED)).toEqual(claudeCatalog());
  });

  it("leads with Auto, Reasoning, Standard, Fast, then the engine's own rows", () => {
    const merged = mergeFluxCatalog(claudeCatalog(), "claudeAgent", KEYED);
    expect(merged.options.map((option) => option.id)).toEqual([
      "flux-auto",
      "flux-reasoning",
      "flux-standard",
      "flux-fast",
      "claude-opus-5",
      "claude-sonnet-5",
      "ollama::llama3",
    ]);
    expect(merged.options.slice(0, 4).map((option) => option.label)).toEqual(TIER_LABELS);
    // non-custom, so ModelPicker puts them in the official list, not Custom
    expect(merged.options.slice(0, 4).every((option) => option.custom === undefined)).toBe(true);
  });

  it("emits codex rows provider-qualified so they cannot decode to OpenAI", () => {
    const merged = mergeFluxCatalog({ default: "gpt-5.6-sol", options: [{ id: "gpt-5.6-sol", label: "GPT" }] }, "codex", KEYED);
    expect(merged.options.map((option) => option.id)).toEqual([
      "flux::flux-auto",
      "flux::flux-reasoning",
      "flux::flux-standard",
      "flux::flux-fast",
      "gpt-5.6-sol",
    ]);
  });

  it("sorts pinned Flux rows after the user's own models", () => {
    const merged = mergeFluxCatalog(
      {
        default: "claude-sonnet-5",
        options: [
          { id: "flux-pinned-claude-opus-5", label: "Flux · Opus 5", custom: true },
          { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
          { id: "ollama::llama3", label: "llama3 (Ollama)", custom: true },
        ],
      },
      "claudeAgent",
      KEYED,
    );
    expect(merged.options.map((option) => option.id)).toEqual([
      "flux-auto",
      "flux-reasoning",
      "flux-standard",
      "flux-fast",
      "claude-sonnet-5",
      "ollama::llama3",
      "flux-pinned-claude-opus-5",
    ]);
  });

  it("never leaves a duplicate tier row when the engine already listed one", () => {
    const merged = mergeFluxCatalog(
      { default: "claude-sonnet-5", options: [{ id: "flux-auto", label: "flux-auto", custom: true }, { id: "claude-sonnet-5", label: "S" }] },
      "claudeAgent",
      KEYED,
    );
    expect(merged.options.filter((option) => option.id === "flux-auto")).toHaveLength(1);
    expect(merged.options[0]).toEqual({ id: "flux-auto", label: "Flux Auto" });
  });

  it("removes a stale Flux row the engine's own config carries when the key is gone", () => {
    const merged = mergeFluxCatalog(
      { default: "claude-sonnet-5", options: [{ id: "flux-auto", label: "flux-auto", custom: true }, { id: "claude-sonnet-5", label: "S" }] },
      "claudeAgent",
      UNKEYED,
    );
    expect(merged.options.map((option) => option.id)).toEqual(["claude-sonnet-5"]);
  });

  it("keeps the engine's own default rather than promoting Flux Auto", () => {
    expect(mergeFluxCatalog(claudeCatalog(), "claudeAgent", KEYED).default).toBe("claude-sonnet-5");
  });

  it("takes Flux Auto as the default only for an engine that had no catalog", () => {
    // qwen with no local host: default "" and nothing to select
    expect(mergeFluxCatalog({ default: "", options: [] }, "qwenAgent", KEYED)).toEqual({
      default: "flux-auto",
      options: FLUX_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
    });
    expect(mergeFluxCatalog({ default: "", options: [] }, "qwenAgent", UNKEYED)).toEqual({ default: "", options: [] });
  });

  it("drops a default that pointed at a Flux row it just removed", () => {
    const merged = mergeFluxCatalog(
      { default: "flux-auto", options: [{ id: "flux-auto", label: "Flux Auto" }, { id: "qwen3", label: "qwen3", custom: true }] },
      "qwenAgent",
      UNKEYED,
    );
    expect(merged).toEqual({ default: "qwen3", options: [{ id: "qwen3", label: "qwen3", custom: true }] });
  });
});

describe("filterFluxRows — the registry backstop", () => {
  const withFlux: ModelCatalog = {
    default: "opencode-1",
    options: [{ id: "opencode-1", label: "one" }, { id: "flux-auto", label: "Flux Auto" }],
  };

  it("strips Flux rows a driver leaked onto an engine with no surface", () => {
    expect(filterFluxRows(withFlux, "opencodeGo", KEYED).options.map((option) => option.id)).toEqual(["opencode-1"]);
  });

  it("strips Flux rows on a routable engine when no key is configured", () => {
    expect(filterFluxRows(withFlux, "claudeAgent", UNKEYED).options.map((option) => option.id)).toEqual(["opencode-1"]);
  });

  it("strips a BARE flux id on codex — the exact shape that 400s at api.openai.com", () => {
    const catalog: ModelCatalog = {
      default: "gpt-5.6-sol",
      options: [
        { id: "gpt-5.6-sol", label: "GPT" },
        { id: "flux-auto", label: "Flux Auto" },
        { id: "flux::flux-auto", label: "Flux Auto" },
      ],
    };
    expect(filterFluxRows(catalog, "codex", KEYED).options.map((option) => option.id)).toEqual([
      "gpt-5.6-sol",
      "flux::flux-auto",
    ]);
  });

  it("passes a correctly gated catalog through untouched, same object", () => {
    const merged = mergeFluxCatalog(claudeCatalog(), "claudeAgent", KEYED);
    expect(filterFluxRows(merged, "claudeAgent", KEYED)).toBe(merged);
  });

  it("repairs a default left dangling by the filter", () => {
    const catalog: ModelCatalog = { default: "flux-auto", options: [{ id: "flux-auto", label: "Flux Auto" }, { id: "x", label: "x" }] };
    expect(filterFluxRows(catalog, "opencodeGo", KEYED)).toEqual({ default: "x", options: [{ id: "x", label: "x" }] });
  });

  it("runs inside registry.describe() — a driver that forgets the gate cannot leak", async () => {
    process.env.FLUX_API_KEY = FLUX_KEY;
    const fake = makeFakeDriver({ kind: "opencodeGo" });
    // the fake driver hands its own `models` object to every instance it makes
    Object.assign(fake.driver, {
      models: { default: "oc-1", options: [{ id: "oc-1", label: "one" }, { id: "flux-auto", label: "Flux Auto" }] },
    });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "opencodeGo" } });
    try {
      const [described] = await registry.describe();
      expect(described.models.options.map((option) => option.id)).toEqual(["oc-1"]);
      // the instance's own catalog is untouched — describe() is the choke point
      expect(registry.get("a")!.models.options.map((option) => option.id)).toEqual(["oc-1", "flux-auto"]);
    } finally {
      await registry.disposeAll();
    }
  });
});

describe("fluxSelectionRefusal — the spawn backstop", () => {
  it("says nothing about an ordinary model", () => {
    expect(fluxSelectionRefusal("claude-sonnet-5", "claudeAgent", KEYED)).toBeNull();
    expect(fluxSelectionRefusal("ollama::flux-auto", "opencodeGo", KEYED)).toBeNull();
    expect(fluxSelectionRefusal(undefined, "opencodeGo", KEYED)).toBeNull();
  });

  it("refuses a persisted flux-* selection on an engine with no Flux surface", () => {
    expect(fluxSelectionRefusal("flux-auto", "droidAgent", KEYED)).toBe(
      "this bot's engine cannot route Flux Router — choose another model in settings",
    );
  });

  it("tells a setup-class engine apart from an unroutable one", () => {
    // opencode CAN route; it just has not been set up. Saying "cannot route"
    // sends the user to change engines when the fix is one deliberate write.
    const env = { ...KEYED, HOME: join(tmpdir(), "murage-flux-surface-no-such-home") } as NodeJS.ProcessEnv;
    const refusal = fluxSelectionRefusal("flux-auto", "opencodeGo", env);
    expect(refusal).toContain("not set up for this engine yet");
    expect(refusal).not.toContain("cannot route");
  });

  it("refuses when the key was removed after the selection was saved", () => {
    expect(fluxSelectionRefusal("flux-auto", "claudeAgent", UNKEYED)).toContain("no API key");
  });

  it("refuses a bare flux id on codex rather than POSTing it to api.openai.com", () => {
    expect(fluxSelectionRefusal("flux-auto", "codex", KEYED)).toContain("not a Flux Router model this engine can route");
    expect(fluxSelectionRefusal("flux::flux-auto", "codex", KEYED)).toBeNull();
  });

  it("allows a correctly shaped selection on every routable engine", () => {
    expect(fluxSelectionRefusal("flux-reasoning", "claudeAgent", KEYED)).toBeNull();
    expect(fluxSelectionRefusal("flux-fast", "qwenAgent", KEYED)).toBeNull();
  });
});

describe("the gate is actually wired into the spawn path", () => {
  // fluxSelectionRefusal's four branches are covered above as a unit.
  // server/index.ts boots a server on import, so it cannot be imported into a
  // unit test — this pins that the call is still there, and still sits with
  // the effort re-check it mirrors. It is a wiring pin, not a behaviour test.
  const indexSource = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");

  it("calls fluxSelectionRefusal with the instance's driverKind", () => {
    expect(indexSource).toContain('import { fluxSelectionRefusal } from "./flux-surface.ts";');
    expect(indexSource).toContain("const fluxRefusal = fluxSelectionRefusal(model, instance.driverKind);");
  });

  it("throws it as a 409, beside the effort re-check", () => {
    const effortAt = indexSource.indexOf("is not offered by this bot's engine — choose another level in settings");
    const fluxAt = indexSource.indexOf("const fluxRefusal = fluxSelectionRefusal(");
    expect(effortAt).toBeGreaterThan(-1);
    expect(fluxAt).toBeGreaterThan(effortAt);
    expect(indexSource.slice(fluxAt, fluxAt + 200)).toContain(
      "throw Object.assign(new Error(fluxRefusal), { status: 409 })",
    );
  });
});

describe("the gate as each driver actually builds its catalog", () => {
  it("codex offers no Flux row without a key, and flux:: rows with one", async () => {
    const home = scratch("murage-flux-codex-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const env = { HOME: home, USERPROFILE: home, VITEST: "true" };

    const without = await readCodexModelCatalog(env);
    expect(without.options.some((option) => isFluxModel(option.id))).toBe(false);

    process.env.FLUX_API_KEY = FLUX_KEY;
    const withKey = await readCodexModelCatalog(env);
    expect(withKey.options.slice(0, 4).map((option) => option.id)).toEqual([
      "flux::flux-auto",
      "flux::flux-reasoning",
      "flux::flux-standard",
      "flux::flux-fast",
    ]);
    expect(withKey.default).toBe("gpt-5.6-sol");
  });

  it("codex keeps the gate on the no-config.toml path too", async () => {
    // readCodexModelCatalog has two returns; the early one fires when there is
    // no ~/.codex/config.toml at all.
    process.env.FLUX_API_KEY = FLUX_KEY;
    const home = scratch("murage-flux-codex-bare-");
    const catalog = await readCodexModelCatalog({ HOME: home, USERPROFILE: home, VITEST: "true" });
    expect(catalog.options[0]!.id).toBe("flux::flux-auto");
  });

  it("claude offers the four tiers first once a key is configured", async () => {
    process.env.FLUX_API_KEY = FLUX_KEY;
    const home = scratch("murage-flux-claude-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ customModels: ["local-glm"] }));
    const instance = await ClaudeDriver.create({
      instanceId: "claude-flux",
      displayName: "Claude",
      environment: { HOME: home, USERPROFILE: home },
      enabled: true,
      config: ClaudeDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.slice(0, 4).map((option) => option.label)).toEqual(TIER_LABELS);
      expect(instance.models.default).toBe("claude-sonnet-5");
      // and the custom row the user configured is still there, after them
      expect(instance.models.options.some((option) => option.id === "local-glm")).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("claude offers none of them without a key", async () => {
    const home = scratch("murage-flux-claude-off-");
    const instance = await ClaudeDriver.create({
      instanceId: "claude-noflux",
      displayName: "Claude",
      environment: { HOME: home, USERPROFILE: home },
      enabled: true,
      config: ClaudeDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((option) => isFluxModel(option.id))).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it("qwen picks the key up from process.env, not from its stripped child env", async () => {
    // qwen's resolveModels receives childEnv(), which has already had
    // FLUX_API_KEY deleted as a workspace credential — the gate must read the
    // key from config/process.env or it would never see one.
    process.env.FLUX_API_KEY = FLUX_KEY;
    const home = scratch("murage-flux-qwen-");
    const instance = await QwenAgentDriver.create({
      instanceId: "qwen-flux",
      displayName: "Qwen",
      environment: { HOME: home, USERPROFILE: home },
      enabled: true,
      config: QwenAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.map((option) => option.id)).toEqual([
        "flux-auto",
        "flux-reasoning",
        "flux-standard",
        "flux-fast",
      ]);
      expect(instance.models.default).toBe("flux-auto");
    } finally {
      await instance.dispose();
    }
  });
});
