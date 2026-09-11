// F4-T4: the Markdown editor surface. Named `.test.ts` like every component
// test here (node environment, no jsdom): the controller is driven with a
// real headless Tiptap 3.31.3 editor, and markup goes through
// `renderToStaticMarkup`. Assertions observe the bytes a save would write,
// the draft store contents and editor update events, not labels alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileRevision, SaveReceipt, WorkspaceReadResult, WorkspaceWriteRequest } from "../../shared/workspace-files";
import { WorkspaceFileRequestError, createDocumentSessionStore, documentKey, editDocument, openDocumentSession } from "@/lib/document-session";
import { createMarkdownDraftStore, createMemoryDraftBackend, type MarkdownDraftStore } from "@/lib/markdown-drafts";
import { createMarkdownExtensions } from "@/lib/markdown-fidelity";
import {
  MarkdownEditor,
  MarkdownEditorController,
  draftStatusMessage,
  fileStatusMessage,
  type ScheduleTimer,
} from "./MarkdownEditor";

const rev = (name: string) => `rev-${name}-00000000` as FileRevision;
const corpus = (file: string) => fileURLToPath(new URL(`../lib/__fixtures__/markdown-corpus/${file}`, import.meta.url));

/** The F4-T1 read contract for a corpus file: strict UTF-8, BOM removed. */
function readCorpus(file: string, revision = rev("r0")): WorkspaceReadResult {
  const bytes = readFileSync(corpus(file));
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  return {
    scope: { botId: "bot-a", threadId: "thread-1" },
    relativePath: `outputs/${file}`,
    revision,
    encoding: "utf-8",
    bom,
    newline: content.includes("\r\n") ? "crlf" : content.includes("\n") ? "lf" : "none",
    bytes: bytes.byteLength,
    modifiedAt: 1,
    content,
  };
}

function manualScheduler() {
  const tasks = new Map<number, () => void>();
  let next = 0;
  const schedule: ScheduleTimer = callback => {
    const id = ++next;
    tasks.set(id, callback);
    return () => tasks.delete(id);
  };
  return {
    schedule,
    pending: () => tasks.size,
    flush() {
      const due = [...tasks.values()];
      tasks.clear();
      for (const task of due) task();
    },
  };
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

function receiptFor(request: WorkspaceWriteRequest, revision: FileRevision): SaveReceipt {
  return {
    requestId: request.requestId,
    scope: request.scope,
    relativePath: request.relativePath,
    previousRevision: request.baseRevision,
    revision,
    bytes: request.content.length,
    savedAt: 5_000,
    ...(request.draftRevision !== undefined ? { draftRevision: request.draftRevision } : {}),
  };
}

const editors: Editor[] = [];
const controllers: MarkdownEditorController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const editor of editors.splice(0)) editor.destroy();
});

function setup(read: WorkspaceReadResult, options: { drafts?: MarkdownDraftStore | null; save?: (request: WorkspaceWriteRequest) => Promise<SaveReceipt>; readDisk?: () => Promise<WorkspaceReadResult>; initialMode?: "auto" | "source"; connect?: boolean } = {}) {
  const session = createDocumentSessionStore(openDocumentSession(read));
  const backend = createMemoryDraftBackend();
  const drafts = options.drafts === undefined ? createMarkdownDraftStore(backend) : options.drafts;
  const scheduler = manualScheduler();
  const writes: WorkspaceWriteRequest[] = [];
  let ids = 0;
  const save = vi.fn(options.save ?? (async (request: WorkspaceWriteRequest) => receiptFor(request, rev(`w${writes.length}`))));
  const controller = new MarkdownEditorController({
    session,
    save: request => {
      writes.push(request);
      return save(request);
    },
    ...(options.readDisk ? { readDisk: options.readDisk } : {}),
    drafts,
    schedule: scheduler.schedule,
    createRequestId: () => `req-${++ids}`,
    ...(options.initialMode ? { initialMode: options.initialMode } : {}),
    ...(options.connect !== undefined ? { connect: options.connect } : {}),
  });
  controllers.push(controller);
  return { session, backend, drafts, scheduler, writes, save, controller };
}

