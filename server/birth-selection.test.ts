// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sean's ruling, 2026-11-06, ENGINE-DEFAULT Option A: verified paid Claude or Codex leads desktop births.
// Usable eligible Fuigo, the eligible Chief and the eligible first-bot probe remain fallbacks. Owner picks win.
// Every automatic birth keeps its mark, in memory and on disk. Earlier BIRTH-FUIGO preservation rows remain below.
// Real Store, isolated DATA_DIR, injected dependencies.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { importBotPackageContents, previewBotPackageContents } from "./bot-package-import.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";
import { closeDatabase, database } from "./database.ts";
import { fuigoBirthModel } from "./default-engine.ts";
import { STATIC_FUIGO_MODELS } from "./drivers/acp/fuigo.ts";
import { starterProfileContents } from "./starter-profiles.ts";
import { Store, type BotRecord, type BirthDeps } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

type Instance = { instanceId: string; driverKind?: string; enabled?: boolean; models: ModelCatalog };
// A `fuigo login` catalogue: Fuigo's own non-Flux rows, which survive the Flux filter with no key.
const LOGIN: ModelCatalog = { default: "grok-code", options: [{ id: "grok-code", label: "Grok Code" }] };
const fuigo = (instanceId = "fuigo", models: ModelCatalog = LOGIN, enabled = true): Instance => ({ instanceId, driverKind: "fuigoAgent", enabled, models });
const CLAUDE = { instanceId: "claude", model: "sonnet" };
const CODEX = { instanceId: "codex", model: "gpt-6" };
const EMPTY = { instanceId: "", model: "" };
const FLUX_KEY = "sk-flux-birthfixture0000000000000000000000"; // secret-scan: fixture

let savedKey: string | undefined;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database();
  savedKey = process.env.FLUX_API_KEY; delete process.env.FLUX_API_KEY;
});
afterEach(() => {
  flushCoalesced(); vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.FLUX_API_KEY; else process.env.FLUX_API_KEY = savedKey;
});

/** A Store wired the way index.ts wires it: live Fuigo instances and the desktop/Cloud copy switch. */
function world(opts: { fuigo?: Instance[]; copyChief?: boolean; firstBot?: { instanceId: string; model: string }; signedIn?: BirthDeps["signedIn"]; eligible?: BirthDeps["eligible"] } = {}) {
  const state = { fuigo: opts.fuigo ?? [] };
  const store = new Store({ signedIn: opts.signedIn, eligible: opts.eligible, fuigo: () => state.fuigo, copyChief: opts.copyChief ?? true, ...(opts.firstBot ? { firstBot: () => opts.firstBot! } : {}) });
  return { store, state };
}
const onDisk = (id: string) => (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as BotRecord[]).find(bot => bot.id === id)!;
const reloaded = (id: string) => new Store(() => EMPTY).bot(id)!;
const chiefOn = (store: Store, selection: { instanceId: string; model: string }) => {
  const chief = store.createBot({ name: "Chief", modelSelection: selection }, { seedMessages: false });
  store.setChiefOfStaff(chief.id, undefined, "workspace");
  return store.bot(chief.id)!;
};

it("a Store without birth dependencies preserves explicit selections and leaves automatic births empty", () => {
  const store = new Store();
  const chief = chiefOn(store, CLAUDE);
  expect(chief.modelSelection).toEqual(CLAUDE);
  expect(onDisk(chief.id).modelSelection).toEqual(CLAUDE);
  const automatic = store.createBot({ name: "No engine dependencies" }, { seedMessages: false });
  expect(automatic.modelSelection).toEqual(EMPTY);
  expect(automatic.engineAutoPicked).toBe(true);
  expect(onDisk(automatic.id).modelSelection).toEqual(EMPTY);
  expect(new Store().bot(chief.id)!.modelSelection).toEqual(CLAUDE);
});

describe("rule step 1: a usable Fuigo", () => {
  it("the first bot is born on Fuigo and marked when Fuigo has a model", () => {
    const { store } = world({ fuigo: [fuigo()] });
    const first = store.createBot({}, { seedMessages: false });
    expect(first.modelSelection).toMatchObject({ instanceId: "fuigo", model: "grok-code" });
    expect(first.engineAutoPicked).toBe(true);
    expect(onDisk(first.id).engineAutoPicked).toBe(true);
    expect(reloaded(first.id).modelSelection).toMatchObject({ instanceId: "fuigo", model: "grok-code" });
  });

  it("a later bot is born on Fuigo whatever the Chief is on", () => {
    const { store } = world({ fuigo: [fuigo()] });
    chiefOn(store, CLAUDE);
    const later = store.createBot({ name: "Later" }, { seedMessages: false });
    expect(later.modelSelection).toMatchObject({ instanceId: "fuigo", model: "grok-code" });
    expect(later.engineAutoPicked).toBe(true);
  });

  it("a Fuigo catalogue with no named default gives its first model", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", { default: "", options: [{ id: "local", label: "Local" }, { id: "other", label: "Other" }] })] });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject({ instanceId: "fuigo", model: "local" });
  });

  it("two Fuigo instances: the Chief's own if usable, else the first", () => {
    const { store, state } = world({ fuigo: [fuigo("fuigo-a"), fuigo("fuigo-b")] });
    chiefOn(store, { instanceId: "fuigo-b", model: "grok-code" });
    expect(store.createBot({ name: "Own" }, { seedMessages: false }).modelSelection.instanceId).toBe("fuigo-b");
    state.fuigo = [fuigo("fuigo-a"), fuigo("fuigo-b", { default: "", options: [] })];
    expect(store.createBot({ name: "First" }, { seedMessages: false }).modelSelection.instanceId).toBe("fuigo-a");
  });

  it("a disabled Fuigo row is not usable", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", LOGIN, false)] });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject(EMPTY);
  });
});

