import { tmpdir } from "node:os";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { recoverAll } from "./engine-exec.ts";
import { useFakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { clearEdits, JSONL_FORMAT, skeletonOf } from "./engine-plan-core.ts";
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDirs } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { configureRedo, listRedo, writeRedo } from "./engine-redo.ts";
import { rebaseEngineRedoRecord } from "./engine-redo-paths.ts";
import { fsOps } from "./engine-fs.ts";

const context = { dataDir: "/new", previous: ["/old"], platform: "linux" as const };
const record = { v: 2 as const, kind: "rows" as const, id: "a", engine: "claude", home: "/old/providers/account", path: "/old/providers/account/projects/chat.jsonl", dev: "1", ino: "2", how: "lock", format: "claude", rows: [] };
afterEach(() => { configureRedo(undefined); vi.restoreAllMocks(); });

it("S5 site 18 listRedo supplies reconstructed paths to real recovery and preserves the durable journal until repair", () => {
  ensureDirs();
  const prior=join(DATA_DIR,"earlier");
  writeFileSync(join(DATA_DIR,".murage-root.json"),JSON.stringify({schema:1,root:prior,previous:[]}));
  bootDataRoots();
  const directory=join(DATA_DIR,"engine-redo");configureRedo(directory);
  const { id: _id, v: _v, kind: _kind, ...body } = record;
  const id=writeRedo({...body,home:join(prior,"providers","account"),path:join(prior,"providers","account","history.jsonl")});
  expect(listRedo()).toMatchObject([{id,home:join(DATA_DIR,"providers","account"),path:join(DATA_DIR,"providers","account","history.jsonl")}]);
  expect(JSON.parse(readFileSync(join(directory,`${id}.json`),"utf8")).home).toBe(join(prior,"providers","account"));
});

it("S5 site 18 reconstructs the journal home and file together without touching the old folder", () => {
  const next = rebaseEngineRedoRecord(record, context);
  expect(next).toEqual({ ...record, home: "/new/providers/account", path: "/new/providers/account/projects/chat.jsonl" });
  expect(record.home).toBe("/old/providers/account");
});
it("S5 site 18 preserves external engine homes and refuses a managed journal that escapes its own home", () => {
  const external = { ...record, home: "/user/claude", path: "/user/claude/history.jsonl" };
  expect(rebaseEngineRedoRecord(external, context)).toEqual(external);
  expect(rebaseEngineRedoRecord({ ...record, path: "/old/providers/other/history.jsonl" }, context)).toBeNull();
  expect(rebaseEngineRedoRecord({ ...record, path: "/old/providers/account/../other/history.jsonl" }, context)).toBeNull();
  expect(rebaseEngineRedoRecord(record, { ...context, previous: [] })).toEqual(record);
});
it("S5 site 18 rebases both join sides or refuses the whole journal", () => {
  const journal = { v: 2 as const, kind: "join" as const, id: "j", engine: "claude", home: record.home, into: { path: record.path, dev: "1", ino: "2" }, from: { path: record.path + ".murage-deleting", dev: "1", ino: "3" }, base: 0, lead: 0 as const };
  expect(rebaseEngineRedoRecord(journal, context)).toMatchObject({ home: "/new/providers/account", into: { path: "/new/providers/account/projects/chat.jsonl" }, from: { path: "/new/providers/account/projects/chat.jsonl.murage-deleting" } });
  expect(rebaseEngineRedoRecord({ ...journal, from: { ...journal.from, path: "/old/providers/other/file" } }, context)).toBeNull();
});

it.each(["EIO", "EACCES", "EMFILE"])("S5 site 18 refuses recovery when provenance cannot be read (%s)", code => {
  ensureDirs(); configureRedo(join(DATA_DIR, "engine-redo"));
  const lstat = fsOps.lstat;
  vi.spyOn(fsOps, "lstat").mockImplementation(path => {
    if (path === join(DATA_DIR, ".murage-root.json")) throw Object.assign(new Error(code), { code });
    return lstat(path);
  });
  expect(() => listRedo()).toThrow();
});

it("S5 site 18 refuses malformed provenance instead of treating it as an unmoved folder", () => {
  ensureDirs(); configureRedo(join(DATA_DIR, "engine-redo"));
  writeFileSync(join(DATA_DIR, ".murage-root.json"), "{cut");
  expect(() => listRedo()).toThrow();
});

