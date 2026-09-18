// The Local rail in the model picker (0.1.52 LM2, spec V3).
//
// Two things were invisible before this. A local row said only the model id, so
// two machines serving the same model were indistinguishable — you picked one
// and found out which by watching a fan spin up. And when no local server was
// running the rail vanished entirely, which is how a feature that exists in
// Murage, and in upstream, stayed unknown to everyone who did not already have
// a server on the exact loopback port Murage guessed.
import { describe, expect, it } from "vitest";

import {
  CHOOSE_ENGINE_OPTION,
  ENGINE_DISABLED_SUFFIX,
  PICKER_ZONES,
  engineFamilies,
  engineFamilyHeader,
  engineMenuFamilies,
  engineMenuKey,
  engineMenuOptions,
  orderedPickerModels,
  pickerHeadings,
  pickerZone,
  CUSTOM_MODELS_GROUP,
  LOCAL_MODELS_GROUP,
  NO_LOCAL_SERVER_ROW,
  NO_MODEL_CHOSEN,
  pickerCountLine,
  pickerEmptyState,
  pickerTriggerTitle,
  contextLabel,
  localPickerRows,
  localRowLabel,
  localRowNote,
  localToolsWarning,
  pickerModels,
  pickerConnectionsToRefresh,
  showNoLocalServerRow,
  unavailableSelectionLabel,
  type PickerEngine,
  type PickerModel,
} from "./provider-model-picker";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const pickerSource = readFileSync(fileURLToPath(new URL("../components/ModelPicker.tsx", import.meta.url)), "utf8");

function fluxConnection(): PublicProviderConnection {
  const ids=["flux-auto","flux-reasoning","flux-standard","flux-fast","flux-pinned-glm-5-3","future-vendor-choice"];
  return {id:"flux-account",preset:"flux",label:"Flux Router",enabled:true,configured:true,revision:"r1",baseUrl:"https://api.fluxrouter.ai/v1",protocol:"openai",state:"catalog-ready",
    catalog:{connectionId:"flux-account",fetchedAt:1000,stale:false,assurance:"catalog-only",models:[
      ...ids.map(id=>({connectionId:"flux-account",preset:"flux" as const,id,label:id,enabled:true,chatEligible:true,capabilities:{chat:true},outputModalities:["text"]})),
      {connectionId:"flux-account",preset:"flux",id:"future-visual-arm",label:"Visual",enabled:true,chatEligible:false,capabilities:{chat:false},outputModalities:["image"]},
    ]}};
}
it("offers the full authoritative Flux chat list on every already-supported connection engine",()=>{
  const connection=fluxConnection();
  for(const driverKind of ["claudeAgent","codex","qwenAgent","hermesAgent","fuigoAgent","grok","openai-compat"]){
    const instance:PickerEngine={instanceId:driverKind,driverKind,displayName:driverKind,snapshot:{state:"available",authenticated:false},models:{default:"native",options:[]}};
    const rows=pickerModels(instance,[connection]);
    expect(rows.map(row=>row.selection)).toEqual(connection.catalog.models.filter(model=>model.chatEligible).map(model=>({instanceId:driverKind,connectionId:connection.id,model:model.id})));
    expect(rows).toHaveLength(6);
  }
});
it("refreshes cold Flux cache on open without retrying failures or refreshing unrelated providers",()=>{
  const warm=fluxConnection(),cold={...warm,catalog:{...warm.catalog,fetchedAt:undefined,models:[]}};
  const failed={...cold,id:"failed",catalog:{...cold.catalog,error:{code:"offline" as const,message:"Unavailable"}}};
  const other={...cold,id:"other",preset:"openai" as const};
  expect(pickerConnectionsToRefresh([warm,cold,failed,other,{...cold,id:"disabled",enabled:false}],false)).toEqual([cold]);
  expect(pickerConnectionsToRefresh([warm,failed,other],true)).toEqual([warm,failed,other]);
});

function engine(options: PickerEngine["models"]["options"]): PickerEngine {
  return {
    instanceId: "pi",
    driverKind: "piAgent",
    displayName: "pi",
    snapshot: { state: "available", authenticated: true },
    models: { default: options[0]?.id ?? "", options },
  };
}

