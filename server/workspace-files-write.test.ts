// F4-T1: bounded read, revision-conditioned atomic Markdown write, bot-active
// hold and save-version. Every assertion observes the bytes on disk, not only
// the answer.
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeArtifacts, readArtifact } from "./artifacts.ts";
import { ProjectFolderLeaseError, ProjectFolderLeases } from "./project-folder-leases.ts";
import { ProjectTurnLeases } from "./project-turn-leases.ts";
import { hiddenRoute } from "./route-delegation.ts";
import {
  WORKSPACE_SAVE_TEMP_PREFIX, WORKSPACE_WRITE_BODY_MAX_BYTES, WorkspaceFileError, decodeWorkspaceText, listWorkspaceDirectory, readWorkspaceFile,
  saveWorkspaceVersion, workspaceFilesRoute, workspaceNewlineStyle, writeWorkspaceMarkdown, type WorkspaceFilesDeps, type WorkspaceWriteHooks,
} from "./workspace-files.ts";
import { WORKSPACE_TEXT_MAX_BYTES, type FileRevision, type SaveReceipt, type WorkspaceScopeRef } from "../shared/workspace-files.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-workspace-write-"))); roots.push(base);
  const dataDir = join(base, "data"), taskRoot = join(dataDir, "workspaces", "bot", "threads", "thread");
  mkdirSync(taskRoot, { recursive: true });
  const task: { threadId: string; cwd?: string | null; resumeCursors: Record<string, unknown> } = { threadId: "thread", cwd: taskRoot, resumeCursors: {} };
  const bot = { id: "bot", name: "Research bot", threadId: "thread", resumeCursors: {}, tasks: [task] };
  const db = new DatabaseSync(join(base, "messages.db")); initializeArtifacts(db); databases.push(db);
  const leases = new ProjectFolderLeases();
  // Same rules as artifactScopes() in server/index.ts for a direct task.
  const deps: WorkspaceFilesDeps = {
    dataDir, database: () => db, store: { bots: [bot], groups: [] } as never,
    artifactScopes: () => bot.tasks.filter(item => item.cwd !== null)
      .map(item => ({ botId: bot.id, botName: bot.name, threadId: item.threadId, workspaceRoot: item.cwd ?? join(dataDir, "workspaces", bot.id) })),
    projectFolders: leases,
  };
  const scope: WorkspaceScopeRef = { botId: "bot", threadId: "thread" };
  const put = (relative: string, content: string | Uint8Array) => {
    const path = join(taskRoot, ...relative.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  const storage = join(dataDir, "artifact-files");
  const access = { owner: true, scopes: [{ botId: "bot", botName: bot.name, threadId: "thread", workspaceRoot: taskRoot }] };
  const artifactCount = () => Number((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n);
  const read = (relativePath: string) => readWorkspaceFile(deps, { scope, relativePath });
  const save = (relativePath: string, content: string, baseRevision: FileRevision | null, extra: Record<string, unknown> = {}, hooks?: WorkspaceWriteHooks): Promise<SaveReceipt> =>
    writeWorkspaceMarkdown(deps, { scope, relativePath, baseRevision, requestId: "req-1", content, bom: false, ...extra }, hooks);
  const leftovers = (directory = taskRoot) => readdirSync(directory).filter(name => name.startsWith(WORKSPACE_SAVE_TEMP_PREFIX));
  return { base, dataDir, taskRoot, task, bot, db, leases, deps, scope, put, storage, access, artifactCount, read, save, leftovers };
}

/** The refusal a sync read or an async write throws (rejects with). */
async function refusal(action: () => unknown): Promise<WorkspaceFileError> {
  try { await action(); } catch (error) { if (error instanceof WorkspaceFileError) return error; throw error; }
  throw new Error("expected a refusal");
}
const codeOf = async (action: () => unknown) => (await refusal(action)).code;

type RouteOptions = { method?: string; desktop?: boolean; body?: unknown; readBody?: (maxBytes?: number) => Promise<unknown> };
const call = (deps: WorkspaceFilesDeps, target: string, options: RouteOptions = {}) => {
  const url = new URL(`http://127.0.0.1${target}`);
  return workspaceFilesRoute({ method: options.method ?? "GET", path: url.pathname, url, headers: {}, desktop: options.desktop ?? true,
    readBody: options.readBody ?? (async () => options.body) }, deps);
};

describe("bounded workspace read", () => {
  it("reports BOM, newline style and the discovery revision, and leaves the bytes untouched", async () => {
    const f = fixture();
    const original = Buffer.concat([BOM, Buffer.from("# Title\r\nBody ü\r\n", "utf8")]);
    const path = f.put("notes/a.md", original);
    const before = lstatSync(path);
    const result = f.read("notes/a.md");
    expect(result).toMatchObject({ scope: f.scope, relativePath: "notes/a.md", encoding: "utf-8", bom: true, newline: "crlf", bytes: original.length, content: "# Title\r\nBody ü\r\n" });
    expect(result.modifiedAt).toBe(Math.trunc(before.mtimeMs));
    const listed = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "notes" }).entries.find(entry => entry.name === "a.md");
    expect(result.revision).toBe(listed?.revision);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(lstatSync(path).mtimeMs).toBe(before.mtimeMs);
  });

  it("classifies newline styles and keeps a second BOM in the content", async () => {
    expect(workspaceNewlineStyle("a\nb\n")).toBe("lf");
    expect(workspaceNewlineStyle("a\r\nb")).toBe("crlf");
    expect(workspaceNewlineStyle("a\r\nb\n")).toBe("mixed");
    expect(workspaceNewlineStyle("a\rb")).toBe("mixed");
    expect(workspaceNewlineStyle("one line")).toBe("none");
    expect(decodeWorkspaceText(Buffer.concat([BOM, BOM, Buffer.from("x")]))).toEqual({ bom: true, content: "\uFEFFx" });
    expect(decodeWorkspaceText(Buffer.from("plain"))).toEqual({ bom: false, content: "plain" });
  });

  it("refuses non-UTF-8, oversized, linked, hard-linked, private, hidden and missing files", async () => {
    const f = fixture();
    f.put("latin1.md", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await codeOf(() => f.read("latin1.md"))).toBe("unsupported-encoding");
    f.put("big.md", Buffer.alloc(WORKSPACE_TEXT_MAX_BYTES + 1, 0x61));
    expect(await codeOf(() => f.read("big.md"))).toBe("too-large");
    const outside = join(f.base, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret.md"), "outside");
    symlinkSync(join(outside, "secret.md"), join(f.taskRoot, "link.md"));
    expect(await codeOf(() => f.read("link.md"))).toBe("linked-file");
    symlinkSync(outside, join(f.taskRoot, "linked"));
    expect(await codeOf(() => f.read("linked/secret.md"))).toBe("linked-file");
    const hard = f.put("hard.md", "shared");
    linkSync(hard, join(f.taskRoot, "hard-copy.md"));
    expect(await codeOf(() => f.read("hard.md"))).toBe("not-regular-file");
    mkdirSync(join(f.taskRoot, "folder.md"));
    expect(await codeOf(() => f.read("folder.md"))).toBe("not-regular-file");
    f.put("MEMORY.md", "private");
    expect(await codeOf(() => f.read("MEMORY.md"))).toBe("private-file");
    expect(await codeOf(() => f.read("memory/notes.md"))).toBe("private-file");
    for (const bad of [".hidden.md", "../x.md", "/etc/hosts", "a\\b.md", "c:x.md", ""]) expect(await codeOf(() => f.read(bad)), bad).toBe("invalid-path");
    expect(await codeOf(() => f.read("missing.md"))).toBe("not-found");
    expect(await codeOf(() => f.read("missing/deeper.md"))).toBe("not-found");
  });

  it("answers the conversation state instead of reading legacy, unknown or not-yet-created workspaces", async () => {
    const f = fixture();
    f.put("a.md", "x");
    f.task.cwd = null;
    expect(await codeOf(() => f.read("a.md"))).toBe("no-dedicated-workspace");
    f.task.cwd = undefined; rmSync(f.taskRoot, { recursive: true });
    expect(await codeOf(() => f.read("a.md"))).toBe("not-found");
    expect(await codeOf(() => readWorkspaceFile(f.deps, { scope: { botId: "nobody", threadId: "thread" }, relativePath: "a.md" }))).toBe("scope-unavailable");
  });

  it("serves GET reads to the desktop only", async () => {
    const f = fixture();
    f.put("a.md", "# A\n");
    const ok = await call(f.deps, "/api/workspace-files/read?botId=bot&threadId=thread&path=a.md");
    expect(ok).toMatchObject({ status: 200, headers: { "cache-control": "no-store" }, body: { content: "# A\n", newline: "lf", bom: false } });
    expect(await call(f.deps, "/api/workspace-files/read?botId=bot&threadId=thread&path=a.md", { desktop: false })).toEqual(hiddenRoute());
    expect(await call(f.deps, "/api/workspace-files/read?botId=bot&threadId=thread&path=a.md", { method: "POST" })).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await call(f.deps, "/api/workspace-files/read?botId=bot&threadId=thread&path=a.md&root=/")).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await call(f.deps, "/api/workspace-files/read?botId=bot&threadId=thread&path=missing.md")).toMatchObject({ status: 404, body: { code: "not-found" } });
  });
});

