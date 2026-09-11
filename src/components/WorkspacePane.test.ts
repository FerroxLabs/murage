// F4-T3: the workspace pane beside the chat.
//
// Node, no DOM, like every component test here: the first paint of the pane
// surface goes through `renderToStaticMarkup`, the editor registry's save
// discipline is driven with real MarkdownEditorControllers over a shared
// transport, and the wiring the browser proof depends on is pinned in
// source. Dragging, tab switching in a real renderer, saving bytes to disk
// and the compact overlay are proved in src/e2e/workspace-pane.human.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileRevision, SaveReceipt, WorkspaceReadResult, WorkspaceWriteRequest } from "../../shared/workspace-files";
import { createDocumentSessionStore, hasUnsavedChanges, openDocumentSession } from "@/lib/document-session";
import { initialWorkspacePaneState, workspacePaneReducer, type WorkspacePaneAction, type WorkspacePaneState } from "@/lib/workspace-pane";
import { MarkdownEditorController } from "./MarkdownEditor";
import { WorkspacePaneSurface, readErrorMessage, scopeLabel, type WorkspacePaneSurfaceProps } from "./WorkspacePane";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const scopeA = { botId: "research", threadId: "task" };
const scopeB = { botId: "ops", threadId: "ops-task" };
const bots = [
  { id: "research", name: "Research bot", threadId: "task", tasks: [{ threadId: "task", title: "Weekly report" }] },
  { id: "ops", name: "Ops bot", threadId: "ops-task" },
];
const label = (scope: { botId: string; threadId: string }) => scopeLabel(bots, scope);
const pane = (actions: WorkspacePaneAction[], from: WorkspacePaneState = initialWorkspacePaneState) => actions.reduce(workspacePaneReducer, from);
const never = async () => new Promise<never>(() => {});
const render = (props: Partial<WorkspacePaneSurfaceProps> & { pane: WorkspacePaneState }) =>
  renderToStaticMarkup(createElement(WorkspacePaneSurface, { scope: scopeA, dispatch: () => {}, labelForScope: label, api: never, narrow: false, ...props }));

