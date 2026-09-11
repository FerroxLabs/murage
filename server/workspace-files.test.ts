import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactScope } from "./artifacts.ts";
import { hiddenRoute } from "./route-delegation.ts";
import {
  WORKSPACE_DIRECTORY_SCAN_LIMIT, WorkspaceFileError, listWorkspaceDirectory, resolveWorkspaceRoot, searchWorkspace, workspaceFilesRoute,
  type WorkspaceFilesDeps,
} from "./workspace-files.ts";
import { WORKSPACE_LIST_PAGE_SIZE, WORKSPACE_SEARCH_MAX_ENTRIES, isFileRevision, type WorkspaceEntry } from "../shared/workspace-files.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type FakeTask = { threadId: string; cwd?: string | null; resumeCursors: Record<string, unknown> };
type FakeBot = { id: string; name: string; threadId: string; cwd?: string; resumeCursors: Record<string, unknown>; tasks?: FakeTask[] };
type FakeGroup = { id: string; threadId: string; memberIds: string[]; cwd?: string; pinnedCwd?: string | null; tasks?: Array<{ threadId: string; pinnedCwd?: string | null }> };

/** Same rules as artifactScopes() in server/index.ts (without retained rows). */
function scopesFor(dataDir: string, bots: FakeBot[], groups: FakeGroup[]): ArtifactScope[] {
  const scopes: ArtifactScope[] = [];
  for (const bot of bots) {
    for (const task of bot.tasks ?? [{ threadId: bot.threadId, cwd: undefined }]) {
      const workspaceRoot = task.cwd === null ? undefined : task.cwd ?? bot.cwd ?? join(dataDir, "workspaces", bot.id);
      if (workspaceRoot) scopes.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, workspaceRoot });
    }
    for (const group of groups.filter(group => group.memberIds.includes(bot.id))) {
      for (const task of group.tasks ?? [{ threadId: group.threadId, pinnedCwd: group.pinnedCwd }]) {
        const pinned = task.pinnedCwd === undefined ? group.cwd : task.pinnedCwd;
        scopes.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, workspaceRoot: pinned ?? join(dataDir, "workspaces", bot.id) });
      }
    }
  }
  return scopes;
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-workspace-files-"))); roots.push(base);
  const dataDir = join(base, "data"), taskRoot = join(dataDir, "workspaces", "bot", "threads", "thread");
  mkdirSync(taskRoot, { recursive: true });
  const bot: FakeBot = { id: "bot", name: "Research bot", threadId: "thread", resumeCursors: {}, tasks: [{ threadId: "thread", cwd: taskRoot, resumeCursors: {} }] };
  const bots = [bot], groups: FakeGroup[] = [];
  const state = { scopes: () => scopesFor(dataDir, bots, groups) };
  const deps: WorkspaceFilesDeps = {
    dataDir,
    database: () => { throw new Error("discovery must not use the database"); },
    store: { bots, groups } as never,
    artifactScopes: () => state.scopes(),
  };
  const write = (relative: string, content = "x", root = taskRoot) => {
    const path = join(root, ...relative.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  return { base, dataDir, taskRoot, bot, bots, groups, deps, state, write, scope: { botId: "bot", threadId: "thread" } };
}
const codeOf = (action: () => unknown) => {
  try { action(); } catch (error) { if (error instanceof WorkspaceFileError) return error.code; throw error; }
  return "ok";
};
const names = (entries: WorkspaceEntry[]) => entries.map(entry => entry.name);
const cursorOf = (value: unknown) => `l1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
const call = (deps: WorkspaceFilesDeps, target: string, options: { desktop?: boolean; method?: string } = {}) => {
  const url = new URL(`http://127.0.0.1${target}`);
  return workspaceFilesRoute({ method: options.method ?? "GET", path: url.pathname, url, headers: {}, desktop: options.desktop ?? true,
    readBody: () => { throw new Error("discovery must not read request bodies"); } }, deps);
};