/** A real, unmounted Tiptap editor wired exactly like the React surface. */
function attachHeadlessEditor(controller: MarkdownEditorController) {
  const body = controller.richBody();
  if (body === null) throw new Error("document is not in rich mode");
  const editor = new Editor({ element: null, injectCSS: false, extensions: createMarkdownExtensions(), content: body, contentType: "markdown" });
  editors.push(editor);
  const updates = { count: 0 };
  editor.on("update", () => { updates.count += 1; });
  controller.attachRichEditor(editor);
  return { editor, updates };
}

/** Type into the end of the first block, the way a keystroke transaction does. */
function typeAtEndOfFirstBlock(editor: Editor, text: string) {
  editor.commands.command(({ tr }) => {
    tr.insertText(text, tr.doc.firstChild!.nodeSize - 1);
    return true;
  });
}

describe("opening and viewing", () => {
  it("opens a proven file in rich mode and viewing, waiting and closing write nothing", async () => {
    const read = readCorpus("rich-crlf-frontmatter-bom.md");
    const { session, controller, scheduler, writes, backend, save } = setup(read);
    expect(session.getState().mode).toBe("rich");
    const { editor, updates } = attachHeadlessEditor(controller);
    expect(editor.getMarkdown()).toBe("# Windows file\n\n- item one\n- item two\n\n```js\nconsole.log(\"x\");\n```");
    scheduler.flush();
    await settle();
    expect(updates.count).toBe(0);
    expect(session.getState()).toMatchObject({ status: "clean", draft: read.content, draftRevision: 0 });
    expect(await controller.save()).toEqual({ status: "refused", refused: "unchanged" });
    await controller.dispose();
    expect(save).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(backend.records()).toEqual([]);
  });

  it("opens a file the gate refuses in Source mode on its exact text and explains why", () => {
    const read = readCorpus("source-table.md");
    const { session, controller } = setup(read);
    expect(session.getState().mode).toBe("source");
    expect(controller.setMode("rich")).toBe(false);
    expect(session.getState().mode).toBe("source");
    expect(controller.getSnapshot().view).toMatchObject({ richBlockedBy: ["unsupported-syntax"], unsupportedSyntax: ["table"] });
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain("Rich editing is off: this file uses Markdown the rich editor would change (table). Source mode keeps every byte.");
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*disabled=""[^>]*>Rich<\/button>/);
    expect(html).toContain(`>| Name | Score |\n| --- | --- |\n| a \\| b | 1 |\n</textarea>`);
  });

  it("keeps mixed newlines in Source mode and saves them verbatim", async () => {
    const read = readCorpus("source-mixed-newlines.md");
    const { controller, writes, session } = setup(read);
    expect(controller.getSnapshot().view.richBlockedBy).toEqual(["mixed-newlines"]);
    controller.editSource(`${read.content}More.\r\n`);
    await controller.save();
    expect(writes[0]).toMatchObject({ content: "# Mixed\r\n\nCRLF then LF.\nMore.\r\n", bom: false });
    expect(session.getState().status).toBe("clean");
  });

  it("can start in Source mode and switch to rich only for a proven text", () => {
    const { session, controller } = setup(readCorpus("rich-basic.md"), { initialMode: "source" });
    expect(session.getState().mode).toBe("source");
    expect(controller.setMode("rich")).toBe(true);
    expect(session.getState().mode).toBe("rich");
    expect(controller.richBody()).toContain("# Quarterly report");
  });
});

