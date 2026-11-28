// @vitest-environment jsdom
// Where the Local models section is allowed to be, and what it is never
// allowed to do.
//
// The defect this section exists to fix is structural, not cosmetic: the
// feature was rendered only when something happened to answer, so it could not
// be found by anyone who did not already have it working. A conditional render
// would reintroduce exactly that, and a conditional render is invisible to a
// screenshot of a machine that does have a server running — which is the only
// machine a developer tends to look at. So the condition is asserted on the
// source, the way SettingsSurface.test.ts asserts its panes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LocalServerView } from "../../shared/local-models";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { ServerCard } from "./LocalModelsSettings";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../state/store", async (original) => ({ ...(await original<typeof import("../state/store")>()), api: fixture.api }));

const here = dirname(fileURLToPath(import.meta.url));
const models = readFileSync(join(here, "ModelsSettings.tsx"), "utf8");
const section = readFileSync(join(here, "LocalModelsSettings.tsx"), "utf8");
// The chip and its lazy dialog (1.0.19 slice P) are one picker: read both.
const picker = ["ModelPicker.tsx", "ModelPickerDialog.tsx"].map((file) => readFileSync(join(here, file), "utf8")).join("\n");
const engines = readFileSync(join(here, "EnginesSettings.tsx"), "utf8");
const setup = readFileSync(join(here, "EngineSetup.tsx"), "utf8");

describe("the section is permanent (spec V1)", () => {
  it("is mounted unconditionally inside Models settings", () => {
    expect(models).toContain("<LocalModelsSettings />");
    // no `&&`, no ternary, no `snapshot?.` guard in front of it
    expect(models).not.toMatch(/[&?][^\n]*<LocalModelsSettings/);
  });

  it("renders its heading and its Add a server action outside every data branch", () => {
    const body = section.slice(section.indexOf("export function LocalModelsSettings"));
    const heading = body.indexOf("local-models-title");
    const add = body.indexOf("Add a server");
    expect(heading).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(-1);
    // Both sit in the component's single returned <section>, which has no
    // guard of its own: the only guarded blocks are the states inside it.
    expect(body).toContain('<section ref={root} id="local-models"');
    for (const marker of ["servers.length === 0", "loading && !snapshot"]) {
      expect(body.indexOf(marker), marker).toBeGreaterThan(heading);
    }
  });

  it("keeps the empty state pointing at the addresses that were checked", () => {
    expect(section).toContain("lookedLine(snapshot.looked)");
    expect(section).toContain("No model server is running on this computer.");
  });
});

describe("one name, one place (spec UX rule)", () => {
  it("uses the shared title everywhere rather than a second spelling", () => {
    for (const source of [section, engines, setup]) {
      expect(source).toContain("LOCAL_MODELS_TITLE");
    }
    expect(picker).toContain("LOCAL_MODELS_GROUP");
  });

  it("puts no protocol jargon in the section's own copy", () => {
    // Addresses the user types are fine; the words below are ours, not theirs.
    const copy = section.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const banned of ["OpenAI-compatible", "openai-compat", "inject", "oMLX"]) {
      expect(copy, banned).not.toContain(banned);
    }
  });

  it("routes the picker's empty rail and the engine rows to the same section", () => {
    expect(picker).toContain("OPEN_LOCAL_MODELS_EVENT");
    expect(engines).toContain("OPEN_LOCAL_MODELS_EVENT");
    expect(setup).toContain("OPEN_LOCAL_MODELS_EVENT");
    expect(section).toContain("window.addEventListener(OPEN_LOCAL_MODELS_EVENT, open)");
  });
});

describe("no dead ends", () => {
  it("gives every card its next action from the one mapping the tests cover", () => {
    expect(section).toContain("nextActionFor(server, model)");
    // and never hand-rolls a second label next to it
    expect(section.match(/nextActionFor\(/g)).toHaveLength(1);
  });

  it("offers edit and remove only for a server the user can actually change", () => {
    expect(section).toContain("{server.editable && <>");
    expect(section).toContain("{!server.editable &&");
  });

  it("says what removing a server does before it happens", () => {
    expect(section).toContain("The engine entries Murage wrote for it are removed too.");
  });
});

describe("a key is only ever a key", () => {
  it("never renders a saved key back to the screen", () => {
    // The add and edit inputs are write-only: `value={apiKey}` is local state
    // that starts empty, and the server view carries only `hasKey`.
    expect(section).not.toMatch(/value=\{server\.apiKey/);
    expect(section).toContain("server.hasKey");
    expect(section).toMatch(/type="password"/);
  });
});

// M10 (1.0.23) P4/P3: the real card for an Ollama cloud model, rendered and clicked.
describe("M10 Ollama cloud model card", () => {
  let restore: () => void;
  beforeAll(() => { restore = installDOMHarness(); });
  afterAll(() => restore());
  afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); fixture.api.mockReset(); });

  const SENTENCE = "This model runs on ollama.com at its own context, so it needs no copy.";
  const ollama = (cloud: boolean): LocalServerView => ({
    id: "srv_fixture01", name: "desktop", label: "Ollama on desktop", kind: "ollama", address: "http://127.0.0.1:11434/v1",
    source: "added", editable: true, hasKey: false, status: "running", checkedAt: 1,
    models: [{
      id: "srv_fixture01::fixture-model:big", model: "fixture-model:big", loaded: false, engines: [], ...(cloud ? { cloud: true as const } : {}),
      // A card rendered before Murage knew the alias was cloud still offers the copy.
      test: { serverId: "srv_fixture01", apiBase: "http://127.0.0.1:11434/v1", model: "fixture-model:big", outcome: "context-too-small", checks: [],
        surfaces: { chat: false, responses: false, messages: false }, context: { contextWindow: 4_096, source: "ollama-ps", loaded: true }, testedAt: 1, durationMs: 1 },
    }],
  });
  const card = (server: LocalServerView, onChanged = vi.fn()) => mount(h(ServerCard, { server, now: 1, onChanged, onTested: vi.fn() }));

  it("W8b shows Runs on ollama.com under a cloud model's name, and not under a local one", async () => {
    card(ollama(true));
    await settle();
    const lines = [...document.querySelectorAll("[data-local-model-id] p")].map((p) => p.textContent);
    expect(lines).toContain("Runs on ollama.com"); // W8b-line
    cleanup(); await settle(); document.body.replaceChildren();
    card(ollama(false));
    await settle();
    expect([...document.querySelectorAll("[data-local-model-id] p")].map((p) => p.textContent)).not.toContain("Runs on ollama.com");
  });

  it("W8b a stale copy offer refused as cloud-model shows the server's sentence and refreshes once", async () => {
    fixture.api.mockRejectedValue(Object.assign(new Error("400"), { status: 400, body: { error: SENTENCE, code: "cloud-model" } }));
    const onChanged = vi.fn();
    card(ollama(false), onChanged);
    await settle();
    const offer = [...document.querySelectorAll("button")].find((b) => b.textContent === "Create a 64K copy")!;
    await act(async () => { offer.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle(); await settle();
    expect(onChanged).toHaveBeenCalledTimes(1); // W8b-refresh
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(SENTENCE);
  });
});
