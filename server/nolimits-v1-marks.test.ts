// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 cut (designs/NOLIMITS-V1-CUT.md, train 1.0.18): the coarse marks. V9 marked-turn rows with the turn's start,
// test T, V3 carried rows, V6 (c) ownWrite keys, V7 engines seen in full, V2 the working folder at turn start (M9).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadRegistry, TextBudget } from "./download-registry.ts";
import {
  anyOwnWrite, beginOutsideTurn, engineSeenInFull, forgetOutsideState, markTurnOutside, markedTurnsOf, notProvenClean, ownWrite,
  ownWritten, promptCarriesOutside, wireOutsideStore, type CarriedRow,
} from "./email/external-marks.ts";
import { nodeFsHooks } from "./outside-dl.ts";
import { registerText } from "./outside-register.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { cwdOutsideMark } from "./outside-wire.ts";

const dir = () => mkdtempSync(join(tmpdir(), "nlmi-v1-"));
let now = 0;
const wire = (path = join(dir(), "outside-state.jsonl")) => { expect(wireOutsideStore(fileOutsideStore(path), () => now)).toBe(true); return path; };
afterEach(() => { forgetOutsideState(); now = 0; });

describe("V9 marked turns", () => {
  it("V9-1 a mark with no turn id still writes a markedTurns row with begunAt, and it survives a restart", () => {
    now = 1000;
    const path = wire();
    beginOutsideTurn("t1", "keys", undefined, false);
    now = 5000;
    markTurnOutside("t1", "web page");
    expect(markedTurnsOf("t1")).toEqual([{ threadId: "t1", instanceId: "keys", sessionKey: expect.any(String), gen: expect.any(Number), birthRunId: expect.any(String), turnId: "t1#5000", at: 5000, begunAt: 1000 }]);
    forgetOutsideState();
    wire(path);
    expect(markedTurnsOf("t1")).toEqual([{ threadId: "t1", instanceId: "keys", sessionKey: expect.any(String), gen: expect.any(Number), birthRunId: expect.any(String), turnId: "t1#5000", at: 5000, begunAt: 1000 }]);
  });
});

describe("test T (V1, V3)", () => {
  it("marks words from a thread whose marked turn began at most 60 s after them; a never-marked thread is clean", () => {
    now = 10_000;
    wire();
    now = 200_000;
    beginOutsideTurn("t1", "keys", undefined, false);
    markTurnOutside("t1", "web search");
    expect(notProvenClean("t1", 300_000)).toBe(true);
    expect(notProvenClean("t1", 150_000)).toBe(true);
    expect(notProvenClean("t1", 100_000)).toBe(false);
    expect(notProvenClean("t2", 300_000)).toBe(false);
    expect(notProvenClean("t2", undefined)).toBe(true);
    expect(notProvenClean(undefined, 300_000)).toBe(true);
  });
  it("is not proven clean while the store is not ready", () => {
    expect(notProvenClean("t2", 1)).toBe(true);
  });
});

describe("V3 carried rows", () => {
  const owner = (id: string, at: number, seq?: number): CarriedRow => ({ id, at, role: "user", ...(seq !== undefined ? { seq } : {}) });
  const base = { threadId: "t1", botId: "b1", promptIds: [] as string[] };
  it("V3-1 a replay with another person's row, or another bot's, is marked", () => {
    now = 1000; wire(); now = 2000;
    const person: CarriedRow = { id: "p", at: 2000, role: "user", automation: { kind: "channel" } };
    const bot: CarriedRow = { id: "q", at: 2000, role: "bot", from: { botId: "b2" } };
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["p"], branch: [person] })).toBe("another person");
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["q"], branch: [bot] })).toBe("another bot");
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["o"], branch: [owner("o", 2000)] })).toBeNull();
    // the same rows on a resumed session's own transcript still mark (authors)
    expect(promptCarriesOutside({ ...base, resumed: true, replayIds: [], branch: [person], sessionFromSeq: undefined })).toBe("another person");
  });
  it("V3-2 a fresh session replaying a row from after a marked turn is marked; only rows before it: clean", () => {
    now = 10_000; wire();
    now = 200_000;
    beginOutsideTurn("t1", "keys", undefined, false);
    markTurnOutside("t1", "web page");
    const rows = [owner("old", 100_000), owner("late", 250_000)];
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["late"], branch: rows })).toBe("earlier turn");
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["old"], branch: rows })).toBeNull();
    // a row before outsideSince, or with no time, is an earlier session
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["x"], branch: [owner("x", 5_000)] })).toBe("earlier session");
    expect(promptCarriesOutside({ ...base, resumed: false, replayIds: ["y"], branch: [{ id: "y", role: "user" }] })).toBe("earlier session");
    // a row riding the prompt is checked in full on a resumed session too
    expect(promptCarriesOutside({ ...base, resumed: true, replayIds: [], promptIds: ["late"], branch: rows })).toBe("earlier turn");
    // a resumed session's own owner rows: the session taint covers time
    expect(promptCarriesOutside({ ...base, resumed: true, replayIds: [], branch: rows, sessionFromSeq: undefined })).toBeNull();
  });
});

