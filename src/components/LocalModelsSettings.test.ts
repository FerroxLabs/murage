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

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const models = readFileSync(join(here, "ModelsSettings.tsx"), "utf8");
const section = readFileSync(join(here, "LocalModelsSettings.tsx"), "utf8");
const picker = readFileSync(join(here, "ModelPicker.tsx"), "utf8");
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
    const heading = body.indexOf("local-models-heading");
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