describe("workspace root resolution", () => {
  it("derives the managed task workspace, a custom folder and a room desk from the store", async () => {
    const f = fixture();
    expect(resolveWorkspaceRoot(f.deps, f.scope).info).toEqual({ scope: f.scope, state: "ready", label: "Research bot", displayPath: f.taskRoot, managed: true });
    const project = join(f.base, "client-project"); mkdirSync(project);
    f.bot.tasks![0]!.cwd = project;
    expect(resolveWorkspaceRoot(f.deps, f.scope).info).toEqual({ scope: f.scope, state: "ready", label: "client-project", displayPath: project, managed: false });
    f.groups.push({ id: "room", threadId: "room-thread", memberIds: ["bot"], tasks: [{ threadId: "room-thread" }] });
    const room = { botId: "bot", threadId: "room-thread" };
    expect(resolveWorkspaceRoot(f.deps, room).info).toEqual({ scope: room, state: "ready", label: "Research bot", displayPath: join(f.dataDir, "workspaces", "bot"), managed: false });
    f.groups[0]!.tasks![0]!.pinnedCwd = project;
    expect(resolveWorkspaceRoot(f.deps, room).info).toMatchObject({ state: "ready", displayPath: project, managed: false });
    const response = await call(f.deps, "/api/workspace-files/root?botId=bot&threadId=thread");
    expect(response).toMatchObject({ status: 200, headers: { "cache-control": "no-store" }, body: { state: "ready", displayPath: project } });
  });

  it("answers legacy, cloud, HOME and filesystem-root conversations without reading them", () => {
    const f = fixture(), task = f.bot.tasks![0]!;
    task.cwd = null;
    expect(resolveWorkspaceRoot(f.deps, f.scope).info).toEqual({ scope: f.scope, state: "no-dedicated-workspace", label: "Research bot", managed: false });
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }))).toBe("no-dedicated-workspace");
    expect(codeOf(() => searchWorkspace(f.deps, { scope: f.scope, query: "report" }))).toBe("no-dedicated-workspace");
    writeFileSync(join(f.dataDir, "routines.json"), JSON.stringify({ version: 1, routines: [], runs: [{ id: "run", botId: "bot", threadId: "thread", runOn: "cloud" }] }));
    expect(resolveWorkspaceRoot(f.deps, f.scope).info.state).toBe("remote");
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }))).toBe("remote-workspace");
    rmSync(join(f.dataDir, "routines.json"));
    // A task with a provider session pins to home on its next turn.
    task.cwd = undefined; task.resumeCursors = { claude: "session" };
    expect(resolveWorkspaceRoot(f.deps, f.scope).info.state).toBe("no-dedicated-workspace");
    task.resumeCursors = {};
    for (const folder of [homedir(), dirname(realpathSync.native(homedir())), "/"]) {
      task.cwd = folder;
      const info = resolveWorkspaceRoot(f.deps, f.scope).info;
      expect(info, folder).toEqual({ scope: f.scope, state: "no-dedicated-workspace", label: "Research bot", managed: false });
      expect(codeOf(() => searchWorkspace(f.deps, { scope: f.scope, query: "a" })), folder).toBe("no-dedicated-workspace");
    }
  });

  it("refuses unknown, retained-only, unauthorized and link-swapped roots", () => {
    const f = fixture();
    expect(codeOf(() => resolveWorkspaceRoot(f.deps, { botId: "other", threadId: "thread" }))).toBe("scope-unavailable");
    expect(codeOf(() => resolveWorkspaceRoot(f.deps, { botId: "bot", threadId: "other" }))).toBe("scope-unavailable");
    f.state.scopes = () => [];
    expect(codeOf(() => resolveWorkspaceRoot(f.deps, f.scope))).toBe("scope-unavailable");
    f.state.scopes = () => [{ botId: "bot", botName: "Research bot", threadId: "thread", workspaceRoot: f.taskRoot, threadAvailable: false }];
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }))).toBe("scope-unavailable");
    f.state.scopes = () => [{ botId: "bot", botName: "Research bot", threadId: "thread", workspaceRoot: join(f.base, "elsewhere") }];
    expect(codeOf(() => resolveWorkspaceRoot(f.deps, f.scope))).toBe("scope-unavailable");
    f.state.scopes = () => scopesFor(f.dataDir, f.bots, f.groups);
    const project = join(f.base, "project"), moved = join(f.base, "moved");
    mkdirSync(project); f.bot.tasks![0]!.cwd = project;
    renameSync(project, moved); symlinkSync(moved, project, "dir");
    expect(resolveWorkspaceRoot(f.deps, f.scope).info).toMatchObject({ state: "unavailable", managed: false });
    expect(resolveWorkspaceRoot(f.deps, f.scope).info.displayPath).toBeUndefined();
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }))).toBe("scope-unavailable");
  });

  it("lists a conversation that has not run as empty without creating, pinning or reading a folder", () => {
    const f = fixture();
    const fresh: FakeBot = { id: "fresh", name: "Fresh bot", threadId: "new-thread", resumeCursors: {}, tasks: [{ threadId: "new-thread", resumeCursors: {} }] };
    f.bots.push(fresh);
    const scope = { botId: "fresh", threadId: "new-thread" };
    expect(resolveWorkspaceRoot(f.deps, scope)).toMatchObject({ pending: true, info: { state: "ready", managed: true, label: "Fresh bot" } });
    expect(listWorkspaceDirectory(f.deps, { scope, directory: "" })).toMatchObject({ entries: [], incomplete: false });
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope, directory: "reports" }))).toBe("not-found");
    expect(searchWorkspace(f.deps, { scope, query: "report" })).toMatchObject({ entries: [], incomplete: false, scanned: 0 });
    expect(existsSync(join(f.dataDir, "workspaces", "fresh"))).toBe(false);
    expect(fresh.tasks![0]!.cwd).toBeUndefined();
  });
});