describe("rule step 2: no usable Fuigo, a later desktop bot copies the Chief", () => {
  it("no Fuigo model: a later bot copies the Chief's non-empty selection as a value (changing the copy leaves the Chief alone)", () => {
    const { store } = world();
    const chief = chiefOn(store, { ...CLAUDE, connectionId: "acct-1" } as typeof CLAUDE);
    const later = store.createBot({ name: "Later" }, { seedMessages: false });
    expect(later.modelSelection).toMatchObject({ instanceId: "claude", model: "sonnet", connectionId: "acct-1" });
    expect(later.engineAutoPicked).toBe(true);
    later.modelSelection.model = "changed";
    expect(store.bot(chief.id)!.modelSelection.model).toBe("sonnet");
  });

  it("no workspace Chief: the oldest bot is the source", () => {
    const { store } = world();
    store.createBot({ name: "Oldest", modelSelection: CODEX }, { seedMessages: false });
    store.createBot({ name: "Middle", modelSelection: CLAUDE }, { seedMessages: false });
    expect(store.createBot({ name: "New" }, { seedMessages: false }).modelSelection).toMatchObject(CODEX);
  });

  it("no workspace Chief: the oldest bot by age is the source even when a package import appended a newer one (Astra lane M1)", () => {
    const { store } = world();
    const oldest = store.createBot({ name: "Oldest", modelSelection: CODEX }, { seedMessages: false });
    const imported = store.createBot({ name: "Imported", modelSelection: CLAUDE }, { seedMessages: false });
    store.bot(oldest.id)!.createdAt = 1_000; store.bot(imported.id)!.createdAt = 2_000;
    // an import appends: the newer bot sits at the END of the array
    store.bots.sort((x, y) => x.createdAt - y.createdAt);
    expect(store.createBot({ name: "New" }, { seedMessages: false }).modelSelection).toMatchObject(CODEX);
  });

  it("a Chief with an instance and a blank model is not copied", () => {
    const { store } = world();
    chiefOn(store, { instanceId: "claude", model: "" });
    const later = store.createBot({ name: "Later" }, { seedMessages: false });
    expect(later.modelSelection).toMatchObject(EMPTY);
    expect(later.engineAutoPicked).toBe(true);
  });

  it("BN2: a Chief still on Fuigo/flux-auto after the key is removed is copied as it is", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    chiefOn(store, { instanceId: "fuigo", model: "flux-auto" });
    expect(store.createBot({ name: "Later" }, { seedMessages: false }).modelSelection).toMatchObject({ instanceId: "fuigo", model: "flux-auto" });
  });

  it("BN2: a Chief on Claude while a new key's Fuigo catalogue is still empty is copied as it is", () => {
    process.env.FLUX_API_KEY = FLUX_KEY;
    const { store } = world({ fuigo: [fuigo("fuigo", { default: "", options: [] })] });
    chiefOn(store, CLAUDE);
    expect(store.createBot({ name: "Later" }, { seedMessages: false }).modelSelection).toMatchObject(CLAUDE);
  });
});

describe("rule step 3: the empty seed", () => {
  it("first bot with no Fuigo model is born empty and marked, never on another engine", () => {
    const { store } = world();
    const first = store.createBot({}, { seedMessages: false });
    expect(first.modelSelection).toMatchObject(EMPTY);
    expect(first.engineAutoPicked).toBe(true);
  });

  it("Chief empty gives empty plus the mark", () => {
    const { store } = world();
    chiefOn(store, EMPTY);
    const later = store.createBot({ name: "Later" }, { seedMessages: false });
    expect(later.modelSelection).toMatchObject(EMPTY);
    expect(later.engineAutoPicked).toBe(true);
  });
});