describe("editing and saving", () => {
  it("serializes a rich edit into the file's BOM, CRLF and frontmatter and clears the draft once saved", async () => {
    const read = readCorpus("rich-crlf-frontmatter-bom.md");
    const { session, controller, scheduler, writes, backend } = setup(read);
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " (edited)");
    const dirty = session.getState();
    expect(dirty.status).toBe("dirty");
    expect(dirty.draft).toBe(read.content.replace("# Windows file", "# Windows file (edited)"));

    expect(controller.getSnapshot().view.draftStatus).toBe("pending");
    scheduler.flush();
    await settle();
    expect(backend.records()).toMatchObject([{ key: documentKey(dirty.identity), content: dirty.draft, baseRevision: rev("r0"), draftRevision: 1 }]);
    expect(draftStatusMessage(controller.getSnapshot().view)).toBe("Draft preserved");
    expect(fileStatusMessage(session.getState())).toBe("Unsaved changes");

    expect(await controller.save()).toEqual({ status: "saved", stillDirty: false });
    expect(writes).toEqual([{
      scope: { botId: "bot-a", threadId: "thread-1" },
      relativePath: "outputs/rich-crlf-frontmatter-bom.md",
      baseRevision: rev("r0"),
      requestId: "req-1",
      content: dirty.draft,
      bom: true,
      draftRevision: 1,
    }]);
    expect(writes[0]!.content.replace(/\r\n/g, "")).not.toContain("\n");
    await settle();
    expect(session.getState()).toMatchObject({ status: "clean", baseRevision: rev("w1") });
    expect(backend.records()).toEqual([]);
    expect(fileStatusMessage(session.getState())).toBe("File saved");
    expect(draftStatusMessage(controller.getSnapshot().view)).toBeNull();
  });

  it("keeps typing that continued during a save dirty and keeps its newer draft", async () => {
    let answer!: (receipt: SaveReceipt) => void;
    const { session, controller, scheduler, backend, writes } = setup(readCorpus("rich-basic.md"), {
      save: () => new Promise(resolve => { answer = resolve; }),
    });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " v1");
    scheduler.flush();
    await settle();
    const saving = controller.save();
    expect(session.getState().status).toBe("saving");
    typeAtEndOfFirstBlock(editor, " v2");
    answer(receiptFor(writes[0]!, rev("w1")));
    expect(await saving).toEqual({ status: "saved", stillDirty: true });
    scheduler.flush();
    await settle();
    const state = session.getState();
    expect(state).toMatchObject({ status: "dirty", baseRevision: rev("w1"), savedDraftRevision: 1, draftRevision: 2 });
    expect(state.savedContent).toContain("# Quarterly report v1\n");
    expect(state.draft).toContain("# Quarterly report v1 v2\n");
    expect(backend.records()).toMatchObject([{ draftRevision: 2, baseRevision: rev("w1") }]);
  });

  it("never announces a failed save and keeps both the text and its draft", async () => {
    const { session, controller, scheduler, backend } = setup(readCorpus("rich-basic.md"), {
      save: async () => { throw new WorkspaceFileRequestError("bot-writing", "Bot is writing"); },
    });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, "!");
    scheduler.flush();
    await settle();
    expect(await controller.save()).toEqual({ status: "failed", code: "bot-writing" });
    await settle();
    expect(session.getState()).toMatchObject({ status: "error", lastSave: null, baseRevision: rev("r0") });
    expect(session.getState().draft).toContain("# Quarterly report!");
    expect(backend.records()).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain("File not saved: a bot is writing to this workspace.");
    expect(html).not.toContain("File saved");
  });

  it("discards back to the disk text without emitting an edit and clears the draft", async () => {
    const read = readCorpus("rich-basic.md");
    const { session, controller, scheduler, backend } = setup(read);
    const { editor, updates } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, "!");
    scheduler.flush();
    await settle();
    const before = updates.count;
    expect(controller.discard()).toBe(true);
    await settle();
    expect(updates.count).toBe(before);
    expect(editor.getMarkdown()).toBe(read.content.replace(/\n+$/, ""));
    expect(session.getState()).toMatchObject({ status: "clean", draft: read.content });
    expect(backend.records()).toEqual([]);
    expect(scheduler.pending()).toBe(0);
  });
});