describe("a local row names its machine (spec V3)", () => {
  const rows = pickerModels(
    engine([
      { id: "srv_abcdefgh::qwen3.8-27b", label: "qwen3.8-27b · llama.cpp on seanbeast", custom: true, localServer: "llama.cpp on seanbeast" },
      { id: "ollama::qwen3.8-27b", label: "qwen3.8-27b · Ollama", custom: true, localServer: "Ollama", localTools: "failed" },
      { id: "gpt-5", label: "GPT-5" },
    ]),
    [],
  );

  it("groups every local model under the one name this feature has", () => {
    expect(localPickerRows(rows).map((row) => row.selection.model)).toEqual([
      "srv_abcdefgh::qwen3.8-27b",
      "ollama::qwen3.8-27b",
    ]);
    expect(localPickerRows(rows).every((row) => row.group === LOCAL_MODELS_GROUP)).toBe(true);
    expect(rows.find((row) => row.selection.model === "gpt-5")?.group).toBe("Engine models");
  });

  it("keeps a cloud row an engine carries as custom out of the Local rail", () => {
    // Pi lists groq models as custom rows and openai-compat ships OpenRouter
    // defaults the same way. Neither is a local model; under the Local models
    // heading they would be a lie, and they would hide the rail's own empty
    // state on exactly the engines that carry them.
    const cloudy = pickerModels(
      engine([
        { id: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B", custom: true, provider: "groq" },
        { id: "srv_abcdefgh::qwen3.8-27b", label: "qwen3.8-27b", custom: true, localServer: "llama.cpp on seanbeast" },
      ]),
      [],
    );
    expect(localPickerRows(cloudy).map((row) => row.selection.model)).toEqual(["srv_abcdefgh::qwen3.8-27b"]);
    expect(cloudy.find((row) => row.selection.model === "groq/llama-3.3-70b-versatile")?.group).toBe(CUSTOM_MODELS_GROUP);
    expect(localPickerRows(pickerModels(engine([{ id: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B", custom: true, provider: "groq" }]), []))).toEqual([]);
  });

  it("shows model then server, and does not repeat the server when the label already has it", () => {
    const [llama] = localPickerRows(rows);
    expect(localRowLabel(llama!)).toBe("qwen3.8-27b · llama.cpp on seanbeast");
    expect(localRowLabel({ ...llama!, label: "qwen3.8-27b" })).toBe("qwen3.8-27b · llama.cpp on seanbeast");
  });

  it("keeps the server on the row so two machines serving one model stay apart", () => {
    expect(localPickerRows(rows).map((row) => row.localServer)).toEqual(["llama.cpp on seanbeast", "Ollama"]);
  });

  it("says on the second line what the test found, and reads a 64K window as 64K", () => {
    const [llama, ollama] = localPickerRows(rows);
    expect(localRowNote({ ...llama!, localTools: "pass" })).toBe("Tools work");
    expect(localRowNote({ ...llama!, localTools: "partial" })).toBe("Tools work, with gaps");
    // the warning line carries a failure; the note does not say it twice
    expect(localRowNote(ollama!)).toBe("");
    expect(localRowNote(llama!)).toBe("Not tested yet");
    expect(localRowNote(rows.find((row) => row.selection.model === "gpt-5")!)).toBe("");
    // the same number the Local models card shows as "64K context loaded"
    expect(contextLabel(65_536)).toBe("64K context");
    expect(contextLabel(131_072)).toBe("128K context");
    expect(contextLabel(200_000)).toBe("200K context");
    // cloud catalogs report decimal windows (server/provider-connections context_length): never a binary K
    expect(contextLabel(128_000)).toBe("128K context");
    expect(contextLabel(163_840)).toBe("164K context");
    expect(contextLabel(256_000)).toBe("256K context");
    expect(contextLabel(32_768)).toBe("32K context");
    expect(contextLabel(0)).toBe("");
  });

  it("marks a model whose tool test failed, and accuses an untested one of nothing", () => {
    const [llama, ollama] = localPickerRows(rows);
    expect(localToolsWarning(llama!)).toBe("");
    expect(localToolsWarning(ollama!)).toContain("Tools test failed");
    expect(localToolsWarning({ ...llama!, localTools: "partial" })).toContain("gaps");
  });
});

describe("local rows on a chat-only engine", () => {
  it("lists a failed-test model as chat only instead of warning it off", () => {
    const compat: PickerEngine = {
      instanceId: "openaiCompat", driverKind: "openai-compat", displayName: "OpenAI-compatible",
      snapshot: { state: "available", authenticated: true },
      models: { default: "ollama::companion:latest", options: [
        { id: "ollama::companion:latest", label: "companion:latest · Ollama", custom: true, localServer: "Ollama", localTools: "failed" },
      ] },
    };
    const [row] = pickerModels(compat, []);
    expect(row).toMatchObject({ group: LOCAL_MODELS_GROUP, chatOnly: true, localTools: "failed" });
    expect(localToolsWarning(row!)).toContain("Chat only");
    expect(localToolsWarning(row!)).not.toContain("Tools test failed");
    // The same model on a tools engine keeps the agent-work warning.
    const [onFuigo] = pickerModels({ ...compat, instanceId: "fuigo", driverKind: "fuigoAgent" }, []);
    expect(onFuigo!.chatOnly).toBeUndefined();
    expect(localToolsWarning(onFuigo!)).toContain("Tools test failed");
  });
});

describe("a pick that outlived its server", () => {
  it("names the model and the fact on the chip, never the raw picker id", () => {
    expect(unavailableSelectionLabel("srv_abcdefgh::qwen3.8-27b")).toBe("qwen3.8-27b · local server unavailable");
    expect(unavailableSelectionLabel("ollama::qwen3.8-27b:latest")).toBe("qwen3.8-27b:latest · local server unavailable");
    expect(unavailableSelectionLabel("gpt-5")).toBe("gpt-5");
    // a cloud pick that dropped out of its catalog is not a local server: never accuse it of being one
    expect(unavailableSelectionLabel("flux::flux-auto")).toBe("flux::flux-auto");
    expect(unavailableSelectionLabel("openrouter::anthropic/claude-sonnet-4")).toBe("openrouter::anthropic/claude-sonnet-4");
    expect(unavailableSelectionLabel("lmstudio::qwen")).toBe("qwen · local server unavailable");
  });
});

describe("the rail is a state, not an absence", () => {
  it("has one row to show when this computer has no local server at all", () => {
    const cloudOnly = engine([{ id: "gpt-5", label: "GPT-5" }]);
    const rows = pickerModels(cloudOnly, []);
    expect(localPickerRows(rows)).toEqual([]);
    expect(showNoLocalServerRow(cloudOnly, rows)).toBe(true);
    // The row the picker then renders says both what is true and where to fix it.
    expect(NO_LOCAL_SERVER_ROW).toContain("No local server detected");
    expect(NO_LOCAL_SERVER_ROW).toContain("Settings → Models");
  });

  it("drops the row as soon as a tools engine carries a local row", () => {
    const withServer = engine([
      { id: "gpt-5", label: "GPT-5" },
      { id: "srv_abcdefgh::qwen3.8-27b", label: "qwen3.8-27b", custom: true, localServer: "llama.cpp on seanbeast", localTools: "pass" },
    ]);
    expect(showNoLocalServerRow(withServer, pickerModels(withServer, []))).toBe(false);
  });

  it("never claims 'no local server' on a chat-only engine (openai-compat, grok)", () => {
    // These drivers are not local engines (grok never merges the Local models
    // inject; openai-compat lists it only as chat-only extras), so the row
    // would be a false nudge. Their Engines line already says "chat only
    // (no tools)"; the rail stays quiet.
    for (const driverKind of ["openai-compat", "grok"]) {
      const chatOnly: PickerEngine = {
        ...engine([{ id: "qwen3.8-27b", label: "qwen3.8-27b", custom: true }]),
        instanceId: driverKind,
        driverKind,
      };
      const rows = pickerModels(chatOnly, []);
      expect(rows.map((row) => row.group)).toEqual([CUSTOM_MODELS_GROUP]);
      expect(localPickerRows(rows)).toEqual([]);
      expect(showNoLocalServerRow(chatOnly, rows)).toBe(false);
    }
  });

  it("has no rail at all on an engine that cannot use a local server, or before the engine loads", () => {
    const gemini: PickerEngine = { ...engine([{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]), instanceId: "gemini", driverKind: "gemini" };
    expect(showNoLocalServerRow(gemini, pickerModels(gemini, []))).toBe(false);
    expect(showNoLocalServerRow(null, [])).toBe(false);
    expect(showNoLocalServerRow(undefined, [])).toBe(false);
  });
});

// ── The first-run picker ────────────────────────────────────────────────────
// A brand-new profile has no selection at all: server/index.ts defaultSelection
// deliberately returns {instanceId:"",model:""} rather than pinning a bot to an
// engine that cannot answer. Every one of these read as a fault report before:
// "0 compatible chat models", a blank engine box, and a chip that said
// "Unavailable engine · " with nothing after the separator.
describe("the picker with nothing configured", () => {
  it("never leaves a dangling separator in the chip tooltip", () => {
    expect(unavailableSelectionLabel("")).toBe(NO_MODEL_CHOSEN);
    expect(unavailableSelectionLabel("   ")).toBe(NO_MODEL_CHOSEN);
    const title = pickerTriggerTitle(undefined, unavailableSelectionLabel(""), undefined);
    expect(title).not.toMatch(/·\s*$/);
    expect(title).not.toContain("Unavailable engine");
    expect(title).toBe("No model chosen yet — open this to pick one");
  });

  it("still names a genuinely unavailable engine, and still joins cleanly", () => {
    expect(pickerTriggerTitle(undefined, "gpt-5.6-sol", undefined)).toBe("Unavailable engine · gpt-5.6-sol");
    expect(pickerTriggerTitle("Claude", "Claude Sonnet 5", "My key")).toBe("Claude · Claude Sonnet 5 · My key");
    expect(pickerTriggerTitle("Claude", "Claude Sonnet 5", undefined)).toBe("Claude · Claude Sonnet 5");
  });

  it("counts models only once there is an engine to count them for", () => {
    expect(pickerCountLine(false, 0)).toBe("Pick an engine above to see the models it can run");
    expect(pickerCountLine(false, 0)).not.toMatch(/^0 /);
    expect(pickerCountLine(true, 0)).toBe("No models to choose here yet");
    expect(pickerCountLine(true, 1)).toBe("1 compatible chat model · prices per million tokens");
    expect(pickerCountLine(true, 7)).toBe("7 compatible chat models · prices per million tokens");
  });

  it("offers the engine select a row that says what it wants", () => {
    expect(CHOOSE_ENGINE_OPTION).toBe("Choose an engine");
  });

  it("answers the empty list with both next steps, including the local one", () => {
    const empty = pickerEmptyState(false, false);
    expect(empty).not.toBeNull();
    expect(empty!.title).toBe("No engine set up yet");
    expect(empty!.action).toBeTruthy();
    // showNoLocalServerRow needs an engine to be truthful, so it goes quiet
    // here; this is the only thing left that can mention a local model.
    expect(empty!.localAction).toBeTruthy();
    expect(showNoLocalServerRow(undefined, [])).toBe(false);
    // plain words only: no jargon, no config file, no terminal
    for (const copy of [empty!.title, empty!.body, empty!.action, empty!.localAction]) {
      expect(copy).not.toMatch(/config\.json|terminal|CLI|npm |install -g|~\//i);
    }
  });

  it("stands aside once an engine is chosen, or while the user is searching", () => {
    expect(pickerEmptyState(true, false)).toBeNull();
    expect(pickerEmptyState(false, true)).toBeNull();
  });
});

// ── The Engine control ────────────────────────────────────────────────────
// It used to be a native <select> whose every family was an <optgroup
// label={primary.displayName}> around options carrying that same displayName.
// One connection per driver is the normal case, so the list read
// "Claude / Claude / Codex / Codex …" — a header repeating its only row
// (Sean's screenshot, 2026-09-18).
function fleetEngine(instanceId: string, driverKind: string, displayName: string, enabled = true): PickerEngine {
  return { instanceId, driverKind, displayName, enabled, snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] } };
}

describe("engineMenuFamilies", () => {
  it("gives a family of one no header, so its name is printed once", () => {
    const families = engineMenuFamilies([fleetEngine("claude", "claudeAgent", "Claude"), fleetEngine("codex", "codex", "Codex")]);
    expect(families.map(f => f.header)).toEqual(["", ""]);
    expect(families.flatMap(f => f.options.map(o => o.label))).toEqual(["Claude", "Codex"]);
    // The whole drawn text of the list, headers included: each name once.
    expect(families.flatMap(f => (f.header ? [f.header] : []).concat(f.options.map(o => o.label)))).toEqual(["Claude", "Codex"]);
  });

  it("keeps the header for a family that groups more than one connection, where it is the only thing telling them apart", () => {
    const families = engineMenuFamilies([
      fleetEngine("claude", "claudeAgent", "Claude"),
      fleetEngine("claude-work", "claudeAgent", "Claude · work account"),
      fleetEngine("codex", "codex", "Codex"),
    ]);
    expect(families[0]!.header).toBe("Claude");
    expect(families[0]!.options.map(o => o.label)).toEqual(["Claude", "Claude · work account"]);
    expect(families[1]!.header).toBe("");
  });

  it("keeps the disabled suffix on the row itself, where the old <option> carried it", () => {
    const [family] = engineMenuFamilies([fleetEngine("codex", "codex", "Codex", false)]);
    expect(ENGINE_DISABLED_SUFFIX).toBe(" · Disabled");
    expect(family!.options[0]!.label).toBe("Codex · Disabled");
    expect(family!.options[0]!.disabled).toBe(true);
  });

  it("flattens to the selectable rows only, so arrow keys never land on a header", () => {
    const instances = [fleetEngine("claude", "claudeAgent", "Claude"), fleetEngine("claude-work", "claudeAgent", "Claude · work"), fleetEngine("codex", "codex", "Codex")];
    expect(engineMenuOptions(instances).map(o => o.instance.instanceId)).toEqual(["claude", "claude-work", "codex"]);
  });
});

describe("engineFamilyHeader", () => {
  // One rule, two surfaces: the model picker's engine list and Settings →
  // Engines. Both used to draw a header that repeated its only row.
  const claude = fleetEngine("claude", "claudeAgent", "Claude");

  it("is empty for a family of one, because the header would repeat the row", () => {
    expect(engineFamilyHeader(claude, [claude])).toBe("");
  });

  it("is the family's name once it groups more than one connection", () => {
    const work = fleetEngine("claude-work", "claudeAgent", "Claude work");
    expect(engineFamilyHeader(claude, [claude, work])).toBe("Claude");
  });

  it("is the rule engineMenuFamilies itself uses, so the two surfaces cannot drift", () => {
    const work = fleetEngine("claude-work", "claudeAgent", "Claude work"), codex = fleetEngine("codex", "codex", "Codex");
    for (const family of engineFamilies([claude, work, codex])) {
      const menu = engineMenuFamilies([claude, work, codex]).find(f => f.key === family.primary.driverKind)!;
      expect(menu.header).toBe(engineFamilyHeader(family.primary, family.members));
    }
  });
});

describe("engineMenuKey", () => {
  const shut = { open: false, index: 0, count: 3 }, listing = { open: true, index: 0, count: 3 };

  it("opens on the keys a <select> opened on, landing on the current choice", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) expect(engineMenuKey(key, { ...shut, index: 2 })).toEqual({ type: "open", index: 2 });
    expect(engineMenuKey("Home", shut)).toEqual({ type: "open", index: 0 });
    expect(engineMenuKey("End", shut)).toEqual({ type: "open", index: 2 });
  });

  it("wraps on the arrows, the way the model rows below this control wrap", () => {
    expect(engineMenuKey("ArrowDown", listing)).toEqual({ type: "move", index: 1 });
    expect(engineMenuKey("ArrowUp", listing)).toEqual({ type: "move", index: 2 });
    expect(engineMenuKey("ArrowDown", { ...listing, index: 2 })).toEqual({ type: "move", index: 0 });
    expect(engineMenuKey("Home", { ...listing, index: 2 })).toEqual({ type: "move", index: 0 });
    expect(engineMenuKey("End", listing)).toEqual({ type: "move", index: 2 });
  });

  it("chooses on Enter or Space and closes on Escape or Tab", () => {
    expect(engineMenuKey("Enter", { ...listing, index: 1 })).toEqual({ type: "select", index: 1 });
    expect(engineMenuKey(" ", { ...listing, index: 1 })).toEqual({ type: "select", index: 1 });
    expect(engineMenuKey("Escape", listing)).toEqual({ type: "close" });
    expect(engineMenuKey("Tab", listing)).toEqual({ type: "close" });
  });

  it("leaves every other key, and a closed control's Escape, to the menu around it", () => {
    expect(engineMenuKey("a", listing)).toEqual({ type: "none" });
    expect(engineMenuKey("Escape", shut)).toEqual({ type: "none" });
    expect(engineMenuKey("ArrowDown", { open: false, index: 0, count: 0 })).toEqual({ type: "none" });
  });
});

// ── Zones and ranks, as a pair ────────────────────────────────────────────
// orderedPickerModels decides the ORDER; pickerZone decides the HEADING over
// each run. They are two ladders describing one partition, so a rank with no
// zone of its own does not fail loudly — its rows quietly fall through to
// row.group, and a later rank carrying that same group prints the heading a
// SECOND time with another heading in between. That is a name drawn twice,
// which is the defect this lane exists to fix, arriving from the ordering side.
const modelRow = (model: string, label: string, group: string, provider = "Fuigo"): PickerModel =>
  ({ key: JSON.stringify(["e", null, model]), selection: { instanceId: "e", model }, label, group, provider } as PickerModel);

describe("pickerZone", () => {
  const rows = { auto: modelRow("flux-auto", "Flux Auto", "Engine models"), star: modelRow("gpt-5", "GPT-5", "Engine models"), last: modelRow("claude-sonnet-5", "Claude Sonnet 5", "Engine models"), plain: modelRow("kimi-k2", "Kimi K2", "Engine models") };

  it("draws the zones the picker has always drawn, in the same precedence", () => {
    const favorites = [rows.star.key], recent = [rows.last.key];
    expect(pickerZone(rows.auto, favorites, recent)).toBe("Flux Auto");
    expect(pickerZone(rows.star, favorites, recent)).toBe("Favorites");
    expect(pickerZone(rows.last, favorites, recent)).toBe("Recent");
    expect(pickerZone(rows.plain, favorites, recent)).toBe("Engine models");
  });

  it("prefers Flux Auto over a star, and a star over a recent, as the order does", () => {
    expect(pickerZone(rows.auto, [rows.auto.key], [rows.auto.key])).toBe("Flux Auto");
    expect(pickerZone(rows.star, [rows.star.key], [rows.star.key])).toBe("Favorites");
  });

  it("falls back to the row's own group when no zone claims it", () => {
    expect(pickerZone(modelRow("m", "M", "Flux Router"), [], [])).toBe("Flux Router");
    expect(PICKER_ZONES.map(zone => zone.name)).toEqual(["Flux Auto", "Favorites", "Recent"]);
  });
});

describe("the picker's headings never repeat", () => {
  // Deliberately rank-agnostic: it names no rank and no constant. It drives
  // WHATEVER ladder orderedPickerModels currently has through WHATEVER ladder
  // pickerZone currently has, over a fleet that puts Flux routes, a star, a
  // recent and ordinary models in one group. If the two ladders ever stop
  // describing the same partition, a heading repeats and this fails.
  const fleet = [
    modelRow("flux-auto", "Flux Auto", "Engine models"),
    modelRow("flux-fast", "Flux Fast", "Engine models"),
    modelRow("flux-reasoning", "Flux Reasoning", "Engine models"),
    modelRow("gpt-5", "GPT-5", "Engine models"),
    modelRow("kimi-k2", "Kimi K2", "Engine models"),
    modelRow("claude-sonnet-5", "Claude Sonnet 5", "Engine models"),
    modelRow("gemini-3-pro", "Gemini 3 Pro", "Flux Router", "flux"),
  ];
  const favorites = [modelRow("gpt-5", "", "").key], recent = [modelRow("claude-sonnet-5", "", "").key];

  it("gives every rank a zone of its own, so no heading is drawn twice", () => {
    const headings = pickerHeadings(orderedPickerModels(fleet, "", favorites, recent), favorites, recent);
    expect(headings).toEqual([...new Set(headings)]);
  });

  it("still draws a heading for each run, not one heading for the whole list", () => {
    const headings = pickerHeadings(orderedPickerModels(fleet, "", favorites, recent), favorites, recent);
    expect(headings.length).toBeGreaterThan(1);
    expect(headings[0]).toBe("Flux Auto");
    expect(headings).toContain("Favorites");
    expect(headings).toContain("Recent");
  });

  it("reports a heading drawn twice instead of hiding it — the guard above is only as honest as this fold", () => {
    // Hand-ordered so one group is split by another zone. A fold that
    // de-duplicated (rather than only collapsing consecutive runs) would make
    // the no-repeat assertion above vacuously true, so it is pinned here.
    const first = modelRow("a", "A", "Engine models"), starred = modelRow("b", "B", "Engine models"), later = modelRow("c", "C", "Engine models");
    expect(pickerHeadings([first, starred, later], [starred.key], [])).toEqual(["Engine models", "Favorites", "Engine models"]);
    // And a run really is collapsed: two adjacent rows of one zone, one heading.
    expect(pickerHeadings([first, later], [], [])).toEqual(["Engine models"]);
  });

  it("is the same fold the picker itself runs", () => {
    expect(pickerSource).toContain("const zone=pickerZone(row,prefs.favorites,prefs.recent);const heading=zone!==previousGroup;previousGroup=zone;");
  });
});
