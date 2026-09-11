// F4-T3: the workspace pane's tab rules, geometry and transport, driven
// without React or a DOM. The browser proof (src/e2e/workspace-pane.human.
// spec.ts) exercises the same reducer through the real component.
import { describe, expect, it, vi } from "vitest";
import type { FileRevision, WorkspaceListResponse } from "../../shared/workspace-files";
import { WorkspaceFileRequestError } from "./document-session";
import {
  WORKSPACE_PANE_DEFAULT_WIDTH,
  WORKSPACE_PANE_MIN_CHAT_WIDTH,
  WORKSPACE_PANE_MIN_WIDTH,
  activeWorkspaceTab,
  clampWorkspaceWidth,
  copyPath,
  documentKindForPath,
  initialWorkspacePaneState,
  probeWorkspaceRevision,
  replaceableTab,
  workspaceApi,
  workspacePaneReducer,
  type WorkspacePaneAction,
  type WorkspacePaneState,
} from "./workspace-pane";

const scopeA = { botId: "bot-a", threadId: "task-1" };
const scopeB = { botId: "bot-b", threadId: "task-9" };
const run = (actions: WorkspacePaneAction[], from: WorkspacePaneState = initialWorkspacePaneState) => actions.reduce(workspacePaneReducer, from);
const rev = (name: string) => `rev-${name}-00000000` as FileRevision;

describe("opening files", () => {
  it("a single click opens a preview tab and shows the pane", () => {
    const state = run([{ type: "open", scope: scopeA, relativePath: "outputs/report.md", id: "t1" }]);
    expect(state.open).toBe(true);
    expect(state.compactView).toBe("workspace");
    expect(state.tabs).toEqual([{ id: "t1", scope: scopeA, relativePath: "outputs/report.md", mode: "preview", pinned: false, dirty: false }]);
    expect(state.activeTabId).toBe("t1");
  });

  it("the next single click reuses the clean preview tab instead of piling up tabs", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1" },
      { type: "open", scope: scopeA, relativePath: "b.txt", id: "t2" },
    ]);
    expect(state.tabs.map(tab => tab.relativePath)).toEqual(["b.txt"]);
    expect(state.tabs[0]!.id).toBe("t2");
    expect(state.activeTabId).toBe("t2");
  });

  it("Keep open and Edit make a tab persistent, so the next click opens beside it", () => {
    const pinned = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", pin: true },
      { type: "open", scope: scopeA, relativePath: "b.md", id: "t2" },
    ]);
    expect(pinned.tabs.map(tab => [tab.relativePath, tab.pinned])).toEqual([["a.md", true], ["b.md", false]]);
    const edited = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", mode: "edit" },
      { type: "open", scope: scopeA, relativePath: "b.md", id: "t2" },
    ]);
    expect(edited.tabs.map(tab => [tab.relativePath, tab.mode, tab.pinned])).toEqual([["a.md", "edit", true], ["b.md", "preview", false]]);
  });

  it("a dirty preview tab is never replaced", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1" },
      { type: "setDirty", id: "t1", dirty: true },
      { type: "open", scope: scopeA, relativePath: "b.md", id: "t2" },
    ]);
    expect(state.tabs.map(tab => tab.relativePath)).toEqual(["a.md", "b.md"]);
    // The dirty tab is not the one a later click may take over; the new one is.
    expect(replaceableTab(state.tabs)?.id).toBe("t2");
  });

  it("opening a file that is already open focuses its tab; asking to edit upgrades it in place", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", pin: true },
      { type: "open", scope: scopeA, relativePath: "b.md", id: "t2", pin: true },
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t3" },
    ]);
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("t1");
    const edit = workspacePaneReducer(state, { type: "open", scope: scopeA, relativePath: "a.md", mode: "edit" });
    expect(edit.tabs[0]).toMatchObject({ id: "t1", mode: "edit", pinned: true });
    // Asking to preview an edit tab never demotes it: its text may be unsaved.
    const again = workspacePaneReducer(edit, { type: "open", scope: scopeA, relativePath: "a.md", mode: "preview" });
    expect(again.tabs[0]!.mode).toBe("edit");
  });

  it("the same path in another conversation is a different file, and opening it changes no selection", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "notes.md", id: "t1", pin: true },
      { type: "open", scope: scopeB, relativePath: "notes.md", id: "t2", pin: true },
    ]);
    expect(state.tabs.map(tab => tab.scope.botId)).toEqual(["bot-a", "bot-b"]);
    // The reducer knows nothing about the selected conversation: nothing here
    // could change it.
    expect(Object.keys(state)).not.toContain("selectedId");
  });
});

