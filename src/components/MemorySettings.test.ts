import { describe, expect, it } from "vitest";
import { folderMemoryInUse, memoryAudienceLabel, memoryListAction, memoryModeDescription } from "./MemorySettings";

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
  it.each(["off"] as const)("never claims recall is running when %s", mode => {
    expect(memoryModeDescription(mode)).toContain("Capture and recall are off.");
    expect(memoryModeDescription(mode)).not.toContain("recall are on");
  });
  it("explains that paused processing still captures sources", () => {
    expect(memoryModeDescription("paused")).toBe("Processing and recall are paused. New sources are still captured.");
  });
  it("distinguishes capture-only from active recall", () => {
    expect(memoryModeDescription("capture")).toBe("Capture is on. Recall is off.");
    expect(memoryModeDescription("active")).toBe("Capture and recall are on.");
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
