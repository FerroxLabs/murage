// S5-DATADIR-PATHS r4.1 section 7: the data-root model (DR0-DR7) and rebaseStoredPath (section 2), on throwaway folders.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataRoots, dataRootSeams, sameRoot, WorkspaceTreeError, workspaceTreeText } from "./data-roots.ts";
import { lexicalKey, rebaseStoredPath } from "./stored-paths.ts";
import { protectedRootRefusal } from "./data-dir-guard.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const temps: string[] = [];
const seamsBefore = { ...dataRootSeams };
afterEach(() => { Object.assign(dataRootSeams, seamsBefore); for (const dir of temps.splice(0)) removeTempDirSync(dir); });
function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-roots-")));
  temps.push(base);
  const dataDir = join(base, "data"), other = join(base, "other-volume");
  mkdirSync(dataDir); mkdirSync(other);
  const lines: string[] = [];
  const make = () => { const roots = new DataRoots(dataDir, line => lines.push(line)); roots.boot(); return roots; };
  return { base, dataDir, other, lines, make };
}
const record = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, ".murage-root.json"), "utf8"));
const code = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (error) { return error instanceof WorkspaceTreeError ? error.code : `other:${(error as Error).message}`; } };

describe("DR2/DR3 linked root works by default (D5d)", () => {
  it("first boot records the link silently; 20 turns run with no card and desks land under T", () => {
    const f = fixture(); const T = join(f.other, "ws"); mkdirSync(T);
    symlinkSync(T, join(f.dataDir, "workspaces"), "dir");
    const roots = f.make();
    expect(record(f.dataDir).linkedRoots.workspaces.target).toBe(T);
    for (let turn = 0; turn < 20; turn++) expect(roots.rootFor("workspaces").canonical).toBe(T);
    const desk = roots.ownedPath(join(f.dataDir, "workspaces", "bot-a", "threads", "t1"), { create: true });
    expect(desk.canonical).toBe(join(T, "bot-a", "threads", "t1"));
    expect(lstatSync(join(T, "bot-a", "threads", "t1")).isDirectory()).toBe(true);
    expect(f.lines.filter(line => line.includes("changed") || line.includes("refused"))).toEqual([]);
  });
  it("a RELATIVE link text compares equal to its canonical record (no card over turns)", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "elsewhere"));
    const T = join(f.base, "rel-target"); mkdirSync(T);
    symlinkSync("../rel-target", join(f.dataDir, "workspaces"), "dir");
    const roots = f.make();
    for (let turn = 0; turn < 5; turn++) expect(roots.status("workspaces")).toBe("ok");
    const again = f.make();
    expect(again.status("workspaces")).toBe("ok");
  });
  it("a plain root works as at b17 and records nothing", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces"));
    const roots = f.make();
    expect(roots.rootFor("workspaces").canonical).toBe(join(f.dataDir, "workspaces"));
    expect(record(f.dataDir).linkedRoots).toBeUndefined();
  });
});

describe("links below a root are refused, never followed (D5)", () => {
  it("a linked bot folder, memory folder and desk component each refuse with no mkdir through the link", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces")); const outside = join(f.other, "elsewhere"); mkdirSync(outside);
    const roots = f.make();
    symlinkSync(outside, join(f.dataDir, "workspaces", "bot-a"), "dir");
    expect(code(() => roots.ownedPath(join(f.dataDir, "workspaces", "bot-a", "memory"), { create: true }))).toBe("link-below-root");
    mkdirSync(join(f.dataDir, "workspaces", "bot-b"));
    symlinkSync(outside, join(f.dataDir, "workspaces", "bot-b", "memory"), "dir");
    expect(code(() => roots.ownedPath(join(f.dataDir, "workspaces", "bot-b", "memory"), { create: true }))).toBe("link-below-root");
    mkdirSync(join(f.dataDir, "workspaces", "bot-c")); symlinkSync(outside, join(f.dataDir, "workspaces", "bot-c", "threads"), "dir");
    expect(code(() => roots.ownedPath(join(f.dataDir, "workspaces", "bot-c", "threads", "t"), { create: true }))).toBe("link-below-root");
    expect(readdirSync(outside)).toEqual([]);
  });
  it("an escape is refused (D4)", () => {
    const f = fixture(); const roots = f.make();
    expect(code(() => roots.ownedPath(join(f.base, "elsewhere"), { create: true }))).toBe("escape");
  });
  it("a non-root top-level link is refused exactly as at b17", () => {
    const f = fixture(); symlinkSync(f.other, join(f.dataDir, "skill-state"), "dir"); const roots = f.make();
    expect(code(() => roots.ownedPath(join(f.dataDir, "skill-state", "x"), { create: true }))).toBe("link-below-root");
  });
});