describe("revision-conditioned Markdown write", () => {
  it("writes the exact bytes, keeps BOM, CRLF and file mode, and keeps the previous revision in Files", async () => {
    const f = fixture();
    const old = Buffer.concat([BOM, Buffer.from("# Old\r\n", "utf8")]);
    const path = f.put("reports/report.md", old);
    chmodSync(path, 0o640);
    const opened = f.read("reports/report.md");
    const receipt = await f.save("reports/report.md", "# New\r\nline two\r\n", opened.revision, { bom: true, draftRevision: 7, requestId: "save-42" });
    const expected = Buffer.concat([BOM, Buffer.from("# New\r\nline two\r\n", "utf8")]);
    expect(readFileSync(path).equals(expected)).toBe(true);
    expect(receipt).toMatchObject({ requestId: "save-42", scope: f.scope, relativePath: "reports/report.md", previousRevision: opened.revision, bytes: expected.length, draftRevision: 7 });
    expect(receipt.revision).not.toBe(opened.revision);
    expect(f.read("reports/report.md")).toMatchObject({ revision: receipt.revision, bom: true, newline: "crlf", content: "# New\r\nline two\r\n" });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(lstatSync(path).nlink).toBe(1);
    // The replaced revision is recoverable, byte for byte, from Files.
    expect(receipt.artifactId).toBeTruthy();
    const kept = readArtifact(f.db, f.storage, receipt.artifactId!, f.access);
    expect(kept.bytes.equals(old)).toBe(true);
    expect(kept.artifact).toMatchObject({ relativePath: "reports/report.md", sha256: sha(old), sourceState: "changed" });
    expect(kept.artifact.producer).toBeUndefined();
    expect(kept.artifact.runId).toBeUndefined();
    expect(f.leftovers(join(f.taskRoot, "reports"))).toEqual([]);
    // A second edit builds on the new revision.
    const second = await f.save("reports/report.md", "# Newer\n", receipt.revision);
    expect(readFileSync(path, "utf8")).toBe("# Newer\n");
    expect(second.previousRevision).toBe(receipt.revision);
  });

  it("saving the unchanged text rewrites nothing and adds no saved version", async () => {
    const f = fixture();
    const original = Buffer.concat([BOM, Buffer.from("same\r\ntext\n", "utf8")]);
    const path = f.put("same.md", original);
    const before = lstatSync(path), opened = f.read("same.md");
    const receipt = await f.save("same.md", opened.content, opened.revision, { bom: opened.bom });
    expect(receipt).toMatchObject({ previousRevision: opened.revision, revision: opened.revision, bytes: original.length });
    expect(receipt.artifactId).toBeUndefined();
    const after = lstatSync(path);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(f.artifactCount()).toBe(0);
  });

  it("refuses a stale revision and never overwrites an external change", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    writeFileSync(path, "# Changed elsewhere\n");
    const error = await refusal(() => f.save("a.md", "# My edit\n", opened.revision));
    expect(error.code).toBe("revision-conflict");
    expect(error.status).toBe(409);
    expect(error.currentRevision).toBe(f.read("a.md").revision);
    expect(readFileSync(path, "utf8")).toBe("# Changed elsewhere\n");
    expect(f.leftovers()).toEqual([]);
    expect(f.artifactCount()).toBe(0);
  });

  it("rechecks the file immediately before the commit", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    const error = await refusal(() => f.save("a.md", "# My edit\n", opened.revision, {}, { beforeCommit: () => writeFileSync(path, "# Bot wrote this\n") }));
    expect(error.code).toBe("revision-conflict");
    expect(error.currentRevision).toBe(f.read("a.md").revision);
    expect(readFileSync(path, "utf8")).toBe("# Bot wrote this\n");
    expect(f.leftovers()).toEqual([]);
  });

  it("refuses a file that was moved, deleted or swapped for a link", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    unlinkSync(path);
    expect(await codeOf(() => f.save("a.md", "# Edit\n", opened.revision))).toBe("not-found");
    const outside = join(f.base, "target.md"); writeFileSync(outside, "outside");
    symlinkSync(outside, path);
    expect(await codeOf(() => f.save("a.md", "# Edit\n", opened.revision))).toBe("linked-file");
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    unlinkSync(path);
    const moved = f.put("b.md", "# Base\n"), movedRevision = f.read("b.md").revision;
    // A different file at the same name is a different revision. The original
    // is moved away and kept, so the replacement really is another file:
    // Linux hands a freed inode number straight back, and inside one timestamp
    // tick an unlink + recreate with the same bytes is the same dev, ino, size,
    // mtime, ctime and content — no observable property says it is different.
    const away = join(f.base, "b-moved-away.md");
    renameSync(moved, away); writeFileSync(moved, "# Base\n");
    expect(lstatSync(moved).ino).not.toBe(lstatSync(away).ino);
    expect(await codeOf(() => f.save("b.md", "# Edit\n", movedRevision))).toBe("revision-conflict");
    expect(readFileSync(moved, "utf8")).toBe("# Base\n");
    expect(f.leftovers()).toEqual([]);
  });

  it("Save a copy creates a new private file and never replaces an existing one", async () => {
    const f = fixture();
    const receipt = await f.save("copy.md", "# Copy\n", null);
    const path = join(f.taskRoot, "copy.md");
    expect(receipt).toMatchObject({ previousRevision: null, relativePath: "copy.md" });
    expect(receipt.artifactId).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("# Copy\n");
    expect(lstatSync(path).nlink).toBe(1);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(f.read("copy.md").revision).toBe(receipt.revision);
    expect(await codeOf(() => f.save("copy.md", "# Other\n", null))).toBe("already-exists");
    expect(readFileSync(path, "utf8")).toBe("# Copy\n");
    // Created by someone else between the check and the commit.
    const racer = join(f.taskRoot, "race.md");
    expect(await codeOf(() => f.save("race.md", "# Mine\n", null, {}, { beforeCommit: () => writeFileSync(racer, "# Theirs\n") }))).toBe("already-exists");
    expect(readFileSync(racer, "utf8")).toBe("# Theirs\n");
    // No folders are created for a copy.
    expect(await codeOf(() => f.save("new-folder/copy.md", "# Copy\n", null))).toBe("not-found");
    expect(f.leftovers()).toEqual([]);
  });

  it("writes Markdown only, within the size bound, from a well-formed request", async () => {
    const f = fixture();
    const path = f.put("a.txt", "text"), opened = f.read("a.txt");
    expect(await codeOf(() => f.save("a.txt", "changed", opened.revision))).toBe("invalid-request");
    expect(readFileSync(path, "utf8")).toBe("text");
    const md = f.put("a.md", "x"), base = f.read("a.md").revision;
    expect(await codeOf(() => f.save("a.md", "a".repeat(WORKSPACE_TEXT_MAX_BYTES + 1), base))).toBe("too-large");
    expect(await codeOf(() => f.save("a.md", "a".repeat(WORKSPACE_TEXT_MAX_BYTES - 2), base, { bom: true }))).toBe("too-large");
    expect(await codeOf(() => f.save("a.md", "broken \uD800 surrogate", base))).toBe("invalid-request");
    expect(await codeOf(() => f.save("MEMORY.md", "x", null))).toBe("private-file");
    const good = { scope: f.scope, relativePath: "a.md", baseRevision: base, requestId: "r", content: "y", bom: false };
    for (const bad of [
      null, [], "text", { ...good, extra: true }, { ...good, requestId: undefined }, { ...good, requestId: "bad id" }, { ...good, baseRevision: "short" },
      { ...good, baseRevision: undefined }, { ...good, content: 5 }, { ...good, bom: "no" }, { ...good, draftRevision: -1 }, { ...good, draftRevision: 1.5 },
      { ...good, scope: { botId: "bot", threadId: "thread", root: "/" } }, { ...good, scope: { botId: "../bot", threadId: "thread" } },
    ]) expect(await codeOf(() => writeWorkspaceMarkdown(f.deps, bad)), JSON.stringify(bad)).toBe("invalid-request");
    expect(readFileSync(md, "utf8")).toBe("x");
    // A full-size document is accepted.
    const full = "b".repeat(WORKSPACE_TEXT_MAX_BYTES);
    expect((await f.save("a.md", full, base)).bytes).toBe(WORKSPACE_TEXT_MAX_BYTES);
    expect(statSync(md).size).toBe(WORKSPACE_TEXT_MAX_BYTES);
  });

  it("refuses legacy, remote and not-yet-authorized workspaces", async () => {
    const f = fixture();
    f.put("a.md", "x");
    const base = f.read("a.md").revision;
    f.task.cwd = null;
    expect(await codeOf(() => f.save("a.md", "y", base))).toBe("no-dedicated-workspace");
    writeFileSync(join(f.dataDir, "routines.json"), JSON.stringify({ runs: [{ botId: "bot", threadId: "thread", runOn: "cloud" }] }));
    expect(await codeOf(() => f.save("a.md", "y", base))).toBe("remote-workspace");
    rmSync(join(f.dataDir, "routines.json"));
    // Not dispatched yet: dispatch would pin this folder, but Files does not
    // authorize it for the conversation, so nothing is written into it.
    f.task.cwd = undefined;
    expect(await codeOf(() => f.save("a.md", "y", base))).toBe("scope-unavailable");
    expect(await codeOf(() => f.save("new.md", "y", null))).toBe("scope-unavailable");
    expect(readFileSync(join(f.taskRoot, "a.md"), "utf8")).toBe("x");
  });
});

