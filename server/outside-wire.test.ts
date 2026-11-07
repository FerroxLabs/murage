// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT 1.0.20 server fill (design r4 3.1, 3.2 M2/M3, 3.5, C2): the durable outside store, the engine tool
// mark at item.started, and the AutoContext fields the gate reads. A clean owner turn is filled `outsideRead: null`;
// a turn that saw outside content, or a store that is not wired, is filled marked.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginOutsideTurn, forgetOutsideState, markTurnOutside, sessionTainted, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { askOutsideMark, noteToolStartOutside, outsideContextFields, toolStartOutside } from "./outside-wire.ts";

const dir = () => mkdtempSync(join(tmpdir(), "nlmi-wire-"));
afterEach(() => forgetOutsideState());

describe("outside store (3.5)", () => {
  it("replays marks, sessions, marked turns, outsideSince and registry rows after a restart", () => {
    const path = join(dir(), "outside-state.jsonl");
    expect(wireOutsideStore(fileOutsideStore(path), () => 1000)).toBe(true);
    beginOutsideTurn("t1", "keys", "turn-1", false);
    markTurnOutside("t1", "web page");
    const store = fileOutsideStore(path);
    store.writeRegistry([{ path: "/srv/a", kind: "file", since: 5 } as never], []);
    forgetOutsideState();
    const loaded = fileOutsideStore(path).load();
    expect(loaded.outsideSince).toBe(1000);
    expect(loaded.marks.map((m) => [m.threadId, m.source, m.turnId])).toEqual([["t1", "web page", "turn-1"]]);
    expect(loaded.sessions.find((s) => s.threadId === "t1")?.tainted).toBe(true);
    expect(loaded.markedTurns.map((t) => t.turnId)).toEqual(["turn-1"]);
    expect(fileOutsideStore(path).loadRegistry().map((e) => e.path)).toEqual(["/srv/a"]);
    expect(wireOutsideStore(fileOutsideStore(path))).toBe(true);
    expect(sessionTainted("t1", "keys")).toBe(true);
  });

  it("a cleared mark stays cleared, and a torn last line (a crash mid-write) is skipped", () => {
    const path = join(dir(), "outside-state.jsonl");
    wireOutsideStore(fileOutsideStore(path));
    beginOutsideTurn("t1", "keys", "turn-1", false);
    markTurnOutside("t1", "git");
    beginOutsideTurn("t1", "keys", "turn-2", true);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"k":"mark","row":{"thr`);
    const loaded = fileOutsideStore(path).load();
    expect(loaded.marks.filter((m) => m.threadId === "t1" && m.turnId === "turn-2").length).toBe(1);
    expect(loaded.marks.some((m) => m.turnId === "turn-1")).toBe(false);
  });

  it("a damaged line before the end leaves the store not ready (fail closed)", () => {
    const path = join(dir(), "outside-state.jsonl");
    writeFileSync(path, `not json\n{"k":"since","at":1}\n`);
    expect(wireOutsideStore(fileOutsideStore(path))).toBe(false);
    expect(outsideContextFields("t1", "/work").outsideRead).not.toBeNull();
  });
});

describe("engine tool mark at item.started (M2, M3)", () => {
  const engine = (title: string, extra: Record<string, unknown> = {}) => ({ origin: "engine" as const, title, ...extra });
  it("local tools and ACP local kinds do not mark", () => {
    for (const title of ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite", "Bash", "BashOutput", "KillShell"]) {
      expect(toolStartOutside(engine(title, { input: { command: "ls" } })), title).toBeNull();
    }
    for (const toolKind of ["edit", "delete", "move", "execute", "think", "switch_mode"]) {
      expect(toolStartOutside(engine("whatever", { toolKind, input: { command: "pwd" } })), toolKind).toBeNull();
    }
    // v1 F5: with no tool identity, `read` is local only with a local path and no URL, and `search` is a web search
    expect(toolStartOutside(engine("whatever", { toolKind: "read", input: { path: "/w/a.txt" } }))).toBeNull();
    expect(toolStartOutside(engine("whatever", { toolKind: "read", input: { command: "pwd" } }))).toBe("outside tool");
    // 1.0.19 4.4: a search naming a local target (a pattern, path or glob field) and no URL or query is local
    expect(toolStartOutside(engine("whatever", { toolKind: "search", input: { pattern: "x" } }))).toBeNull();
    expect(toolStartOutside(engine("whatever", { toolKind: "search", input: { query: "x" } }))).toBe("web search");
    expect(toolStartOutside(engine("commandExecution", { input: { command: "ls" } }))).toBeNull();
  });
  it("web tools, unknown tools, Task and foreign MCP tools mark", () => {
    expect(toolStartOutside(engine("WebFetch"))).toBe("web page");
    expect(toolStartOutside(engine("WebSearch"))).toBe("web search");
    expect(toolStartOutside(engine("Task"))).toBe("outside tool");
    expect(toolStartOutside(engine("mcp__github__get_issue"))).toBe("outside tool");
    expect(toolStartOutside(engine("x", { toolKind: "fetch" }))).toBe("outside tool");
    expect(toolStartOutside(engine("x", { toolKind: "other" }))).toBe("outside tool");
    expect(toolStartOutside(engine(""))).toBe("outside tool");
  });
  it("own clean readers do not mark; every other own tool marks (fail closed)", () => {
    expect(toolStartOutside(engine("mcp__agents__list_bots"))).toBeNull();
    expect(toolStartOutside(engine("mcp__agents__murage_help"))).toBeNull();
    expect(toolStartOutside(engine("dweb.dweb_status"))).toBeNull();
    expect(toolStartOutside(engine("mcp__elsewhere__list_bots"))).toBe("outside tool");
    // 1.0.19 4.2: an own server's tool never marks at the item; venue_read_messages marks in its handler (OWN_MARKS_TOOLS)
    expect(toolStartOutside(engine("mcp__agents__venue_read_messages"))).toBeNull();
  });
  it("a shell text whose marking scan hits marks; an empty command marks", () => {
    expect(toolStartOutside(engine("Bash", { input: { command: "curl https://example.com/x" } }))).toBe("network command");
    expect(toolStartOutside(engine("Bash", { input: { command: "npm install left-pad" } }))).toBe("package install");
    expect(toolStartOutside(engine("Bash", { input: {} }))).toBe("outside tool");
    expect(toolStartOutside(engine("Bash", { input: { command: "cat .env" } }))).toBeNull();
  });
  it("noteToolStartOutside marks the running turn", () => {
    wireOutsideStore(fileOutsideStore(join(dir(), "s.jsonl")));
    beginOutsideTurn("t1", "keys", "turn-1", false);
    noteToolStartOutside("t1", engine("Bash", { input: { command: "cat .env" } }));
    expect(outsideContextFields("t1", "/work").outsideRead).toBeNull();
    noteToolStartOutside("t1", engine("WebFetch"));
    expect(outsideContextFields("t1", "/work").outsideRead).toEqual(["web page"]);
  });
  // builder #11 diagnostic (11-06): the 7 API reds were this row, the fake ACP engine's scripted `run` tool with no kind and
  // no input. The mark is right (an unknown kind is not local), and it carries to the next resumed turn as `earlier turn`.
  it("an ACP tool row with no kind and no input marks the turn and its session; the same row as a local kind does not", () => {
    wireOutsideStore(fileOutsideStore(join(dir(), "s.jsonl")));
    expect(toolStartOutside(engine("run"))).toBe("outside tool");
    expect(toolStartOutside(engine("run", { toolKind: "think" }))).toBeNull();
    beginOutsideTurn("t1", "keys", "turn-1", false);
    noteToolStartOutside("t1", engine("run", { toolKind: "think" }));
    expect(outsideContextFields("t1", "/work").outsideRead).toBeNull();
    expect(sessionTainted("t1", "keys")).toBe(false);
    noteToolStartOutside("t1", engine("run"));
    expect(outsideContextFields("t1", "/work").outsideRead).toEqual(["outside tool"]);
    beginOutsideTurn("t1", "keys", "turn-2", true);
    expect(outsideContextFields("t1", "/work").outsideRead).toEqual(["earlier turn"]);
  });
});

describe("AutoContext fill (C2, 6.3)", () => {
  it("a clean turn on a wired store is null; not wired is marked", () => {
    expect(outsideContextFields("t1", "/work").outsideRead).toEqual(["outside tool"]);
    wireOutsideStore(fileOutsideStore(join(dir(), "s.jsonl")));
    beginOutsideTurn("t1", "keys", "turn-1", false);
    const fields = outsideContextFields("t1", "/work");
    expect(fields.outsideRead).toBeNull();
    expect(fields.workFolder).toBe("/work");
    expect(fields.readOnlySoFar).toBe(true);
    expect(fields.readOnlyHooks?.cwd).toBe("/work");
  });
  it("a resumed session with no start record is marked earlier session (M7)", () => {
    wireOutsideStore(fileOutsideStore(join(dir(), "s.jsonl")));
    beginOutsideTurn("t2", "keys", "turn-1", true);
    expect(outsideContextFields("t2", undefined).outsideRead).toEqual(["earlier session"]);
  });
  it("a write on a marked turn ends readOnlySoFar for the session", () => {
    wireOutsideStore(fileOutsideStore(join(dir(), "s.jsonl")));
    beginOutsideTurn("t1", "keys", "turn-1", false);
    markTurnOutside("t1", "web page");
    noteToolStartOutside("t1", { origin: "engine", title: "Read", input: { file_path: "/work/a" } });
    expect(outsideContextFields("t1", "/work").readOnlySoFar).toBe(true);
    noteToolStartOutside("t1", { origin: "engine", title: "Write", input: { file_path: "/work/a" } });
    expect(outsideContextFields("t1", "/work").readOnlySoFar).toBe(false);
  });
});


it("R7b askOutsideMark holds downloaded file past the gate", () => {
  expect(wireOutsideStore(fileOutsideStore(join(dir(), "outside-state.jsonl")))).toBe(true); const root = dir();
  beginOutsideTurn("r7b", "keys", undefined, false);
  noteToolStartOutside("r7b", { origin: "engine", title: "Bash", input: { command: `curl -o ${join(root, "a.txt")} https://example.com/a` } }, root);
  expect(askOutsideMark("r7b", { command: "x".repeat(128 * 1024 + 1) }, undefined, root)).toBe("downloaded file");
});