describe("closing tabs", () => {
  it("closes a clean tab and moves to its neighbour", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", pin: true },
      { type: "open", scope: scopeA, relativePath: "b.md", id: "t2", pin: true },
      { type: "open", scope: scopeA, relativePath: "c.md", id: "t3", pin: true },
      { type: "activate", id: "t2" },
      { type: "close", id: "t2" },
    ]);
    expect(state.tabs.map(tab => tab.id)).toEqual(["t1", "t3"]);
    expect(state.activeTabId).toBe("t3");
    const last = run([{ type: "close", id: "t3" }], state);
    expect(last.activeTabId).toBe("t1");
    expect(run([{ type: "close", id: "t1" }], last).activeTabId).toBeNull();
  });

  it("refuses to close a dirty tab until the owner confirms, and changes nothing meanwhile", () => {
    const dirty = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", mode: "edit" },
      { type: "setDirty", id: "t1", dirty: true },
    ]);
    const asked = workspacePaneReducer(dirty, { type: "close", id: "t1" });
    expect(asked.tabs).toBe(dirty.tabs);
    expect(asked.closeRequest).toBe("t1");
    expect(workspacePaneReducer(asked, { type: "cancelClose" }).closeRequest).toBeNull();
    expect(workspacePaneReducer(asked, { type: "cancelClose" }).tabs).toBe(dirty.tabs);
    const forced = workspacePaneReducer(asked, { type: "close", id: "t1", force: true });
    expect(forced.tabs).toEqual([]);
    expect(forced.closeRequest).toBeNull();
  });

  it("a tab that became clean again closes without a question", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", mode: "edit" },
      { type: "setDirty", id: "t1", dirty: true },
      { type: "setDirty", id: "t1", dirty: false },
      { type: "close", id: "t1" },
    ]);
    expect(state.tabs).toEqual([]);
  });

  it("switching a dirty tab back to Preview is refused; Edit always pins", () => {
    const state = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1" },
      { type: "setMode", id: "t1", mode: "edit" },
    ]);
    expect(state.tabs[0]).toMatchObject({ mode: "edit", pinned: true });
    const dirty = workspacePaneReducer(state, { type: "setDirty", id: "t1", dirty: true });
    expect(workspacePaneReducer(dirty, { type: "setMode", id: "t1", mode: "preview" }).tabs[0]!.mode).toBe("edit");
    expect(workspacePaneReducer(state, { type: "setMode", id: "t1", mode: "preview" }).tabs[0]!.mode).toBe("preview");
  });
});

describe("layout state", () => {
  it("keeps the rail wide enough and the chat usable", () => {
    expect(clampWorkspaceWidth(100)).toBe(WORKSPACE_PANE_MIN_WIDTH);
    expect(clampWorkspaceWidth(Number.NaN)).toBe(WORKSPACE_PANE_DEFAULT_WIDTH);
    expect(clampWorkspaceWidth(900, 1000)).toBe(1000 - WORKSPACE_PANE_MIN_CHAT_WIDTH);
    // A container too small for both: the rail wins, at its minimum.
    expect(clampWorkspaceWidth(900, 500)).toBe(WORKSPACE_PANE_MIN_WIDTH);
    expect(clampWorkspaceWidth(500, 1400)).toBe(500);
  });

  it("stores a clamped width and ignores a no-op", () => {
    const state = run([{ type: "setWidth", width: 2000, containerWidth: 1200 }]);
    expect(state.width).toBe(1200 - WORKSPACE_PANE_MIN_CHAT_WIDTH);
    expect(workspacePaneReducer(state, { type: "setWidth", width: state.width })).toBe(state);
  });

  it("closing the pane keeps the tabs and drops expansion; show reopens on the workspace side", () => {
    const open = run([
      { type: "open", scope: scopeA, relativePath: "a.md", id: "t1", pin: true },
      { type: "setExpanded", expanded: true },
      { type: "setCompactView", view: "chat" },
    ]);
    const closed = workspacePaneReducer(open, { type: "setOpen", open: false });
    expect(closed).toMatchObject({ open: false, expanded: false, tabs: open.tabs });
    const shown = workspacePaneReducer(closed, { type: "show" });
    expect(shown).toMatchObject({ open: true, compactView: "workspace", activeTabId: "t1" });
    expect(activeWorkspaceTab(shown)?.relativePath).toBe("a.md");
  });

  it("returns the same state for actions that change nothing", () => {
    const state = run([{ type: "open", scope: scopeA, relativePath: "a.md", id: "t1" }]);
    expect(workspacePaneReducer(state, { type: "activate", id: "missing" })).toBe(state);
    expect(workspacePaneReducer(state, { type: "close", id: "missing" })).toBe(state);
    expect(workspacePaneReducer(state, { type: "setDirty", id: "t1", dirty: false })).toBe(state);
    expect(workspacePaneReducer(state, { type: "setExpanded", expanded: false })).toBe(state);
    expect(workspacePaneReducer(state, { type: "cancelClose" })).toBe(state);
  });
});