describe("bot-active hold", () => {
  it("holds an overwrite while a bot turn is using the workspace, and still allows Save a copy", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    f.leases.acquireWriter("turn-1", f.taskRoot);
    const error = await refusal(() => f.save("a.md", "# Edit\n", opened.revision));
    expect([error.code, error.status]).toEqual(["bot-writing", 423]);
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.artifactCount()).toBe(0);
    expect(f.leftovers()).toEqual([]);
    expect((await f.save("a copy.md", "# Edit\n", null)).previousRevision).toBeNull();
    f.leases.release("turn-1");
    // A room turn on the bot's whole desk overlaps this task workspace too.
    f.leases.acquireWriter("room-turn", join(f.dataDir, "workspaces", "bot"));
    expect(await codeOf(() => f.save("a.md", "# Edit\n", opened.revision))).toBe("bot-writing");
    f.leases.release("room-turn");
    // A turn in an unrelated folder does not hold this workspace.
    const elsewhere = join(f.base, "project"); mkdirSync(elsewhere);
    f.leases.acquireWriter("other-turn", elsewhere);
    await f.save("a.md", "# Edit\n", opened.revision);
    expect(readFileSync(path, "utf8")).toBe("# Edit\n");
  });

  it("keeps a bot turn from starting inside the commit window and releases the hold afterwards", async () => {
    const f = fixture();
    f.put("a.md", "# Base\n");
    let refused: unknown;
    await f.save("a.md", "# Edit\n", f.read("a.md").revision, {}, { beforeCommit: () => {
      try { f.leases.acquireWriter("late-turn", f.taskRoot); } catch (error) { refused = error; }
    } });
    expect(refused).toBeInstanceOf(ProjectFolderLeaseError);
    expect((refused as ProjectFolderLeaseError).code).toBe("conflict");
    expect(() => f.leases.acquireWriter("next-turn", f.taskRoot)).not.toThrow();
    f.leases.release("next-turn");
    // A refused save releases its hold as well.
    expect(await codeOf(() => f.save("a.md", "# Again\n", "r1.stale-revision-token" as FileRevision))).toBe("revision-conflict");
    expect(() => f.leases.acquireWriter("after-refusal", f.taskRoot)).not.toThrow();
  });

  // STOPRESTORE2: the Stop → engine-close window. A stopped turn keeps its
  // writer lease until the engine's terminal event, while the bot already
  // reads idle. With the turn-aware admission (server/index.ts passes
  // projectTurnLeases) an overwrite waits for that release, bounded by the
  // engine's close budget; a live turn is still refused at once.
  function turnAware(closeMs: number) {
    const f = fixture();
    const turns = new ProjectTurnLeases();
    const deps: WorkspaceFilesDeps = { ...f.deps, projectFolders: turns.folders, projectTurns: turns, stoppedTurnCloseMs: () => closeMs };
    const save = (relativePath: string, content: string, baseRevision: FileRevision | null) =>
      writeWorkspaceMarkdown(deps, { scope: f.scope, relativePath, baseRevision, requestId: "req-1", content, bom: false });
    const hold = (generation: string, stop: boolean) => {
      turns.acquire("thread", generation, f.taskRoot);
      turns.markDispatched(generation);
      turns.bind("thread", generation, `turn-${generation}`);
      if (stop) turns.markStopRequested(generation);
    };
    return { ...f, turns, deps, save, hold };
  }

  it("waits for a stopped turn's lease and then writes; nothing is written before the release", async () => {
    const f = turnAware(5_000);
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    f.hold("stopped", true);
    let settled: SaveReceipt | undefined;
    const save = f.save("a.md", "# Edit\n", opened.revision);
    save.then(receipt => { settled = receipt; }, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(settled).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.leftovers()).toEqual([]);
    // The engine's terminal event releases the lease: the save goes through.
    f.turns.complete("thread", "turn-stopped");
    expect((await save).previousRevision).toBe(opened.revision);
    expect(readFileSync(path, "utf8")).toBe("# Edit\n");
    expect(f.artifactCount()).toBe(1);
    // The hold is gone afterwards: a new turn can start in the folder.
    expect(() => f.turns.acquire("thread", "next", f.taskRoot)).not.toThrow();
  });

  it("still refuses a live turn at once, with a stopped one beside it or alone", async () => {
    const f = turnAware(5_000);
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    f.hold("live", false);
    const started = Date.now();
    const error = await refusal(() => f.save("a.md", "# Edit\n", opened.revision));
    expect([error.code, error.status]).toEqual(["bot-writing", 423]);
    expect(Date.now() - started).toBeLessThan(1_000);
    f.hold("stopped", true);
    expect(await codeOf(() => f.save("a.md", "# Edit\n", opened.revision))).toBe("bot-writing");
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.artifactCount()).toBe(0);
    // Save a copy never needs the hold.
    expect((await f.save("copy.md", "# Edit\n", null)).previousRevision).toBeNull();
  });

  it("answers workspace_stopped_turn_closing (423, retry) when the stopped turn outlives the close budget, and a retry after the close writes", async () => {
    const f = turnAware(50);
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    f.hold("stopped", true);
    const error = await refusal(() => f.save("a.md", "# Edit\n", opened.revision));
    expect([error.code, error.status]).toEqual(["workspace_stopped_turn_closing", 423]);
    expect(error.message).toMatch(/stopped bot turn is still closing/);
    expect(error.message).toMatch(/save again/);
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.leftovers()).toEqual([]);
    // Nothing was taken from the stopped turn; it still owns the folder.
    expect(f.turns.folders.conflicts(f.taskRoot, "restore").map(lease => lease.ownerId)).toEqual(["stopped"]);
    const held = await call(f.deps, "/api/workspace-files/write", { method: "POST", body: { scope: f.scope, relativePath: "a.md", baseRevision: opened.revision, requestId: "route-1", content: "# Edit\n", bom: false } });
    expect(held).toMatchObject({ status: 423, body: { code: "workspace_stopped_turn_closing" } });
    f.turns.complete("thread", "turn-stopped");
    expect((await f.save("a.md", "# Edit\n", opened.revision)).previousRevision).toBe(opened.revision);
    expect(readFileSync(path, "utf8")).toBe("# Edit\n");
  });

  it("refuses, not writes, when the conversation stops resolving to the held folder during the wait", async () => {
    const f = turnAware(5_000);
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    f.hold("stopped", true);
    const save = f.save("a.md", "# Edit\n", opened.revision);
    // The task is re-pointed while the save waits (a legacy home pin).
    f.task.cwd = null;
    f.turns.complete("thread", "turn-stopped");
    expect(await codeOf(() => save)).toBe("no-dedicated-workspace");
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(() => f.turns.acquire("thread", "next", f.taskRoot)).not.toThrow();
  });

  it("fails closed when the writer registry is not available", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const deps = { ...f.deps, projectFolders: undefined };
    const request = { scope: f.scope, relativePath: "a.md", baseRevision: f.read("a.md").revision, requestId: "r", content: "# Edit\n", bom: false };
    expect(await codeOf(() => writeWorkspaceMarkdown(deps, request))).toBe("bot-writing");
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect((await writeWorkspaceMarkdown(deps, { ...request, relativePath: "copy.md", baseRevision: null })).previousRevision).toBeNull();
  });

  // FOLLOW2 (STOPRESTORE2 verifier notes). The registry only ever throws its
  // own refusals, but a save must answer the same way on both admission
  // paths if it ever throws anything else: an unusable folder, never a
  // writing bot. The turn-aware path used to fold such a throw into
  // `bot-writing` (423) while the synchronous path answered `root-changed`.
  it("answers root-changed, not bot-writing, when the registry throws something other than its own refusal, on either admission path", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    const request = { scope: f.scope, relativePath: "a.md", baseRevision: opened.revision, requestId: "r", content: "# Edit\n", bom: false };
    const broken = { acquireRestore: () => { throw new TypeError("registry exploded"); }, release: () => false };
    // Synchronous path (no projectTurns): the pre-STOPRESTORE2 behavior.
    const sync = await refusal(() => writeWorkspaceMarkdown({ ...f.deps, projectFolders: broken }, request));
    expect([sync.code, sync.status]).toEqual(["root-changed", 409]);
    // Turn-aware path: the same throw, through acquireRestoreWhenStopped.
    const turns = new ProjectTurnLeases();
    Object.defineProperty(turns, "folders", { value: broken });
    const aware = await refusal(() => writeWorkspaceMarkdown({ ...f.deps, projectFolders: broken, projectTurns: turns, stoppedTurnCloseMs: () => 5_000 }, request));
    expect([aware.code, aware.status]).toEqual(["root-changed", 409]);
    // The registry's own refusals keep their meaning on that path.
    const conflicting = { acquireRestore: () => { throw new ProjectFolderLeaseError("conflict"); }, release: () => false, conflicts: () => { throw new ProjectFolderLeaseError("conflict"); } };
    Object.defineProperty(turns, "folders", { value: conflicting });
    expect(await codeOf(() => writeWorkspaceMarkdown({ ...f.deps, projectFolders: conflicting, projectTurns: turns, stoppedTurnCloseMs: () => 5_000 }, request))).toBe("bot-writing");
    const unusable = { acquireRestore: () => { throw new ProjectFolderLeaseError("invalid-path"); }, release: () => false };
    Object.defineProperty(turns, "folders", { value: unusable });
    expect(await codeOf(() => writeWorkspaceMarkdown({ ...f.deps, projectFolders: unusable, projectTurns: turns, stoppedTurnCloseMs: () => 5_000 }, request))).toBe("root-changed");
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.artifactCount()).toBe(0);
    expect(f.leftovers()).toEqual([]);
  });

  // FOLLOW2 (STOPRESTORE2 verifier notes). `stoppedTurnCloseMs` is optional;
  // without it the wait budget was 0 and a stopped turn answered
  // workspace_stopped_turn_closing at once, as if the engine's close budget
  // had already run out. The default is that budget, providerCloseDeadlineMs
  // (MURAGE_PROVIDER_CLOSE_MS, read at each save).
  it("waits for a stopped turn up to the engine's close budget when stoppedTurnCloseMs is not passed", async () => {
    const previous = process.env.MURAGE_PROVIDER_CLOSE_MS;
    try {
      const f = turnAware(0);
      const deps: WorkspaceFilesDeps = { ...f.deps, stoppedTurnCloseMs: undefined };
      const path = f.put("a.md", "# Base\n");
      const opened = f.read("a.md");
      const request = { scope: f.scope, relativePath: "a.md", baseRevision: opened.revision, requestId: "r", content: "# Edit\n", bom: false };
      f.hold("stopped", true);
      // The default budget (5 s): the save is still waiting after 60 ms,
      // and goes through once the engine's terminal event releases the lease.
      delete process.env.MURAGE_PROVIDER_CLOSE_MS;
      let settled: SaveReceipt | undefined;
      const save = writeWorkspaceMarkdown(deps, request);
      save.then(receipt => { settled = receipt; }, () => undefined);
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(settled).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("# Base\n");
      f.turns.complete("thread", "turn-stopped");
      expect((await save).previousRevision).toBe(opened.revision);
      expect(readFileSync(path, "utf8")).toBe("# Edit\n");
      // The budget is the engine's, read at save time: shortened, the wait
      // ends on workspace_stopped_turn_closing instead of at once.
      process.env.MURAGE_PROVIDER_CLOSE_MS = "50";
      const reopened = f.read("a.md");
      f.hold("stopped-again", true);
      const started = Date.now();
      const error = await refusal(() => writeWorkspaceMarkdown(deps, { ...request, baseRevision: reopened.revision, content: "# Again\n" }));
      expect([error.code, error.status]).toEqual(["workspace_stopped_turn_closing", 423]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
      expect(readFileSync(path, "utf8")).toBe("# Edit\n");
    } finally {
      if (previous === undefined) delete process.env.MURAGE_PROVIDER_CLOSE_MS; else process.env.MURAGE_PROVIDER_CLOSE_MS = previous;
    }
  });
});

