// 1.0.20 STOP-CHIP: the generation fence of the owner Stop line (owner-stop-terminal.ts), the real module index.ts wires.
// The phase witnesses on the real turn path are in stop-chip-phases-1020-api.test.ts.
import { expect, it } from "vitest";
import { createOwnerStopTerminals } from "./owner-stop-terminal.ts";

const world = (hostStopNoted = false) => {
  const lines: string[] = [];
  let failWrites = 0;
  const terminals = createOwnerStopTerminals({
    hostStopNoted: () => hostStopNoted,
    writeLine: (threadId) => { if (failWrites > 0) { failWrites -= 1; throw new Error("database is locked"); } lines.push(threadId); },
    warn: () => {},
  });
  return { lines, terminals, failNextWrite: () => { failWrites = 1; } };
};

it("a generation gets one stop line, whichever of the Stop route, the give-back and the terminal fold comes first or again", () => {
  const { lines, terminals } = world();
  terminals.arm("g1", "setup");
  expect(terminals.noteArmed("thread", "g1")).toBe(true);
  // the give-back of the same stopped setup, a second Stop, and a late stopped terminal event of that generation
  expect(terminals.note("thread", "g1")).toBe(false);
  expect(terminals.noteArmed("thread", "g1")).toBe(false);
  const foldWrite = () => { lines.push("fold"); };
  expect(terminals.once("g1", foldWrite)).toBe(false);
  expect(lines).toEqual(["thread"]);
  // the fold first, then a late no-engine-turn caller
  expect(terminals.once("g2", foldWrite)).toBe(true);
  expect(terminals.note("thread", "g2")).toBe(false);
  expect(lines).toEqual(["thread", "fold"]);
  // another generation of the same thread is another turn: its own line
  expect(terminals.note("thread", "g3")).toBe(true);
  expect(lines).toEqual(["thread", "fold", "thread"]);
});

it("a stop line whose write failed is still owed: the redelivered fold writes it, once", () => {
  const { lines, terminals } = world();
  const write = () => { if (lines.length === 0 && !retried) { retried = true; throw new Error("database is locked"); } lines.push("fold"); };
  let retried = false;
  expect(() => terminals.once("g1", write)).toThrow("database is locked");
  expect(terminals.once("g1", write)).toBe(true);
  expect(terminals.once("g1", write)).toBe(false);
  expect(lines).toEqual(["fold"]);
});

it("a failed write in the Stop route never fails the Stop, and the give-back may still write the line", () => {
  const { lines, terminals, failNextWrite } = world();
  terminals.arm("g1", "setup");
  failNextWrite();
  expect(terminals.noteArmed("thread", "g1")).toBe(false);
  expect(terminals.note("thread", "g1")).toBe(true);
  expect(lines).toEqual(["thread"]);
});

it("the claim phase of the first Stop stands for the generation: a second Stop cannot release or note a dispatching run", () => {
  const { lines, terminals } = world();
  terminals.arm("g1", "dispatching");
  // the second Stop finds no claim; nothing it passes may change the record
  terminals.arm("g1", "setup");
  expect(terminals.dispatching("g1")).toBe(true);
  expect(terminals.noteArmed("thread", "g1")).toBe(false);
  expect(lines).toEqual([]);
  // the guarded send's give-back retires it and writes the line
  expect(terminals.note("thread", "g1")).toBe(true);
  expect(lines).toEqual(["thread"]);
  expect(terminals.dispatching("never-stopped")).toBe(false);
  expect(terminals.noteArmed("thread", "never-stopped")).toBe(false);
});

it("a host stop keeps its own line: no \"Stopped by you\" for a stop the person did not press", () => {
  const noted = world(true);
  noted.terminals.arm("g1", "setup");
  expect(noted.terminals.noteArmed("thread", "g1")).toBe(false);
  const { lines, terminals } = world();
  terminals.arm("g2", "setup", "the request that asked ended");
  expect(terminals.noteArmed("thread", "g2")).toBe(false);
  expect([...noted.lines, ...lines]).toEqual([]);
});