describe("reloads and conflicts", () => {
  it("applies an external change while clean with emitUpdate false, so it never becomes a save or a draft", async () => {
    const { session, controller, scheduler, writes, backend } = setup(readCorpus("rich-basic.md"));
    const { editor, updates } = attachHeadlessEditor(controller);
    controller.observeDisk({ revision: rev("r2"), content: "# Rewritten by the bot\n\nNew body.\n", bom: false, newline: "lf" });
    expect(editor.getMarkdown()).toBe("# Rewritten by the bot\n\nNew body.");
    expect(updates.count).toBe(0);
    expect(session.getState()).toMatchObject({ status: "clean", baseRevision: rev("r2"), mode: "rich" });
    expect(scheduler.pending()).toBe(0);
    expect(await controller.save()).toEqual({ status: "refused", refused: "unchanged" });
    await settle();
    expect(writes).toEqual([]);
    expect(backend.records()).toEqual([]);
  });

  it("falls back to Source mode when a reload brings syntax the rich editor would change", () => {
    const { session, controller } = setup(readCorpus("rich-basic.md"));
    const { editor, updates } = attachHeadlessEditor(controller);
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    controller.observeDisk({ revision: rev("r2"), content: table, bom: false });
    expect(session.getState()).toMatchObject({ mode: "source", draft: table, status: "clean" });
    expect(updates.count).toBe(0);
    expect(editor.getMarkdown()).toContain("Quarterly report");
    expect(controller.getSnapshot().view.richBlockedBy).toEqual(["unsupported-syntax"]);
  });

  it("raises a conflict for an external change while dirty and reloads the disk version only on request", async () => {
    const { session, controller, scheduler, backend } = setup(readCorpus("rich-basic.md"));
    const { editor, updates } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " mine");
    scheduler.flush();
    await settle();
    controller.observeDisk({ revision: rev("r2"), content: "# Theirs\n", bom: false });
    const conflicted = session.getState();
    expect(conflicted).toMatchObject({ status: "conflict", conflict: { source: "external-change", disk: { content: "# Theirs\n" } } });
    expect(conflicted.draft).toContain("Quarterly report mine");
    expect(await controller.save()).toEqual({ status: "refused", refused: "conflict" });

    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain("This file changed on disk");
    expect(html).toContain("Use the disk version");
    expect(html).toContain("Keep my version");

    const before = updates.count;
    expect(await controller.resolveConflict("reload")).toBe(true);
    await settle();
    expect(updates.count).toBe(before);
    expect(editor.getMarkdown()).toBe("# Theirs");
    expect(session.getState()).toMatchObject({ status: "clean", baseRevision: rev("r2"), draft: "# Theirs\n" });
    expect(backend.records()).toEqual([]);
  });

  it("keeps my version on request and conditions the next save on the disk revision", async () => {
    const { session, controller, writes } = setup(readCorpus("rich-basic.md"));
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " mine");
    controller.observeDisk({ revision: rev("r2"), content: "# Theirs\n", bom: false });
    expect(await controller.resolveConflict("keep-mine")).toBe(true);
    expect(session.getState()).toMatchObject({ status: "dirty", baseRevision: rev("r2") });
    await controller.save();
    expect(writes[0]).toMatchObject({ baseRevision: rev("r2") });
    expect(writes[0]!.content).toContain("Quarterly report mine");
  });

  it("reads the disk after a rejected save so both versions can be compared", async () => {
    const disk = { ...readCorpus("rich-basic.md", rev("r7")), content: "# Changed by a bot\n" };
    const { session, controller } = setup(readCorpus("rich-basic.md"), {
      save: async () => { throw { code: "revision-conflict", error: "changed", currentRevision: rev("r7") }; },
      readDisk: async () => disk,
    });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " mine");
    expect(await controller.save()).toEqual({ status: "conflict" });
    await settle();
    expect(session.getState()).toMatchObject({ status: "conflict", conflict: { source: "save-rejected", currentRevision: rev("r7"), disk: { content: "# Changed by a bot\n" } } });
    expect(session.getState().draft).toContain("Quarterly report mine");
  });
});