describe("previous revision must be kept", () => {
  it("overwrites nothing when the Files library cannot store the previous revision", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    writeFileSync(f.storage, "not a folder");
    expect(await codeOf(() => f.save("a.md", "# Edit\n", opened.revision))).toBe("write-failed");
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.leftovers()).toEqual([]);
    rmSync(f.storage);
    // 10,000 saved files is the library's count limit.
    mkdirSync(f.storage);
    for (let index = 0; index < 10_000; index++) writeFileSync(join(f.storage, `f${index}.txt`), "");
    const full = await refusal(() => f.save("a.md", "# Edit\n", opened.revision));
    expect([full.code, full.status]).toEqual(["quota-exceeded", 507]);
    expect(readFileSync(path, "utf8")).toBe("# Base\n");
    expect(f.leftovers()).toEqual([]);
    expect(f.artifactCount()).toBe(0);
  });
});

describe("save version", () => {
  it("copies exactly the chosen revision into Files without invented provenance, once", async () => {
    const f = fixture();
    const bytes = Buffer.from("<h1>Report</h1>");
    f.put("reports/report.html", bytes);
    const revision = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "reports" }).entries[0]!.revision!;
    const { artifact } = saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "reports/report.html", revision, name: "  Q3 report  " });
    expect(artifact).toMatchObject({ name: "Q3 report", kind: "html", sha256: sha(bytes), bytes: bytes.length, relativePath: "reports/report.html", sourceState: "current", botId: "bot", threadId: "thread" });
    expect(artifact.producer).toBeUndefined();
    expect(artifact.runId).toBeUndefined();
    expect(readArtifact(f.db, f.storage, artifact.id, f.access).bytes.equals(bytes)).toBe(true);
    expect(saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "reports/report.html", revision, name: "Q3 report" }).artifact.id).toBe(artifact.id);
    expect(f.artifactCount()).toBe(1);
  });

  it("refuses a changed, private, oversized or malformed request", async () => {
    const f = fixture();
    const path = f.put("a.md", "one");
    const revision = f.read("a.md").revision;
    writeFileSync(path, "two");
    const error = await refusal(() => saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "a.md", revision }));
    expect(error.code).toBe("revision-conflict");
    expect(error.currentRevision).toBe(f.read("a.md").revision);
    f.put("MEMORY.md", "private");
    expect(await codeOf(() => saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "MEMORY.md", revision }))).toBe("private-file");
    f.put("huge.bin", Buffer.alloc(25 * 1024 * 1024 + 1));
    const huge = listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "" }).entries.find(entry => entry.name === "huge.bin")!.revision!;
    expect(await codeOf(() => saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "huge.bin", revision: huge }))).toBe("too-large");
    for (const bad of [{}, { scope: f.scope, relativePath: "a.md" }, { scope: f.scope, relativePath: "a.md", revision, name: "" }, { scope: f.scope, relativePath: "a.md", revision, name: "x".repeat(201) },
      { scope: f.scope, relativePath: "a.md", revision, path: "/etc/hosts" }]) expect(await codeOf(() => saveWorkspaceVersion(f.deps, bad)), JSON.stringify(bad)).toBe("invalid-request");
    expect(f.artifactCount()).toBe(0);
  });
});