describe("first paint", () => {
  it("names the conversation whose files it lists, and asks for one when there is none", () => {
    const markup = render({ pane: pane([{ type: "show" }]) });
    expect(markup).toContain('data-testid="workspace-pane-scope"');
    expect(markup).toContain("Research bot · Weekly report");
    expect(markup).toContain("Open a file from the list to preview it here.");
    expect(render({ pane: pane([{ type: "show" }]), scope: null })).toContain("Select a conversation to see its workspace.");
    expect(scopeLabel(bots, scopeB)).toBe("Ops bot · this task");
  });

  it("is a resizable rail on a wide screen and a covering overlay below md", () => {
    const rail = render({ pane: pane([{ type: "show" }]) });
    expect(rail).toContain('data-layout="rail"');
    expect(rail).toContain('role="separator"');
    expect(rail).toContain('aria-orientation="vertical"');
    expect(rail).toContain("width:440px");
    expect(rail).toContain("max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full");
    expect(rail).not.toContain("Back to chat");

    const expanded = render({ pane: pane([{ type: "show" }, { type: "setExpanded", expanded: true }]) });
    expect(expanded).toContain('data-layout="expanded"');
    expect(expanded).not.toContain('role="separator"');
    expect(expanded).toContain('aria-label="Show chat beside"');

    const compact = render({ pane: pane([{ type: "show" }]), narrow: true });
    expect(compact).toContain('data-layout="compact"');
    expect(compact).toContain("Back to chat");
    expect(compact).not.toContain('role="separator"');
    expect(compact).not.toMatch(/<aside[^>]*\shidden/);
    // Back to chat hides the pane but keeps it mounted, so its drafts survive.
    const backInChat = render({ pane: pane([{ type: "show" }, { type: "setCompactView", view: "chat" }]), narrow: true });
    expect(backInChat).toMatch(/<aside[^>]*\shidden=""/);
    expect(render({ pane: pane([{ type: "show" }, { type: "setCompactView", view: "chat" }]), narrow: false })).not.toMatch(/<aside[^>]*\shidden/);
  });

  it("shows every open tab with its state, and names another conversation's file as such", () => {
    const state = pane([
      { type: "open", scope: scopeA, relativePath: "outputs/report.md", id: "t1", mode: "edit" },
      { type: "setDirty", id: "t1", dirty: true },
      { type: "open", scope: scopeB, relativePath: "notes.md", id: "t2" },
      { type: "activate", id: "t1" },
    ]);
    const markup = render({ pane: state });
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/data-tab-id="t1" data-dirty="true"/);
    expect(markup).toContain('aria-label="report.md has unsaved changes"');
    expect(markup).toMatch(/data-tab-id="t2"[^>]*data-preview="true"/);
    expect(markup).toContain("notes.md (preview tab, replaced by the next file you open) — From Ops bot · this task");
    expect(markup).toContain('aria-label="Close report.md"');
    expect(markup).toContain('aria-label="Close notes.md"');
    // The active tab's document is mounted; it is still loading on first paint.
    expect(markup).toMatch(/data-testid="workspace-document" data-tab-id="t1" data-mode="edit"/);
    expect(markup).toContain("Opening report.md…");
  });

  it("asks before a dirty tab closes, with both answers", () => {
    const state = pane([
      { type: "open", scope: scopeA, relativePath: "outputs/report.md", id: "t1", mode: "edit" },
      { type: "setDirty", id: "t1", dirty: true },
      { type: "close", id: "t1" },
    ]);
    const markup = render({ pane: state });
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Close without saving?");
    expect(markup).toContain("report.md has unsaved changes. The file on disk stays as it is");
    expect(markup).toContain(">Keep editing</button>");
    expect(markup).toContain(">Close anyway</button>");
  });

  it("never shows a blank for a file it cannot read", () => {
    expect(readErrorMessage("too-large", "big.md")).toBe("This file is larger than the preview limit. Open it in its app or show it in its folder.");
    expect(readErrorMessage("unsupported-encoding", "x.txt")).toContain("not UTF-8 text");
    expect(readErrorMessage("not-found", "gone.md")).toBe("This file is no longer at that location.");
    expect(readErrorMessage("unknown", "a.md", "Disk on fire")).toBe("Disk on fire");
    expect(readErrorMessage(null, "a.md")).toBe("a.md could not be read.");
  });
});

// ── Save discipline across tabs ─────────────────────────────────────────

const rev = (name: string) => `rev-${name}-00000000` as FileRevision;
const readOf = (scope: { botId: string; threadId: string }, relativePath: string, content: string, revision = rev("r0")): WorkspaceReadResult =>
  ({ scope, relativePath, revision, encoding: "utf-8", bom: false, newline: "lf", bytes: content.length, modifiedAt: 1, content });
const receiptFor = (request: WorkspaceWriteRequest, revision: FileRevision): SaveReceipt => ({
  requestId: request.requestId, scope: request.scope, relativePath: request.relativePath, previousRevision: request.baseRevision,
  revision, bytes: request.content.length, savedAt: 5_000, ...(request.draftRevision !== undefined ? { draftRevision: request.draftRevision } : {}),
});
const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };

const controllers: MarkdownEditorController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose(); });

/** One shared transport, as the pane has, whose acknowledgements are held. */
function sharedTransport() {
  const held: Array<{ request: WorkspaceWriteRequest; resolve: (receipt: SaveReceipt) => void }> = [];
  const disk = new Map<string, string>();
  const save = vi.fn((request: WorkspaceWriteRequest) => new Promise<SaveReceipt>(resolve => held.push({ request, resolve })));
  const ack = (index: number, revision: FileRevision) => {
    const item = held[index]!;
    disk.set(item.request.relativePath, item.request.content);
    item.resolve(receiptFor(item.request, revision));
  };
  return { held, disk, save, ack };
}

