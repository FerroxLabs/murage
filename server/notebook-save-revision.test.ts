// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 U33: the notebook editor saves against the revision it loaded. Words written to MEMORY.md after the editor opened (the bot's own
// file tools, another window) are kept: the save answers with the current revision (the route's 409) instead of replacing them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspace, memoryFileRevision, readMemoryFile, saveMemoryFile, workspaceDir, writeMemoryFile, WORKSPACES_DIR } from "./workspace.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const BOT = "bot-notebook-revision";
const file = () => join(workspaceDir(BOT), "MEMORY.md");

describe("U33: a notebook save never replaces a newer file", () => {
  beforeEach(() => { removeTempDirSync(WORKSPACES_DIR); ensureWorkspace(BOT); });

  it("the read carries a revision, and a save at that revision writes and returns the new one", () => {
    writeMemoryFile(BOT, "- likes tea\n");
    const opened = readMemoryFile(BOT);
    expect(opened.revision).toMatch(/^[0-9a-f]{32}$/);
    expect(memoryFileRevision(BOT)).toBe(opened.revision);
    const saved = saveMemoryFile(BOT, "- likes tea\n- lives in Austin\n", opened.revision);
    expect(saved.saved).toBe(true);
    expect(saved.revision).not.toBe(opened.revision);
    expect(readFileSync(file(), "utf8")).toBe("- likes tea\n- lives in Austin\n");
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
  });

  it("the bot writes after the editor opened: the editor's save is refused and the bot's words stay", () => {
    writeMemoryFile(BOT, "- likes tea\n");
    const opened = readMemoryFile(BOT);
    writeFileSync(file(), "- likes tea\n- prefers mornings\n");           // the bot's own file tool, mid-edit
    const saved = saveMemoryFile(BOT, "- likes coffee\n", opened.revision);
    expect(saved.saved).toBe(false);
    expect(saved.revision).toBe(readMemoryFile(BOT).revision);
    expect(readFileSync(file(), "utf8")).toBe("- likes tea\n- prefers mornings\n");
    // the editor reloads at the newer revision, and its save then lands
    expect(saveMemoryFile(BOT, "- likes coffee\n- prefers mornings\n", saved.revision).saved).toBe(true);
    expect(readFileSync(file(), "utf8")).toBe("- likes coffee\n- prefers mornings\n");
  });

  it("a file created after an editor opened an empty notebook is kept too; a save against the new revision then lands", () => {
    removeTempDirSync(WORKSPACES_DIR);
    const opened = readMemoryFile(BOT);
    expect(opened.revision).toBe("none");
    writeMemoryFile(BOT, "- the bot wrote first\n");
    const refused = saveMemoryFile(BOT, "- the owner's note\n", opened.revision);
    expect(refused.saved).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe("- the bot wrote first\n");
    expect(saveMemoryFile(BOT, "- the owner's note\n", refused.revision).saved).toBe(true);
    expect(readFileSync(file(), "utf8")).toBe("- the owner's note\n");
  });

  it("an editor that opened an empty notebook saves into a missing file", () => {
    removeTempDirSync(WORKSPACES_DIR);
    const opened = readMemoryFile(BOT);
    expect(saveMemoryFile(BOT, "- first note\n", opened.revision).saved).toBe(true);
    expect(readFileSync(file(), "utf8")).toBe("- first note\n");
  });
});
