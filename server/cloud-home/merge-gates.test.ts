// SPDX-License-Identifier: AGPL-3.0-or-later
// CLOUD-HOME-ON-RELEASE merge gates (Astra review of 9a634f99c): three Cloud behaviours the merge must keep, and none of them may
// change a desktop. Real Store, temp DATA_DIR.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushCoalesced } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { pickDefaultEngine } from "../default-engine.ts";
import { fuigoTransformEnv } from "../drivers/acp/fuigo.ts";
import { homeBirthFallback } from "./engine-signins.ts";
import { FLUX_OPENAI_BASE } from "../flux-routing.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const EMPTY = { instanceId: "", model: "" };
const CLAUDE = { instanceId: "claude", model: "claude-model" };
const FLUX_KEY = "sk-flux-Ffffffffffffffffffffffffffffffffffffffffff";
const OWN = { instanceId: "codex", model: "gpt-6" };

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.unstubAllEnvs(); });

describe("birth with no usable Fuigo", () => {
  it("a Cloud home keeps the home-wide fallback (an available, signed-in Claude)", () => {
    const store = new Store({ fuigo: () => [], copyChief: false, homeFallback: () => CLAUDE });
    const bot = store.createBot({}, { seedMessages: false });
    expect(bot.modelSelection).toMatchObject(CLAUDE);
    expect(bot.engineAutoPicked).toBe(true);
  });
  it("a Cloud home with no reading is born empty and marked", () => {
    const store = new Store({ fuigo: () => [], copyChief: false, homeFallback: () => EMPTY });
    const bot = store.createBot({}, { seedMessages: false });
    expect(bot.modelSelection).toEqual(EMPTY);
    expect(bot.engineAutoPicked).toBe(true);
  });
  it("a desktop (no fallback) stays empty", () => {
    const store = new Store({ fuigo: () => [], copyChief: true });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toEqual(EMPTY);
  });
});

describe("the Cloud birth fallback is a fresh pick, not a value cached at boot", () => {
  const model = (id: string) => ({ default: id, options: [{ id }] });
  it("Fuigo usable at boot, then unusable: the next birth picks Claude", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    // A keyless Fuigo has no birth model (birthModels drops the Flux rows), so the home holds a Flux key.
    vi.stubEnv("FLUX_API_KEY", FLUX_KEY);
    const fuigoLive = { instanceId: "fuigo", driverKind: "fuigoAgent", enabled: true, models: model("flux-auto") };
    let fuigo = [fuigoLive];
    // The last probe still lists Fuigo with a catalogue (it ran while Fuigo was usable); Claude is available.
    const readings = [
      { instanceId: "fuigo", driverKind: "fuigoAgent", snapshot: { state: "available" }, models: model("flux-auto") },
      { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available" }, models: model("claude-model") },
    ];
    const store = new Store({ fuigo: () => fuigo as never, copyChief: false, homeFallback: homeBirthFallback(() => readings, pickDefaultEngine) });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject({ instanceId: "fuigo" });
    fuigo = [{ ...fuigoLive, enabled: false }];
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject({ instanceId: "claude", model: "claude-model" });
  });
});

describe("the Cloud birth fallback reconciles against the live registry", () => {
  const model = (id: string) => ({ default: id, options: [{ id }] });
  it("Claude available at boot, then removed: the next birth does not pick it", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const readings = [
      { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available" }, models: model("claude-model") },
      { instanceId: "codex", driverKind: "codexAgent", snapshot: { state: "available" }, models: model("codex-model") },
    ];
    const entry = (id: string) => [id, { snapshot: { state: "available" }, models: model(`${id}-model`) }] as const;
    let live = new Map([entry("claude"), entry("codex")]);
    const fallback = homeBirthFallback(() => readings, pickDefaultEngine, () => live);
    live = new Map([entry("claude")]);
    expect(fallback().instanceId).toBe("claude");
    live = new Map([entry("codex")]);
    expect(fallback().instanceId).toBe("codex");
    live = new Map();
    expect(fallback().instanceId).not.toBe("claude");
    expect(fallback().instanceId).not.toBe("codex");
  });
});

describe("a chat's own model pick and the Murage-picked mark", () => {
  const setup = () => {
    const store = new Store({ fuigo: () => [], copyChief: false, homeFallback: () => CLAUDE });
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id)!;
    return { store, bot, task };
  };
  it("Cloud home: the mark stays", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const { store, bot, task } = setup();
    store.patchTask(bot.id, task.threadId, { modelSelection: OWN });
    expect(store.bot(bot.id)!.engineAutoPicked).toBe(true);
  });
  it("desktop: the mark is cleared", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const { store, bot, task } = setup();
    store.patchTask(bot.id, task.threadId, { modelSelection: OWN });
    expect(store.bot(bot.id)!.engineAutoPicked).toBeUndefined();
  });
});

describe("the Flux base pin in the Fuigo driver", () => {
  const configured = { FUIGO_API_BASE_URL: "https://configured.example/v1", FUIGO_MODELS_BASE_URL: "https://configured.example/m" };
  it("a Cloud home with a Flux key pins both bases to the router", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    vi.stubEnv("FLUX_API_KEY", FLUX_KEY);
    const env: Record<string, string | undefined> = { ...configured };
    fuigoTransformEnv(env);
    expect(env.FUIGO_API_BASE_URL).toBe(FLUX_OPENAI_BASE);
    expect(env.FUIGO_MODELS_BASE_URL).toBe(FLUX_OPENAI_BASE);
  });
  it("a desktop keeps whatever base is configured", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    vi.stubEnv("FLUX_API_KEY", FLUX_KEY);
    const env: Record<string, string | undefined> = { ...configured };
    fuigoTransformEnv(env);
    expect(env.FUIGO_API_BASE_URL).toBe(configured.FUIGO_API_BASE_URL);
    expect(env.FUIGO_MODELS_BASE_URL).toBe(configured.FUIGO_MODELS_BASE_URL);
  });
});
