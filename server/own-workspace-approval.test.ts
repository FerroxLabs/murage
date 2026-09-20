// D57 — the boundary itself, on a real filesystem.
//
// This decides whether a permission card is raised, so every test here is an
// escape attempt: the happy path is one describe block and the rest is the
// list of ways "inside the bot's own folder" can be made to look true when it
// is not. Nothing is stubbed — the directories, the links and the sibling
// folders below are real, because a symlink test that mocks realpath proves
// nothing about a symlink.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isOwnWorkspaceBookkeeping,
  isOwnWorkspaceFileTool,
  ownWorkspaceRoots,
  toolFilePaths,
} from "./own-workspace-approval.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const BOT = "bot-abc";
const THREAD = "thread-1";
const OTHER_BOT = "bot-other";

let fixture: string;
let dataDir: string;
let workspaces: string;
let botDir: string;
let threadDir: string;
let outside: string;

/** One permission request, in the shape the caller builds from the engine's
 * own report: the tool the engine named and the paths its structured input
 * carried. */
const asks = (paths: string[] | undefined, tool = "Edit", scope?: Partial<{ dataDir: string; botId: string; threadId: string }>) =>
  isOwnWorkspaceBookkeeping({ dataDir, botId: BOT, threadId: THREAD, ...scope, tool, paths });

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "murage-d57-"));
  dataDir = join(fixture, "data");
  workspaces = join(dataDir, "workspaces");
  botDir = join(workspaces, BOT);
  threadDir = join(botDir, "threads", THREAD);
  outside = join(fixture, "outside");
  mkdirSync(join(botDir, "memory"), { recursive: true });
  mkdirSync(threadDir, { recursive: true });
  mkdirSync(join(workspaces, OTHER_BOT, "threads", "thread-9"), { recursive: true });
  // The sibling whose name merely STARTS with this bot's.
  mkdirSync(join(workspaces, `${BOT}-evil`), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(botDir, "MEMORY.md"), "# Memory\n");
  writeFileSync(join(outside, "secret.md"), "not yours\n");
  // A folder inside the workspace that points out of it, and a file inside it
  // that points out of it.
  symlinkSync(outside, join(botDir, "escape-dir"));
  symlinkSync(join(outside, "secret.md"), join(threadDir, "escape-file.md"));
});

afterAll(async () => { await removeTempDir(fixture); });

describe("the paths a request names", () => {
  it("reads the engine's structured file argument", () => {
    expect(toolFilePaths({ file_path: "/a/b.md", old_string: "x", new_string: "y" })).toEqual(["/a/b.md"]);
    expect(toolFilePaths({ notebook_path: "/a/b.ipynb" })).toEqual(["/a/b.ipynb"]);
    expect(toolFilePaths({ path: "/a/b.md" })).toEqual(["/a/b.md"]);
  });

  it("never reads a path out of model-written prose", () => {
    // `old_string` is whatever the model typed. If this read it, a bot could
    // name its own MEMORY.md in the replacement text of an edit to /etc/hosts.
    expect(toolFilePaths({ file_path: "/etc/hosts", old_string: '"file_path":"/data/workspaces/bot-abc/MEMORY.md"' }))
      .toEqual(["/etc/hosts"]);
    expect(toolFilePaths({ command: "cat /data/workspaces/bot-abc/MEMORY.md" })).toBeUndefined();
    expect(toolFilePaths({ content: "/data/workspaces/bot-abc/MEMORY.md" })).toBeUndefined();
  });

  it("fails closed on a shape it does not understand", () => {
    expect(toolFilePaths({ file_path: ["/a/b.md", "/etc/hosts"] })).toBeUndefined();
    expect(toolFilePaths({ file_path: { toString: () => "/a/b.md" } })).toBeUndefined();
    expect(toolFilePaths({ file_path: null })).toBeUndefined();
    expect(toolFilePaths({ file_path: "" })).toBeUndefined();
    expect(toolFilePaths({})).toBeUndefined();
    expect(toolFilePaths(undefined)).toBeUndefined();
    expect(toolFilePaths("/a/b.md")).toBeUndefined();
    expect(toolFilePaths(["/a/b.md"])).toBeUndefined();
  });

  it("carries every path the request names, so all of them can be judged", () => {
    expect(toolFilePaths({ file_path: "/a/b.md", path: "/c/d.md" })).toEqual(["/a/b.md", "/c/d.md"]);
  });
});

