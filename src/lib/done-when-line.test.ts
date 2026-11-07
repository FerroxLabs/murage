// U4 S3: the done-when line under a hand-off row paints only a bounded line, and a row that carries one shows with Tool calls off.
import { describe, expect, it } from "vitest";
import { doneWhenText, hasDoneWhenLine } from "./done-when-line";

describe("done-when line", () => {
  it("paints a bounded line and nothing for blank, absent or over-long text", () => {
    expect(doneWhenText(" the PR is open ")).toBe("the PR is open");
    expect(doneWhenText("   ")).toBe("");
    expect(doneWhenText("x".repeat(281))).toBe("");
    expect(doneWhenText("😀".repeat(280))).toBe("😀".repeat(280));
    expect(doneWhenText(undefined)).toBe("");
    expect(doneWhenText(42 as unknown as string)).toBe("");
  });
  it("marks a hand-off row with a line as shown whatever the Tool calls setting is", () => {
    expect(hasDoneWhenLine("the site is live")).toBe(true);
    expect(hasDoneWhenLine(undefined)).toBe(false);
    expect(hasDoneWhenLine("x".repeat(281))).toBe(false);
  });
});