describe("directory listing", () => {
  it("lists one folder with metadata, hides private setup and invents no authorship", () => {
    const f = fixture();
    for (const path of ["MEMORY.md", "memory/note.md", "skills/tool.md", "credentials/key.txt", ".env", ".git/config", "AGENTS.md"]) f.write(path, "private");
    f.write("reports/weekly/result.html", "<h1>Weekly</h1>"); f.write("notes.md", "# Notes"); f.write("outputs/summary.txt", "done");
    const root = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" });
    expect(names(root.entries)).toEqual(["outputs", "reports", "notes.md"]);
    expect(root).toMatchObject({ scope: f.scope, directory: "", incomplete: false, root: { state: "ready", managed: true } });
    expect(root.cursor).toBeUndefined();
    expect(JSON.stringify(root)).not.toMatch(/MEMORY|memory|skills|credentials|\.env|\.git|AGENTS/);
    const notes = root.entries[2]!;
    expect(notes).toMatchObject({ name: "notes.md", relativePath: "notes.md", kind: "file", state: "local", bytes: 7 });
    expect(isFileRevision(notes.revision)).toBe(true);
    expect(Object.keys(notes).sort()).toEqual(["bytes", "kind", "modifiedAt", "name", "relativePath", "revision", "state"]);
    expect(root.entries[0]).toMatchObject({ kind: "directory", state: "local" });
    expect(root.entries[0]!.revision).toBeUndefined();
    const nested = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "reports/weekly" });
    expect(nested.entries).toMatchObject([{ name: "result.html", relativePath: "reports/weekly/result.html", kind: "file", state: "local", bytes: 15 }]);
    f.write("notes.md", "# Notes, revised");
    const revised = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" });
    expect(revised.entries[2]!.revision).not.toBe(notes.revision);
    expect(revised.directoryRevision).toBe(root.directoryRevision);
    f.write("zeta.md");
    expect(listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }).directoryRevision).not.toBe(root.directoryRevision);
  });

  it("pages 200 entries at a time with a cursor bound to the folder revision", async () => {
    const f = fixture();
    for (let index = 0; index < 450; index++) f.write(`bulk/f${String(index).padStart(3, "0")}.txt`);
    const seen: string[] = [];
    let page = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "bulk" });
    const firstCursor = page.cursor!;
    const sizes = [page.entries.length];
    seen.push(...names(page.entries));
    while (page.cursor) {
      expect(page.incomplete).toBe(true);
      page = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "bulk", cursor: page.cursor });
      sizes.push(page.entries.length); seen.push(...names(page.entries));
    }
    expect(sizes).toEqual([WORKSPACE_LIST_PAGE_SIZE, WORKSPACE_LIST_PAGE_SIZE, 50]);
    expect(page.incomplete).toBe(false);
    expect(seen).toEqual(Array.from({ length: 450 }, (_, index) => `f${String(index).padStart(3, "0")}.txt`));
    const http = await call(f.deps, `/api/workspace-files/list?botId=bot&threadId=thread&directory=bulk&cursor=${firstCursor}`);
    expect(http).toMatchObject({ status: 200, body: { directory: "bulk", incomplete: true } });
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "", cursor: firstCursor }))).toBe("cursor-stale");
    for (const cursor of ["l1.!!", "garbage", cursorOf({ r: "x", i: -1 }), cursorOf({ r: "x", i: 1, extra: true }), `l1.${"A".repeat(1100)}`]) {
      expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "bulk", cursor })), cursor.slice(0, 20)).toBe("invalid-request");
    }
    f.write("bulk/zzz.txt");
    expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "bulk", cursor: firstCursor }))).toBe("cursor-stale");
    const stale = await call(f.deps, `/api/workspace-files/list?botId=bot&threadId=thread&directory=bulk&cursor=${firstCursor}`);
    expect(stale).toMatchObject({ status: 409, body: { code: "cursor-stale" } });
  });

  it("marks a folder larger than the scan limit incomplete on every page", () => {
    const f = fixture();
    mkdirSync(join(f.taskRoot, "huge"));
    for (let index = 0; index <= WORKSPACE_DIRECTORY_SCAN_LIMIT; index++) writeFileSync(join(f.taskRoot, "huge", `n${index}`), "");
    let page = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "huge" });
    let listed = page.entries.length;
    while (page.cursor) { page = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "huge", cursor: page.cursor }); listed += page.entries.length; }
    expect(listed).toBe(WORKSPACE_DIRECTORY_SCAN_LIMIT);
    expect(page.incomplete).toBe(true);
  }, 60_000);

  it("refuses unsafe folder paths and lists links without following them", () => {
    const f = fixture();
    f.write("reports/weekly/result.html"); f.write("notes.md", "notes");
    const outside = join(f.base, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret-plan.txt"), "outside");
    symlinkSync(join(f.taskRoot, "reports"), join(f.taskRoot, "alias"), "dir");
    symlinkSync(join(f.taskRoot, "notes.md"), join(f.taskRoot, "alias.md"));
    symlinkSync(outside, join(f.taskRoot, "outside"), "dir");
    linkSync(join(f.taskRoot, "notes.md"), join(f.taskRoot, "hard.md"));
    const expected: Array<[string, string]> = [["../x", "invalid-path"], ["/etc", "invalid-path"], [".git", "invalid-path"], ["a//b", "invalid-path"], ["a\\b", "invalid-path"],
      ["memory", "private-file"], ["notes/SKILLS", "private-file"], ["notes.md", "invalid-path"], ["missing", "not-found"], ["outside", "linked-file"], ["alias/weekly", "linked-file"]];
    for (const [directory, code] of expected) expect(codeOf(() => listWorkspaceDirectory(f.deps, { scope: f.scope, directory })), directory).toBe(code);
    const entries = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }).entries;
    for (const name of ["alias", "alias.md", "outside"]) {
      const entry = entries.find(item => item.name === name)!;
      expect(entry, name).toMatchObject({ kind: "link", state: "unsupported" });
      expect(entry.revision, name).toBeUndefined();
    }
    for (const name of ["notes.md", "hard.md"]) {
      const entry = entries.find(item => item.name === name)!;
      expect(entry, name).toMatchObject({ kind: "file", state: "unsupported" });
      expect(entry.revision, name).toBeUndefined();
    }
    expect(searchWorkspace(f.deps, { scope: f.scope, query: "secret" }).entries).toEqual([]);
    expect(names(searchWorkspace(f.deps, { scope: f.scope, query: "result" }).entries)).toEqual(["result.html"]);
  });
});

