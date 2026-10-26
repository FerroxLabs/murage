// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 U33 (designs/MEMORY-MISC-SIMPLER-106.md, A): the bot's own file tools write MEMORY.md from another process. A notebook save writes a
// private temp file and renames it over the notebook, holding the live file open as a witness. These tests put a bot write inside each
// window of the save, through the filesystem calls the save itself makes, and require the bot's words to survive and the editor to get a
// conflict. The save never moves, links, deletes or follows the live notebook (Grok r3 H1, H2), and it says saved only after reading its
// own text back from the path (r3 M).
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks: { fsync?: () => void; rename?: (from: string, to: string) => void; link?: (from: string, to: string) => void; noHardLinks?: boolean } = {};
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fsyncSync = (fd: number) => { actual.fsyncSync(fd); const hook = hooks.fsync; hooks.fsync = undefined; hook?.(); };
  const renameSync = (from: string, to: string) => { actual.renameSync(from, to); const hook = hooks.rename; if (hook) { hooks.rename = undefined; hook(String(from), String(to)); } };
  const linkSync = (from: string, to: string) => {
    // a volume without hard links (FAT, some network shares)
    if (hooks.noHardLinks) throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    actual.linkSync(from, to); const hook = hooks.link; if (hook) { hooks.link = undefined; hook(String(from), String(to)); }
  };
  const hooked = { fsyncSync, renameSync, linkSync };
  return { ...actual, ...hooked, default: { ...actual, ...hooked } };
});

// a setup file may already have loaded workspace.ts with the real fs: load it again so it sees the hooked one
vi.resetModules();
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { ensureWorkspace, loadMemory, readMemoryFile, saveMemoryFile, workspaceDir, writeMemoryFile, WORKSPACES_DIR } = await import("./workspace.ts");
const { removeTempDirSync } = await import("./testing/cleanup.ts");

const BOT = "bot-notebook-race";
const file = () => join(workspaceDir(BOT), "MEMORY.md");
const onDisk = () => realFs.readFileSync(file(), "utf8");
const leftovers = () => realFs.readdirSync(workspaceDir(BOT)).filter(name => /\.(save|held|tmp)$/.test(name));
/** The bot's own file tool replacing the notebook: its temp file, renamed over the path (a new inode). */
const botReplaces = (text: string) => { const tmp = `${file()}.bot-${Math.random()}`; realFs.writeFileSync(tmp, text); realFs.renameSync(tmp, file()); };
const isPublish = (from: string, to: string) => to === file() && /\.save$/.test(from);
/** How Windows refuses a rename over a file another handle still holds open (after the save's own retries). */
const WINDOWS_BUSY = /EPERM|EACCES|EBUSY/;

