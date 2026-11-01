// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATE: on a Mac, a tool call held at the OS folder prompt says so in that chat, and the line can do nothing but appear
// and clear. The shapes are the ones each driver emits (claude.ts:4881, codex.ts:1863, acp/core.ts:3823).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { createMacFolderPromptWatch, type MacFolderPromptDeps } from "./mac-folder-prompt.ts";
import { FOLDER_PROMPT_DELAY_MS, FOLDER_PROMPT_MAX_MS, folderPromptShowing, macFolderPromptLine, macFoldersNamed } from "../shared/mac-folder-prompt.ts";

const T = "thread-1";
let seq = 0;
const base = (over: Record<string, unknown> = {}) => ({ eventId: `e${++seq}`, provider: "claude", threadId: T, turnId: "turn-1", createdAt: "2026-10-31T00:00:00Z", ...over });
const ev = (event: Record<string, unknown>) => base(event) as unknown as RuntimeEvent;
const bash = (itemId: string, command: string, over: Record<string, unknown> = {}) =>
  ev({ type: "item.started", itemType: "tool", origin: "engine", itemId, title: "Bash", input: { command }, ...over });
const done = (itemId: string, over: Record<string, unknown> = {}) => ev({ type: "item.completed", itemType: "tool", itemId, ok: true, ...over });

