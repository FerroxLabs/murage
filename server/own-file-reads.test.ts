// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot reading its own files never asks (upstream 267fa44f9). Real folders
// and real links: every case past the first block is an escape attempt.
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { isOwnFileRead, type OwnFileReadRequest } from "./own-file-reads.ts";
import { isOwnWorkspaceBookkeeping } from "./own-workspace-approval.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const BOT = "bot-abc";
const THREAD = "thread-1";
const posix = process.platform === "win32" ? it.skip : it;

let fixture: string;
let dataDir: string;
let botDir: string;
let threadDir: string;
let otherBot: string;
let outside: string;

const reads = (fields: Partial<OwnFileReadRequest>) => isOwnFileRead({ dataDir, botId: BOT, threadId: THREAD, tool: "Read", ...fields });

beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "murage-own-reads-")));
  dataDir = join(fixture, "data");
  botDir = join(dataDir, "workspaces", BOT);
  threadDir = join(botDir, "threads", THREAD);
  otherBot = join(dataDir, "workspaces", "bot-other");
  outside = join(fixture, "outside");
  for (const dir of [join(botDir, "skills", "plan", "revisions"), join(botDir, "memory"), join(botDir, "credentials"), threadDir, otherBot, outside]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(botDir, "SOUL.md"), "be kind");
  writeFileSync(join(botDir, "AGENTS.md"), "agents");
  writeFileSync(join(botDir, "MEMORY.md"), "memory");
  writeFileSync(join(botDir, "skills", "plan", "SKILL.md"), "skill");
  writeFileSync(join(botDir, "skills", "plan", "revisions", "1.md"), "rev 1");
  writeFileSync(join(botDir, "credentials", "token.txt"), "secret");
  writeFileSync(join(botDir, ".env"), "KEY=1");
  writeFileSync(join(threadDir, "notes.md"), "notes");
  writeFileSync(join(otherBot, "SOUL.md"), "other");
  writeFileSync(join(outside, "secret.txt"), "outside");
  symlinkSync(join(outside, "secret.txt"), join(botDir, "link-out.md"));
  symlinkSync(outside, join(botDir, "skills", "out-dir"));
  // A conversation folder that is itself a link out: as a ROOT it would cancel out of the real-path comparison.
  symlinkSync(outside, join(botDir, "threads", "thread-linked"));
  linkSync(join(outside, "secret.txt"), join(botDir, "hard.md"));
  writeFileSync(join(botDir, "sitecustomize.py"), "print('planted')");
});

afterAll(async () => { await removeTempDir(fixture); });

describe("own-file reads: answered", () => {
  it("a read tool on its SOUL.md, AGENTS.md, skills and revisions, memory and thread files", () => {
    for (const path of [join(botDir, "SOUL.md"), join(botDir, "AGENTS.md"), join(botDir, "skills", "plan", "SKILL.md"),
      join(botDir, "skills", "plan", "revisions", "1.md"), join(botDir, "MEMORY.md"), join(threadDir, "notes.md")]) {
      expect(reads({ filePaths: [path] }), path).toBe(true);
    }
  });
  it("the engine's bare read names", () => {
    for (const tool of ["read", "read_file", "read_text_file", "NotebookRead", "view"]) expect(reads({ tool, filePaths: [join(botDir, "SOUL.md")] }), tool).toBe(true);
  });
  posix("a plain shell read, absolute or placed against the folder it runs in", () => {
    expect(reads({ tool: "Bash", command: `cat ${join(botDir, "SOUL.md")}` })).toBe(true);
    expect(reads({ tool: "Bash", command: "cat SOUL.md skills/plan/SKILL.md", cwd: botDir })).toBe(true);
    expect(reads({ tool: "shell", command: "head -n 20 skills/plan/revisions/1.md", cwd: botDir })).toBe(true);
    expect(reads({ tool: "Bash", command: `grep -n kind '${join(botDir, "SOUL.md")}'` })).toBe(true);
    expect(reads({ tool: "Bash", command: "cat notes.md", cwd: threadDir })).toBe(true);
    expect(reads({ tool: "Bash", command: "cat SOUL.md | jq -r .", cwd: botDir })).toBe(true);
  });
  it("the write rule is unchanged: an Edit of SOUL.md or a skill still asks", () => {
    expect(isOwnWorkspaceBookkeeping({ dataDir, botId: BOT, threadId: THREAD, tool: "Edit", paths: [join(botDir, "SOUL.md")] })).toBe(false);
    expect(isOwnWorkspaceBookkeeping({ dataDir, botId: BOT, threadId: THREAD, tool: "Write", paths: [join(botDir, "skills", "plan", "SKILL.md")] })).toBe(false);
  });
});