describe("drafts", () => {
  it("shows a visible error when the draft bound refuses a draft, and never drops the text", async () => {
    const backend = createMemoryDraftBackend();
    const drafts = createMarkdownDraftStore(backend, { maxCount: 0 });
    const { session, controller, scheduler } = setup(readCorpus("rich-basic.md"), { drafts });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, "!");
    scheduler.flush();
    await settle();
    expect(controller.getSnapshot().view).toMatchObject({ draftStatus: "failed", draftError: "draft-count-exceeded" });
    expect(session.getState().draft).toContain("Quarterly report!");
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toMatch(/role="alert"[^>]*>Draft not preserved: at most 50 documents can keep unsaved drafts/);
    expect(html).not.toContain("Draft preserved<");
  });

  it("restores a preserved draft into a reopened document", async () => {
    const read = readCorpus("rich-basic.md");
    const backend = createMemoryDraftBackend();
    const drafts = createMarkdownDraftStore(backend, { now: () => 42 });
    const first = setup(read, { drafts });
    const { editor } = attachHeadlessEditor(first.controller);
    typeAtEndOfFirstBlock(editor, " unsaved");
    await first.controller.dispose();
    expect(backend.records()).toMatchObject([{ draftRevision: 1, updatedAt: 42 }]);

    const second = setup(read, { drafts });
    expect(await second.controller.restoreDraft()).toBe(true);
    expect(second.session.getState()).toMatchObject({ status: "dirty", mode: "rich" });
    expect(second.session.getState().draft).toContain("Quarterly report unsaved");
    expect(second.controller.getSnapshot().view).toMatchObject({ recoveredDraftAt: 42, draftStatus: "preserved" });
    const { editor: reopened, updates } = attachHeadlessEditor(second.controller);
    expect(reopened.getMarkdown()).toContain("# Quarterly report unsaved");
    expect(updates.count).toBe(0);
    expect(renderToStaticMarkup(createElement(MarkdownEditor, { controller: second.controller }))).toContain("Recovered unsaved draft");
  });

  it("clears a stored draft that holds nothing beyond the file", async () => {
    const read = readCorpus("rich-basic.md");
    const backend = createMemoryDraftBackend();
    const drafts = createMarkdownDraftStore(backend);
    await drafts.preserve({ scope: read.scope, relativePath: read.relativePath }, { baseRevision: rev("r0"), content: read.content, draftRevision: 3 });
    const { controller } = setup(read, { drafts });
    expect(await controller.restoreDraft()).toBe(false);
    await settle();
    expect(backend.records()).toEqual([]);
  });

  it("works without a draft store", async () => {
    const { session, controller, scheduler } = setup(readCorpus("rich-basic.md"), { drafts: null });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, "!");
    expect(scheduler.pending()).toBe(0);
    expect(await controller.save()).toEqual({ status: "saved", stillDirty: false });
    expect(session.getState().status).toBe("clean");
  });
});

describe("draft and conflict races", () => {
  it("clears a draft whose preserve was still in flight when the disk version was chosen", async () => {
    const memory = createMemoryDraftBackend();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let gated = true;
    const drafts = createMarkdownDraftStore({
      async transact(plan, options) {
        if (gated && options.write) {
          gated = false;
          await gate;
        }
        return memory.transact(plan, options);
      },
    });
    const { session, controller, scheduler } = setup(readCorpus("rich-basic.md"), { drafts });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " mine");
    scheduler.flush();
    // The preserve is now waiting inside the store.
    controller.observeDisk({ revision: rev("r2"), content: "# Theirs\n", bom: false });
    expect(await controller.resolveConflict("reload")).toBe(true);
    expect(session.getState().status).toBe("clean");
    release();
    await settle();
    expect(memory.records()).toEqual([]);
    expect(controller.getSnapshot().view.draftStatus).toBe("idle");
  });

  it("reports a conflict as resolved when reading the disk shows it already holds this draft", async () => {
    const read = readCorpus("rich-basic.md");
    let draftText = "";
    const { session, controller } = setup(read, {
      save: async request => {
        draftText = request.content;
        throw new WorkspaceFileRequestError("revision-conflict", "changed", rev("r3"));
      },
      readDisk: async () => ({ ...read, revision: rev("r3"), content: draftText }),
    });
    controller.setMode("source");
    controller.editSource(`${read.content}\nAdded in Source mode.\n`);
    expect(await controller.save()).toEqual({ status: "conflict" });
    await settle();
    // The unknown-outcome write had landed: the disk already holds the draft.
    expect(session.getState()).toMatchObject({ status: "clean", baseRevision: rev("r3"), conflict: null });
    expect(await controller.resolveConflict("keep-mine")).toBe(true);
  });
});