describe("between boots (D5e, D5e-T)", () => {
  it("the link retargeted -> changed, nothing written under either; confirm re-records and turns run", () => {
    const f = fixture(); const A = join(f.other, "a"), B = join(f.other, "b"); mkdirSync(A); mkdirSync(B);
    symlinkSync(A, join(f.dataDir, "workspaces"), "dir"); f.make();
    rmSync(join(f.dataDir, "workspaces")); symlinkSync(B, join(f.dataDir, "workspaces"), "dir");
    const roots = f.make();
    expect(code(() => roots.ownedPath(join(f.dataDir, "workspaces", "bot", "memory"), { create: true }))).toBe("root-changed");
    expect(readdirSync(A)).toEqual([]); expect(readdirSync(B)).toEqual([]);
    expect(roots.candidate("workspaces")).toBe(B);
    expect(roots.confirm("workspaces")).toEqual({ status: 200, state: "ok" });
    expect(record(f.dataDir).linkedRoots.workspaces.target).toBe(B);
    expect(roots.rootFor("workspaces").canonical).toBe(B);
    // BUILD-FIX 1: the NEXT turn after the confirm is ok
    expect(roots.status("workspaces")).toBe("ok");
  });
  it("the target folder replaced (same path, new ino, same dev) -> changed; ino 0 on both sides and a dev-changed remount -> no card", () => {
    expect(sameRoot({ target: "/x", dev: 1, ino: 5 }, { target: "/x", dev: 1, ino: 6 })).toBe(false);
    expect(sameRoot({ target: "/x", dev: 1, ino: 0 }, { target: "/x", dev: 1, ino: 6 })).toBe(true);
    expect(sameRoot({ target: "/x", dev: 1, ino: 5 }, { target: "/x", dev: 2, ino: 6 })).toBe(true);
    const f = fixture(); const A = join(f.other, "a"); mkdirSync(A);
    symlinkSync(A, join(f.dataDir, "workspaces"), "dir"); f.make();
    renameSync(A, join(f.other, "a-old")); mkdirSync(A);
    const roots = f.make();
    expect(roots.status("workspaces")).toBe("changed");
  });
  it("D5e-T: the frozen T is never realpath'd again", () => {
    const f = fixture(); const A = join(f.other, "a"); mkdirSync(A);
    symlinkSync(A, join(f.dataDir, "workspaces"), "dir"); f.make();
    const seen: string[] = []; const real = dataRootSeams.realpath;
    dataRootSeams.realpath = path => { seen.push(path); return real(path); };
    const roots = f.make(); roots.status("workspaces");
    expect(seen).not.toContain(A);
  });
  it("confirm in ok, absent, unavailable and refused states -> 409; a plain dir that differs -> 409 restart (Fable r4 L2)", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces")); const roots = f.make();
    expect(roots.confirm("workspaces").status).toBe(409);
    expect(roots.confirm("providers").status).toBe(409);
    renameSync(join(f.dataDir, "workspaces"), join(f.dataDir, "ws-old")); mkdirSync(join(f.dataDir, "workspaces"));
    expect(roots.status("workspaces")).toBe("changed");
    expect(roots.confirm("workspaces")).toMatchObject({ status: 409, restart: true });
  });
});