function rig(over: Partial<MacFolderPromptDeps> = {}) {
  const shown: Array<[string, string]> = [];
  const cleared: string[] = [];
  const deps = {
    platform: "darwin" as NodeJS.Platform,
    live: vi.fn(() => true),
    askOpen: vi.fn(() => false),
    show: (threadId: string, folder: string) => { shown.push([threadId, folder]); return `row-${shown.length}`; },
    clear: (_threadId: string, rowId: string) => { cleared.push(rowId); },
    ...over,
  };
  return { watch: createMacFolderPromptWatch(deps), shown, cleared, deps };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("which tool calls name a prompt folder", () => {
  it.each([
    ["ls ~/Documents/x", ["Documents"]],
    ['ls ~/Documents/x && echo "done', ["Documents"]],
    ["cat ~/Desktop", ["Desktop"]],
    ["cp $HOME/Downloads/a.zip .", ["Downloads"]],
    ["cp ${HOME}/Downloads/a.zip .", ["Downloads"]],
    ['cp "$HOME"/Downloads/a.zip .', ["Downloads"]],
    ["ls /Users/sam/Documents/x", ["Documents"]],
    ['ls ~/"Documents/report.txt"', ["Documents"]],
    ['ls $HOME/"Downloads/archive.zip"', ["Downloads"]],
    ['{"command":"ls ~/\\"Desktop/a b\\""}', ["Desktop"]],
    ["ls ~/documents", ["Documents"]],
    ["mv ~/Desktop/a ~/Documents/a", ["Desktop", "Documents"]],
    ['{"file_path":"/Users/sam/Desktop/a.txt"}', ["Desktop"]],
    ["ls ~/Documents ~/Documents/b", ["Documents"]],
  ])("%s", (text, folders) => expect(macFoldersNamed(text)).toEqual(folders));

  it.each(["ls /tmp/fnone", "ls ~/gate/x", "ls ~/Documents-old", "ls ~/Documents.bak", "ls ~/work/Documents", "ls /Volumes/x/Users/sam/Desktop", "ls Documents", "echo my documents"])(
    "%s names none", (text) => expect(macFoldersNamed(text)).toEqual([]));
});

describe("the notice", () => {
  it("shows after 20 s with no ask and no result, in the words approved, naming the folder", () => {
    const { watch, shown } = rig();
    watch.observe(bash("a", "ls ~/Downloads/x"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS - 1);
    expect(FOLDER_PROMPT_DELAY_MS).toBe(20_000);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual([[T, "Downloads"]]);
    expect(macFolderPromptLine("Downloads")).toBe("Your Mac is asking whether Murage can open your Downloads folder. Look for the pop-up, or turn it on in System Settings, Privacy & Security, Files & Folders.");
  });

  it.each([
    ["Claude", { title: "Read", input: { file_path: "/Users/sam/Desktop/a.txt" } }],
    ["Codex", { title: "ls ~/Desktop/a", input: undefined }],
    ["ACP", { title: "ls ~/Desktop/a", input: { command: "ls ~/Desktop/a" } }],
  ])("reads the %s shape with no per-engine code", (_engine, shape) => {
    const { watch, shown } = rig();
    watch.observe(ev({ type: "item.started", itemType: "tool", origin: "engine", itemId: "a", ...shape }));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toEqual([[T, "Desktop"]]);
  });

  it.each([
    ["a direct chat or a routine's task thread", "bot-thread"],
    ["a project or a room routine", "group-thread"],
  ])("shows on %s, on that thread only", (_what, threadId) => {
    const { watch, shown } = rig();
    watch.observe(bash("a", "ls ~/Documents", { threadId }));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toEqual([[threadId, "Documents"]]);
  });

  it("does nothing off a Mac", () => {
    const { watch, shown } = rig({ platform: "linux" });
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS * 2);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves Murage's own lines and tools naming no folder alone", () => {
    const { watch, shown } = rig();
    watch.observe(bash("a", "ls ~/Documents", { origin: "murage" }));
    watch.observe(bash("b", "ls /tmp"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toEqual([]);
  });

  it("is one row for parallel calls on a folder, and stays until the last result", () => {
    const { watch, shown, cleared } = rig();
    watch.observe(bash("a", "ls ~/Documents/a"));
    watch.observe(bash("b", "ls ~/Documents/b"));
    watch.observe(bash("c", "ls ~/Desktop"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown.map(([, folder]) => folder)).toEqual(["Documents", "Desktop"]);
    watch.observe(done("a"));
    expect(cleared).toEqual([]);
    watch.observe(done("b"));
    expect(cleared).toEqual(["row-1"]);
    watch.observe(done("c"));
    expect(cleared).toEqual(["row-1", "row-2"]);
  });

  it("raises a new row for the next call after one cleared", () => {
    const { watch, shown } = rig();
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    watch.observe(done("a"));
    watch.observe(bash("b", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toHaveLength(2);
  });

  const enders: Array<[string, RuntimeEvent]> = [
    ["the tool result", done("a")],
    ["an ask that got through", ev({ type: "request.opened", requestId: "r", requestType: "permission" })],
    ["the engine's tool heartbeat", ev({ type: "item.updated", itemType: "tool" })],
    ["the turn's completion (Stop lands here)", ev({ type: "turn.completed" })],
    ["a completion with no turn id", ev({ type: "turn.completed", turnId: undefined })],
    ["the next turn starting", ev({ type: "turn.started", turnId: "turn-2" })],
    ["the session exiting", ev({ type: "session.exited" })],
  ];

  it.each(enders)("never fires after %s", (_what, ender) => {
    const { watch, shown } = rig();
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS - 1);
    watch.observe(ender);
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(enders)("clears on %s", (_what, ender) => {
    const { watch, cleared } = rig();
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    watch.observe(ender);
    expect(cleared).toEqual(["row-1"]);
  });

  it("does not clear on another turn's completion or a result for another tool", () => {
    const { watch, cleared } = rig();
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    watch.observe(ev({ type: "turn.completed", turnId: "turn-0" }));
    watch.observe(done("other"));
    expect(cleared).toEqual([]);
  });

  it("drops an older turn's watch when a later call starts", () => {
    const { watch, cleared, shown } = rig();
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    watch.observe(bash("b", "ls ~/Documents", { turnId: "turn-2" }));
    expect(cleared).toEqual(["row-1"]);
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toHaveLength(2);
  });

  it("stays quiet when a card is already open", () => {
    const { watch, shown } = rig({ askOpen: () => true });
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears when the turn is retired with no provider event (a provider reload, a room stall)", () => {
    let live = true;
    const { watch, cleared, shown } = rig({ live: () => live, sweepMs: 60_000 });
    watch.observe(bash("a", "ls ~/Documents"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    live = false;
    vi.advanceTimersByTime(60_000);
    expect(cleared).toEqual(["row-1"]);
    expect(vi.getTimerCount()).toBe(0);
    watch.observe(bash("b", "ls ~/Desktop"));
    vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS);
    expect(shown).toHaveLength(1);
  });

  it("survives a thread that has gone away", () => {
    const { watch } = rig({ show: () => { throw new Error("gone"); }, clear: () => { throw new Error("gone"); } });
    watch.observe(bash("a", "ls ~/Documents"));
    expect(() => vi.advanceTimersByTime(FOLDER_PROMPT_DELAY_MS)).not.toThrow();
    expect(() => watch.observe(done("a"))).not.toThrow();
  });

  it("stops drawing a row no server can clear once the longest wait has passed", () => {
    const row = { at: 1_000, folderPrompt: { folder: "Documents" } };
    expect(folderPromptShowing(row, 1_000 + FOLDER_PROMPT_MAX_MS - 1)).toBe(true);
    expect(folderPromptShowing(row, 1_000 + FOLDER_PROMPT_MAX_MS)).toBe(false);
    expect(folderPromptShowing({ at: 1_000, folderPrompt: { folder: "Documents", done: true } }, 1_000)).toBe(false);
    expect(folderPromptShowing({ at: 1_000 }, 1_000)).toBe(false);
  });
});

describe("it cannot touch a permission", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

  it("imports only its own words and the event type", () => {
    const imports = [...read("./mac-folder-prompt.ts").matchAll(/^import .*$/gm)].map(([line]) => line);
    expect(imports).toEqual([
      'import type { RuntimeEvent } from "./contracts.ts";',
      'import { FOLDER_PROMPT_DELAY_MS, macFoldersNamed, type MacPromptFolder } from "../shared/mac-folder-prompt.ts";',
    ]);
  });

  it("is wired with reads, one line and one patch", () => {
    const source = read("./index.ts");
    const wiring = source.slice(source.indexOf("createMacFolderPromptWatch({"), source.indexOf("macFolderPrompt.observe(event)"));
    expect(wiring).not.toMatch(/answerRequest|resolve|deny|interrupt|setWaitingOnHuman|respond/i);
    expect(wiring.match(/store\.\w+/g)).toEqual(["store.appendMessage", "store.patchMessage"]);
    expect(source).toContain("bus.subscribe((event: RuntimeEvent) => {\n  if (shouldIgnoreProviderEvent(event)) return;\n  macFolderPrompt.observe(event);\n});");
  });
});
