// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 J1: shows who; no secrets; Set back absent when the value moved on; a "Murage" actor row; Set back on a
// model leaves the cleared app choices cleared.
import { describe, expect, it } from "vitest";
import { changedRecentlyView, setBackFor, shownValue, whoChanged, type ChangedRecentlyRow } from "./changed-recently";

const row = (over: Partial<ChangedRecentlyRow> = {}): ChangedRecentlyRow => ({
  changeId: "c1", actor: { kind: "owner" }, writer: "w", settingId: "bot.model.pick", bot: "dax", before: "small", after: "large", at: 100, shape: "field", ...over,
});
const ctx = (current: unknown) => ({ botName: (id: string) => (id === "dax" ? "Dax" : null), current: () => current });

describe("Changed recently (J1)", () => {
  it("shows who changed it, including Murage and another program", () => {
    expect(whoChanged({ kind: "owner" }, () => null)).toBe("You");
    expect(whoChanged({ kind: "bot", botId: "dax" }, () => "Dax")).toBe("Dax");
    expect(whoChanged({ kind: "bot", botId: "x" }, () => null)).toBe("A bot");
    expect(whoChanged({ kind: "murage" }, () => null)).toBe("Murage");
    expect(whoChanged({ kind: "otherProgram" }, () => null)).toBe("Another program");
  });
  it("never shows a secret value", () => {
    expect(shownValue("providers.api-key", "sk-live-123")).toBeNull();
    expect(shownValue("bot.email.note", "my password is x")).toBeNull();
    expect(shownValue("general.name", "Sam")).toBe("Sam");
    expect(shownValue("general.sound", true)).toBe("On");
    expect(shownValue("general.blob", { a: 1 })).toBeNull();
    const [view] = changedRecentlyView([row({ settingId: "providers.token", before: "aaa", after: "bbb" })], ctx("bbb"));
    expect(view.was).toBeNull();
    expect(view.now).toBeNull();
    expect(view.setBack.available).toBe(false);
  });
  it("offers Set back only while the value is still the one it wrote", () => {
    expect(setBackFor(row(), "large").available).toBe(true);
    expect(setBackFor(row(), "medium").available).toBe(false);
  });
  it("never offers Set back for No limits, a removal or a form", () => {
    for (const shape of ["noLimits", "removal", "form"] as const) expect(setBackFor(row({ shape }), "large").available, shape).toBe(false);
  });
  it("a Murage row carries its reason and that app choices cleared", () => {
    const [view] = changedRecentlyView([row({ actor: { kind: "murage" }, reason: "The model was retired", clearedAppChoices: true })], ctx("large"));
    expect(view.who).toBe("Murage");
    expect(view.note).toBe("The model was retired. App choices cleared");
  });
  it("Set back on a model says the cleared app choices do not come back", () => {
    const says = setBackFor(row({ valueKind: "model", clearedAppChoices: true }), "large").says;
    expect(says).toContain("changes the model again");
    expect(says).toContain("do not come back");
  });
  it("hides a flagged secret and refuses Set back to or from No limits or with no shape", () => {
    const [v] = changedRecentlyView([row({ settingId: "voice.elevenlabsKey", secret: true, before: "el_1", after: "el_2" })], ctx("el_2"));
    expect(v.was).toBeNull();
    expect(v.now).toBeNull();
    expect(setBackFor(row({ before: "noLimits", after: "ask" }), "ask").available).toBe(false);
    expect(setBackFor(row({ shape: undefined }), "large").available).toBe(false);
  });
  it("lists newest first and caps the list", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ changeId: `c${i}`, at: i }));
    const view = changedRecentlyView(rows, ctx("large"));
    expect(view).toHaveLength(20);
    expect(view[0].changeId).toBe("c29");
  });
});