describe("mid-boot (D5f, D5f-back, D5m)", () => {
  it("(1) retargeted, (2) T itself replaced by a link, (3) an ancestor of T redirected, (4) plain replaced by a link -> changed; put back -> ok, record byte-identical", () => {
    const f = fixture(); const parent = join(f.other, "p"), A = join(parent, "a"), U = join(f.other, "u"); mkdirSync(A, { recursive: true }); mkdirSync(U);
    const link = join(f.dataDir, "workspaces"); symlinkSync(A, link, "dir");
    const roots = f.make(); const before = readFileSync(join(f.dataDir, ".murage-root.json"));
    rmSync(link); symlinkSync(U, link, "dir");
    expect(roots.status("workspaces")).toBe("changed");
    rmSync(link); symlinkSync(A, link, "dir");
    expect(roots.status("workspaces")).toBe("ok");
    renameSync(A, join(parent, "a-real")); symlinkSync(U, A, "dir");
    expect(roots.status("workspaces")).toBe("changed");
    rmSync(A); renameSync(join(parent, "a-real"), A);
    expect(roots.status("workspaces")).toBe("ok");
    renameSync(parent, join(f.other, "p-real")); mkdirSync(join(f.other, "q", "a"), { recursive: true }); symlinkSync(join(f.other, "q"), parent, "dir");
    expect(roots.status("workspaces")).toBe("changed");
    rmSync(parent); renameSync(join(f.other, "p-real"), parent);
    expect(roots.status("workspaces")).toBe("ok");
    expect(readFileSync(join(f.dataDir, ".murage-root.json")).equals(before)).toBe(true);
    expect(readdirSync(U)).toEqual([]);
    const g = fixture(); mkdirSync(join(g.dataDir, "workspaces")); const plain = g.make();
    renameSync(join(g.dataDir, "workspaces"), join(g.dataDir, "ws-real")); symlinkSync(g.other, join(g.dataDir, "workspaces"), "dir");
    expect(plain.status("workspaces")).toBe("changed");
    expect(plain.confirm("workspaces").status).toBe(200);
    expect(plain.status("workspaces")).toBe("ok");
  });
  it("D5m: plain at boot, removed (read-only: absent-and-empty), then a link -> changed, nothing recorded", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces")); const roots = f.make();
    rmSync(join(f.dataDir, "workspaces"), { recursive: true });
    expect(roots.rootFor("workspaces").state).toBe("absent");
    symlinkSync(f.other, join(f.dataDir, "workspaces"), "dir");
    expect(code(() => roots.rootFor("workspaces", { create: true }))).toBe("root-changed");
    expect(record(f.dataDir).linkedRoots).toBeUndefined();
    expect(readdirSync(f.other)).toEqual([]);
  });

  it("D5m-r (driver ruling 05:02Z): a plain root removed mid-boot is recreated by the next walker, ok with a new snapshot and one log line", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces")); const roots = f.make(); const lines = f.lines;
    rmSync(join(f.dataDir, "workspaces"), { recursive: true });
    const desk = roots.ownedPath(join(f.dataDir, "workspaces", "bot-a", "threads", "t1"), { create: true });
    expect(lstatSync(join(f.dataDir, "workspaces")).isDirectory()).toBe(true);
    expect(lstatSync(desk.canonical).isDirectory()).toBe(true);
    expect(roots.rootFor("workspaces").state).toBe("ok");
    expect(lines.filter(line => line === "data-root-recreated root=workspaces")).toHaveLength(1);
    expect(record(f.dataDir).linkedRoots).toBeUndefined();
  });

  it("D5m-r link variant: a plain root removed then replaced by a link -> the next turn is changed, nothing written under the target", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces")); const roots = f.make();
    rmSync(join(f.dataDir, "workspaces"), { recursive: true });
    symlinkSync(f.other, join(f.dataDir, "workspaces"), "dir");
    expect(code(() => roots.ownedPath(join(f.dataDir, "workspaces", "bot-a"), { create: true }))).toBe("root-changed");
    expect(readdirSync(f.other)).toEqual([]);
    expect(record(f.dataDir).linkedRoots).toBeUndefined();
  });

  it("D5m-r: a missing DATA_DIR (unmounted volume) is never recreated -> unavailable", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, "workspaces")); const roots = f.make();
    rmSync(f.dataDir, { recursive: true });
    expect(code(() => roots.rootFor("workspaces", { create: true }))).toBe("root-unavailable");
    expect(existsSync(f.dataDir)).toBe(false);
  });
});