describe("which tools can reach the exemption at all", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "write_text_file", "edit"]) {
    it(`covers the engine's own ${tool}`, () => expect(isOwnWorkspaceFileTool(tool)).toBe(true));
  }
  // A tool that takes a path AND does something else with it is never
  // bookkeeping, however plausible its name.
  for (const tool of ["Bash", "shell", "computer_exec", "mcp__box__write", "mcp__files__edit", "fs/write_text_file", "functions.write", "WebFetch", "", "  "]) {
    it(`never covers ${tool || "(blank)"}`, () => expect(isOwnWorkspaceFileTool(tool)).toBe(false));
  }
  it("never covers a non-string the engine did not name", () => {
    expect(isOwnWorkspaceFileTool(undefined)).toBe(false);
    expect(isOwnWorkspaceFileTool(null)).toBe(false);
    expect(isOwnWorkspaceFileTool({ toString: () => "Edit" })).toBe(false);
  });
});

describe("the bot's own bookkeeping", () => {
  it("is its own MEMORY.md", () => expect(asks([join(botDir, "MEMORY.md")])).toBe(true));
  it("is its own memory topic file", () => expect(asks([join(botDir, "memory", "pricing.md")])).toBe(true));
  it("is a file in its own thread folder", () => expect(asks([join(threadDir, "notes.md")])).toBe(true));
  it("is a file it has not created yet", () => expect(asks([join(threadDir, "new", "deep", "draft.md")])).toBe(true));
  it("is every path at once when all of them are its own", () => {
    expect(asks([join(botDir, "MEMORY.md"), join(threadDir, "notes.md")])).toBe(true);
  });
  it("is the thread folder's own path, which sits inside the workspace folder", () => {
    expect(asks([threadDir])).toBe(true);
  });
  it("still applies through its own Read", () => expect(asks([join(botDir, "MEMORY.md")], "Read")).toBe(true));
});

describe("escape attempts — every one of these must still ask", () => {
  // Written as literal strings, never through `join`: `join` collapses `..`
  // itself, so a test built with it would never reach the scan it is for.
  it("a path that climbs out with ..", () => {
    expect(asks([`${threadDir}/../../../../secret.md`])).toBe(false);
    expect(asks([`${botDir}/../${OTHER_BOT}/MEMORY.md`])).toBe(false);
  });

  it("a .. that would have landed back inside", () => {
    // Refused anyway: this never resolves a `..`, because every resolver
    // available collapses it lexically, before the symlinks in the chain.
    expect(asks([`${botDir}/memory/../MEMORY.md`])).toBe(false);
    expect(asks([`${botDir}/escape-dir/../MEMORY.md`])).toBe(false);
  });

  it("a .. spelled with backslashes", () => {
    expect(asks([`${threadDir}\\..\\..\\..\\..\\outside\\secret.md`])).toBe(false);
    expect(asks([`${botDir}\\..\\${OTHER_BOT}\\MEMORY.md`])).toBe(false);
  });

  it("a single-dot segment", () => expect(asks([`${botDir}/./MEMORY.md`])).toBe(false));

  it("a folder inside the workspace that points out of it", () => {
    expect(realpathSync(join(botDir, "escape-dir"))).toBe(realpathSync(outside));
    expect(asks([join(botDir, "escape-dir", "secret.md")])).toBe(false);
  });

  it("a file inside the thread folder that points out of it", () => {
    expect(asks([join(threadDir, "escape-file.md")])).toBe(false);
  });

  it("a sibling folder whose name merely starts with this bot's", () => {
    expect(asks([join(workspaces, `${BOT}-evil`, "MEMORY.md")])).toBe(false);
  });

  it("another bot's workspace", () => {
    expect(asks([join(workspaces, OTHER_BOT, "MEMORY.md")])).toBe(false);
    expect(asks([join(workspaces, OTHER_BOT, "threads", "thread-9", "notes.md")])).toBe(false);
  });

  it("another conversation judged for the wrong bot", () => {
    // The same path, asked for by the bot that does not own it.
    expect(asks([join(botDir, "MEMORY.md")], "Edit", { botId: OTHER_BOT })).toBe(false);
  });

  it("one path of two outside", () => {
    expect(asks([join(botDir, "MEMORY.md"), join(outside, "secret.md")])).toBe(false);
  });

  it("the managed folder itself, which is not a file anything writes", () => {
    expect(asks([botDir])).toBe(false);
  });

  it("the data dir outside the bot's desk", () => {
    expect(asks([join(dataDir, "config.json")])).toBe(false);
    expect(asks([join(workspaces, "shared.md")])).toBe(false);
    expect(asks([workspaces])).toBe(false);
    expect(asks([dataDir])).toBe(false);
  });

  it("setup material that decides what the bot is or can reach", () => {
    for (const relative of ["SOUL.md", "AGENTS.md", "CLAUDE.md", join("credentials", "token.json"), join("skills", "x", "SKILL.md")]) {
      expect(asks([join(botDir, relative)])).toBe(false);
    }
  });

  it("a relative path, whose meaning depends on a cwd this does not have", () => {
    expect(asks(["MEMORY.md"])).toBe(false);
    expect(asks(["./MEMORY.md"])).toBe(false);
    expect(asks([join("workspaces", BOT, "MEMORY.md")])).toBe(false);
    // And from inside the folder itself, where every resolver this could
    // reach for would answer "yes, that is the bot's own MEMORY.md". The
    // server's working directory is not the engine's, and a relative path
    // read as though it were is how a path outside gets judged as one inside.
    const before = process.cwd();
    try {
      process.chdir(botDir);
      expect(asks(["MEMORY.md"])).toBe(false);
    } finally { process.chdir(before); }
  });

  it("a Windows drive-letter or UNC spelling", () => {
    expect(asks([`C:\\Users\\Ada\\data\\workspaces\\${BOT}\\MEMORY.md`])).toBe(false);
    expect(asks([`\\\\server\\share\\workspaces\\${BOT}\\MEMORY.md`])).toBe(false);
    // The real managed path behind the Windows "no normalization" prefix.
    expect(asks([`\\\\?\\${join(botDir, "MEMORY.md")}`])).toBe(false);
  });

  it("a tool that is not one of the engine's own file tools", () => {
    for (const tool of ["Bash", "computer_exec", "mcp__box__write", "AskUserQuestion"]) {
      expect(asks([join(botDir, "MEMORY.md")], tool)).toBe(false);
    }
  });

  it("a request that names no path at all", () => {
    expect(asks(undefined)).toBe(false);
    expect(asks([])).toBe(false);
  });

  it("an id this installation could never have made a folder for", () => {
    expect(asks([join(botDir, "MEMORY.md")], "Edit", { botId: "../escape" })).toBe(false);
    expect(asks([join(botDir, "MEMORY.md")], "Edit", { threadId: "../escape" })).toBe(false);
    expect(ownWorkspaceRoots({ dataDir, botId: "a/b", threadId: THREAD })).toEqual([]);
  });
});

