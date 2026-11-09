// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 cut (designs/NOLIMITS-V1-CUT.md, train 1.0.18) V4 downloads at the server seams: (a) registration at an
// engine tool's item.started (shell texts R1-R8, file edits R5 on a marked turn), (b) the coarse span, (c) the read side
// (scan hooks, local file tools), (e) the turn end stamp, (f) the ask-time check; F3 the installer PATH. (F5 and the F6
// cwd window are builder C's, wip/1018-nlmi-v5.)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginOutsideTurn, downloadRegistry, endOutsideTurn, forgetOutsideState, markTurnOutside, turnOutsideRead, wireOutsideStore,
} from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { SEARCH_ALL, askOutsideMark, installPathUnknown, noteEnginePath, noteToolStartOutside, pathFoldersFor } from "./outside-wire.ts";

const dir = () => mkdtempSync(join(tmpdir(), "nlmi-v1-dl-"));
const wire = () => { expect(wireOutsideStore(fileOutsideStore(join(dir(), "outside-state.jsonl")))).toBe(true); };
const shell = (command: string) => ({ origin: "engine" as const, title: "Bash", input: { command } });
const tool = (title: string, input: unknown = {}) => ({ origin: "engine" as const, title, input });
afterEach(() => { forgetOutsideState(); });

describe("V4 (a) registration at item.started", () => {
  it("V4-1 curl -o on turn 1 registers the file; a fresh chat's cat of it marks downloaded file", () => {
    wire();
    const root = dir();
    beginOutsideTurn("t1", "keys", undefined, false);
    noteToolStartOutside("t1", shell(`curl -o ${join(root, "a.txt")} https://example.com/a`), root);
    expect(turnOutsideRead("t1")).not.toBeNull();
    writeFileSync(join(root, "a.txt"), "x");
    endOutsideTurn("t1", undefined);
    expect(downloadRegistry().empty()).toBe(false);
    beginOutsideTurn("t2", "keys", undefined, false);
    // a fresh chat's engine is spawned (spawnCli notes its PATH for the thread) before any of its tools is judged
    noteEnginePath("t2", process.env.PATH);
    // (f) the ask is judged on the state before: the asked call itself is what marks
    expect(turnOutsideRead("t2")).toBeNull();
    expect(askOutsideMark("t2", { command: `cat ${join(root, "a.txt")}` }, undefined, root)).toBe("downloaded file");
    noteToolStartOutside("t2", shell(`cat ${join(root, "a.txt")}`), root);
    expect(turnOutsideRead("t2")).toBe("downloaded file");
  });
  it("V4-2 rg in a fresh chat over a folder holding an entry marks", () => {
    wire();
    const root = dir();
    mkdirSync(join(root, "x"));
    beginOutsideTurn("t1", "keys", undefined, false);
    noteToolStartOutside("t1", shell(`curl -o ${join(root, "x", "a.txt")} https://example.com/a`), root);
    endOutsideTurn("t1", undefined);
    beginOutsideTurn("t2", "keys", undefined, false);
    noteToolStartOutside("t2", shell(`rg api ${join(root, "x")}`), root);
    expect(turnOutsideRead("t2")).not.toBeNull();
  });
  it("R5: an engine file edit on a marked turn registers the path; on a clean turn it does not", () => {
    wire();
    const root = dir();
    beginOutsideTurn("t1", "keys", undefined, false);
    noteToolStartOutside("t1", tool("Write", { file_path: join(root, "clean.txt") }), root);
    expect(downloadRegistry().empty()).toBe(true);
    markTurnOutside("t1", "web page");
    noteToolStartOutside("t1", tool("Write", { file_path: join(root, "w.txt") }), root);
    expect(downloadRegistry().list().some((e) => e.kind === "file" && e.path.endsWith("/w.txt"))).toBe(true);
  });
});

