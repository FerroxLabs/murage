import { describe, expect, it } from "vitest";
import { memoryListAction } from "./MemorySettings";

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