describe("refused targets (D5g)", () => {
  const refusedFor = (target: (f: ReturnType<typeof fixture>) => string, name: "workspaces" | "providers" = "workspaces") => {
    const f = fixture(); symlinkSync(target(f), join(f.dataDir, name), "dir");
    const roots = f.make();
    return { f, roots, code: code(() => roots.rootFor(name)) };
  };
  it("refuses /, HOME, an ancestor of HOME, DATA_DIR, an ancestor of DATA_DIR, the other root, and nested roots, with the refused text", () => {
    const home = fixture(); dataRootSeams.homedir = () => join(home.base, "home"); mkdirSync(join(home.base, "home"));
    expect(refusedFor(() => "/").code).toBe("root-refused");
    expect(refusedFor(() => join(home.base, "home")).code).toBe("root-refused");
    expect(refusedFor(() => home.base).code).toBe("root-refused");
    expect(refusedFor(f => f.dataDir).code).toBe("root-refused");
    expect(refusedFor(f => f.base).code).toBe("root-refused");
    expect(refusedFor(f => { mkdirSync(join(f.dataDir, "providers")); return join(f.dataDir, "providers"); }).code).toBe("root-refused");
    const nested = fixture(); const shared = join(nested.other, "shared"); mkdirSync(join(shared, "inner"), { recursive: true });
    symlinkSync(shared, join(nested.dataDir, "workspaces"), "dir"); symlinkSync(join(shared, "inner"), join(nested.dataDir, "providers"), "dir");
    const roots = nested.make();
    expect(code(() => roots.rootFor("providers"))).toBe("root-refused");
    expect(workspaceTreeText("root-refused")).toContain("keeps separate from bot work");
    expect(workspaceTreeText("root-refused")).not.toBe(workspaceTreeText("root-unavailable"));
  });
  it("a mount point folder of its own is allowed", () => {
    const { code: c, f } = refusedFor(f => { const mount = join(f.other, "Work"); mkdirSync(mount); return mount; });
    expect(c).toBeUndefined();
    expect(record(f.dataDir).linkedRoots.workspaces).toBeDefined();
  });
});

describe("unavailable (D5h) and absent (D5k)", () => {
  it("target missing at boot -> unavailable, no record; present later -> runs, recorded, one realpath per check", () => {
    const f = fixture(); const T = join(f.other, "disk"); symlinkSync(T, join(f.dataDir, "workspaces"), "dir");
    const roots = f.make();
    expect(code(() => roots.rootFor("workspaces"))).toBe("root-unavailable");
    expect(existsSync(T)).toBe(false);
    expect(JSON.parse(readFileSync(join(f.dataDir, ".murage-root.json"), "utf8")).linkedRoots).toBeUndefined();
    mkdirSync(T);
    let calls = 0; const real = dataRootSeams.realpath; dataRootSeams.realpath = path => { calls++; return real(path); };
    expect(roots.rootFor("workspaces").canonical).toBe(T);
    expect(calls).toBe(1);
    expect(record(f.dataDir).linkedRoots.workspaces.target).toBe(T);
  });
  it("a dangling link and an ELOOP chain -> unavailable", () => {
    const f = fixture(); symlinkSync(join(f.dataDir, "loop-b"), join(f.dataDir, "loop-a")); symlinkSync(join(f.dataDir, "loop-a"), join(f.dataDir, "loop-b"));
    symlinkSync(join(f.dataDir, "loop-a"), join(f.dataDir, "workspaces"), "dir");
    expect(code(() => f.make().rootFor("workspaces"))).toBe("root-unavailable");
  });
  it("fresh install: absent is ok-and-empty for readers, created 0o700 by the first writer, no linkedRoots", () => {
    const f = fixture(); const roots = f.make();
    expect(roots.rootFor("workspaces")).toMatchObject({ state: "absent" });
    const desk = roots.ownedPath(join(f.dataDir, "workspaces", "bot", "threads", "t"), { create: true });
    expect(lstatSync(join(f.dataDir, "workspaces")).mode & 0o777).toBe(0o700);
    expect(desk.created[0]).toBe(join(f.dataDir, "workspaces"));
    expect(record(f.dataDir).linkedRoots).toBeUndefined();
  });
  it("a link planted while absent -> changed, nothing created or recorded; confirm records it", () => {
    const f = fixture(); const roots = f.make();
    symlinkSync(f.other, join(f.dataDir, "workspaces"), "dir");
    expect(code(() => roots.ownedPath(join(f.dataDir, "workspaces", "bot"), { create: true }))).toBe("root-changed");
    expect(readdirSync(f.other)).toEqual([]);
    expect(roots.confirm("workspaces").status).toBe(200);
    expect(roots.status("workspaces")).toBe("ok");
  });
  it("boot kind absent, a real dir made by someone else -> ok with a snapshot taken then (BUILD-FIX 7)", () => {
    const f = fixture(); const roots = f.make(); mkdirSync(join(f.dataDir, "workspaces"));
    expect(roots.status("workspaces")).toBe("ok");
  });
  it("root-record write failure: the roots still work (Fable r4 L3)", () => {
    const f = fixture(); mkdirSync(join(f.dataDir, ".murage-root.json")); symlinkSync(f.other, join(f.dataDir, "workspaces"), "dir");
    const roots = f.make();
    expect(roots.rootFor("workspaces").canonical).toBe(f.other);
    expect(f.lines.some(line => line.includes("data-root-record"))).toBe(true);
  });
});