it("S5 recovery refuses a rebased destination ancestor link and preserves external history", () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-redo-destination-"));
  const fake = useFakeExclusion();
  try {
    const current = join(scratch, "current"), old = join(scratch, "old"), outside = join(scratch, "outside");
    const home = join(current, "providers", "account");
    mkdirSync(home, { recursive: true }); mkdirSync(outside);
    const external = join(outside, "history.jsonl");
    const bytes = Buffer.from(JSON.stringify({ sessionId: "session", project: "/fixture", display: "external history stays intact", pastedContents: {} }));
    writeFileSync(external, Buffer.concat([bytes, Buffer.from("\n")]));
    symlinkSync(outside, join(home, "projects"), "junction");
    writeFileSync(join(current, ".murage-root.json"), JSON.stringify({ schema: 1, root: current, previous: [{ root: old, source: "start", at: "fixture" }] }));
    const directory = join(current, "engine-redo"); configureRedo(directory);
    const stat = lstatSync(external), edits = clearEdits(bytes, JSONL_FORMAT["claude-history"]!)!;
    const id = writeRedo({ engine: "claude", home: join(old, "providers", "account"), path: join(old, "providers", "account", "projects", "history.jsonl"), dev: String(stat.dev), ino: String(stat.ino), how: "dirlock", format: "claude-history", rows: [{ off: 0, len: bytes.length, skel: skeletonOf(bytes, edits), edits: edits.map(({at,len,kind}) => ({at,len,kind})) }] });
    const before = readFileSync(external);
    const result = recoverAll();
    expect(readFileSync(external)).toEqual(before);
    expect(result.unreadable).toBeTruthy();
    expect(result.repaired).toBe(0);
    expect(existsSync(join(directory, `${id}.json`))).toBe(true);
  } finally { fake.restore(); configureRedo(undefined); removeTempDirSync(scratch); }
});

it.each(["plain", "approved-linked", "remounted-linked"] as const)("S5 recovery pins and repairs a moved journal under a %s provider root", layout => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-redo-pinned-")));
  const fake = useFakeExclusion();
  try {
    const current = join(scratch, "current"), old = join(scratch, "old"), target = join(scratch, "provider-target");
    mkdirSync(current); mkdirSync(target);
    if (layout !== "plain") symlinkSync(target, join(current, "providers"), "junction");
    const physicalRoot = layout !== "plain" ? target : join(current, "providers"), home = join(physicalRoot, "account");
    mkdirSync(home, { recursive: true });
    const targetStat = lstatSync(target);
    writeFileSync(join(current, ".murage-root.json"), JSON.stringify({ schema: 1, root: current, previous: [{ root: old, source: "start", at: "fixture" }], ...(layout !== "plain" ? { linkedRoots: { providers: { target, dev: targetStat.dev + (layout === "remounted-linked" ? 1 : 0), ino: targetStat.ino + (layout === "remounted-linked" ? 1 : 0), at: "fixture" } } } : {}) }));
    const path = join(home, "history.jsonl"), bytes = Buffer.from(JSON.stringify({ sessionId: "session", project: "/fixture", display: "moved history to clear", pastedContents: {} }));
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n")]));
    const stat = lstatSync(path), edits = clearEdits(bytes, JSONL_FORMAT["claude-history"]!)!;
    const directory = join(current, "engine-redo"); configureRedo(directory);
    const id = writeRedo({ engine: "claude", home: join(old, "providers", "account"), path: join(old, "providers", "account", "history.jsonl"), dev: String(stat.dev), ino: String(stat.ino), how: "dirlock", format: "claude-history", rows: [{ off: 0, len: bytes.length, skel: skeletonOf(bytes, edits), edits: edits.map(({at,len,kind}) => ({at,len,kind})) }] });
    expect(listRedo()).toMatchObject([{ home, path }]);
    expect(recoverAll()).toMatchObject({ repaired: 1, pending: [] });
    expect(readFileSync(path, "utf8")).not.toContain("moved history to clear");
    expect(existsSync(join(directory, `${id}.json`))).toBe(false);
  } finally { fake.restore(); configureRedo(undefined); removeTempDirSync(scratch); }
});
