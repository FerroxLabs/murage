import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HighLevelMovedNotice, fetchHighLevelMovedLine } from "./HighLevelMovedNotice";

const LINE = "HighLevel now connects through Connected apps (Composio) or your own MCP server.";

describe("the one HighLevel moved line", () => {
  it("asks the one route and shows its line as given", async () => {
    const asked: string[] = [];
    expect(await fetchHighLevelMovedLine(async (path) => { asked.push(path); return { line: LINE }; })).toBe(LINE);
    expect(asked).toEqual(["/api/notices/highlevel-moved"]);
  });

  it("shows nothing for null, an odd answer or a failure", async () => {
    expect(await fetchHighLevelMovedLine(async () => ({ line: null }))).toBeNull();
    expect(await fetchHighLevelMovedLine(async () => ({ line: "  " }))).toBeNull();
    expect(await fetchHighLevelMovedLine(async () => ({ line: 3 }))).toBeNull();
    expect(await fetchHighLevelMovedLine(async () => null)).toBeNull();
    expect(await fetchHighLevelMovedLine(async () => { throw new Error("offline"); })).toBeNull();
  });

  it("draws nothing before an answer, and never asks when not ready", () => {
    let calls = 0;
    expect(renderToStaticMarkup(createElement(HighLevelMovedNotice, { ready: false, request: async () => { calls++; return { line: LINE }; } }))).toBe("");
    expect(calls).toBe(0);
  });
});