describe("P1 root record (D13, D17)", () => {
  it("a moved data dir moves the old root into previous and drops linkedRoots", () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, ".murage-root.json"), JSON.stringify({ schema: 1, root: "/gone/old/.murage", previous: [], linkedRoots: { workspaces: { target: "/gone/x", dev: 1, ino: 2, at: "" } } }));
    const roots = f.make();
    expect(roots.previousRoots()).toEqual(["/gone/old/.murage"]);
    expect(record(f.dataDir).linkedRoots).toBeUndefined();
  });
  it("a corrupt record is renamed aside and rewritten with no previous roots", () => {
    const f = fixture(); writeFileSync(join(f.dataDir, ".murage-root.json"), "{nope");
    const roots = f.make();
    expect(roots.previousRoots()).toEqual([]);
    expect(readdirSync(f.dataDir).some(name => name.startsWith(".murage-root.json.corrupt-"))).toBe(true);
  });
});

describe("C12 guard (D5n)", () => {
  it("with workspaces linked, protectedRootRefusal refuses T and DATA_DIR/workspaces; T/<botId> stays deletable", () => {
    const f = fixture(); const T = join(f.other, "ws"); mkdirSync(join(T, "bot-a"), { recursive: true });
    symlinkSync(T, join(f.dataDir, "workspaces"), "dir");
    const roots = f.make();
    const targets = () => roots.protectedTargets("workspaces");
    expect(protectedRootRefusal(T, f.dataDir, targets)).toContain("every bot workspace");
    expect(protectedRootRefusal(f.other, f.dataDir, targets)).toContain("every bot workspace");
    expect(protectedRootRefusal(join(f.dataDir, "workspaces"), f.dataDir, targets)).not.toBeNull();
    expect(protectedRootRefusal(join(T, "bot-a"), f.dataDir, targets)).toBeNull();
    expect(protectedRootRefusal(join(T, "bot-a"), f.dataDir, () => [])).toBeNull();
  });
});