describe("failures stay visible (fix round 1)", () => {
  const rejectSave = async (): Promise<SaveReceipt> => { throw new WorkspaceFileRequestError("revision-conflict", "changed", rev("r7")); };

  it("says why a conflict cannot be resolved when the disk read fails, and reads again on request", async () => {
    const read = readCorpus("rich-basic.md");
    let failRead = true;
    const { session, controller } = setup(read, {
      save: rejectSave,
      readDisk: async () => {
        if (failRead) throw new TypeError("Failed to fetch");
        return { ...read, revision: rev("r7"), content: "# Changed by a bot\n" };
      },
    });
    const { editor } = attachHeadlessEditor(controller);
    typeAtEndOfFirstBlock(editor, " mine");
    expect(await controller.save()).toEqual({ status: "conflict" });
    await settle();
    expect(session.getState().conflict).toMatchObject({ source: "save-rejected", disk: null });
    expect(controller.getSnapshot().view.conflictRead).toEqual({ status: "failed", code: "network" });
    // Pressing a choice reads again; it fails again, and says so.
    expect(await controller.resolveConflict("reload")).toBe(false);
    expect(controller.getSnapshot().view.conflictRead).toEqual({ status: "failed", code: "network" });
    expect(session.getState().draft).toContain("Quarterly report mine");
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain('<div role="alert" data-testid="markdown-conflict-read-error"');
    expect(html).toContain("Could not read the version on disk: Murage could not be reached. Your text is kept.");
    expect(html).toContain(">Read the disk version again</button>");
    expect(html).not.toMatch(/disabled=""[^>]*>Use the disk version</);

    failRead = false;
    expect(await controller.retryConflictRead()).toBe(true);
    expect(controller.getSnapshot().view.conflictRead).toBeNull();
    expect(session.getState().conflict).toMatchObject({ currentRevision: rev("r7"), disk: { content: "# Changed by a bot\n" } });
    expect(renderToStaticMarkup(createElement(MarkdownEditor, { controller }))).not.toContain("markdown-conflict-read-error");
    expect(await controller.resolveConflict("reload")).toBe(true);
    expect(session.getState()).toMatchObject({ status: "clean", draft: "# Changed by a bot\n", baseRevision: rev("r7") });
  });

  it("says a conflict cannot be resolved here when no disk reader is supplied", async () => {
    const { session, controller } = setup(readCorpus("rich-basic.md"), { save: rejectSave });
    controller.setMode("source");
    controller.editSource("changed\n");
    expect(await controller.save()).toEqual({ status: "conflict" });
    await settle();
    expect(controller.getSnapshot().view.conflictRead).toEqual({ status: "unavailable" });
    expect(await controller.resolveConflict("keep-mine")).toBe(false);
    expect(session.getState()).toMatchObject({ status: "conflict", draft: "changed\n" });
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain("The version on disk cannot be read here, so neither choice can be applied yet. Your text is kept.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use the disk version<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Keep my version<\/button>/);
    expect(html).not.toContain("Read the disk version again");
  });
});

describe("recovered drafts and closing (fix round 1)", () => {
  /** A stored crash draft whose lookup is held until `release()`. */
  async function slowRecoverySetup() {
    const read = readCorpus("rich-basic.md");
    const memory = createMemoryDraftBackend();
    await createMarkdownDraftStore(memory).preserve({ scope: read.scope, relativePath: read.relativePath }, // Revision 1: a clear bounded by this session's own revisions would
    // reach it, so only the held-draft rule keeps it alive.
    { baseRevision: rev("r0"), content: "CRASHED WORK\n", draftRevision: 1 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const drafts = createMarkdownDraftStore({
      async transact(plan, options) {
        if (!options.write) await gate;
        return memory.transact(plan, options);
      },
    });
    const context = setup(read, { drafts });
    const restoring = context.controller.restoreDraft();
    const { editor } = attachHeadlessEditor(context.controller);
    typeAtEndOfFirstBlock(editor, " new typing");
    context.scheduler.flush();
    release();
    expect(await restoring).toBe(false);
    await settle();
    return { ...context, memory, editor };
  }

  it("holds a crash draft found after typing started and never writes over it", async () => {
    const { session, controller, memory, editor, scheduler } = await slowRecoverySetup();
    expect(memory.records()).toMatchObject([{ content: "CRASHED WORK\n", draftRevision: 1 }]);
    expect(controller.getSnapshot().view.heldDraftAt).toEqual(expect.any(Number));
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain('data-testid="markdown-held-draft"');
    expect(html).toContain("An unsaved draft from an earlier session was found");
    // More typing, going clean again, or closing never replaces or clears it.
    typeAtEndOfFirstBlock(editor, "!");
    scheduler.flush();
    await settle();
    expect(controller.discard()).toBe(true);
    await settle();
    expect(memory.records()).toMatchObject([{ content: "CRASHED WORK\n" }]);
    typeAtEndOfFirstBlock(editor, " again");
    // Using it replaces the new typing only because the user chose it.
    expect(controller.restoreHeldDraft()).toBe(true);
    expect(session.getState()).toMatchObject({ status: "dirty", draft: "CRASHED WORK\n" });
    expect(controller.getSnapshot().view).toMatchObject({ heldDraftAt: null, recoveredDraftAt: expect.any(Number), draftStatus: "preserved" });
    expect(editor.getMarkdown()).toBe("CRASHED WORK");
    await controller.dispose();
    expect(memory.records()).toMatchObject([{ content: "CRASHED WORK\n" }]);
  });

  it("replaces a held crash draft with the current typing only when the user keeps it", async () => {
    const { controller, memory, scheduler } = await slowRecoverySetup();
    expect(memory.records()).toMatchObject([{ content: "CRASHED WORK\n" }]);
    expect(controller.keepCurrentOverHeldDraft()).toBe(true);
    scheduler.flush();
    await settle();
    expect(memory.records()).toHaveLength(1);
    expect(memory.records()[0]!.content).toContain("# Quarterly report new typing\n");
    expect(controller.getSnapshot().view).toMatchObject({ heldDraftAt: null, draftStatus: "preserved" });
  });

  it("clears the draft of a save that was still in flight when the document closed", async () => {
    for (const preservedBeforeSave of [true, false]) {
      let answer!: (receipt: SaveReceipt) => void;
      const { controller, scheduler, backend, writes } = setup(readCorpus("rich-basic.md"), {
        save: () => new Promise(resolve => { answer = resolve; }),
      });
      const { editor } = attachHeadlessEditor(controller);
      typeAtEndOfFirstBlock(editor, " closing");
      if (preservedBeforeSave) {
        scheduler.flush();
        await settle();
        expect(backend.records()).toHaveLength(1);
      }
      const saving = controller.save();
      // Closing flushes a still-pending draft before the receipt arrives.
      await controller.dispose();
      expect(backend.records()).toHaveLength(1);
      answer(receiptFor(writes[0]!, rev("w1")));
      expect(await saving).toEqual({ status: "saved", stillDirty: false });
      await settle();
      expect(backend.records()).toEqual([]);
    }
  });

  it("does not follow the session until connected, so a discarded StrictMode instance never schedules drafts", async () => {
    const { session, controller, scheduler, backend } = setup(readCorpus("rich-basic.md"), { connect: false, initialMode: "source" });
    session.update(state => editDocument(state, "typed through another instance\n"));
    expect(scheduler.pending()).toBe(0);
    expect(controller.getSnapshot().session.draft).not.toBe("typed through another instance\n");
    const unsubscribe = controller.subscribe(() => {});
    expect(controller.getSnapshot().session.draft).toBe("typed through another instance\n");
    controller.connect();
    controller.editSource("typed after connecting\n");
    expect(scheduler.pending()).toBeGreaterThan(0);
    scheduler.flush();
    await settle();
    expect(backend.records()).toMatchObject([{ content: "typed after connecting\n" }]);
    unsubscribe();
  });

  it("re-checks rich eligibility once Source typing pauses", () => {
    const { controller, scheduler } = setup(readCorpus("source-table.md"));
    expect(controller.getSnapshot().view.richBlockedBy).toEqual(["unsupported-syntax"]);
    controller.editSource("# No table now\n\nPlain text.\n");
    expect(controller.getSnapshot().view.richBlockedBy).toEqual(["unsupported-syntax"]);
    scheduler.flush();
    expect(controller.getSnapshot().view).toMatchObject({ richBlockedBy: [], unsupportedSyntax: [] });
    expect(renderToStaticMarkup(createElement(MarkdownEditor, { controller }))).not.toMatch(/disabled=""[^>]*>Rich<\/button>/);
    controller.editSource("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    scheduler.flush();
    expect(controller.getSnapshot().view.richBlockedBy).toEqual(["unsupported-syntax"]);
  });
});

describe("markup", () => {
  it("renders the rich surface with the Rich mode pressed and no draft or saved claim for a fresh file", () => {
    const { controller } = setup(readCorpus("rich-basic.md"));
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller, title: "Quarterly report" }));
    expect(html).toContain('aria-label="Quarterly report"');
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Rich<\/button>/);
    expect(html).toContain("No unsaved changes");
    expect(html).not.toContain("Draft preserved");
    expect(html).not.toContain("<textarea");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it("escapes document text in Source mode", () => {
    const { controller } = setup({ ...readCorpus("source-html-comment.md") });
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { controller }));
    expect(html).toContain("&lt;!-- reviewer: keep this --&gt;");
    expect(html).not.toContain("<div align=\"center\">");
  });
});