describe("document kinds and names", () => {
  it("routes files by extension and never guesses a binary as text", () => {
    expect(documentKindForPath("outputs/report.md")).toBe("markdown");
    expect(documentKindForPath("README.markdown")).toBe("markdown");
    expect(documentKindForPath("site/index.html")).toBe("html");
    expect(documentKindForPath("shots/one.PNG")).toBe("image");
    expect(documentKindForPath("data/rows.csv")).toBe("text");
    expect(documentKindForPath("Makefile")).toBe("text");
    expect(documentKindForPath("deck.pptx")).toBe("binary");
    expect(documentKindForPath("archive.tar.gz")).toBe("binary");
    expect(documentKindForPath("clip.mp4")).toBe("binary");
  });

  it("names a copy beside the original", () => {
    expect(copyPath("outputs/report.md")).toBe("outputs/report copy.md");
    expect(copyPath("outputs/report.md", 1)).toBe("outputs/report copy 2.md");
    expect(copyPath("notes")).toBe("notes copy");
  });
});

describe("transport", () => {
  const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body });

  it("keeps a workspace refusal's code and current revision", async () => {
    const fetchImpl = vi.fn(async () => response(409, { error: "The file changed.", code: "revision-conflict", currentRevision: rev("disk") }));
    await expect(workspaceApi("/api/workspace-files/write", { method: "POST", body: "{}" }, fetchImpl)).rejects.toMatchObject({
      name: "WorkspaceFileRequestError", code: "revision-conflict", currentRevision: rev("disk"), status: 409, message: "The file changed.",
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-murage-surface"]).toBe("desktop");
  });

  it("answers a plain failure with the status and no invented code", async () => {
    const fetchImpl = vi.fn(async () => response(500, { error: "boom" }));
    const error = await workspaceApi("/x", undefined, fetchImpl).catch(e => e);
    expect(error).not.toBeInstanceOf(WorkspaceFileRequestError);
    expect(error).toMatchObject({ status: 500, message: "boom" });
  });

  it("probes a revision from the parent listing, walking pages, and reports missing only when the walk finished", async () => {
    const pages: WorkspaceListResponse[] = [
      { scope: scopeA, root: { scope: scopeA, state: "ready", label: "w", managed: true }, directory: "outputs", directoryRevision: "d1", entries: [{ name: "other.md", relativePath: "outputs/other.md", kind: "file", state: "local", revision: rev("o") }], cursor: "c1", incomplete: true },
      { scope: scopeA, root: { scope: scopeA, state: "ready", label: "w", managed: true }, directory: "outputs", directoryRevision: "d1", entries: [{ name: "report.md", relativePath: "outputs/report.md", kind: "file", state: "local", revision: rev("r2") }], incomplete: false },
    ];
    const calls: string[] = [];
    const api = async (path: string) => { calls.push(path); return pages.shift()!; };
    const found = await probeWorkspaceRevision(api, scopeA, "outputs/report.md");
    expect(found).toEqual({ state: "found", entry: expect.objectContaining({ revision: rev("r2") }) });
    expect(calls[0]).toContain("directory=outputs");
    expect(calls[1]).toContain("cursor=c1");

    const empty = async () => ({ scope: scopeA, root: { scope: scopeA, state: "ready", label: "w", managed: true }, directory: "", directoryRevision: "d", entries: [], incomplete: false });
    expect(await probeWorkspaceRevision(empty, scopeA, "gone.md")).toEqual({ state: "missing" });
    const truncated = async () => ({ scope: scopeA, root: { scope: scopeA, state: "ready", label: "w", managed: true }, directory: "", directoryRevision: "d", entries: [], incomplete: true });
    expect(await probeWorkspaceRevision(truncated, scopeA, "big.md")).toEqual({ state: "unknown" });
    const folderGone = async () => { throw new WorkspaceFileRequestError("not-found"); };
    expect(await probeWorkspaceRevision(folderGone, scopeA, "outputs/x.md")).toEqual({ state: "missing" });
    const network = async () => { throw new TypeError("fetch failed"); };
    expect(await probeWorkspaceRevision(network, scopeA, "outputs/x.md")).toEqual({ state: "unknown" });
  });
});