// Hetzner int-head (Linux, 48 workers): an equal-length rewrite made inside
// one timestamp tick kept size, inode, mtime and ctime, so a revision built
// from metadata alone stayed valid and Save version copied bytes nobody chose.
// Each case rewrites the same number of bytes and puts the modification time
// back, the way a quick tool edit looks on a coarse-timestamp filesystem.
// server/workspace-revision.test.ts proves the same with every timestamp held.
describe("an equal-length rewrite with the modification time put back", () => {
  const rewriteKeepingTime = (path: string, content: string) => {
    const before = lstatSync(path);
    writeFileSync(path, content);
    utimesSync(path, before.atime, before.mtime);
    const after = lstatSync(path);
    expect([after.ino, after.size]).toEqual([before.ino, before.size]);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(1);
  };

  it("refuses Save version for the old revision and saves nothing", async () => {
    const f = fixture();
    const path = f.put("a.md", "one");
    const revision = f.read("a.md").revision;
    rewriteKeepingTime(path, "two");
    const error = await refusal(() => saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "a.md", revision }));
    expect(error.code).toBe("revision-conflict");
    expect(error.currentRevision).toBe(f.read("a.md").revision);
    expect(error.currentRevision).not.toBe(revision);
    expect(f.artifactCount()).toBe(0);
    // The new state saves as exactly its own bytes.
    const { artifact } = saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "a.md", revision: error.currentRevision! });
    expect(readArtifact(f.db, f.storage, artifact.id, f.access).bytes.toString("utf8")).toBe("two");
  });

  it("refuses a Markdown save based on the old revision and leaves the rewrite on disk", async () => {
    const f = fixture();
    const path = f.put("a.md", "# one\n");
    const opened = f.read("a.md");
    rewriteKeepingTime(path, "# two\n");
    const error = await refusal(() => f.save("a.md", "# mine\n", opened.revision));
    expect(error.code).toBe("revision-conflict");
    expect(error.currentRevision).toBe(f.read("a.md").revision);
    expect(readFileSync(path, "utf8")).toBe("# two\n");
    expect(f.leftovers()).toEqual([]);
    expect(f.artifactCount()).toBe(0);
    // Saving the old text back over it is not "unchanged" either.
    expect(await codeOf(() => f.save("a.md", "# one\n", opened.revision))).toBe("revision-conflict");
    expect(readFileSync(path, "utf8")).toBe("# two\n");
  });

  it("gives the rewritten file a new listing revision that matches its read", async () => {
    const f = fixture();
    const path = f.put("notes/a.md", "alpha");
    const listed = () => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "notes" }).entries.find(entry => entry.name === "a.md")!.revision;
    const before = listed();
    expect(before).toBe(f.read("notes/a.md").revision);
    rewriteKeepingTime(path, "omega");
    const after = listed();
    expect(after).not.toBe(before);
    expect(f.read("notes/a.md")).toMatchObject({ revision: after, content: "omega" });
  });
});