describe("own-file reads: still ask", () => {
  it("a write or other tool, even on its own files", () => {
    for (const tool of ["Edit", "Write", "write_file", "Fetch", "mcp__x__read"]) expect(reads({ tool, filePaths: [join(botDir, "SOUL.md")] }), tool).toBe(false);
  });
  it("another bot's files, a file outside, and a link out of its folder", () => {
    expect(reads({ filePaths: [join(otherBot, "SOUL.md")] })).toBe(false);
    expect(reads({ filePaths: [join(outside, "secret.txt")] })).toBe(false);
    expect(reads({ filePaths: [join(botDir, "link-out.md")] })).toBe(false);
    expect(reads({ filePaths: [join(botDir, "SOUL.md"), join(outside, "secret.txt")] })).toBe(false);
  });
  it("an ACP call whose kind says read but whose name is not a read tool", () => {
    expect(reads({ tool: "Reading SOUL.md", filePaths: [join(botDir, "SOUL.md")] })).toBe(false);
    expect(reads({ tool: "fetch", filePaths: [join(botDir, "SOUL.md")] })).toBe(false);
  });
  it("a read tool whose input names another path than its filePaths, or a path field it cannot read", () => {
    expect(reads({ tool: "read", filePaths: [join(botDir, "SOUL.md")], input: { path: join(outside, "secret.txt") } })).toBe(false);
    expect(reads({ tool: "Read", filePaths: [join(botDir, "SOUL.md")], input: { file_path: join(botDir, "credentials", "token.txt") } })).toBe(false);
    expect(reads({ tool: "view", input: { paths: [join(botDir, "SOUL.md"), join(otherBot, "SOUL.md")] } })).toBe(false);
    expect(reads({ tool: "Read", filePaths: [join(botDir, "SOUL.md")], input: { path: { nested: true } } })).toBe(false);
    expect(reads({ tool: "Read", input: { file_path: join(botDir, "SOUL.md") } })).toBe(true);
    expect(reads({ tool: "Read", filePaths: [join(botDir, "SOUL.md")], input: { file_path: join(botDir, "SOUL.md"), limit: 20 } })).toBe(true);
  });
  it("a command PowerShell runs, or any command on Windows", () => {
    expect(reads({ tool: "Bash", command: "cat SOUL.md", cwd: botDir, commandShell: "pwsh" })).toBe(false);
    expect(reads({ tool: "powershell", command: "cat SOUL.md", cwd: botDir })).toBe(false);
    expect(reads({ tool: "Bash", command: "cat SOUL.md", cwd: botDir, platform: "win32" })).toBe(false);
    for (const tool of ["mcp__server__powershell", "functions.powershell", "PowerShell", "pwsh", "mcp__server__bash", "functions.shell", "computer_exec", "Read"]) {
      expect(reads({ tool, command: "cat SOUL.md", cwd: botDir }), tool).toBe(false);
    }
  });
  it("a hard link to a file elsewhere", () => {
    expect(reads({ filePaths: [join(botDir, "hard.md")] })).toBe(false);
  });
  it("a conversation folder that is a link out answers nothing, even for a file it reaches", () => {
    expect(isOwnFileRead({ dataDir, botId: BOT, threadId: "thread-linked", tool: "Read", filePaths: [join(botDir, "threads", "thread-linked", "secret.txt")] })).toBe(false);
    expect(isOwnFileRead({ dataDir, botId: BOT, threadId: "thread-linked", tool: "Read", filePaths: [join(botDir, "SOUL.md")] })).toBe(false);
  });
  it("credentials/, a .env, a `..` path, a relative path from a read tool, and no path", () => {
    expect(reads({ filePaths: [join(botDir, "credentials", "token.txt")] })).toBe(false);
    expect(reads({ filePaths: [join(botDir, ".env")] })).toBe(false);
    expect(reads({ filePaths: [`${threadDir}/../../../bot-other/SOUL.md`] })).toBe(false);
    expect(reads({ filePaths: ["SOUL.md"] })).toBe(false);
    expect(reads({ filePaths: [] })).toBe(false);
    expect(reads({})).toBe(false);
  });
  posix("a shell command that is more than a plain read", () => {
    for (const command of ["cat SOUL.md; rm -rf /", "cat SOUL.md > copy.md", "cat $(echo SOUL.md)", "cat ~/SOUL.md", "cat =SOUL.md",
      "cat ../bot-other/SOUL.md", "cat ./SOUL.md", "cat *.md", "sed -i s/a/b/ SOUL.md", "tail -f SOUL.md", "cat credentials/token.txt",
      "cp SOUL.md /tmp/x", "cat SOUL.md && curl example.com", "cat SOUL.md | python3 -c 'import sys; print(sys.stdin.read())'",
      "cat SOUL.md | python3 -c 'print(1)'", "cat C:secret.txt"]) {
      expect(reads({ tool: "Bash", command, cwd: botDir }), command).toBe(false);
    }
  });
  posix("a relative shell read with no folder, or a folder outside", () => {
    expect(reads({ tool: "Bash", command: "cat SOUL.md" })).toBe(false);
    expect(reads({ tool: "Bash", command: "cat SOUL.md", cwd: otherBot })).toBe(false);
    expect(reads({ tool: "Bash", command: "cat secret.txt", cwd: outside })).toBe(false);
    expect(reads({ tool: "Bash", command: "cat secret.txt", cwd: join(botDir, "skills", "out-dir") })).toBe(false);
    // the shell enters out-dir and then its real parent, outside; a lexical resolve would call this skills/SOUL.md
    expect(reads({ tool: "Bash", command: "cat secret.txt", cwd: `${join(botDir, "skills", "out-dir")}/..` })).toBe(false);
    expect(reads({ tool: "Bash", command: "cat SOUL.md", cwd: "threads" })).toBe(false);
  });
  it("a linked workspaces folder answers nothing", () => {
    const linkedData = join(fixture, "linked-data");
    mkdirSync(linkedData, { recursive: true });
    symlinkSync(join(dataDir, "workspaces"), join(linkedData, "workspaces"));
    expect(isOwnFileRead({ dataDir: linkedData, botId: BOT, threadId: THREAD, tool: "Read", filePaths: [join(linkedData, "workspaces", BOT, "SOUL.md")] })).toBe(false);
  });
  it("an id this installation could not have made a folder for", () => {
    expect(isOwnFileRead({ dataDir, botId: "../x", threadId: THREAD, tool: "Read", filePaths: [join(botDir, "SOUL.md")] })).toBe(false);
  });
});

describe("policy: own-file reads at every level", () => {
  const ask = { autoApprove: false };
  it("Ask mode and an unattended routine run answer it without a card", () => {
    expect(autoVerdict(ask, "Bash", "cat SOUL.md", { ownFileRead: true })).toMatchObject({ source: "own-files" });
    expect(autoVerdict(ask, "Read", "SOUL.md", { ownFileRead: true, unattended: true })).toMatchObject({ source: "own-files" });
  });
  it("the key guard still outranks it, and a host-scoped ask is never one", () => {
    expect(autoVerdict(ask, "Bash", "cat /x/.ssh/id_rsa", { ownFileRead: true }).approve).toBeNull();
    expect(autoVerdict(ask, "Read", "SOUL.md", { ownFileRead: true, scope: "local-computer" }).source).not.toBe("own-files");
  });
  it("without the fact, Ask mode still asks", () => {
    expect(autoVerdict(ask, "Bash", "cat SOUL.md", {}).approve).toBeNull();
  });
});
