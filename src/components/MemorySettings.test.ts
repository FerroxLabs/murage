import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { folderMemoryInUse, memoryAudienceLabel, memoryListAction, memoryModeDescription, recordAudienceLabel, unnamedScopeIds } from "./MemorySettings";
import { initialContext } from "../../shared/upgrade-machine.mjs";

describe("owner memory audience requests", () => {
  it("retains the bot boundary through search, audience changes and pagination", () => {
    expect(memoryListAction(" backups ", "room-scope", "candidate", "bot-one", "next")).toEqual({
      action: "list", query: "backups", scopeId: "room-scope", state: "candidate", botId: "bot-one", cursor: "next",
    });
    expect(memoryListAction("", "", "", "bot-one")).toEqual({ action: "list", botId: "bot-one" });
  });
  it("uses all owner audiences only from the workspace surface", () => {
    expect(memoryListAction("", "", "")).toEqual({ action: "list" });
  });
  it("carries view and cursor without dropping the selected bot", () => {
    expect(memoryListAction("", "", "", "bot-one", "page-two", "important")).toEqual({action:"list",botId:"bot-one",cursor:"page-two",view:"important"});
  });
});

describe("compact memory state", () => {
  const none = initialContext("app");
  it.each(["off"] as const)("never claims recall is running when %s", mode => {
    expect(memoryModeDescription(none, { mode })).toContain("Capture and recall are off.");
    expect(memoryModeDescription(none, { mode })).not.toContain("recall are on");
  });
  it("UX-01 / r2-1: a hold overrides a cached active status; unknown health never promises capture; an ordinary pause says so only when capture is on", () => {
    const held = "Earlier memory is set aside for now. Your chats work as usual. New things are not added to memory while it is set aside.";
    expect(memoryModeDescription(none, { mode: "active", held: true, capture: "off", recall: "off" })).toBe(held);
    expect(memoryModeDescription(none, { mode: "paused", storedMode: "active", held: true })).toBe(held);
    expect(memoryModeDescription(none, { mode: "paused" })).toBe("Memory is paused. Your chats work as usual.");
    expect(memoryModeDescription(none, { mode: "paused", held: false, capture: "on", recall: "off" })).toBe("Memory is paused. Your chats work as usual, and new things are still noted.");
    expect(memoryModeDescription(none, { mode: "active" })).toBe("Memory is on.");
  });
  it("distinguishes capture-only from active recall", () => {
    expect(memoryModeDescription(none, { mode: "capture", held: false, capture: "on", recall: "off" })).toBe("Capture is on. Recall is off.");
    expect(memoryModeDescription(none, { mode: "active", held: false, capture: "on", recall: "on" })).toBe("Capture and recall are on.");
  });
});

describe("folder memory is never called a project (PM5)", () => {
  it("labels a folder audience as folder memory and offers it only where it is used", () => {
    expect(memoryAudienceLabel({ kind: "project", label: "/Users/alex/closedesk" })).toBe("Folder memory: /Users/alex/closedesk");
    expect(memoryAudienceLabel({ kind: "room", label: "Tallyroo Launch" })).toBe("Tallyroo Launch");
    expect(folderMemoryInUse([{ kind: "room" }, { kind: "bot" }])).toBe(false);
    expect(folderMemoryInUse([{ kind: "project" }])).toBe(true);
  });
});

describe("a record in a conversation the status left out", () => {
  const held = [{ id: "bot-1", label: "Ada" }];
  it("asks for the scopes it cannot name, once", () => {
    expect(unnamedScopeIds(["bot-1", "conv-9", "conv-9", "conv-10"], held, new Set(["conv-10"]))).toEqual(["conv-9"]);
    expect(unnamedScopeIds(["bot-1"], held, new Set())).toEqual([]);
  });
  it("shows the fetched name, never a generic conversation label", () => {
    const withFetched = [...held, { id: "conv-9", label: "Quarterly plan" }];
    expect(recordAudienceLabel("conv-9", withFetched, true)).toBe("Quarterly plan");
    expect(recordAudienceLabel("conv-9", held, false)).toBe("Loading audience");
    expect(recordAudienceLabel("conv-9", held, true)).toBe("Unavailable audience");
    for (const settled of [true, false]) expect(recordAudienceLabel("conv-9", held, settled)).not.toBe("A conversation");
  });
  it("the settings screen no longer prints the generic label", () => {
    const source = readFileSync(new URL("./MemorySettings.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/\? "A conversation"/);
    expect(source).toContain('action: "scope-labels"');
  });
});
