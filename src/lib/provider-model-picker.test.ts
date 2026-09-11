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
  CUSTOM_MODELS_GROUP,
  LOCAL_MODELS_GROUP,
  NO_LOCAL_SERVER_ROW,
  contextLabel,
  localPickerRows,
  localRowLabel,
  localRowNote,
  localToolsWarning,
  pickerModels,
  unavailableSelectionLabel,
  type PickerEngine,
} from "./provider-model-picker";

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
    expect(contextLabel(0)).toBe("");
  });

  it("marks a model whose tool test failed, and accuses an untested one of nothing", () => {
    const [llama, ollama] = localPickerRows(rows);
    expect(localToolsWarning(llama!)).toBe("");
    expect(localToolsWarning(ollama!)).toContain("Tools test failed");
    expect(localToolsWarning({ ...llama!, localTools: "partial" })).toContain("gaps");
  });
});

describe("a pick that outlived its server", () => {
  it("names the model and the fact on the chip, never the raw picker id", () => {
    expect(unavailableSelectionLabel("srv_abcdefgh::qwen3.8-27b")).toBe("qwen3.8-27b · local server unavailable");
    expect(unavailableSelectionLabel("ollama::qwen3.8-27b:latest")).toBe("qwen3.8-27b:latest · local server unavailable");
    expect(unavailableSelectionLabel("gpt-5")).toBe("gpt-5");
  });
});

describe("the rail is a state, not an absence", () => {
  it("has one row to show when this computer has no local server at all", () => {
    const rows = pickerModels(engine([{ id: "gpt-5", label: "GPT-5" }]), []);
    expect(localPickerRows(rows)).toEqual([]);
    // The row the picker then renders says both what is true and where to fix it.
    expect(NO_LOCAL_SERVER_ROW).toContain("No local server detected");
    expect(NO_LOCAL_SERVER_ROW).toContain("Settings → Models");
  });
});