describe("keyless Fuigo, a real static catalogue and no Flux key", () => {
  it("the shared reading: STATIC_FUIGO_MODELS has no birth model without a key and flux-auto with one", () => {
    expect(fuigoBirthModel(fuigo("fuigo", STATIC_FUIGO_MODELS))).toBe("");
    process.env.FLUX_API_KEY = FLUX_KEY;
    expect(fuigoBirthModel(fuigo("fuigo", STATIC_FUIGO_MODELS))).toBe(STATIC_FUIGO_MODELS.default);
  });

  it("the first bot is born empty and marked", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    const first = store.createBot({}, { seedMessages: false });
    expect(first.modelSelection).toMatchObject(EMPTY);
    expect(first.engineAutoPicked).toBe(true);
  });

  it("a later desktop bot copies the Chief", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    chiefOn(store, CLAUDE);
    expect(store.createBot({ name: "Later" }, { seedMessages: false }).modelSelection).toMatchObject(CLAUDE);
  });

  it("a fuigo-login catalogue with its own rows is usable with no Flux key", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", { default: "flux-auto", options: [...STATIC_FUIGO_MODELS.options, { id: "grok-code", label: "Grok Code" }] })] });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject({ instanceId: "fuigo", model: "grok-code" });
  });

  it("a key landing makes the static catalogue usable at once (the filter reads the key at the call)", () => {
    const { store } = world({ fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    chiefOn(store, CLAUDE);
    process.env.FLUX_API_KEY = FLUX_KEY;
    expect(store.createBot({ name: "Later" }, { seedMessages: false }).modelSelection).toMatchObject({ instanceId: "fuigo", model: STATIC_FUIGO_MODELS.default });
  });
});

describe("owner picks win", () => {
  it("an owner selection in the profile is kept and unmarked", () => {
    const { store } = world({ fuigo: [fuigo()] });
    const picked = store.createBot({ name: "Picked", modelSelection: CLAUDE }, { seedMessages: false });
    expect(picked.modelSelection).toMatchObject(CLAUDE);
    expect(picked.engineAutoPicked).toBeUndefined();
    expect(onDisk(picked.id).engineAutoPicked).toBeUndefined();
  });
});

describe("no startup cache, no sign-in", () => {
  it("birth reads no sign-in", () => {
    const trap = fuigo();
    for (const field of ["snapshot", "authenticated", "state"]) Object.defineProperty(trap, field, { get() { throw new Error(`birth read ${field}`); } });
    const { store } = world({ fuigo: [trap] });
    expect(store.createBot({}, { seedMessages: false }).modelSelection.instanceId).toBe("fuigo");
  });

  it("birth source names no authenticated, pickDefaultEngine, pickDefaultEngineForBot, botEngineSignIn or bootSelection", () => {
    const storeSrc = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const start = storeSrc.indexOf("  birthSelection(): ModelSelection {");
    expect(start).toBeGreaterThan(-1);
    const body = storeSrc.slice(start, storeSrc.indexOf("\n  }\n", start));
    for (const name of ["authenticated", "snapshot", "pickDefaultEngine", "pickDefaultEngineForBot", "botEngineSignIn", "bootSelection", "describe("]) expect(body, name).not.toContain(name);
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).not.toMatch(/new Store\(\(\) => bootSelection/);
    // r3: bootSelection reaches birth only as the desktop first-bot fallback, and the whole Fuigo list goes in (birth filters it).
    expect(index).toContain('copyChief: birthOnDesktop, eligible: id => liveForBirth(id) !== null');
    expect(index).toContain('firstBot: () => bootSelection, signedIn: source => birthCandidate(');
    expect(index).toContain('reading: registry.scanReading()');
    expect(index).toContain('fuigo: () => registry.instances().filter(instance => instance.driverKind === "fuigoAgent")');
    // Pin the complete boundary: eligibility is shared, paid and remembered choices are desktop-only.
    expect(index.replace(/\s+/g, " ")).toContain('const birthOnDesktop = process.env.MURAGE_CLOUD_ROLE !== "home"; const store = new Store({ fuigo: () => registry.instances().filter(instance => instance.driverKind === "fuigoAgent"), copyChief: birthOnDesktop, eligible: id => liveForBirth(id) !== null, ...(birthOnDesktop ? { firstBot: () => bootSelection, signedIn: source => birthCandidate({ reading: registry.scanReading(), paidOnly: ENGINE_DEFAULT_PAID_ONLY, live: liveForBirth, source }) } : {}) },');
    expect(index.match(/\bbootSelection\b/g)?.length, "bootSelection: declaration, adopt, the r3 firstBot wiring, engine health and comments only").toBeLessThanOrEqual(8);
    // no birth caller of the sign-in-ranked pick is left; it survives only as engine health's display probe (BN1)
    expect(index).not.toMatch(/\bdefaultSelection\(/);
    expect(index.match(/engineHealthPrimaryProbe\b/g)?.length).toBe(2);
  });

  it("a default-engine.json naming Claude never reaches a new bot", () => {
    writeFileSync(join(DATA_DIR, "default-engine.json"), JSON.stringify(CLAUDE));
    const { store } = world();
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject(EMPTY);
    const withFuigo = world({ fuigo: [fuigo()] }).store;
    expect(withFuigo.createBot({ name: "Two" }, { seedMessages: false }).modelSelection.instanceId).toBe("fuigo");
  });
});

describe("r3: the first desktop bot with no usable Fuigo takes the first-launch probe's reading", () => {
  it("Claude found and no key: the first bot is born on Claude, marked", () => {
    const { store } = world({ firstBot: CLAUDE });
    const first = store.createBot({}, { seedMessages: false });
    expect(first.modelSelection).toMatchObject(CLAUDE);
    expect(first.engineAutoPicked).toBe(true);
  });
  it("a usable Fuigo still wins over the probe's reading", () => {
    const { store } = world({ fuigo: [fuigo()], firstBot: CLAUDE });
    expect(store.createBot({}, { seedMessages: false }).modelSelection.instanceId).toBe("fuigo");
  });
  it("a later bot never reads the probe: it copies the Chief", () => {
    const { store } = world({ firstBot: CODEX });
    chiefOn(store, CLAUDE);
    expect(store.createBot({ name: "Two" }, { seedMessages: false }).modelSelection).toMatchObject(CLAUDE);
  });
  it("a probe reading that names a Fuigo which cannot answer is never used (a remembered flux-auto after the key is removed)", () => {
    delete process.env.FLUX_API_KEY;
    const { store } = world({ fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS as ModelCatalog)], firstBot: { instanceId: "fuigo", model: "flux-auto" } });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject(EMPTY);
  });
  it("an empty probe reading gives the empty seed, marked (the blank machine is unchanged)", () => {
    const { store } = world({ firstBot: EMPTY });
    const first = store.createBot({}, { seedMessages: false });
    expect(first.modelSelection).toMatchObject(EMPTY);
    expect(first.engineAutoPicked).toBe(true);
  });
  it("Cloud never reads it: Ember with no usable Fuigo is empty and marked", () => {
    const { store } = world({ copyChief: false, firstBot: CLAUDE });
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toMatchObject(EMPTY);
  });
});

