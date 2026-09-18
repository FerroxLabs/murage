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
} from "./provider-model-picker";
import type { PublicProviderConnection } from "../../shared/provider-connections";

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