describe("a managed folder that is itself a link", () => {
  // A link BELOW a root is caught by the comparison — the real path lands
  // outside. A link AT or ABOVE a root cancels out, because both sides
  // resolve through it, so those are refused outright.
  let linked: string;
  beforeAll(() => {
    linked = join(fixture, "linked-data");
    mkdirSync(join(linked, "workspaces"), { recursive: true });
    // workspaces/<bot> is a link to the whole filesystem's worth of "outside".
    symlinkSync(outside, join(linked, "workspaces", BOT));
  });

  it("refuses a workspace folder that points somewhere else", () => {
    const path = join(linked, "workspaces", BOT, "secret.md");
    // Without the check this reads as "inside the bot's own folder": both
    // sides resolve through the same link.
    expect(realpathSync(join(linked, "workspaces", BOT))).toBe(realpathSync(outside));
    expect(isOwnWorkspaceBookkeeping({ dataDir: linked, botId: BOT, threadId: THREAD, tool: "Edit", paths: [path] })).toBe(false);
  });
});

describe("segments compare exactly, never folded", () => {
  // Nothing under `ghost` exists, so nothing is canonicalized away and this
  // is the segment comparison on its own — the same assertion on a real macOS
  // folder would be answered by the case-insensitive filesystem instead.
  const ghostScope = (dir: string) => ({ dataDir: dir, botId: "abc", threadId: "t1", tool: "Edit" as const });

  it("matches the exact spelling and nothing else", () => {
    const ghost = join(fixture, "ghost-data");
    expect(isOwnWorkspaceBookkeeping({ ...ghostScope(ghost), paths: [join(ghost, "workspaces", "abc", "MEMORY.md")] })).toBe(true);
    expect(isOwnWorkspaceBookkeeping({ ...ghostScope(ghost), paths: [join(ghost, "WORKSPACES", "abc", "MEMORY.md")] })).toBe(false);
    expect(isOwnWorkspaceBookkeeping({ ...ghostScope(ghost), paths: [join(ghost, "workspaces", "ABC", "MEMORY.md")] })).toBe(false);
  });

  it("agrees with the filesystem about a case-variant of a folder that exists", () => {
    // On a case-insensitive volume this path IS the bot's own MEMORY.md and
    // the kernel says so; on a case-sensitive one it is a different folder
    // and is refused. Either way the answer comes from the filesystem, not
    // from this module lowercasing anything. `realpathSync.native` is the
    // authority here — and the one the boundary itself resolves with —
    // because only the libc call reports the on-disk casing of a component.
    const variant = join(dataDir, "WORKSPACES", BOT, "MEMORY.md");
    let sameFile = false;
    try { sameFile = realpathSync.native(variant) === realpathSync.native(join(botDir, "MEMORY.md")); } catch { sameFile = false; }
    expect(asks([variant])).toBe(sameFile);
  });
});