function editorFor(read: WorkspaceReadResult, save: (request: WorkspaceWriteRequest) => Promise<SaveReceipt>, dirty: boolean[]) {
  const session = createDocumentSessionStore(openDocumentSession(read, { mode: "source" }));
  let ids = 0;
  const controller = new MarkdownEditorController({ session, save, drafts: null, initialMode: "source", createRequestId: () => `${read.relativePath}#${++ids}`, connect: false });
  // The pane mirrors this into the tab's dirty flag.
  session.subscribe(() => { dirty.push(hasUnsavedChanges(session.getState())); });
  controller.connect();
  controllers.push(controller);
  return { session, controller };
}

describe("one editor per tab over one transport", () => {
  it("a receipt settles only the tab whose request it answers, even after switching tabs and typing", async () => {
    const transport = sharedTransport();
    const dirtyA: boolean[] = [], dirtyB: boolean[] = [];
    const a = editorFor(readOf(scopeA, "outputs/report.md", "# Report\n"), transport.save, dirtyA);
    const b = editorFor(readOf(scopeA, "outputs/notes.md", "notes\n"), transport.save, dirtyB);

    a.controller.editSource("# Report\n\nfirst\n");
    const saveA = a.controller.save();
    expect(a.session.getState().status).toBe("saving");
    // The person switches to the other tab and types there while A's save is
    // still in flight.
    b.controller.editSource("notes\nmore\n");
    expect(hasUnsavedChanges(b.session.getState())).toBe(true);

    transport.ack(0, rev("a1"));
    await expect(saveA).resolves.toEqual({ status: "saved", stillDirty: false });
    expect(a.session.getState()).toMatchObject({ status: "clean", baseRevision: rev("a1"), savedContent: "# Report\n\nfirst\n" });
    // B never heard about A's receipt: still dirty, still on its own base.
    expect(b.session.getState()).toMatchObject({ status: "dirty", baseRevision: rev("r0"), draft: "notes\nmore\n" });
    expect(dirtyB.at(-1)).toBe(true);
    expect(dirtyA.at(-1)).toBe(false);
    expect(transport.disk.get("outputs/notes.md")).toBeUndefined();
  });

  it("typing during a save leaves the newer text unsaved when the receipt lands", async () => {
    const transport = sharedTransport();
    const dirty: boolean[] = [];
    const a = editorFor(readOf(scopeA, "outputs/report.md", "one\n"), transport.save, dirty);
    a.controller.editSource("two\n");
    const saving = a.controller.save();
    a.controller.editSource("three\n");
    transport.ack(0, rev("a1"));
    await expect(saving).resolves.toEqual({ status: "saved", stillDirty: true });
    expect(transport.disk.get("outputs/report.md")).toBe("two\n");
    const state = a.session.getState();
    expect(state).toMatchObject({ status: "dirty", baseRevision: rev("a1"), savedContent: "two\n", draft: "three\n" });
    expect(dirty.at(-1)).toBe(true);
    // The next save is conditioned on the revision the first one produced.
    const second = a.controller.save();
    expect(transport.held[1]!.request.baseRevision).toBe(rev("a1"));
    transport.ack(1, rev("a2"));
    await expect(second).resolves.toEqual({ status: "saved", stillDirty: false });
  });

  it("a receipt that arrives after its tab closed is recorded on that closed document only", async () => {
    const transport = sharedTransport();
    const a = editorFor(readOf(scopeA, "outputs/report.md", "one\n"), transport.save, []);
    const b = editorFor(readOf(scopeA, "outputs/notes.md", "notes\n"), transport.save, []);
    a.controller.editSource("two\n");
    b.controller.editSource("notes\nmore\n");
    const saving = a.controller.save();
    // The tab is closed (the pane disposes its editor) before the answer.
    await a.controller.dispose();
    transport.ack(0, rev("a1"));
    // The write did happen, so the closed document says so rather than
    // pretending nothing was saved (its draft is cleared); the tab that is
    // still open never hears about it.
    await expect(saving).resolves.toEqual({ status: "saved", stillDirty: false });
    expect(a.session.getState()).toMatchObject({ closed: true, baseRevision: rev("a1") });
    expect(b.session.getState()).toMatchObject({ status: "dirty", baseRevision: rev("r0"), draft: "notes\nmore\n" });
    await settle();
  });

  it("an external change is a quiet reload for a clean tab and a conflict for a dirty one", () => {
    const transport = sharedTransport();
    const clean = editorFor(readOf(scopeA, "a.md", "one\n"), transport.save, []);
    clean.controller.observeDisk({ revision: rev("d1"), content: "one\ntwo\n", bom: false, newline: "lf" });
    expect(clean.session.getState()).toMatchObject({ status: "clean", baseRevision: rev("d1"), draft: "one\ntwo\n", conflict: null });

    const dirty = editorFor(readOf(scopeA, "b.md", "one\n"), transport.save, []);
    dirty.controller.editSource("mine\n");
    dirty.controller.observeDisk({ revision: rev("d2"), content: "theirs\n", bom: false, newline: "lf" });
    expect(dirty.session.getState()).toMatchObject({ status: "conflict", draft: "mine\n", conflict: { source: "external-change", currentRevision: rev("d2") } });
  });
});