describe("write and save-version routes", () => {
  it("round-trips a save through the desktop route with the larger body bound", async () => {
    const f = fixture();
    const path = f.put("a.md", "# Base\n");
    const opened = f.read("a.md");
    let bound: number | undefined;
    const body = { scope: f.scope, relativePath: "a.md", baseRevision: opened.revision, requestId: "route-1", content: "# Route\n", bom: false };
    const ok = await call(f.deps, "/api/workspace-files/write", { method: "POST", readBody: async maxBytes => { bound = maxBytes; return body; } });
    expect(bound).toBe(WORKSPACE_WRITE_BODY_MAX_BYTES);
    expect(ok).toMatchObject({ status: 200, headers: { "cache-control": "no-store" }, body: { requestId: "route-1", previousRevision: opened.revision } });
    expect(readFileSync(path, "utf8")).toBe("# Route\n");
    const stale = await call(f.deps, "/api/workspace-files/write", { method: "POST", body });
    expect(stale).toMatchObject({ status: 409, body: { code: "revision-conflict", currentRevision: f.read("a.md").revision } });
    f.leases.acquireWriter("turn", f.taskRoot);
    const held = await call(f.deps, "/api/workspace-files/write", { method: "POST", body: { ...body, baseRevision: f.read("a.md").revision } });
    expect(held).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    f.leases.release("turn");
    const tooBig = await call(f.deps, "/api/workspace-files/write", { method: "POST", readBody: async () => { throw Object.assign(new Error("body too large"), { status: 413 }); } });
    expect(tooBig).toMatchObject({ status: 413, body: { code: "too-large" } });
    const badJson = await call(f.deps, "/api/workspace-files/write", { method: "POST", readBody: async () => { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); } });
    expect(badJson).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await call(f.deps, "/api/workspace-files/write", { method: "GET" })).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(readFileSync(path, "utf8")).toBe("# Route\n");
  });

  it("creates a saved version with 201 and hides both routes from non-desktop callers", async () => {
    const f = fixture();
    f.put("a.md", "# Base\n");
    const revision = f.read("a.md").revision;
    let reads = 0;
    const readBody = async () => { reads++; return { scope: f.scope, relativePath: "a.md", revision }; };
    expect(await call(f.deps, "/api/workspace-files/save-version", { method: "POST", desktop: false, readBody })).toEqual(hiddenRoute());
    expect(await call(f.deps, "/api/workspace-files/write", { method: "POST", desktop: false, readBody })).toEqual(hiddenRoute());
    expect(reads).toBe(0);
    const saved = await call(f.deps, "/api/workspace-files/save-version", { method: "POST", readBody });
    expect(saved).toMatchObject({ status: 201, headers: { "cache-control": "no-store" }, body: { artifact: { relativePath: "a.md", name: "a.md" } } });
    expect(f.artifactCount()).toBe(1);
  });
});
