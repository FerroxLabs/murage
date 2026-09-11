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
  LOCAL_MODELS_GROUP,
  NO_LOCAL_SERVER_ROW,
  localPickerRows,
  localRowLabel,
  localToolsWarning,
  pickerModels,
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

  it("shows model then server, and does not repeat the server when the label already has it", () => {
    const [llama] = localPickerRows(rows);
    expect(localRowLabel(llama!)).toBe("qwen3.8-27b · llama.cpp on seanbeast");
    expect(localRowLabel({ ...llama!, label: "qwen3.8-27b" })).toBe("qwen3.8-27b · llama.cpp on seanbeast");
  });

  it("keeps the server on the row so two machines serving one model stay apart", () => {
    expect(localPickerRows(rows).map((row) => row.localServer)).toEqual(["llama.cpp on seanbeast", "Ollama"]);
  });

  it("marks a model whose tool test failed, and accuses an untested one of nothing", () => {
    const [llama, ollama] = localPickerRows(rows);
    expect(localToolsWarning(llama!)).toBe("");
    expect(localToolsWarning(ollama!)).toContain("Tools test failed");
    expect(localToolsWarning({ ...llama!, localTools: "partial" })).toContain("gaps");
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