describe("Cloud home: never copy the Chief", () => {
  it("Chief on Claude with only its own sign-in and no Fuigo model: the teammate is born empty and marked", () => {
    const { store } = world({ copyChief: false });
    chiefOn(store, CLAUDE);
    const mate = store.createBot({ name: "Mate" }, { seedMessages: false });
    expect(mate.modelSelection).toMatchObject(EMPTY);
    expect(mate.engineAutoPicked).toBe(true);
  });

  it("Chief on Codex: empty and marked", () => {
    const { store } = world({ copyChief: false, fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    chiefOn(store, CODEX);
    expect(store.createBot({ name: "Mate" }, { seedMessages: false }).modelSelection).toMatchObject(EMPTY);
  });

  it("Chief on a disabled engine row: empty and marked", () => {
    const { store } = world({ copyChief: false, fuigo: [fuigo("fuigo", LOGIN, false)] });
    chiefOn(store, { instanceId: "fuigo", model: "grok-code" });
    expect(store.createBot({ name: "Mate" }, { seedMessages: false }).modelSelection).toMatchObject(EMPTY);
  });

  it("BN5: Ember is born on Fuigo when the filtered catalogue has a model", () => {
    process.env.FLUX_API_KEY = FLUX_KEY;
    const { store } = world({ copyChief: false, fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    const ember = store.createBot({ name: "Ember" }, { seedMessages: false });
    expect(ember.modelSelection).toMatchObject({ instanceId: "fuigo", model: STATIC_FUIGO_MODELS.default });
  });

  it("BN5: Ember on STATIC_FUIGO_MODELS with no key is born empty and marked", () => {
    const { store } = world({ copyChief: false, fuigo: [fuigo("fuigo", STATIC_FUIGO_MODELS)] });
    const ember = store.createBot({ name: "Ember" }, { seedMessages: false });
    expect(ember.modelSelection).toMatchObject(EMPTY);
    expect(ember.engineAutoPicked).toBe(true);
  });
});

describe("one mark write", () => {
  it("createBot writes engineAutoPicked once, in the record it saves, and calls no patchBot", () => {
    const { store } = world({ fuigo: [fuigo()] });
    const patch = vi.spyOn(store, "patchBot");
    const birth = vi.spyOn(store, "birthSelection");
    const born = store.createBot({}, { seedMessages: false });
    expect(birth).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(onDisk(born.id).engineAutoPicked).toBe(true);
    const storeSrc = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const create = storeSrc.slice(storeSrc.indexOf("  createBot("), storeSrc.indexOf("    transaction(() => {", storeSrc.indexOf("  createBot(")));
    expect(create.match(/engineAutoPicked = true/g)?.length).toBe(1);
  });
});

describe("route wiring: every birth read happens after the route's last wait", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const between = (from: string, to: string, after = 0) => {
    const a = index.indexOf(from, after);
    expect(a, from).toBeGreaterThan(-1);
    const b = index.indexOf(to, a);
    expect(b, to).toBeGreaterThan(a);
    return index.slice(a, b);
  };

  it("P2 POST /api/bots passes no selection when the body has none, after the writer gate and the cap", () => {
    const route = between("1.0.15 BIRTH-FUIGO P2", "return json(res, 201, {");
    expect(route).not.toMatch(/defaultSelection|birthSelection/);
    expect(route).toContain("...(selection ? { modelSelection: selection } : {})");
    expect(route.indexOf("await awaitWriterGateForeground()")).toBeLessThan(route.indexOf("store.createBot("));
  });

  it("P3 create_bot never copies the Chief, and a born lead is admitted on the birth value in the same tick as createBot", () => {
    expect(index).not.toContain("body.modelSelection === undefined ? chief.modelSelection");
    const tail = between("const late = createPreflight();", "createSlot.commit();", index.indexOf("1.0.15 BIRTH-FUIGO P3"));
    expect(tail).toContain("store.birthSelection()");
    expect(tail).not.toMatch(/\bawait\b/);
    expect(tail).toContain("...(modelSelection ? { modelSelection: { ...modelSelection } } : {})");
  });

  it("P5 package import births once inside the commit and admits leads on the final engine there", () => {
    expect(index).toContain('let importModelSelection: ModelSelection | "birth" = "birth";');
    expect(index).toContain("starterLeads: starter,");
    const commit = between("atomicCommit: ({ prepared }) => {", "botBatch.publish();", index.indexOf("1.0.15 BIRTH-FUIGO P5"));
    expect(commit).not.toMatch(/\bawait\b/);
    expect(commit).toContain("store.preparePackageAddition(prepared.bots, prepared.groups, { born: new Set(prepared.bornBotIds) })");
    expect(commit.indexOf("leadershipAdmissionError")).toBeGreaterThan(commit.indexOf("store.preparePackageAddition("));
  });

  it("P6 team import reads the birth rule and passes no selection to createBot", () => {
    const route = between("1.0.15 BIRTH-FUIGO P6", "{ seedMessages: false },");
    expect(route).toContain("const selection = store.birthSelection();");
    expect(route).not.toMatch(/\bawait\b/);
    expect(route.slice(route.indexOf("store.createBot("))).not.toContain("modelSelection");
  });

  it("P4 a paired browser bot passes no selection, so the birth rule decides, not a remembered engine", () => {
    expect(index).toContain('store.createBot({ name: body.label, title: "External browser connection" }, { seedMessages: false });');
  });
});

  async function importStarter(store: Store, modelSelection: { instanceId: string; model: string } | "birth", between?: () => void) {
    const root = mkdtempSync(join(tmpdir(), "murage-birth-import-"));
    try {
      const contents = starterProfileContents("starter-solo-business");
      const pkg = contents.manifest.definition.package;
      const selection = { agents: pkg.agents.map(agent => agent.key), skills: [], instructions: [], routines: [] };
      const preview = await previewBotPackageContents(contents, { selection, existingBots: [] });
      const running = importBotPackageContents({ contents, dataDir: root, selection, existingBots: store.bots,
        expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash, starterLeads: true,
        modelSelection, acknowledgeWarnings: true,
        atomicCommit: ({ prepared }) => {
          const batch = store.preparePackageAddition(prepared.bots, prepared.groups, { born: new Set(prepared.bornBotIds) });
          writeFileSync(join(DATA_DIR, "bots.json"), batch.files.get("bots.json")!);
          batch.publish();
        } });
      between?.();
      return await running;
    } finally { removeTempDirSync(root); }
  }

describe("P5 package import on a real Store", () => {
  it("a package with no selection: every bot born on Fuigo and marked, in the returned, live, persisted and reloaded records", async () => {
    const { store } = world({ fuigo: [fuigo()] });
    const birth = vi.spyOn(store, "birthSelection");
    const result = await importStarter(store, "birth");
    expect(birth).toHaveBeenCalledTimes(1);
    expect(result.bots.length).toBeGreaterThan(1);
    for (const bot of result.bots) {
      for (const record of [bot, store.bot(bot.id)!, onDisk(bot.id), reloaded(bot.id)]) {
        expect(record.modelSelection).toMatchObject({ instanceId: "fuigo", model: "grok-code" });
        expect(record.engineAutoPicked).toBe(true);
      }
    }
    // a value each, never one shared object
    result.bots[0]!.modelSelection.model = "changed";
    expect(result.bots[1]!.modelSelection.model).toBe("grok-code");
  });

  it("a starter with an explicit selection keeps it, unmarked", async () => {
    const { store } = world({ fuigo: [fuigo()] });
    const result = await importStarter(store, CLAUDE);
    for (const bot of result.bots) { expect(bot.modelSelection).toMatchObject(CLAUDE); expect(bot.engineAutoPicked).toBeUndefined(); }
  });

  it("Fuigo lost during the import: bots born by the copy", async () => {
    const { store, state } = world({ fuigo: [fuigo()] });
    chiefOn(store, CLAUDE);
    const result = await importStarter(store, "birth", () => { state.fuigo = []; });
    for (const bot of result.bots) expect(bot.modelSelection).toMatchObject(CLAUDE);
  });

  it("Fuigo gained during the import: bots born on Fuigo", async () => {
    const { store, state } = world();
    chiefOn(store, CLAUDE);
    const result = await importStarter(store, "birth", () => { state.fuigo = [fuigo()]; });
    for (const bot of result.bots) expect(bot.modelSelection.instanceId).toBe("fuigo");
  });

  it("the import names its lead for the commit to admit", async () => {
    const { store } = world({ fuigo: [fuigo()] });
    const result = await importStarter(store, "birth");
    expect(result.leadBotIds).toHaveLength(1);
  });
});

describe("1.0.18 ENGINE-DEFAULT", () => {
  it("B1/B6: paid engine wins over Fuigo without changing the Chief", () => {
    const signedIn = vi.fn(() => ({ ...CLAUDE }));
    const { store } = world({ fuigo: [fuigo()], signedIn });
    const chief = chiefOn(store, { instanceId: "fuigo", model: "grok-code" });
    const before = onDisk(chief.id);
    const born = store.createBot({}, { seedMessages: false });
    expect(born.modelSelection).toEqual(CLAUDE);
    expect(born.engineAutoPicked).toBe(true);
    expect(onDisk(chief.id)).toEqual(before);
  });
  it("B4: both dependency boundaries pass values", () => {
    const result = { ...CLAUDE };
    const signedIn = vi.fn(() => result);
    const { store } = world({ fuigo: [fuigo()], signedIn });
    const chief = chiefOn(store, { instanceId: "claude", model: "opus" });
    const born = store.createBot({}, { seedMessages: false });
    expect(signedIn).toHaveBeenCalledExactlyOnceWith({ instanceId: "claude", model: "opus" });
    expect(born.modelSelection).toEqual(CLAUDE);
    chief.modelSelection.model = "changed";
    result.model = "changed";
    expect(signedIn.mock.calls[0]).toEqual([{ instanceId: "claude", model: "opus" }]);
    expect(born.modelSelection).toEqual(CLAUDE);
  });
  it("B5: signed-in selection drops connection and effort without Fuigo", () => {
    const { store } = world({ signedIn: () => ({ ...CLAUDE }) });
    chiefOn(store, { ...CLAUDE, connectionId: "other", effort: "high" } as typeof CLAUDE);
    expect(store.createBot({}, { seedMessages: false }).modelSelection).toEqual(CLAUDE);
  });
  it("B2/B3: a null signed-in reading preserves Fuigo, Chief and first-bot fallbacks", () => {
    const { store, state } = world({ fuigo: [fuigo()], signedIn: () => null, firstBot: CODEX });
    const chief = chiefOn(store, CLAUDE);
    expect(store.birthSelection()).toEqual({ instanceId: "fuigo", model: "grok-code" });
    state.fuigo = [];
    expect(store.birthSelection()).toEqual(chief.modelSelection);
    store.bots = [];
    expect(store.birthSelection()).toEqual(CODEX);
  });
  it("B9: an owner pick bypasses the dependency", () => {
    const signedIn = vi.fn(() => ({ ...CLAUDE }));
    const eligible = vi.fn(() => true);
    const { store } = world({ signedIn, eligible });
    expect(store.createBot({ modelSelection: CODEX }, { seedMessages: false }).modelSelection).toEqual(CODEX);
    expect(signedIn).not.toHaveBeenCalled();
    expect(eligible).not.toHaveBeenCalled();
  });
});

describe("1.0.18 ENGINE-DEFAULT eligibility", () => {
  const born = (store: Store, expected: typeof CLAUDE) => {
    const bot = store.createBot({}, { seedMessages: false });
    expect(bot.modelSelection).toEqual(expected);
    expect(bot.engineAutoPicked).toBe(true);
    expect(onDisk(bot.id)).toMatchObject({ modelSelection: expected, engineAutoPicked: true });
    return bot;
  };
  it("B7: omitted birth dependencies preserve existing selection", () => {
    born(world({ fuigo: [fuigo()] }).store, { instanceId: "fuigo", model: "grok-code" });
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database();
    const copy = world().store;
    const chief = chiefOn(copy, CLAUDE);
    expect(born(copy, CLAUDE).modelSelection).not.toBe(chief.modelSelection);
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database();
    born(world({ firstBot: CODEX }).store, CODEX);
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database();
    born(world().store, EMPTY);
  });
  it.each([CLAUDE, { instanceId: "fuigo", model: "grok-code" }])("B7b/B11: rejected Fuigo never wins with Chief %s", selection => {
    const store = world({ fuigo: [fuigo()], eligible: id => id === "claude" }).store;
    chiefOn(store, selection);
    born(store, selection.instanceId === "claude" ? CLAUDE : EMPTY);
  });
  it("B11(c/d/g): settled shadows are refused by Chief and stale probe paths", () => {
    const registry = { get: (_id: string) => null, isRetired: (_id: string) => false };
    const liveForBirth = (id: string) => { const inst = registry.get(id); return inst && !registry.isRetired(id) ? inst : null; };
    const store = world({ eligible: id => liveForBirth(id) !== null, firstBot: CLAUDE }).store;
    born(store, EMPTY);
    chiefOn(store, CLAUDE);
    born(store, EMPTY);
  });
  it("B11(e/f): the signed-in dependency owns eligibility and later Fuigo can win", () => {
    born(world({ signedIn: () => CLAUDE, eligible: () => false }).store, CLAUDE);
    born(world({ fuigo: [fuigo("one"), fuigo("two")], eligible: id => id === "two" }).store, { instanceId: "two", model: "grok-code" });
  });
  it("B8: pairing and package births use the signed-in dependency", async () => {
    const signedIn = vi.fn(() => CLAUDE);
    const store = world({ fuigo: [fuigo()], signedIn }).store;
    const paired = store.createBot({ name: "Paired", title: "Helper" }, { seedMessages: false });
    expect(paired.modelSelection).toEqual(CLAUDE);
    expect(signedIn).toHaveBeenCalled();
    signedIn.mockClear();
    const result = await importStarter(store, "birth");
    expect(signedIn).toHaveBeenCalled();
    for (const bot of result.bots) {
      expect(bot.modelSelection).toEqual(CLAUDE);
      expect(onDisk(bot.id)).toMatchObject({ modelSelection: CLAUDE, engineAutoPicked: true });
    }
  });
  it("B10/G1: birth wiring and shutdown use the r6.2 rules", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index.startsWith('import "./memory/pre-listen-enable.ts";')).toBe(true);
    expect(index.match(/commitEngineChange\(/g)).toHaveLength(6);
    expect(index.match(/reloadWithRollback\(/g)).toHaveLength(6);
    expect(index).not.toContain("await reloadProviders(");
    expect(index).toContain("unsafe: scopedReloadUnsafe");
    expect(index).toContain("retireFleet();\n  providerFleetReady = false;");
    expect(index.match(/registry.beginShutdown\(\)/g)).toHaveLength(1);
    // 2e749c0d5 (NLINT-FIX4 B3) put the outside-store flush seal first in this job, and 39096ec82 (ELD250 B6) added the onStart repair latch ahead of cleanup; the birth rule is unchanged: beginShutdown still precedes the stream close.
    expect(index).toContain("async () => { beginOutsideShutdown(); registry.beginShutdown(); streamsStopping = true; await closeAllStreams(); }");
    const uncommented = index.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(uncommented).toMatch(/const gracefulShutdown = createGracefulShutdown\(\{\s*onStart: \(\) => keepAllRepair\.stop\(\),\s*cleanup: \[\s*async \(\) => \{ beginOutsideShutdown\(\); registry\.beginShutdown\(\); streamsStopping = true; await closeAllStreams\(\); \}/);
    // These five routes must enter reload in the same synchronous interval as their commit.
    // Names, modes and saves are pinned per caller, not just counted across the file.
    const immediateRoutes = [
      ['[id], "fleet", () => saveConfig({ instances: candidate.config.instances })', "result"],
      ['[target], "fleet", () => { receipt = replaceClaudeAccountInstances(next); }', "result"],
      ['newInstances.map(item => item.instanceId), "scoped", () => saveConfig({ instances: next.instances })', "result"],
      ['sameCli, "scoped", () => {}', "outcome"],
      ['[instancePatch[1]], "scoped", () => saveConfig({ instances: result.config.instances })', "outcome"],
    ];
    const compact = index.replace(/\s+/g, " ");
    for (const [args, result] of immediateRoutes) {
      expect(compact, args).toContain(`const change = commitEngineChange(engineChangeHost, ${args}); const ${result} = await reloadWithRollback(engineChangeHost, change, scope => reloadProviders(scope)`);
    }
    // Settings intentionally has browser cleanup between commit and reload. Its fleet mark
    // must precede the first cleanup await; all three saves stay in the synchronous closure.
    expect(index).toContain('const mode = reloadKeys.length ? "fleet" : "none";');
    const settingsStart = index.indexOf('change = commitEngineChange(engineChangeHost, [], mode');
    expect(settingsStart).toBeGreaterThan(-1);
    const settingsReload = index.indexOf('await reloadWithRollback(', settingsStart);
    expect(settingsReload).toBeGreaterThan(settingsStart);
    const settingsInterval = uncommented.slice(uncommented.indexOf('change = commitEngineChange(engineChangeHost, [], mode'));
    expect(settingsInterval.slice(0, settingsInterval.indexOf('await '))).toContain('if (!reloadKeys.length) settleEngineChange(engineChangeHost);');
    expect(settingsInterval.slice(settingsInterval.indexOf('await '))).toMatch(/^await finalizeBrowserCleanupMutation\(\{/);
    expect(compact).toContain('change = commitEngineChange(engineChangeHost, [], mode, () => { if (cloudHome) saveConfig(withoutCloudCredentials(patch)); else if (externalSecretStorage) saveConfig(persisted); else saveConfig(patch); configWriteCommitted = true; syncCredentialEnv(patch); });');
    const beforeSettingsReload = settingsInterval.slice(0, settingsInterval.indexOf("await reloadWithRollback("));
    expect(beforeSettingsReload.match(/\bawait\s+\w+/g)).toEqual(["await finalizeBrowserCleanupMutation", "await releaseAllBrowserCapabilities"]);
    expect(index.slice(settingsReload)).toMatch(/^await reloadWithRollback\(engineChangeHost, change, scope => reloadProviders\(scope\)\);/);
    expect(index.slice(settingsStart, settingsReload)).toMatch(/mandatory: async \(\) => \{[\s\S]*if \(reloadKeys\.length > 0\) \{\s*try \{\s*const result = $/);
    expect(index).toContain('() => describedInstances({ catalogs: "due" })');
    expect(index).toContain('describe: options => describedInstances(options)');
    expect(index).toContain('return pickDefaultEngine(await describedInstances({ catalogs: "due" }))');
    expect(index).toContain('instances: () => describedInstances({ catalogs: "due" })');
    expect(index).toContain('ownerEnvAfterDiscovery(fresh, () => describedInstances(');
    expect(index).not.toMatch(/registry\.(describe|publishScan)\s*\(/);

    const live = index.slice(index.indexOf("const liveForBirth"), index.indexOf("const birthOnDesktop"));
    for (const text of ["registry.get(", "enabled !== false", "registry.isRetired("]) expect(live).toContain(text);
    expect(live).not.toMatch(/\bcfg\b|instanceConfigs/);
    const registry = readFileSync(new URL("./harness/registry.ts", import.meta.url), "utf8");
    for (const [start, end] of [["  async load(", "  /** Rebuild"], ["  async reload(", "  private async resolveEntry"], ["  async disposeAll(", "\n}\n"]]) {
      const offset = registry.indexOf(start);
      expect(registry.slice(offset, registry.indexOf(end, offset))).not.toMatch(/this\.(retired|terminal)|beginShutdown/);
    }
    expect(registry.match(/this\.terminal = true/g)).toHaveLength(1);
    expect(registry).toContain("settle(saved: InstanceConfigMap): void {\n    if (this.terminal) return;");
    const resolve = registry.slice(registry.indexOf("  private async resolveEntry"), registry.indexOf("  /** Holds these"));
    expect(resolve.match(/structuredClone\(entry\)/g)).toHaveLength(1);
    expect(resolve.indexOf("structuredClone(entry)")).toBeLessThan(resolve.indexOf("if ("));
    expect(resolve.match(/instanceId, builtFrom/g)).toHaveLength(4);
    const helper = readFileSync(new URL("./engine-change.ts", import.meta.url), "utf8");
    expect(helper).not.toContain("structuredClone(");
    expect(helper.match(/Object.assign\(host.cfg/g)).toHaveLength(1);
    const recovery = helper.slice(helper.indexOf("host.registry.retire(change.marked)"));
    expect(recovery.indexOf("host.registry.retire(change.marked)")).toBeLessThan(recovery.indexOf("restore()"));
    expect(recovery.slice(0, recovery.indexOf("await reload(scopeArg)"))).not.toContain("settleEngineChange(");
    const save = index.slice(index.indexOf("change = commitEngineChange(engineChangeHost, [], mode"), index.indexOf("if (!reloadKeys.length) settleEngineChange"));
    expect(save.match(/saveConfig\(/g)).toHaveLength(3);
    expect(save).not.toContain("Object.assign(cfg");
    expect(readFileSync(new URL("./birth-reading.ts", import.meta.url), "utf8")).not.toContain('from "./config.ts"');

  });
});

it.each(["fresh", "due"] as const)("BF-12: mapped unavailable account births on Fuigo on %s", async catalogs => {
  const { ProviderRegistry } = await import("./harness/registry.ts");
  const { makeFakeDriver } = await import("./testing/fake-driver.ts");
  const { mappedInstanceScan, mapClaudeAccountInstances } = await import("./mapped-instance-scan.ts");
  const { birthCandidate } = await import("./birth-reading.ts");
  const fake = makeFakeDriver({ kind: "claudeAgent" }); Object.assign(fake.driver, { install: {} });
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ named: { driver: "claudeAgent" } });
  registry.get("named")!.snapshot = async () => ({ state: "available", authenticated: true, billing: "subscription" });
  const describe = mappedInstanceScan(registry, rows => mapClaudeAccountInstances(rows, { named: { driver: "claudeAgent", config: { configDir: "relative" } } }));
  await describe({ catalogs });
  const store = world({ fuigo: [fuigo()], signedIn: source => birthCandidate({ reading: registry.scanReading(), live: id => registry.get(id), source, paidOnly: true }) }).store;
  const bot = store.createBot({}, { seedMessages: false });
  expect(bot.modelSelection.instanceId).toBe("fuigo");
  expect(onDisk(bot.id)).toMatchObject({ modelSelection: { instanceId: "fuigo" }, engineAutoPicked: true });
});
