// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 cut (designs/NOLIMITS-V1-CUT.md, train 1.0.18), part C: V5 (a) the server side of an ask whose engine item
// never came (`itemUnseen` marks the turn), F5 ACP kinds without a tool identity, F6 instruction files below the working
// folder (no depth cutoff, the engine's own folder bound, fail closed) and beside a Claude read, and the cwd window every
// coarse span adds (designs/NOLIMITS-V1-CUT-ASTRA-F6.md: AGREE).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadRegistry, TextBudget, registryKey, type FsHooks } from "./download-registry.ts";
import { beginOutsideTurn, downloadRegistry, forgetOutsideState, turnOutsideRead, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import {
  BELOW_CWD_MAX_DIRS, cwdOutsideMark, noteAskItemUnseen, spanTurn, toolStartOutside, type DlScan, type ListDir,
} from "./outside-wire.ts";

afterEach(() => forgetOutsideState());
const wire = () => { expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlmi-v5-")), "outside-state.jsonl")))).toBe(true); };

interface Node { dir?: boolean; ctime: number }
/** A disk in memory: lstat and realpath by the map, a listing by the paths one level under a folder. */
function fakeDisk(nodes: Record<string, Node>, broken: readonly string[] = []) {
  const fs: FsHooks = {
    lstat: (p) => { if (broken.includes(p)) throw new Error("EIO"); const n = nodes[p]; return n ? { dir: n.dir === true, ctime: n.ctime } : null; },
    realpath: (p) => { if (broken.includes(p)) throw new Error("EIO"); return nodes[p] ? p : null; },
  };
  const listDir: ListDir = (p) => {
    if (broken.includes(p)) throw new Error("EIO");
    if (!nodes[p]?.dir) return null;
    return Object.keys(nodes).filter((k) => k !== p && dirname(k) === p).map((k) => ({ name: k.slice(p.length + (p.endsWith("/") ? 0 : 1)), dir: nodes[k]!.dir === true }));
  };
  return { fs, listDir };
}
const folders = (...paths: string[]): Record<string, Node> => Object.fromEntries(paths.map((p) => [p, { dir: true, ctime: 1 }]));
const spanned = (since: number, until: number) => { const r = new DownloadRegistry(); r.add([{ path: "/", kind: "span", since, until }]); return r; };

describe("V5 (a) the server side of an unseen ask item", () => {
  it("an ask opened with itemUnseen marks the turn outside tool; without it the turn stays clean", () => {
    wire();
    beginOutsideTurn("t1", "keys", undefined, false);
    noteAskItemUnseen("t1", {});
    expect(turnOutsideRead("t1")).toBeNull();
    noteAskItemUnseen("t1", { itemUnseen: true });
    expect(turnOutsideRead("t1")).toBe("outside tool");
  });
});

describe("F5 ACP kinds without a tool identity", () => {
  const acp = (toolKind: string, input: unknown, extra: Record<string, unknown> = {}) => ({ origin: "engine" as const, title: "tool", toolKind, input, ...extra });
  it("kind search marks web search unless it names a local target and no query (1.0.19 4.4)", () => {
    expect(toolStartOutside(acp("search", { query: "api docs" }))).toBe("web search");
    expect(toolStartOutside(acp("search", { pattern: "x", path: "/w" }))).toBeNull();
    expect(toolStartOutside(acp("search", { pattern: "x", path: "/w", query: "x" }))).toBe("web search");
    expect(toolStartOutside(acp("search", { url: "https://example.com" }))).toBe("web search");
  });
  it("kind read is local only when it names a local path and no URL", () => {
    expect(toolStartOutside(acp("read", { absolute_path: "/w/a.txt" }))).toBeNull();
    expect(toolStartOutside(acp("read", { path: "notes/a.txt" }))).toBeNull();
    expect(toolStartOutside(acp("read", { file_path: "C:\\w\\a.txt" }))).toBeNull();
    expect(toolStartOutside(acp("read", { url: "https://example.com/a" }))).toBe("web page");
    expect(toolStartOutside(acp("read", { path: "/w/a.txt", source: "https://example.com/a" }))).toBe("web page");
    expect(toolStartOutside(acp("read", {}))).toBe("outside tool");
    expect(toolStartOutside(acp("read", undefined))).toBe("outside tool");
  });
  it("edit, delete, move, execute, think and switch_mode stay local", () => {
    for (const kind of ["edit", "delete", "move", "think", "switch_mode"]) expect(toolStartOutside(acp(kind, { path: "/w/a" })), kind).toBeNull();
    expect(toolStartOutside(acp("execute", { command: "pwd" }))).toBeNull();
  });
});

describe("F6 instruction files below the working folder (turn start)", () => {
  const deep = { ...folders("/w", "/w/.git", "/w/a", "/w/a/b", "/w/a/b/c", "/w/a/b/c/d"), "/w/a/b/c/d/GEMINI.md": { ctime: 1500 } };
  it("Gemini: cwd/a/b/c/d/GEMINI.md written inside a span marks, with no depth cutoff", () => {
    const { fs, listDir } = fakeDisk(deep);
    expect(cwdOutsideMark("/w", spanned(1000, 2000), fs, "geminiAgent", listDir)).toBe("cloned folder");
  });
  it("the same file written outside every span is clean; no span: no listing at all", () => {
    const { fs, listDir } = fakeDisk(deep);
    expect(cwdOutsideMark("/w", spanned(3000, 4000), fs, "geminiAgent", listDir)).toBeNull();
    let listed = 0;
    const counting: ListDir = (p) => { listed++; return listDir(p); };
    const fileOnly = new DownloadRegistry();
    fileOnly.add([{ path: "/srv/x.txt", kind: "file", since: 1 }]);
    expect(cwdOutsideMark("/w", fileOnly, fs, "geminiAgent", counting)).toBeNull();
    expect(listed).toBe(0);
  });
  it("Claude and Codex load no file below the cwd at start (Claude is checked at each read)", () => {
    const { fs, listDir } = fakeDisk(deep);
    expect(cwdOutsideMark("/w", spanned(1000, 2000), fs, "claudeAgent", listDir)).toBeNull();
    expect(cwdOutsideMark("/w", spanned(1000, 2000), fs, "codex", listDir)).toBeNull();
    // every other engine is listed (Cursor, Fuigo, Grok load rules below the cwd too)
    expect(cwdOutsideMark("/w", spanned(1000, 2000), fs, "cursorAgent", listDir)).toBe("cloned folder");
  });
  it("a listing that reaches the engine's folder bound before it ends marks (fail closed)", () => {
    const many: Record<string, Node> = folders("/w", "/w/.git");
    for (let i = 0; i < BELOW_CWD_MAX_DIRS + 5; i++) many[`/w/f${i}`] = { dir: true, ctime: 1 };
    const { fs, listDir } = fakeDisk(many);
    expect(BELOW_CWD_MAX_DIRS).toBe(200);
    expect(cwdOutsideMark("/w", spanned(1000, 2000), fs, "geminiAgent", listDir)).toBe("cloned folder");
    const few: Record<string, Node> = folders("/w", "/w/.git");
    for (let i = 0; i < 20; i++) few[`/w/f${i}`] = { dir: true, ctime: 1 };
    const small = fakeDisk(few);
    expect(cwdOutsideMark("/w", spanned(1000, 2000), small.fs, "geminiAgent", small.listDir)).toBeNull();
  });
  it("a folder that cannot be listed marks", () => {
    const { fs, listDir } = fakeDisk(deep, ["/w/a/b"]);
    expect(cwdOutsideMark("/w", spanned(1000, 2000), fs, "geminiAgent", listDir)).toBe("cloned folder");
  });
});

describe("F6 the cwd window of every coarse span", () => {
  it("a span adds a window on the turn's working folder, so a later chat there holds an entry", () => {
    wire();
    const root = mkdtempSync(join(tmpdir(), "nlmi-v5-cwd-"));
    beginOutsideTurn("t1", "keys", undefined, false);
    spanTurn("t1", root);
    const windows = downloadRegistry().list().filter((e) => e.kind === "window");
    expect(windows.map((e) => e.path)).toContain(registryKey(root));
    expect(cwdOutsideMark(root)).toBe("cloned folder");
  });
});

describe("F6 a Claude read loads CLAUDE.md beside the read path", () => {
  const disk = (withNested: boolean) => fakeDisk({
    ...folders("/w", "/w/a", "/w/a/b"), "/w/a/b/x.ts": { ctime: 1 },
    ...(withNested ? { "/w/a/CLAUDE.md": { ctime: 1500 } } : {}),
  });
  const scan = (d: ReturnType<typeof disk>): DlScan => ({ registry: spanned(1000, 2000), cwd: "/w", home: "/h", budget: new TextBudget(d.fs), pathFolders: [], listDir: d.listDir });
  const read = (input: unknown, extra: Record<string, unknown> = {}) => ({ origin: "engine" as const, title: "Read", input, ...extra });
  it("a nested instruction file from the cwd down to the read path, written in a span, marks", () => {
    expect(toolStartOutside(read({ file_path: "/w/a/b/x.ts" }), scan(disk(true)))).toBe("cloned folder");
    expect(toolStartOutside(read({ file_path: "/w/a/b/x.ts" }), scan(disk(false)))).toBeNull();
  });
  it("a folder on the way that cannot be listed marks", () => {
    const d = fakeDisk({ ...folders("/w", "/w/a", "/w/a/b"), "/w/a/b/x.ts": { ctime: 1 } }, ["/w/a"]);
    const dl: DlScan = { registry: spanned(1000, 2000), cwd: "/w", home: "/h", budget: new TextBudget(d.fs), pathFolders: [], listDir: d.listDir };
    expect(toolStartOutside(read({ file_path: "/w/a/b/x.ts" }), dl)).not.toBeNull();
  });
});