describe("rebaseStoredPath (section 2: D1-D4, D14, D14b, D15, D16)", () => {
  const ctor = (bot: string, thread: string) => (root: string) => [join(root, "workspaces", bot, "threads", thread), join(root, "workspaces", bot, "threads", thread)];
  it("D1 rebases a recorded previous desk; D2 keeps it with no record; D3 refuses other ids under a recorded root", () => {
    const ctx = { dataDir: "/new/.murage", previous: ["/gone/old/.murage"], platform: "linux" as const };
    expect(rebaseStoredPath("/gone/old/.murage/workspaces/b/threads/t", ctor("b", "t"), ctx)).toEqual({ path: "/new/.murage/workspaces/b/threads/t" });
    expect(rebaseStoredPath("/gone/old/.murage/workspaces/b/threads/t", ctor("b", "t"), { ...ctx, previous: [] })).toEqual({ keep: true });
    expect(rebaseStoredPath("/gone/old/.murage/workspaces/b/threads/OTHER", ctor("b", "t"), ctx)).toEqual({ refused: true });
    expect(rebaseStoredPath("/new/.murage/workspaces/b/threads/t", ctor("b", "t"), ctx)).toEqual({ keep: true });
    expect(rebaseStoredPath("/home/me/project", ctor("b", "t"), ctx)).toEqual({ keep: true });
    expect(rebaseStoredPath("/new/.murage/workspaces/../../etc", ctor("b", "t"), ctx)).toEqual({ refused: true });
  });
  it("D14 two distinct new values refuse", () => {
    const two = (root: string) => [join(root, "workspaces", "b"), root === "/new" ? "/new/x" : join(root, "workspaces", "b")];
    expect(rebaseStoredPath("/old/workspaces/b", two, { dataDir: "/new", previous: ["/old"], platform: "linux" })).toEqual({ refused: true });
  });
  it("D15 darwin: case differs -> refused; NFD home -> rebased", () => {
    const ctx = { dataDir: "/n", previous: ["/Us" + "ers/sean/.murage"], platform: "darwin" as const };
    expect(rebaseStoredPath("/Us" + "ers/Sean/.murage/workspaces/b/threads/t", ctor("b", "t"), ctx)).toEqual({ refused: true });
    expect(rebaseStoredPath("/Us" + "ers/Sean/.murage/workspaces/b/threads/t", ctor("b", "t"), { ...ctx, previous: ["/Us" + "ers/Sean/.murage"] })).toEqual({ path: "/n/workspaces/b/threads/t" });
    const nfc = "/Us" + "ers/Jos\u00e9/.murage", nfd = "/Us" + "ers/Jose\u0301/.murage";
    expect(rebaseStoredPath(`${nfd}/workspaces/b/threads/t`, ctor("b", "t"), { ...ctx, previous: [nfc] })).toEqual({ path: "/n/workspaces/b/threads/t" });
  });
  it("D16 win32: drive change, case, long prefix and forward slashes", () => {
    const w = (root: string) => [`${root}\\workspaces\\b\\threads\\t`];
    const ctx = { dataDir: "D:\\Murage", previous: ["C:\\Users\\Sean\\.murage"], platform: "win32" as const };
    for (const stored of ["C:\\Users\\Sean\\.murage\\workspaces\\b\\threads\\t", "c:\\users\\sean\\.murage\\workspaces\\b\\threads\\t", "\\\\?\\C:\\Users\\Sean\\.murage\\workspaces\\b\\threads\\t", "C:/Us" + "ers/Sean/.murage/workspaces/b/threads/t"]) {
      expect(rebaseStoredPath(stored, w, ctx)).toEqual({ path: "D:\\Murage\\workspaces\\b\\threads\\t" });
    }
    expect(lexicalKey("D:x\\y", "win32")).toBeUndefined();
  });
});

// D5b: exercise index's actual output preparation body without launching its server.
import ts from "typescript";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { ensureTaskWorkspace, selectFileWorkspace, taskWorkspacePath } from "./workspace.ts";
it.each(["desk", "bot"])("D5b output preparation guard: linked %s refuses before mkdir or write through the link", component => {
  mkdirSync(DATA_DIR, { recursive: true });
  const botId = `d5b-${component}`, threadId = "thread";
  const desk = taskWorkspacePath(DATA_DIR, botId, threadId);
  const botRoot = join(DATA_DIR, "workspaces", botId);
  temps.push(botRoot);
  const f = fixture();
  mkdirSync(component === "desk" ? join(botRoot, "threads") : join(DATA_DIR, "workspaces"), { recursive: true });
  symlinkSync(f.other, component === "desk" ? desk : botRoot, "dir");
  bootDataRoots();
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "prepareOutputDestination")!;
  expect(declaration).toBeDefined();
  const store = { bots: [{ id: botId, threadId, tasks: [{ threadId, cwd: desk }] }], groups: [] };
  const code = ts.transpileModule(declaration.getText(ast) + ";return prepareOutputDestination;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const prepare = new Function("DATA_DIR", "store", "selectFileWorkspace", "ensureTaskWorkspace", code)(DATA_DIR, store, selectFileWorkspace, ensureTaskWorkspace);
  const mkdir = vi.spyOn(fs, "mkdirSync"), write = vi.spyOn(fs, "writeFileSync"), rename = vi.spyOn(fs, "renameSync");
  syncBuiltinESMExports();
  try {
    expect(() => prepare(botId, threadId, "generation", true, false)).toThrowError(expect.objectContaining({ name: "WorkspaceTreeError", code: "link-below-root" }));
    const linked = component === "desk" ? desk : botRoot;
    const throughLink = (path: unknown) => [linked, f.other].some(root => String(path) === root || String(path).startsWith(root + "/"));
    for (const spy of [mkdir, write, rename]) expect(spy.mock.calls.filter(args => args.slice(0, 2).some(throughLink))).toEqual([]);
    expect(readdirSync(f.other)).toEqual([]);
  } finally { mkdir.mockRestore(); write.mockRestore(); rename.mockRestore(); syncBuiltinESMExports(); }
});