// ── Wiring the browser proof depends on ─────────────────────────────────

describe("wiring", () => {
  const chat = read("./ChatView.tsx");
  const dialog = read("./FilesDialog.tsx");
  const files = read("./Files.tsx");
  const workspaceFiles = read("./WorkspaceFiles.tsx");
  const cards = read("./ArtifactCards.tsx");
  const surface = read("./WorkspacePane.tsx");

  it("mounts the pane beside the chat column, which only collapses above md", () => {
    expect(chat).toContain('<main className="relative flex h-full min-w-0 flex-1 flex-row bg-app">');
    expect(chat).toContain('data-testid="chat-column"');
    expect(chat).toContain("md:data-collapsed:invisible md:data-collapsed:w-0");
    expect(chat).toContain("<WorkspacePane bot={bot} />");
  });

  it("Files opens a file beside the chat by scope and relative path, and leaves the selection alone", () => {
    expect(dialog).toContain('dispatch({ type: "workspacePane", action: { type: "open", scope, relativePath, mode } })');
    expect(dialog).not.toMatch(/openInPane[\s\S]{0,300}type: "select"/);
    expect(files).toContain("onOpenInPane={onOpenInPane}");
    expect(workspaceFiles).toContain('data-pane-action="preview"');
    expect(workspaceFiles).toContain('data-pane-action="edit"');
    // Open here on a saved version reaches the WORKING file, only while it is current.
    expect(files).toContain('onOpenHere && artifact.sourceState === "current"');
    expect(cards).toContain('action: { type: "open", scope: { botId: artifact.botId, threadId: artifact.threadId }, relativePath: artifact.relativePath, mode: "preview" }');
  });

  it("keeps one editor per edit tab and only disposes it when the tab is gone", () => {
    expect(surface).toContain("const editors = useRef(new Map<string, EditorEntry>())");
    expect(surface).toMatch(/if \(tab && tab\.mode === "edit" && tabKey\(tab\) === entry\.key\) continue;[\s\S]{0,200}void entry\.controller\.dispose\(\)/);
    expect(surface).toContain('dispatch({ type: "setDirty", id: tab.id, dirty: next })');
  });

  it("notices external changes by probing the revision and handing it to the session", () => {
    expect(surface).toContain("probeWorkspaceRevision(api, identity.scope, identity.relativePath)");
    expect(surface).toContain("latest.entry.controller.observeDisk({ revision: read.revision, content: read.content, bom: read.bom, newline: read.newline })");
    expect(surface).toMatch(/if \(result\.entry\.revision === known\) return;/);
  });

  it("renders untrusted HTML only inside the protected preview", () => {
    expect(surface).toMatch(/<iframe[^>]*sandbox=""[^>]*srcDoc=\{artifactPreviewHtml\(load\.read\.content\)\}/);
    expect(surface).not.toContain("dangerouslySetInnerHTML");
  });
});