describe("V4 (b) the coarse span", () => {
  it("V4-3 an outside MCP tool on a marked turn spans every root; a file written then marks a fresh chat's read", () => {
    wire();
    const root = dir();
    beginOutsideTurn("t1", "keys", undefined, false);
    markTurnOutside("t1", "web page");
    noteToolStartOutside("t1", tool("mcp__someone__write_file", { p: 1 }), root);
    expect(downloadRegistry().spanCount()).toBeGreaterThan(0);
    writeFileSync(join(root, "s.txt"), "x");
    endOutsideTurn("t1", undefined);
    expect(downloadRegistry().list().filter((e) => e.kind === "span").every((e) => e.until !== undefined)).toBe(true);
    beginOutsideTurn("t2", "keys", undefined, false);
    noteToolStartOutside("t2", tool("Read", { file_path: join(root, "s.txt") }), root);
    expect(turnOutsideRead("t2")).toBe("downloaded file");
  });
  it("V4-3 race: the turn end is stamped 1 ms past the clock, so a file written in the same whole ms (file times carry a fraction) stays inside the span", () => {
    expect(wireOutsideStore(fileOutsideStore(join(dir(), "outside-state.jsonl")), () => 5000)).toBe(true);
    const root = dir();
    beginOutsideTurn("t1", "keys", undefined, false);
    markTurnOutside("t1", "web page");
    noteToolStartOutside("t1", tool("mcp__someone__write_file", { p: 1 }), root);
    endOutsideTurn("t1", undefined);
    const spans = downloadRegistry().list().filter((e) => e.kind === "span");
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((e) => e.until === 5001)).toBe(true);
  });
  it("a local read tool on a marked turn adds no span; a clean turn's MCP tool adds no span", () => {
    wire();
    const root = dir();
    beginOutsideTurn("t1", "keys", undefined, false);
    noteToolStartOutside("t1", tool("mcp__someone__lookup", {}), root);
    expect(turnOutsideRead("t1")).toBe("outside tool");
    // the first outside tool both marks and spans: it ran on what is now a marked turn
    const after = downloadRegistry().spanCount();
    expect(after).toBeGreaterThan(0);
    noteToolStartOutside("t1", tool("Read", { file_path: join(root, "r.txt") }), root);
    noteToolStartOutside("t1", tool("Grep", { pattern: "x" }), root);
    expect(downloadRegistry().spanCount()).toBe(after);
  });
});

describe("V4 (c) the read side", () => {
  it("V4-6 a Read of a registered path and a Glob with no path in a registered cwd mark", () => {
    wire();
    const root = dir();
    mkdirSync(join(root, "d"));
    beginOutsideTurn("t1", "keys", undefined, false);
    noteToolStartOutside("t1", shell(`git clone https://example.com/x.git ${join(root, "d")}`), root);
    endOutsideTurn("t1", undefined);
    beginOutsideTurn("t2", "keys", undefined, false);
    noteToolStartOutside("t2", tool("Read", { file_path: join(root, "d", "README.md") }), root);
    expect(turnOutsideRead("t2")).toBe("cloned folder");
    beginOutsideTurn("t3", "keys", undefined, false);
    noteToolStartOutside("t3", tool("Glob", { pattern: "*.md" }), join(root, "d"));
    expect(turnOutsideRead("t3")).toBe("cloned folder");
  });
  it("an empty registry keeps local reads clean", () => {
    wire();
    beginOutsideTurn("t1", "keys", undefined, false);
    noteToolStartOutside("t1", tool("Read", { file_path: join(dir(), "a.txt") }), dir());
    expect(turnOutsideRead("t1")).toBeNull();
  });
});

describe("F3 installer PATH", () => {
  it("an install whose installer PATH is not known for the turn counts every searched folder as a hit while its span lasts", () => {
    wire();
    const root = dir();
    mkdirSync(join(root, "bin"));
    beginOutsideTurn("t1", "keys", undefined, false);
    markTurnOutside("t1", "web page");
    noteEnginePath("t1", undefined);
    noteToolStartOutside("t1", shell("npm i -g somepkg"), root);
    endOutsideTurn("t1", undefined);
    expect(installPathUnknown()).toBe(true);
    beginOutsideTurn("t2", "keys", undefined, false);
    expect(pathFoldersFor("t2")).toContain(SEARCH_ALL);
  });
  it("a known engine PATH is unioned with the server PATH", () => {
    wire();
    beginOutsideTurn("t1", "keys", undefined, false);
    noteEnginePath("t1", "/opt/engine/bin");
    expect(pathFoldersFor("t1")).toContain("/opt/engine/bin");
    expect(installPathUnknown()).toBe(false);
  });
});
