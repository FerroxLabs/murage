// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 U33 r2 (Grok H2): the notebook editor saves only against a revision it loaded. Before, Save stayed on after a failed load and the
// editor sent no revision while none was loaded, so a save could replace the whole notebook blind.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { notebookCanSave, notebookSaveBody } from "./notebook-save";

const source = readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const memoryCard = source.slice(source.indexOf("function MemoryCard("), source.indexOf("const openTopic", source.indexOf("function MemoryCard(")));

describe("U33 r2: the notebook Save waits for a loaded revision", () => {
  it("Save is off until a revision has loaded, and on for an edit once it has", () => {
    expect(notebookCanSave({ saving: false, dirty: true, revision: undefined })).toBe(false);
    expect(notebookCanSave({ saving: false, dirty: true, revision: "" })).toBe(false);
    expect(notebookCanSave({ saving: false, dirty: true, revision: "0123456789abcdef0123456789abcdef" })).toBe(true);
    expect(notebookCanSave({ saving: true, dirty: true, revision: "none" })).toBe(false);
    expect(notebookCanSave({ saving: false, dirty: false, revision: "none" })).toBe(false);
  });

  it("every save carries the revision it was edited from", () => {
    expect(notebookSaveBody("- note\n", "none")).toEqual({ text: "- note\n", baseRevision: "none" });
  });

  it("a load clears the revision before it asks, so a failed load leaves Save off; the button and save() both use the gate", () => {
    const load = memoryCard.slice(memoryCard.indexOf("const load = async"), memoryCard.indexOf("const save = async"));
    expect(load.indexOf("setRevision(undefined)")).toBeGreaterThan(-1);
    expect(load.indexOf("setRevision(undefined)")).toBeLessThan(load.indexOf("await api("));
    // the failure path never sets a revision
    expect(load.slice(load.indexOf("catch (e)"))).not.toContain("setRevision(");
    const save = memoryCard.slice(memoryCard.indexOf("const save = async"));
    expect(save).toContain("if (revision === undefined) return;");
    expect(save).toContain("JSON.stringify(notebookSaveBody(text, revision))");
    expect(source).toContain("disabled={!notebookCanSave({ saving, dirty, revision })}");
  });
});