describe("workspace search", () => {
  it("finds a nested shell-written report by name, never by content, and skips private setup", () => {
    const f = fixture();
    f.write("a/b/c/d/Report-Final.HTML", "<h1>needle</h1>");
    const nfd = `Re${String.fromCharCode(0x301)}sume${String.fromCharCode(0x301)}.md`;
    f.write(`docs/${nfd}`, "cv");
    f.write("memory/report-private.md"); f.write(".cache/report-hidden.md"); f.write("notes/MEMORY.md");
    f.write("other.txt", "needle needle");
    const result = searchWorkspace(f.deps, { scope: f.scope, query: "  report-FINAL " });
    expect(result).toMatchObject({ scope: f.scope, query: "report-FINAL", incomplete: false, root: { state: "ready" } });
    expect(result.entries).toMatchObject([{ name: "Report-Final.HTML", relativePath: "a/b/c/d/Report-Final.HTML", kind: "file", state: "local", bytes: 15 }]);
    expect(isFileRevision(result.entries[0]!.revision)).toBe(true);
    expect(result.cursor).toBeUndefined();
    const composed = `r${String.fromCharCode(0xe9)}sum${String.fromCharCode(0xe9)}`;
    expect(searchWorkspace(f.deps, { scope: f.scope, query: composed }).entries.map(entry => entry.relativePath)).toEqual([`docs/${nfd}`]);
    expect(names(searchWorkspace(f.deps, { scope: f.scope, query: "report" }).entries)).toEqual(["Report-Final.HTML"]);
    expect(searchWorkspace(f.deps, { scope: f.scope, query: "memory" }).entries).toEqual([]);
    expect(searchWorkspace(f.deps, { scope: f.scope, query: "needle" }).entries).toEqual([]);
    for (const query of ["", "   ", "x".repeat(201), `a${String.fromCharCode(10)}b`]) expect(codeOf(() => searchWorkspace(f.deps, { scope: f.scope, query })), JSON.stringify(query)).toBe("invalid-request");
  });

  it("stops at depth 8 and says the walk is incomplete", () => {
    const f = fixture();
    const dirs = Array.from({ length: 8 }, (_, index) => `d${index + 1}`);
    f.write(`${dirs.slice(0, 7).join("/")}/deep-8.txt`);
    f.write(`${dirs.join("/")}/deep-9.txt`);
    const result = searchWorkspace(f.deps, { scope: f.scope, query: "deep" });
    expect(result.entries.map(entry => entry.relativePath)).toEqual([`${dirs.slice(0, 7).join("/")}/deep-8.txt`]);
    expect(result.incomplete).toBe(true);
    expect(result.cursor).toBeUndefined();
    // The file is still reachable by navigation.
    expect(names(listWorkspaceDirectory(f.deps, { scope: f.scope, directory: dirs.join("/") }).entries)).toEqual(["deep-9.txt"]);
  });

  it("continues a bounded walk across requests with no gap or duplicate", async () => {
    const f = fixture();
    const expected: string[] = [];
    for (let group = 0; group < 21; group++) {
      for (let item = 0; item < 100; item++) {
        const relative = `g${String(group).padStart(2, "0")}/item-${String(group * 100 + item).padStart(4, "0")}.txt`;
        f.write(relative); expected.push(relative);
      }
    }
    const miss = searchWorkspace(f.deps, { scope: f.scope, query: "no-such-name" });
    expect(miss).toMatchObject({ entries: [], scanned: WORKSPACE_SEARCH_MAX_ENTRIES, incomplete: true });
    const missNext = searchWorkspace(f.deps, { scope: f.scope, query: "no-such-name", cursor: miss.cursor });
    expect(missNext).toMatchObject({ entries: [], scanned: 2121 - WORKSPACE_SEARCH_MAX_ENTRIES, incomplete: false });
    expect(missNext.cursor).toBeUndefined();

    const found: string[] = [];
    let page = searchWorkspace(f.deps, { scope: f.scope, query: "item" });
    const firstCursor = page.cursor!;
    let requests = 1;
    found.push(...page.entries.map(entry => entry.relativePath));
    while (page.cursor) {
      expect(page.entries.length).toBeLessThanOrEqual(WORKSPACE_LIST_PAGE_SIZE);
      expect(page.scanned).toBeLessThanOrEqual(WORKSPACE_SEARCH_MAX_ENTRIES);
      expect(page.incomplete).toBe(true);
      page = searchWorkspace(f.deps, { scope: f.scope, query: "item", cursor: page.cursor });
      requests++; found.push(...page.entries.map(entry => entry.relativePath));
    }
    expect(page.incomplete).toBe(false);
    expect(requests).toBe(11);
    expect(found).toEqual(expected);
    const http = await call(f.deps, `/api/workspace-files/search?botId=bot&threadId=thread&query=item&cursor=${firstCursor}`);
    expect(http).toMatchObject({ status: 200, body: { query: "item", incomplete: true } });
    expect(codeOf(() => searchWorkspace(f.deps, { scope: f.scope, query: "other", cursor: firstCursor }))).toBe("cursor-stale");
    expect(codeOf(() => searchWorkspace(f.deps, { scope: f.scope, query: "item", cursor: "s1.bad!" }))).toBe("invalid-request");
    renameSync(join(f.taskRoot, "g00"), join(f.taskRoot, "zz"));
    expect(codeOf(() => searchWorkspace(f.deps, { scope: f.scope, query: "item", cursor: firstCursor }))).toBe("cursor-stale");
  }, 60_000);
});