describe("U33: a bot write during a notebook save is never overwritten", () => {
  beforeEach(() => {
    hooks.fsync = hooks.rename = hooks.link = undefined; hooks.noHardLinks = false;
    removeTempDirSync(WORKSPACES_DIR);
    ensureWorkspace(BOT);
    writeMemoryFile(BOT, "- likes tea\n");
  });

  it("the bot writes in place after the revision check, while the editor's text is being written: the bot's words stay, the editor gets a conflict", () => {
    const opened = readMemoryFile(BOT);
    // the first fsync of the save is the editor's new text reaching disk: the revision was checked before it
    hooks.fsync = () => realFs.writeFileSync(file(), "- likes tea\n- removed the old address\n");
    const saved = saveMemoryFile(BOT, "- likes tea\n- lives at 1 Old Road\n", opened.revision);
    expect(onDisk()).toBe("- likes tea\n- removed the old address\n");
    expect(saved.saved).toBe(false);
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(leftovers()).toEqual([]);
  });

  it("the bot replaces the file (its own temp and rename) while the editor's text is being written: the bot's file is kept", () => {
    const opened = readMemoryFile(BOT);
    hooks.fsync = () => botReplaces("- the bot's newer note\n");
    const saved = saveMemoryFile(BOT, "- the editor's note\n", opened.revision);
    expect(saved.saved).toBe(false);
    expect(onDisk()).toBe("- the bot's newer note\n");
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(leftovers()).toEqual([]);
  });

  it("a bot writer that had the file open writes into it right after the swap: its bytes go back, the editor gets a conflict", () => {
    const opened = readMemoryFile(BOT);
    const botFd = realFs.openSync(file(), "r+");
    try {
      const write = () => realFs.writeSync(botFd, "- written through an open handle\n", realFs.fstatSync(botFd).size);
      hooks.rename = (from, to) => { if (isPublish(from, to)) write(); };
      hooks.link = (_from, to) => { if (to === file()) write(); };
      if (process.platform === "win32") {
        // Windows refuses the swap itself while the bot's handle is open: the save fails, and the bot's write through its handle lands on
        // the notebook it kept
        expect(() => saveMemoryFile(BOT, "- the editor's note\n", opened.revision)).toThrow(WINDOWS_BUSY);
        write();
      } else {
        const saved = saveMemoryFile(BOT, "- the editor's note\n", opened.revision);
        expect(saved.saved).toBe(false);
      }
      expect(onDisk()).toBe("- likes tea\n- written through an open handle\n");
      expect(leftovers()).toEqual([]);
    } finally { realFs.closeSync(botFd); }
  });

  it("an open-handle write is never put back over a newer bot file that replaced the editor's text", () => {
    const opened = readMemoryFile(BOT);
    const botFd = realFs.openSync(file(), "r+");
    try {
      hooks.rename = (from, to) => {
        if (!isPublish(from, to)) return;
        realFs.writeSync(botFd, "- written through an open handle\n", realFs.fstatSync(botFd).size);
        botReplaces("- the newest note\n");
      };
      if (process.platform === "win32") {
        // Windows refuses the swap while the bot's handle is open: nothing of the bot's is replaced and nothing is put back
        expect(() => saveMemoryFile(BOT, "- the editor's note\n", opened.revision)).toThrow(WINDOWS_BUSY);
        expect(onDisk()).toBe("- likes tea\n");
      } else {
        const saved = saveMemoryFile(BOT, "- the editor's note\n", opened.revision);
        expect(saved.saved).toBe(false);
        expect(onDisk()).toBe("- the newest note\n");
      }
      expect(leftovers()).toEqual([]);
    } finally { realFs.closeSync(botFd); }
  });

  // Grok r3 Medium: success is read back from the path, never assumed
  it("the bot replaces the notebook right after the editor's text is published: the save is not reported as saved", () => {
    const opened = readMemoryFile(BOT);
    const bot = () => botReplaces("- the bot wrote after the save\n");
    hooks.rename = (from, to) => { if (isPublish(from, to)) bot(); };
    hooks.link = (_from, to) => { if (to === file()) bot(); };
    const saved = saveMemoryFile(BOT, "- the editor's note\n", opened.revision);
    expect(onDisk()).toBe("- the bot wrote after the save\n");
    expect(saved.saved).toBe(false);
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(leftovers()).toEqual([]);
  });

  it("with no other writer the save lands, the revision it returns is the file's, and nothing is left beside it", () => {
    const opened = readMemoryFile(BOT);
    const saved = saveMemoryFile(BOT, "- likes coffee\n", opened.revision);
    expect(saved.saved).toBe(true);
    expect(onDisk()).toBe("- likes coffee\n");
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(leftovers()).toEqual([]);
    if (process.platform !== "win32") expect(realFs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("a notebook that does not exist yet is created when the editor saved against none", () => {
    realFs.unlinkSync(file());
    const saved = saveMemoryFile(BOT, "- first note\n", "none");
    expect(saved.saved).toBe(true);
    expect(onDisk()).toBe("- first note\n");
    expect(leftovers()).toEqual([]);
  });

  // Grok r3 High 1: the notebook is never moved aside, so a bot create can never cost the only copy
  it("without hard links, a stale save while the bot creates the path never deletes the notebook", () => {
    const opened = readMemoryFile(BOT);
    realFs.writeFileSync(file(), "- likes tea\n- the bot's newer note\n");
    hooks.noHardLinks = true;
    // if the save ever moved the notebook away, the bot's tool would recreate the path (even empty) at once
    hooks.rename = (from) => { if (from === file()) realFs.writeFileSync(file(), ""); };
    const saved = saveMemoryFile(BOT, "- the editor's note\n", opened.revision);
    expect(saved.saved).toBe(false);
    expect(onDisk()).toBe("- likes tea\n- the bot's newer note\n");
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(leftovers()).toEqual([]);
  });

  // Grok r3 High 2: a linked notebook is refused, never followed
  it.skipIf(process.platform === "win32")("without hard links, a MEMORY.md that is a link is refused: the link stays, its target is untouched, nothing is copied in", () => {
    const outside = realFs.mkdtempSync(join(tmpdir(), "notebook-link-"));
    try {
      const target = join(outside, "elsewhere.md");
      realFs.writeFileSync(target, "- words from outside the notebook\n");
      realFs.unlinkSync(file());
      realFs.symlinkSync(target, file());
      hooks.noHardLinks = true;
      const opened = readMemoryFile(BOT);
      expect(opened.revision).toBe("none");
      expect(() => saveMemoryFile(BOT, "- the editor's note\n", opened.revision)).toThrow();
      expect(realFs.lstatSync(file()).isSymbolicLink()).toBe(true);
      expect(realFs.readFileSync(target, "utf8")).toBe("- words from outside the notebook\n");
      expect(leftovers()).toEqual([]);
    } finally { removeTempDirSync(outside); }
  });

  // Grok r4 High: a hard link is a regular file with a second name; it is refused like a symlink, on read and on save
  it("a MEMORY.md that is a hard link to a file elsewhere is never read into the editor or the prompt, and a save refuses it", () => {
    const target = join(workspaceDir(BOT), "..", `elsewhere-${process.pid}.key`);
    try {
      realFs.writeFileSync(target, "PRIVATE KEY MATERIAL\n");
      realFs.unlinkSync(file());
      realFs.linkSync(target, file());
      const opened = readMemoryFile(BOT);
      expect(opened.text).toBe("");
      expect(opened.revision).toBe("none");
      expect(loadMemory(BOT)).toBeNull();
      expect(() => saveMemoryFile(BOT, "- the editor's note\n", opened.revision)).toThrow();
      expect(realFs.readFileSync(target, "utf8")).toBe("PRIVATE KEY MATERIAL\n");
      expect(realFs.statSync(file()).nlink).toBe(2);
      expect(leftovers()).toEqual([]);
    } finally { try { realFs.unlinkSync(target); } catch { /* gone */ } }
  });

  it("without hard links and no other writer, the save lands", () => {
    const opened = readMemoryFile(BOT);
    hooks.noHardLinks = true;
    const saved = saveMemoryFile(BOT, "- likes coffee\n", opened.revision);
    expect(saved.saved).toBe(true);
    expect(onDisk()).toBe("- likes coffee\n");
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(leftovers()).toEqual([]);
  });
});