describe("V6 (c) ownWrite keys", () => {
  it("are kept across a restart and never clear; not ready reads as written", () => {
    expect(ownWritten("bot:b1")).toBe(true);
    now = 1000;
    const path = wire();
    expect(anyOwnWrite()).toBe(false);
    ownWrite("bot:b1");
    forgetOutsideState();
    wire(path);
    expect(ownWritten("bot:b1")).toBe(true);
    expect(ownWritten("bot:b2")).toBe(false);
    expect(anyOwnWrite()).toBe(true);
  });
});

describe("V7 engines seen in full", () => {
  it("Claude, Codex, the ACP core engines and the chat-completions drivers are covered; every other engine is not", () => {
    for (const kind of ["claudeAgent", "codex", "fuigoAgent", "grokAgent", "grok", "geminiAgent", "cursorAgent", "openai-compat", "minimax"]) expect(engineSeenInFull(kind)).toBe(true);
    for (const kind of ["hermesAgent", "openclawAgent", "antigravityAgent", "piAgent", "kimiAgent", "droidAgent", "opencodeGo", "qwenAgent", "clineAgent", "customAcp", "boxAgent"]) expect(engineSeenInFull(kind)).toBe(false);
    expect(engineSeenInFull(undefined)).toBe(false);
  });
});

describe("V2 working folder at turn start (M9)", () => {
  const ctx = (cwd: string, marked: boolean) => ({ cwd, now: Date.now(), marked, readOnly: false, budget: new TextBudget(nodeFsHooks()), roots: ["/"] });
  const repo = () => { const root = dir(); mkdirSync(join(root, ".git")); return root; };
  it("V2-1 a folder cloned on an earlier turn marks a fresh chat whose working folder it is", () => {
    const root = repo();
    const registry = new DownloadRegistry();
    registry.add(registerText("git clone https://example.com/x.git d", ctx(root, false)));
    mkdirSync(join(root, "d"));
    expect(cwdOutsideMark(join(root, "d"), registry)).toBe("cloned folder");
    // F6 / DL step 2: a working folder that HOLDS an entry marks too
    expect(cwdOutsideMark(root, registry)).toBe("cloned folder");
  });
  it("V2-2 an AGENTS.md written by curl -o on a marked turn in an ancestor marks the next fresh chat", () => {
    const root = repo();
    mkdirSync(join(root, "sub"));
    const registry = new DownloadRegistry();
    registry.add(registerText(`curl -o ${join(root, "AGENTS.md")} https://example.com/a`, ctx(join(root, "sub"), true)));
    writeFileSync(join(root, "AGENTS.md"), "x");
    expect(cwdOutsideMark(join(root, "sub"), registry)).not.toBeNull();
  });
  it("a working folder with nothing registered in or around it stays clean; an empty registry is clean", () => {
    const root = repo();
    const other = repo();
    const registry = new DownloadRegistry();
    registry.add(registerText(`curl -o ${join(other, "a.txt")} https://example.com/a`, ctx(other, false)));
    writeFileSync(join(other, "a.txt"), "x");
    expect(cwdOutsideMark(root, registry)).toBeNull();
    expect(cwdOutsideMark(root, new DownloadRegistry())).toBeNull();
  });
  it("a stat that fails marks (fail closed)", () => {
    const root = repo();
    const registry = new DownloadRegistry();
    registry.add(registerText(`curl -o ${join(root, "z", "a.txt")} https://example.com/a`, ctx(root, false)));
    const broken = { lstat: () => { throw new Error("EIO"); }, realpath: () => { throw new Error("EIO"); } };
    expect(cwdOutsideMark(join(root, "elsewhere"), registry, broken)).toBe("cloned folder");
  });
});