describe("workspace-files route", () => {
  it("serves discovery to the desktop only, parses strictly and leaves editing to F4-T1", async () => {
    const f = fixture();
    f.write("reports/result.html", "<h1>ok</h1>");
    const q = "botId=bot&threadId=thread";
    for (const path of [`/api/workspace-files/root?${q}`, `/api/workspace-files/list?${q}`, `/api/workspace-files/search?${q}&query=result`]) {
      expect(await call(f.deps, path, { desktop: false }), path).toEqual(hiddenRoute());
    }
    expect(await call(f.deps, `/api/workspace-files/search?${q}&query=result`)).toMatchObject({ status: 200, body: { entries: [{ relativePath: "reports/result.html" }] } });
    expect(await call(f.deps, `/api/workspace-files/list?${q}&directory=reports&surface=desktop&surfaceSecret=proof`)).toMatchObject({ status: 200, body: { entries: [{ name: "result.html" }] } });
    const invalid = [
      [`/api/workspace-files/list?${q}`, "POST"], [`/api/workspace-files/list?${q}&extra=1`, "GET"], [`/api/workspace-files/list?${q}&botId=bot`, "GET"],
      ["/api/workspace-files/list?botId=bot", "GET"], ["/api/workspace-files/root?botId=../bot&threadId=thread", "GET"], [`/api/workspace-files/search?${q}`, "GET"],
      [`/api/workspace-files/search?${q}&query=a&directory=reports`, "GET"],
    ] as const;
    for (const [path, method] of invalid) {
      expect(await call(f.deps, path, { method }), `${method} ${path}`).toMatchObject({ status: 400, headers: { "cache-control": "no-store" }, body: { code: "invalid-request" } });
    }
    expect(await call(f.deps, `/api/workspace-files/list?${q}&directory=../x`)).toMatchObject({ status: 400, body: { code: "invalid-path" } });
    expect(await call(f.deps, "/api/workspace-files/root?botId=nobody&threadId=thread")).toMatchObject({ status: 404, body: { code: "scope-unavailable" } });
    for (const path of ["/api/workspace-files/read", "/api/workspace-files/write", "/api/workspace-files/save-version"]) {
      expect(await call(f.deps, path, { method: "POST" }), path).toMatchObject({ status: 501, body: { code: "not-implemented" } });
    }
    for (const path of ["/api/workspace-files", "/api/workspace-files/elsewhere"]) {
      expect(await call(f.deps, path), path).toMatchObject({ status: 404, body: { code: "not-found" } });
    }
  });
});
