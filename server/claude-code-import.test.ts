// secret-scan: fixture (fake keys, redaction test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claude Code copy import (CONTRACTS-B 1 and 1.1): path confinement, names only on a dry run,
// secrets default-deny, existing names skipped, servers land off, atomic "both", one at a time.
import { chmodSync, constants, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterAll, beforeAll } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import {
  AnchoredImport, handleClaudeCodeImport, looksSecret, planServer, readClaudeCodeServers, readClaudeCodeSkills, realImportFs, resetClaudeCodeImportState, runLockedImport, type ImportDeps, type ImportFs,
} from "./claude-code-import.ts";
import { setSettleClockForTest } from "./anchor-settle.ts";
import { AnchoredWinFake, standardTree } from "./testing/anchored-win-fake.ts";

let home: string;
let outside: string;
const unsupportedHost = process.platform !== "linux" && process.platform !== "darwin";
const describePosix = describe.skipIf(unsupportedHost);

function skill(name: string, text = `---\nname: ${name.toLowerCase()}\ndescription: Does ${name}\n---\nBody for ${name}.\n`, extra: Record<string, string> = {}) {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  for (const [file, content] of Object.entries(extra)) writeFileSync(join(dir, file), content);
}
function claudeJson(servers: unknown, extra: Record<string, unknown> = {}) {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ ...extra, mcpServers: servers }));
}

interface World { skills: Map<string, Array<{ path: string; content: string }>>; mcp: Record<string, unknown>; receipt: unknown[]; failMcp?: boolean; failReceipt?: boolean; removed: string[] }
function world(): { w: World; deps: ImportDeps } {
  const w: World = { skills: new Map(), mcp: {}, receipt: [], removed: [] };
  let beforeReceipt: unknown[] = [];
  const deps: ImportDeps = {
    existingSkillNames: () => new Set([...w.skills.keys()]),
    skillPathExists: (name) => w.skills.has(name),
    addSkill: (files) => {
      const name = /name:\s*(\S+)/.exec(files.find((f) => f.path === "SKILL.md")!.content)?.[1] ?? "";
      if (w.skills.has(name)) return { error: "exists", code: "exists" };
      w.skills.set(name, files);
      return { name };
    },
    removeSkill: (name) => { w.skills.delete(name); w.removed.push(name); },
    mcpCurrent: () => ({ ...w.mcp }),
    persistMcp: (next) => { if (w.failMcp) throw new Error("disk"); w.mcp = next; },
    writeReceipt: (r) => { beforeReceipt = [...w.receipt]; if (w.failReceipt) throw new Error("disk"); w.receipt.push(r); },
    restoreReceipt: () => { w.receipt.splice(0, w.receipt.length, ...beforeReceipt); },
  };
  return { w, deps };
}

const run = (body: unknown, deps: ImportDeps, over: Partial<Parameters<typeof handleClaudeCodeImport>[0]> = {}) =>
  handleClaudeCodeImport({ body, enabled: true, home, deps, ownerToken: "desktop-session-a", ...over });

/** Resolve the parent descriptor for a test hook, before it performs a hostile swap. */
function openedPath(path: string): string {
  const proc = /^(\/proc\/self\/fd\/\d+)(?:\/(.*))?$/.exec(path);
  return proc ? join(realImportFs.readlinkSync(proc[1]!), proc[2] ?? "") : path;
}

beforeEach(() => {
  resetClaudeCodeImportState();
  home = realpathSync(mkdtempSync(join(tmpdir(), "cci-home-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "cci-out-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describePosix("the request", () => {
  it("binds reviews to the authenticated session without consuming another owner's review", () => {
    const { w, deps } = world();
    skill("Alpha");
    const dryRunId = (run({ scope: "skills", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    const wrong = run({ scope: "skills", dryRun: false, dryRunId }, deps, { ownerToken: "desktop-session-b" });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: "review-required" });
    expect(w.skills.size).toBe(0);
    expect(run({ scope: "skills", dryRun: false, dryRunId }, deps).status).toBe(201);
    expect(run({ scope: "skills", dryRun: true }, deps, { ownerToken: "" }).status).toBe(403);
  });

  it("expires review snapshots and requires another review", () => {
    const { w, deps } = world();
    skill("Alpha");
    const dryRunId = (run({ scope: "skills", dryRun: true }, deps, { now: () => 0 }).body as { dryRunId: string }).dryRunId;
    const result = run({ scope: "skills", dryRun: false, dryRunId }, deps, { now: () => 15 * 60_000 });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "review-required" });
    expect(w.skills.size).toBe(0);
  });

  it("imports only the reviewed skill bytes and normalized servers after the source changes", () => {
    const { w, deps } = world();
    skill("Alpha", undefined, { "notes.md": "reviewed notes" });
    claudeJson({ plain: { command: "uvx", args: ["reviewed-tool"] } });
    const dryRunId = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    skill("Alpha", "---\nname: replacement\ndescription: Changed\n---\nUnreviewed", { "notes.md": "changed notes" });
    skill("Unreviewed");
    claudeJson({ plain: { command: "evil" }, extra: { command: "unreviewed" } });
    const noRead: ImportFs = { ...realImportFs, openSync: () => { throw new Error("Import must use the reviewed snapshot"); } };
    const done = run({ scope: "both", dryRun: false, dryRunId }, deps, { fs: noRead });
    expect(done.status).toBe(201);
    expect([...w.skills.keys()]).toEqual(["alpha"]);
    expect(w.skills.get("alpha")).toContainEqual({ path: "notes.md", content: "reviewed notes" });
    expect(w.skills.get("alpha")?.find((file) => file.path === "SKILL.md")?.content).toContain("Body for Alpha.");
    expect(w.mcp.plain).toMatchObject({ command: "uvx", args: ["reviewed-tool"], enabled: false });
    expect(w.mcp.extra).toBeUndefined();
    expect(JSON.stringify(done.body)).not.toContain("reviewed-tool");
  });

  it("is refused with 409 while the switch is off, and the body is strict", () => {
    const { deps } = world();
    expect(run({ scope: "both", dryRun: true }, deps, { enabled: false }).status).toBe(409);
    expect(run({ scope: "both", dryRun: true, extra: 1 }, deps).status).toBe(400);
    expect(run({ scope: "everything", dryRun: true }, deps).status).toBe(400);
    expect(run({ scope: "both", dryRun: "yes" }, deps).status).toBe(400);
    expect(run(null, deps).status).toBe(400);
  });

  it("refuses an import without a prior dry run id, and an id only works once and for its own scope", () => {
    const { deps } = world();
    skill("Alpha");
    expect(run({ scope: "skills", dryRun: false }, deps).status).toBe(409);
    expect(run({ scope: "skills", dryRun: false, dryRunId: "made-up" }, deps).status).toBe(409);
    const id = (run({ scope: "skills", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    expect(run({ scope: "mcp", dryRun: false, dryRunId: id }, deps).status).toBe(409);
    const id2 = (run({ scope: "skills", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    expect(run({ scope: "skills", dryRun: false, dryRunId: id2 }, deps).status).toBe(201);
    expect(run({ scope: "skills", dryRun: false, dryRunId: id2 }, deps).status).toBe(409);
  });

  it("answers a second request that arrives while one runs with 409", () => {
    const { w, deps } = world();
    skill("Alpha");
    const id = (run({ scope: "skills", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    let inner = 0;
    const reentrant: ImportDeps = { ...deps, addSkill: (files, label) => { inner = run({ scope: "skills", dryRun: true }, deps).status; return deps.addSkill(files, label); } };
    expect(run({ scope: "skills", dryRun: false, dryRunId: id }, reentrant).status).toBe(201);
    expect(inner).toBe(409);
    expect(w.skills.size).toBe(1);
  });

  it("treats a missing folder and a missing file as empty lists, not errors", () => {
    const { deps } = world();
    const dry = run({ scope: "both", dryRun: true }, deps);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ skills: [], servers: [], skipped: [] });
  });

  it("answers a plain 'could not read' with no path or content for malformed JSON, and imports nothing", () => {
    const { w, deps } = world();
    skill("Alpha");
    writeFileSync(join(home, ".claude.json"), "{ not json SECRET-CONTENT-123");
    const dry = run({ scope: "both", dryRun: true }, deps);
    expect(dry.status).toBe(422);
    const text = JSON.stringify(dry.body);
    expect(text).toContain("Could not read Claude Code files");
    expect(text).not.toContain(home);
    expect(text).not.toContain("SECRET-CONTENT");
    expect(w.skills.size).toBe(0);
  });
});

describePosix("dry run names only", () => {
  it("returns names, kinds and needsKey and no command, url, arg, env or header value", () => {
    const { deps } = world();
    skill("Alpha");
    claudeJson({
      local: { command: "node", args: ["server.js", "--port", "9000"], env: { LANG: "C", API_KEY: "sk-abcdefghijklmnopqrstuvwxyz0123" } }, // secret-scan: fixture
      remote: { type: "http", url: "https://mcp.example.com/v1?token=abc123", headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz" } },
      plain: { command: "uvx", args: ["some-tool"] },
    });
    const dry = run({ scope: "both", dryRun: true }, deps);
    expect(dry.status).toBe(200);
    const body = dry.body as { skills: Array<{ name: string }>; servers: Array<{ name: string; kind: string; needsKey: boolean }> };
    expect(body.skills).toEqual([{ name: "Alpha" }]);
    expect(body.servers).toEqual([
      { name: "local", kind: "local", needsKey: true },
      { name: "plain", kind: "local", needsKey: false },
      { name: "remote", kind: "remote", needsKey: true },
    ]);
    const text = JSON.stringify(dry.body);
    for (const leak of ["node", "server.js", "9000", "sk-abc", "mcp.example.com", "abc123", "Bearer", "uvx", "some-tool", "Authorization", "API_KEY", home]) { // secret-scan: fixture
      expect(text).not.toContain(leak);
    }
  });
});

describePosix("only the two read paths are opened", () => {
  it("opens the skills folder and .claude.json under home and nothing else, and drops the rest of .claude.json", () => {
    const { deps } = world();
    skill("Alpha", undefined, { "notes.md": "hello", ".env": "TOKEN=x", "id_rsa": "KEY", "cert.pem": "P" }); // secret-scan: fixture
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "history.jsonl"), "private");
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    claudeJson({ plain: { command: "uvx" } }, { projects: { "/x": { mcpServers: { hidden: { command: "evil" } } } }, oauthAccount: { token: "t" } });
    const opened: string[] = [];
    const read: string[] = [];
    const paths = new Map<number, string>();
    const spy: ImportFs = {
      ...realImportFs,
      openSync: (path, flags) => {
        const resolved = openedPath(path);
        const fd = realImportFs.openSync(path, flags);
        opened.push(resolved);
        paths.set(fd, resolved);
        return fd;
      },
      readSync: (...args) => { read.push(paths.get(args[0])!); return realImportFs.readSync(...args); },
    };
    const dry = run({ scope: "both", dryRun: true }, deps, { fs: spy });
    expect(dry.status).toBe(200);
    // Anchoring also opens directories and metadata-only handles for excluded files.
    expect(opened.every((path) => path === home || path === join(home, ".claude") || path === join(home, ".claude.json")
      || path === join(home, ".claude", "skills") || path.startsWith(join(home, ".claude", "skills") + "/"))).toBe(true);
    const rel = read.map((path) => path.slice(home.length + 1)).sort();
    expect(rel).toEqual([".claude.json", ".claude/skills/Alpha/SKILL.md", ".claude/skills/Alpha/notes.md"]);
    expect((dry.body as { servers: unknown[] }).servers).toHaveLength(1);
  });

  it("never copies .env, key or credential files from a skill folder", () => {
    const { w, deps } = world();
    skill("Alpha", undefined, { "notes.md": "hello", ".env": "TOKEN=x", "id_rsa": "KEY", "cert.pem": "P", "credentials.json": "{}", "run.sh": "echo hi", "pic.png": "x" }); // secret-scan: fixture
    const id = (run({ scope: "skills", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    expect(run({ scope: "skills", dryRun: false, dryRunId: id }, deps).status).toBe(201);
    expect(w.skills.get("alpha")!.map((f) => f.path).sort()).toEqual(["SKILL.md", "notes.md", "run.sh"]);
  });
});

describePosix("path confinement", () => {
  it.each(["before-open", "after-open", "after-read"] as const)("confines an ancestor swapped for an outside symlink %s", (step) => {
    const { deps } = world();
    skill("Alpha");
    const dir = join(home, ".claude", "skills", "Alpha");
    const target = join(dir, "SKILL.md");
    mkdirSync(join(outside, "Alpha"));
    writeFileSync(join(outside, "Alpha", "SKILL.md"), "---\nname: stolen\ndescription: x\n---\nprivate");
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      renameSync(dir, join(home, "saved-alpha"));
      symlinkSync(join(outside, "Alpha"), dir);
    };
    const racy: ImportFs = {
      ...realImportFs,
      openSync: (path, flags) => {
        const isTarget = openedPath(path) === target && !(flags & constants.O_DIRECTORY);
        if (isTarget && step === "before-open") swap();
        const fd = realImportFs.openSync(path, flags);
        if (isTarget && step === "after-open") swap();
        return fd;
      },
      readSync: (fd, buffer, offset, length, position) => {
        const count = realImportFs.readSync(fd, buffer, offset, length, position);
        if (step === "after-read") swap();
        return count;
      },
    };
    const dry = run({ scope: "skills", dryRun: true }, deps, { fs: racy });
    expect(swapped).toBe(true);
    expect(dry.status).toBe(200);
    // Once verified, the retained handle is safe even if its pathname later changes.
    const safelyRead = step === "after-read" || (step === "after-open" && process.platform === "darwin");
    expect(dry.body).toMatchObject(safelyRead ? { skills: [{ name: "Alpha" }], skipped: [] } : { skills: [], skipped: ["Alpha"] });
    if (!safelyRead) expect(dry.body).toMatchObject({ skippedReasons: [{ name: "Alpha", reason: "Could not read Claude Code files." }] });
    expect(JSON.stringify(dry.body)).not.toContain("private");
    expect(JSON.stringify(dry.body)).not.toContain(outside);
  });

  it.each(["uid", "nlink"] as const)("refuses a file descriptor with an unsafe %s", (field) => {
    const { deps } = world();
    skill("Alpha");
    let reads = 0;
    let closes = 0;
    const racy: ImportFs = {
      ...realImportFs,
      fstatSync: (fd) => {
        const stat = realImportFs.fstatSync(fd);
        return stat.isFile() ? { ...stat, isFile: () => true, isDirectory: () => false, [field]: stat[field] + 1 } : stat;
      },
      readSync: (...args) => { reads++; return realImportFs.readSync(...args); },
      closeSync: (fd) => { closes++; realImportFs.closeSync(fd); },
    };
    expect(run({ scope: "skills", dryRun: true }, deps, { fs: racy }).body).toMatchObject({ skills: [], skipped: ["Alpha"] });
    expect(reads).toBe(0);
    expect(closes).toBeGreaterThan(0);
  });

  it("refuses a .claude/skills folder that is a symlink out of home", () => {
    const { deps } = world();
    mkdirSync(join(outside, "skills", "Evil"), { recursive: true });
    writeFileSync(join(outside, "skills", "Evil", "SKILL.md"), "---\nname: evil\ndescription: x\n---\nbody");
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(outside, "skills"), join(home, ".claude", "skills"));
    expect(run({ scope: "skills", dryRun: true }, deps).status).toBe(422);
  });

  it("refuses a .claude.json that is a symlink, even to a file inside home", () => {
    const { deps } = world();
    writeFileSync(join(home, "real.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    symlinkSync(join(home, "real.json"), join(home, ".claude.json"));
    expect(run({ scope: "mcp", dryRun: true }, deps).status).toBe(422);
  });

  it("names only a proven skipped folder and emits one marker for symlinked skill folders", () => {
    const { deps } = world();
    skill("Good");
    mkdirSync(join(outside, "Away"), { recursive: true });
    writeFileSync(join(outside, "Away", "SKILL.md"), "---\nname: away\ndescription: x\n---\nbody");
    symlinkSync(join(outside, "Away"), join(home, ".claude", "skills", "LinkedFolder"));
    symlinkSync(join(outside, "Away"), join(home, ".claude", "skills", "SecondLink"));
    skill("Sneaky");
    writeFileSync(join(outside, "secret.md"), "outside");
    symlinkSync(join(outside, "secret.md"), join(home, ".claude", "skills", "Sneaky", "notes.md"));
    const dry = run({ scope: "skills", dryRun: true }, deps);
    const body = dry.body as { skills: Array<{ name: string }>; skipped: string[] };
    expect(body.skills).toEqual([{ name: "Good" }]);
    expect(body.skipped).toEqual(["Sneaky", "(could not read)"]);
  });

  it("refuses a link swapped in after the folder was checked (O_NOFOLLOW on the open)", () => {
    const { deps } = world();
    skill("Alpha");
    writeFileSync(join(outside, "stolen.md"), "stolen");
    const target = join(home, ".claude", "skills", "Alpha", "SKILL.md");
    let swapped = false;
    const racy: ImportFs = {
      ...realImportFs,
      openSync: (path, flags) => {
        if (openedPath(path) === target && !swapped) { swapped = true; rmSync(target); symlinkSync(join(outside, "stolen.md"), target); }
        return realImportFs.openSync(path, flags);
      },
    };
    const dry = run({ scope: "skills", dryRun: true }, deps, { fs: racy });
    expect(swapped).toBe(true);
    expect((dry.body as { skills: unknown[] }).skills ?? []).toHaveLength(0);
  });

  it("skips hostile skill and server names and counts them", () => {
    const { deps } = world();
    skill("Good");
    mkdirSync(join(home, ".claude", "skills", "bad;rm -rf"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", ".hidden"), { recursive: true });
    claudeJson({ ok: { command: "uvx" }, "a/../b": { command: "x" }, "$(whoami)": { command: "x" }, ".dot": { command: "x" } });
    const dry = run({ scope: "both", dryRun: true }, deps);
    const body = dry.body as { skills: Array<{ name: string }>; servers: Array<{ name: string }>; skipped: string[] };
    expect(body.skills).toEqual([{ name: "Good" }]);
    expect(body.servers).toEqual([{ name: "ok", kind: "local", needsKey: false }]);
    expect(body.skipped.filter((name) => name === "(unusable name)")).toHaveLength(3);
    expect(body.skipped.filter((name) => name === "(could not read)")).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("whoami");
  });

  it("refuses a .claude.json over 2 MB and one nested deeper than 8", () => {
    const { deps } = world();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {}, pad: "x".repeat(2 * 1024 * 1024 + 10) }));
    expect(run({ scope: "mcp", dryRun: true }, deps).status).toBe(422);
    let deep: unknown = "x";
    for (let i = 0; i < 12; i++) deep = { a: deep };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {}, deep }));
    expect(run({ scope: "mcp", dryRun: true }, deps).status).toBe(422);
  });
});

const OUTSIDE_CANARY = "OUTSIDE-IMPORT-CANARY-should-never-be-copied";

/** Check the review AND its committed snapshot, including transient writes and logs. */
function exerciseConfinement(fs: ImportFs, forbidden: readonly string[] = [OUTSIDE_CANARY]) {
  const { w, deps } = world();
  const addSkill = vi.fn(deps.addSkill);
  const persistMcp = vi.fn(deps.persistMcp);
  const writeReceipt = vi.fn(deps.writeReceipt);
  const logs = ["log", "info", "warn", "error", "debug"] as const;
  const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const read: string[] = [];
  const observed: ImportFs = { ...fs, readSync: (fd, buffer, offset, length, position) => {
    const n = fs.readSync(fd, buffer, offset, length, position);
    read.push(Buffer.from(buffer.subarray(offset, offset + n)).toString("utf8"));
    return n;
  } };
  const observedDeps = { ...deps, addSkill, persistMcp, writeReceipt };
  const dry = run({ scope: "both", dryRun: true }, observedDeps, { fs: observed });
  const done = dry.status === 200
    ? run({ scope: "both", dryRun: false, dryRunId: (dry.body as { dryRunId: string }).dryRunId }, observedDeps, { fs: observed })
    : undefined;
  if (done) expect(done.status).toBe(201);
  const output = JSON.stringify([dry, done, [...w.skills], w.mcp, w.receipt,
    addSkill.mock.calls, persistMcp.mock.calls, writeReceipt.mock.calls, spies.map((spy) => spy.mock.calls), read]);
  for (const text of forbidden) expect(output).not.toContain(text);
  return { dry, done, w };
}

for (const platform of ["linux", "darwin"] as const) describe(`anchored opens on ${platform}`, () => {
  const posixIt = it.skipIf(process.platform !== platform);

  posixIt.each(["after-open", "after-read"] as const)("refuses an ancestor swapped at its syscall and restored %s", (restoreAt) => {
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    const dir = join(home, ".claude", "skills", "Alpha");
    const saved = join(home, "saved-alpha");
    writeFileSync(join(outside, "SKILL.md"), `---\nname: stolen\ndescription: Stolen\n---\n${OUTSIDE_CANARY}`);
    let swapped = false;
    let attacked = false;
    const restore = () => {
      if (!swapped) return;
      rmSync(dir);
      renameSync(saved, dir);
      swapped = false;
    };
    const racy: ImportFs = { ...realImportFs,
      openSync: (path, flags) => {
        if (!attacked && openedPath(path) === dir) {
          attacked = swapped = true;
          renameSync(dir, saved);
          symlinkSync(outside, dir);
          try { return realImportFs.openSync(path, flags); }
          finally { if (restoreAt === "after-open") restore(); }
        }
        return realImportFs.openSync(path, flags);
      },
      readSync: (...args) => {
        const n = realImportFs.readSync(...args);
        if (restoreAt === "after-read") restore();
        return n;
      },
    };
    try {
      const { dry, w } = exerciseConfinement(racy);
      expect(attacked).toBe(true);
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ skills: [], skipped: ["(could not read)"] });
      expect(w.skills.size).toBe(0);
    } finally { restore(); }
  });

  posixIt.each(["after-open", "after-read"] as const)("never reads outside bytes when the final file open's ancestor is restored %s", (restoreAt) => {
    skill("Alpha");
    const dir = join(home, ".claude", "skills", "Alpha");
    const target = join(dir, "SKILL.md");
    const saved = join(home, "saved-alpha");
    writeFileSync(join(outside, "SKILL.md"), `---\nname: stolen\ndescription: Stolen\n---\n${OUTSIDE_CANARY}`);
    let swapped = false;
    let attacked = false;
    const restore = () => {
      if (!swapped) return;
      rmSync(dir);
      renameSync(saved, dir);
      swapped = false;
    };
    const racy: ImportFs = { ...realImportFs,
      openSync: (path, flags) => {
        if (!attacked && !(flags & constants.O_DIRECTORY) && openedPath(path) === target) {
          attacked = swapped = true;
          renameSync(dir, saved);
          symlinkSync(outside, dir);
          try { return realImportFs.openSync(path, flags); }
          finally { if (restoreAt === "after-open") restore(); }
        }
        return realImportFs.openSync(path, flags);
      },
      readSync: (...args) => {
        const n = realImportFs.readSync(...args);
        if (restoreAt === "after-read") restore();
        return n;
      },
    };
    try {
      const { dry, w } = exerciseConfinement(racy);
      expect(attacked).toBe(true);
      expect(dry.status).toBe(200);
      // Linux may open the original inode through its pinned parent, then see its
      // restored expected name. That snapshot is safe; a pathname reopen is not.
      if (platform === "linux" && restoreAt === "after-open") {
        expect(w.skills.get("alpha")?.[0]?.content).toContain("Body for Alpha.");
      } else expect(w.skills.size).toBe(0);
    } finally { restore(); }
  });

  posixIt("does not disclose names from a directory swapped during listing", () => {
    skill("Alpha");
    const dir = join(home, ".claude", "skills");
    const saved = join(home, "saved-skills");
    for (const name of ["secretname", "another-secretname"]) {
      mkdirSync(join(outside, name));
      writeFileSync(join(outside, name, "SKILL.md"), OUTSIDE_CANARY);
    }
    let attacked = false;
    const racy: ImportFs = { ...realImportFs, readdirSync: (path) => {
      if (!attacked && openedPath(path) === dir) {
        attacked = true;
        renameSync(dir, saved);
        symlinkSync(outside, dir);
        try { return realImportFs.readdirSync(path); }
        finally { rmSync(dir); renameSync(saved, dir); }
      }
      return realImportFs.readdirSync(path);
    } };
    const { dry } = exerciseConfinement(racy, [OUTSIDE_CANARY, "secretname"]);
    expect(attacked).toBe(true);
    expect(dry.status).toBe(200);
    expect((dry.body as { skipped: string[] }).skipped.filter((name) => name === "(could not read)").length).toBeLessThanOrEqual(1);
    if (platform === "darwin") expect(dry.body).toMatchObject({ skipped: ["(could not read)"] });
  });

  posixIt("skips a skill holding an outside hardlink without reading the canary", () => {
    skill("Alpha");
    writeFileSync(join(outside, "notes.md"), OUTSIDE_CANARY);
    linkSync(join(outside, "notes.md"), join(home, ".claude", "skills", "Alpha", "notes.md"));
    const { dry, w } = exerciseConfinement(realImportFs);
    expect(dry.body).toMatchObject({ skills: [], skipped: ["Alpha"] });
    expect(w.skills.size).toBe(0);
  });

  posixIt("refuses a hardlinked MCP file without reading it", () => {
    writeFileSync(join(outside, "servers.json"), JSON.stringify({ mcpServers: {}, canary: OUTSIDE_CANARY }));
    linkSync(join(outside, "servers.json"), join(home, ".claude.json"));
    const { dry } = exerciseConfinement(realImportFs);
    expect(dry.status).toBe(422);
    expect(dry.body).toEqual({ error: "Could not read Claude Code files." });
  });

  posixIt("refuses a world-writable skill folder without naming it", () => {
    skill("Alpha");
    chmodSync(join(home, ".claude", "skills", "Alpha"), 0o777);
    const { dry, w } = exerciseConfinement(realImportFs);
    expect(dry.body).toMatchObject({ skills: [], skipped: ["(could not read)"] });
    expect(w.skills.size).toBe(0);
  });

  posixIt("opens a FIFO nonblocking and skips it within the read budget", () => {
    skill("Alpha");
    const target = join(home, ".claude", "skills", "Alpha", "SKILL.md");
    rmSync(target);
    execFileSync("mkfifo", [target]);
    const flagsSeen: number[] = [];
    const fs: ImportFs = { ...realImportFs, openSync: (path, flags) => {
      flagsSeen.push(flags);
      // Guard a regression before the real FIFO open could hang the entire runner.
      expect(flags & constants.O_NONBLOCK).not.toBe(0);
      return realImportFs.openSync(path, flags);
    } };
    const started = Date.now();
    const { dry } = exerciseConfinement(fs);
    expect(dry.body).toMatchObject({ skills: [], skipped: ["Alpha"] });
    expect(flagsSeen.length).toBeGreaterThan(0);
    expect(flagsSeen.every((flags) => (flags & constants.O_NONBLOCK) !== 0)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  posixIt.each([false, true])("gives static and swapped .claude links the same response with skills=%s", (hasSkills) => {
    if (hasSkills) mkdirSync(join(outside, "skills"));
    const dir = join(home, ".claude");
    const saved = join(home, "saved-claude");
    const { deps } = world();
    symlinkSync(outside, dir);
    const direct = run({ scope: "skills", dryRun: true }, deps);
    expect(direct.status).toBe(422);
    expect(direct.body).toEqual({ code: "source-linked", error: "Claude Code files are reached through a link, so Murage did not read them." });
    rmSync(dir);
    mkdirSync(dir);
    let attacked = false;
    const racy: ImportFs = { ...realImportFs, openSync: (path, flags) => {
      if (!attacked && openedPath(path) === dir) {
        attacked = true;
        renameSync(dir, saved);
        symlinkSync(outside, dir);
        try { return realImportFs.openSync(path, flags); }
        finally { rmSync(dir); renameSync(saved, dir); }
      }
      return realImportFs.openSync(path, flags);
    } };
    expect(run({ scope: "skills", dryRun: true }, deps, { fs: racy })).toEqual(direct);
    expect(attacked).toBe(true);
  });
});

describe("platform confinement gates", () => {
  it.skipIf(process.platform !== "linux").each(["unreadable", "different", "deleted"] as const)("fails closed when proc links are %s", (fault) => {
    claudeJson({ plain: { command: "uvx" } });
    const { deps } = world();
    const opened: number[] = [];
    const closed: number[] = [];
    const read = vi.fn(realImportFs.readSync);
    const fs: ImportFs = { ...realImportFs,
      openSync: (path, flags) => { const fd = realImportFs.openSync(path, flags); opened.push(fd); return fd; },
      closeSync: (fd) => { closed.push(fd); realImportFs.closeSync(fd); },
      readSync: read,
      readlinkSync: (path) => {
        if (fault === "unreadable") throw Object.assign(new Error("hidden proc"), { code: "ENOENT" });
        return fault === "different" ? outside : `${realImportFs.readlinkSync(path)} (deleted)`;
      },
    };
    const result = run({ scope: "mcp", dryRun: true }, deps, { fs });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "Could not read Claude Code files." });
    expect(read).not.toHaveBeenCalled();
    expect(opened.length).toBeGreaterThan(0);
    expect(closed.sort()).toEqual(opened.sort());
  });

  it.skipIf(process.platform !== "linux")("refuses an unreadable proc directory listing and closes every descriptor", () => {
    skill("Alpha");
    const { deps } = world();
    const active = new Set<number>();
    const fs: ImportFs = { ...realImportFs,
      openSync: (path, flags) => { const fd = realImportFs.openSync(path, flags); active.add(fd); return fd; },
      closeSync: (fd) => { active.delete(fd); realImportFs.closeSync(fd); },
      readdirSync: (path) => {
        expect(path).toMatch(/^\/proc\/self\/fd\/\d+$/);
        throw Object.assign(new Error("hidden proc"), { code: "ENOENT" });
      },
    };
    expect(run({ scope: "skills", dryRun: true }, deps, { fs }).status).toBe(422);
    expect(active.size).toBe(0);
  });

  it.skipIf(process.platform !== "darwin")("proves O_NOFOLLOW_ANY rejects a symlinked ancestor with ELOOP from a real open", () => {
    mkdirSync(join(outside, "Alpha"));
    writeFileSync(join(outside, "Alpha", "SKILL.md"), OUTSIDE_CANARY);
    symlinkSync(outside, join(home, "linked"));
    let code: string | undefined;
    try {
      const fd = realImportFs.openSync(join(home, "linked", "Alpha", "SKILL.md"), constants.O_RDONLY | 0x20000000 | constants.O_NONBLOCK);
      realImportFs.closeSync(fd);
    } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code).toBe("ELOOP");
  });

  it.skipIf(process.platform !== "darwin")("refuses Darwin 19 before any filesystem call without mocking open", () => {
    const { deps } = world();
    const realpath = vi.fn(realImportFs.realpathSync);
    const result = run({ scope: "both", dryRun: true }, deps, { fs: { ...realImportFs, release: () => "19.6.0", realpathSync: realpath } });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "Could not read Claude Code files." });
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each(["freebsd", "win32"] as const)("refuses %s without any filesystem call (win32: the native helper is absent)", (platform) => {
    const { deps } = world();
    const unexpected = vi.fn((): never => { throw new Error("Filesystem must not be touched"); });
    const winAnchor = vi.fn(() => null);
    const fs = {
      platform: () => platform, release: unexpected, getuid: unexpected, winAnchor,
      realpathSync: unexpected, readlinkSync: unexpected, readdirSync: unexpected,
      openSync: unexpected, fstatSync: unexpected, readSync: unexpected, closeSync: unexpected,
    } as unknown as ImportFs;
    for (const scope of ["skills", "mcp", "both"] as const) for (const dryRun of [true, false]) {
      const result = run({ scope, dryRun }, deps, { fs });
      expect(result.status).toBe(422);
      expect(result.body).toEqual({ error: "Could not read Claude Code files." });
    }
    expect(unexpected).not.toHaveBeenCalled();
    expect(winAnchor.mock.calls.length > 0).toBe(platform === "win32");
  });

  it("win32 with the native helper present walks the anchored tree and imports Beta", () => {
    const fake = standardTree();
    const { w, deps } = world();
    const unexpected = vi.fn((): never => { throw new Error("Filesystem must not be touched"); });
    const fs = { ...realImportFs, platform: () => "win32", winAnchor: () => fake.anchor, realpathSync: unexpected, openSync: unexpected, readdirSync: unexpected } as unknown as ImportFs;
    const dry = run({ scope: "both", dryRun: true }, deps, { fs });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ skills: [{ name: "Alpha" }, { name: "Beta" }], skipped: [] });
    expect(unexpected).not.toHaveBeenCalled();
    expect(fake.homeSeen).toBe(home);
    expect(fake.begins).toBe(1);
    expect(fake.ends).toBe(1);
    expect(fake.openCount()).toBe(0);
    const done = run({ scope: "both", dryRun: false, dryRunId: (dry.body as { dryRunId: string }).dryRunId }, deps, { fs });
    expect(done.status).toBe(201);
    expect([...w.skills.keys()].sort()).toEqual(["alpha", "beta"]);
  });

  it.skipIf(unsupportedHost)("canonicalizes home once for a request spanning both scopes", () => {
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    const { deps } = world();
    const resolve = vi.fn(realImportFs.realpathSync);
    expect(run({ scope: "both", dryRun: true }, deps, { fs: { ...realImportFs, realpathSync: resolve } }).status).toBe(200);
    expect(resolve.mock.calls).toEqual([[home]]);
  });

  it.skipIf(unsupportedHost)("bounds reads at the fstat size even if a file grows", () => {
    claudeJson({ plain: { command: "uvx" } });
    const target = join(home, ".claude.json");
    const originalSize = Buffer.byteLength(JSON.stringify({ mcpServers: { plain: { command: "uvx" } } }));
    const { deps } = world();
    let bytesRead = 0;
    let grew = false;
    const fs: ImportFs = { ...realImportFs, readSync: (fd, buffer, offset, length, position) => {
      if (!grew) {
        grew = true;
        writeFileSync(target, JSON.stringify({ mcpServers: { plain: { command: "uvx" } } }) + OUTSIDE_CANARY);
      }
      expect(position + length).toBeLessThanOrEqual(originalSize);
      const n = realImportFs.readSync(fd, buffer, offset, length, position);
      bytesRead += n;
      return n;
    } };
    const result = run({ scope: "mcp", dryRun: true }, deps, { fs });
    expect(result.status).toBe(422);
    expect(bytesRead).toBe(originalSize);
    expect(JSON.stringify(result.body)).not.toContain(OUTSIDE_CANARY);
  });
});

describe("secrets are default-deny", () => {
  it("recognizes token shapes and leaves ordinary words and paths alone", () => {
    for (const secret of ["sk-ant-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "xoxb-1234567890-abcdefghijkl", "https://user:pass@host/x", "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3gH"]) expect(looksSecret(secret)).toBe(true); // secret-scan: fixture
    for (const fine of ["node", "--port", "9000", "/Users/someone/Documents/projects/a-very-long-folder-name/dist/index.js", "@modelcontextprotocol/server-filesystem", "UTF-8"]) expect(looksSecret(fine)).toBe(false);
  });

  it("drops a token-looking env value and an innocuous-looking env key not on the allow-list, and flags the server", () => {
    const planned = planServer("tool", { command: "uvx", args: ["pkg"], env: { LANG: "en_US", NODE_ENV: "production", API_KEY: "sk-abcdefghijklmnopqrstuvwxyz0123", FOO_URL: "https://internal.example", GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }, [])!; // secret-scan: fixture
    expect(planned.needsKey).toBe(true);
    const entry = planned.entry as { env: Record<string, unknown>; pendingEnv?: string[]; enabled: boolean };
    expect(entry.env).toEqual({ LANG: "en_US", NODE_ENV: "production" });
    expect(entry.pendingEnv?.sort()).toEqual(["API_KEY", "FOO_URL", "GITHUB_TOKEN"]); // secret-scan: fixture
    expect(JSON.stringify(entry)).not.toContain("sk-abc");
    expect(JSON.stringify(entry)).not.toContain("ghp_");
    expect(entry.enabled).toBe(false);
  });

  it("drops args that hold a token, and an address that carries user:pass@ or a query key", () => {
    const withArg = planServer("tool", { command: "uvx", args: ["pkg", "--token=abc12345", "ok"] }, [])!;
    expect((withArg.entry as { args: string[] }).args).toEqual([]);
    expect(withArg.needsKey).toBe(true);
    const withUrl = planServer("site", { type: "http", url: "https://user:pass@mcp.example.com/v1?key=abcdef#frag" }, [])!; // secret-scan: fixture
    expect((withUrl.entry as { url: string }).url).toBe("https://mcp.example.com/v1");
    expect(withUrl.needsKey).toBe(true);
    expect(JSON.stringify(withUrl.entry)).not.toContain("pass");
    expect(planServer("site", { type: "http", url: "https://mcp.example.com/sk-abcdefghijklmnopqrstuvwxyz0123/mcp" }, [])).toBeNull(); // secret-scan: fixture
  });

  it("drops every header value and records the header names as keys still needed", () => {
    const planned = planServer("site", { type: "sse", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz", "X-Api-Key": "k", "Content-Type": "application/json" } }, [])!;
    const entry = planned.entry as { headers: Record<string, unknown>; pendingHeaders?: string[]; auth: string; transport: string };
    expect(entry.headers).toEqual({});
    expect(entry.pendingHeaders?.sort()).toEqual(["Authorization", "X-Api-Key"]);
    expect(entry.auth).toBe("header");
    expect(entry.transport).toBe("sse");
  });
});

describePosix("the import", () => {
  it.each(["name", "size", "path", "collision"] as const)("prevalidates every skill's %s before writing anything", (invalid) => {
    const { w, deps } = world();
    skill("Alpha");
    if (invalid === "name") skill("Bad", "not a skill");
    if (invalid === "size") skill("Bad", undefined, { "large.txt": "x".repeat(256 * 1024 + 1) });
    if (invalid === "path") skill("Bad", undefined, { "bad.txt": "invalid destination path" });
    if (invalid === "collision") skill("Bad", "---\nname: alpha\ndescription: Duplicate\n---\nBody");
    claudeJson({ plain: { command: "uvx" } });
    let writes = 0;
    const observed: ImportDeps = { ...deps, addSkill: (files, label) => { writes++; return deps.addSkill(files, label); } };
    // Simulate a hostile source filename without creating a Windows-invalid fixture.
    const invalidPathFs: ImportFs = {
      ...realImportFs,
      readdirSync: (path) => realImportFs.readdirSync(path).map((name) => name === "bad.txt" ? "C:bad.txt" : name),
    };
    const dry = run({ scope: "both", dryRun: true }, observed, { fs: invalid === "path" ? invalidPathFs : realImportFs });
    // Invalid listed paths now fail during the anchored walk, before preparation.
    expect(dry.status).toBe(invalid === "path" ? 200 : 422);
    if (invalid === "path") expect(dry.body).toMatchObject({ skills: [{ name: "Alpha" }], skipped: ["Bad"] });
    expect(writes).toBe(0);
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
  });

  it("checks parsed destination names and orphaned paths without overwriting them", () => {
    const { w, deps } = world();
    skill("Different", "---\nname: existing\ndescription: Copy\n---\nBody");
    skill("Orphan");
    w.skills.set("existing", [{ path: "SKILL.md", content: "original" }]);
    const guarded: ImportDeps = { ...deps, skillPathExists: (name) => name === "orphan" || deps.skillPathExists(name) };
    const dry = run({ scope: "skills", dryRun: true }, guarded);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ skills: [], skipped: ["Different", "Orphan"] });
    expect(w.skills.get("existing")?.[0]?.content).toBe("original");
  });

  it("rechecks destinations at import when a name was added after review", () => {
    const { w, deps } = world();
    skill("Alpha");
    const dryRunId = (run({ scope: "skills", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    w.skills.set("alpha", [{ path: "SKILL.md", content: "added after review" }]);
    const done = run({ scope: "skills", dryRun: false, dryRunId }, deps);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ skills: 0, skipped: ["Alpha"] });
    expect(w.skills.get("alpha")?.[0]?.content).toBe("added after review");
  });

  it.each(["returned-error", "threw-after-write"] as const)("rolls back every attempted skill on %s and never commits tools or receipt", (failure) => {
    const { w, deps } = world();
    skill("Alpha");
    skill("Beta");
    claudeJson({ plain: { command: "uvx" } });
    const dryRunId = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    let calls = 0;
    const failing: ImportDeps = { ...deps, addSkill: (files, label) => {
      if (++calls === 2) {
        if (failure === "returned-error") return { error: "disk" };
        deps.addSkill(files, label);
        throw new Error("failed after destination write");
      }
      return deps.addSkill(files, label);
    } };
    const done = run({ scope: "both", dryRun: false, dryRunId }, failing);
    expect(done.status).toBe(500);
    expect(done.body).toMatchObject({ error: "Could not finish importing. Nothing was changed." });
    expect(w.skills.size).toBe(0);
    expect(w.removed).toEqual(["beta", "alpha"]);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
  });

  it.each(["servers", "receipt"] as const)("rolls back a %s write that changes storage before throwing", (failure) => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    const dryRunId = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    let serverCalls = 0;
    const failing: ImportDeps = {
      ...deps,
      persistMcp: (next) => { deps.persistMcp(next); if (++serverCalls === 1 && failure === "servers") throw new Error("disk"); },
      writeReceipt: (receipt) => { deps.writeReceipt(receipt); if (failure === "receipt") throw new Error("disk"); },
    };
    const done = run({ scope: "both", dryRun: false, dryRunId }, failing);
    expect(done.status).toBe(500);
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
    expect(done.body).toMatchObject({ error: "Could not finish importing. Nothing was changed." });
  });

  it.each(["skill", "servers", "receipt"] as const)("reports an honest list when the %s rollback fails and continues other rollback steps", (failure) => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    const dryRunId = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    let serverCalls = 0;
    const failing: ImportDeps = {
      ...deps,
      writeReceipt: (receipt) => { deps.writeReceipt(receipt); throw new Error("secret path must not leak"); },
      restoreReceipt: () => { if (failure === "receipt") throw new Error(home); deps.restoreReceipt(); },
      persistMcp: (next) => { if (++serverCalls > 1 && failure === "servers") throw new Error(home); deps.persistMcp(next); },
      removeSkill: (name) => { if (failure === "skill") throw new Error(home); deps.removeSkill(name); },
    };
    const done = run({ scope: "both", dryRun: false, dryRunId }, failing);
    expect(done.status).toBe(500);
    expect(done.body).toMatchObject({ code: "partly-undone", notUndone: [{ kind: failure, ...(failure === "skill" ? { name: "alpha" } : {}) }] });
    expect((done.body as { undone: unknown[] }).undone).toHaveLength(2);
    expect(w.skills.size).toBe(failure === "skill" ? 1 : 0);
    expect(Object.keys(w.mcp)).toHaveLength(failure === "servers" ? 1 : 0);
    expect(w.receipt).toHaveLength(failure === "receipt" ? 1 : 0);
    expect(JSON.stringify(done.body)).not.toContain("Nothing was changed");
    expect(JSON.stringify(done.body)).not.toContain(home);
    expect(JSON.stringify(done.body)).not.toContain("secret path");
  });

  it("adds skills and servers, servers off, with counts and names only in the receipt, and never overwrites", () => {
    const { w, deps } = world();
    skill("Alpha");
    skill("Beta");
    w.skills.set("beta", [{ path: "SKILL.md", content: "mine" }]);
    claudeJson({ plain: { command: "uvx", args: ["x"] }, keyed: { command: "uvx", env: { SECRET_THING: "supersecretvalue123456789abcdef0123" } } });
    w.mcp = { plain: { command: "mine", args: [], env: {}, enabled: true } };
    const id = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    const done = run({ scope: "both", dryRun: false, dryRunId: id }, deps);
    expect(done.status).toBe(201);
    expect(done.body).toEqual({ skills: 1, servers: 1, needsKey: 1, skipped: expect.arrayContaining(["Beta", "plain"]) });
    expect(w.skills.get("beta")![0]!.content).toBe("mine");
    expect((w.mcp.plain as { command: string }).command).toBe("mine");
    const keyed = w.mcp.keyed as { enabled: boolean; env: Record<string, string>; pendingEnv: string[]; disabledReason: string };
    expect(keyed.enabled).toBe(false);
    expect(keyed.env).toEqual({});
    expect(keyed.pendingEnv).toEqual(["SECRET_THING"]);
    expect(w.receipt).toHaveLength(1);
    const text = JSON.stringify([done.body, w.receipt]);
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain(home);
  });

  it("is all-or-nothing for both: a failed server write undoes the skills and leaves the key unchanged", () => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    w.failMcp = true;
    const id = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    const done = run({ scope: "both", dryRun: false, dryRunId: id }, deps);
    expect(done.status).toBe(500);
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
  });

  it("rolls the servers and the skills back when the receipt cannot be written", () => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    w.failReceipt = true;
    const id = (run({ scope: "both", dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    expect(run({ scope: "both", dryRun: false, dryRunId: id }, deps).status).toBe(500);
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
  });

  it("preserves previously imported items and the old receipt when a later import fails", () => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ original: { command: "uvx" } });
    expect(await_import("both", deps).status).toBe(201);
    const originalReceipt = [...w.receipt];
    const originalMcp = { ...w.mcp };
    skill("Beta");
    claudeJson({ original: { command: "uvx" }, added: { command: "node" } });
    w.failReceipt = true;
    const done = await_import("both", deps);
    expect(done.status).toBe(500);
    expect([...w.skills.keys()]).toEqual(["alpha"]);
    expect(w.mcp).toEqual(originalMcp);
    expect(w.receipt).toEqual(originalReceipt);
    expect(done.body).toMatchObject({ error: "Could not finish importing. Nothing was changed." });
  });

  it("sync again only adds what is new and adds to the running counts", () => {
    const { w, deps } = world();
    skill("Alpha");
    const first = await_import("skills", deps);
    expect(first.body).toMatchObject({ skills: 1 });
    skill("Gamma");
    const again = run({ scope: "skills", dryRun: true }, deps);
    expect((again.body as { skills: Array<{ name: string }> }).skills).toEqual([{ name: "Gamma" }]);
    const second = handleClaudeCodeImport({ body: { scope: "skills", dryRun: false, dryRunId: (again.body as { dryRunId: string }).dryRunId }, enabled: true, home, deps, ownerToken: "desktop-session-a", previous: { skills: 1 } });
    expect(second.body).toMatchObject({ skills: 1 });
    expect((w.receipt.at(-1) as { skills: number }).skills).toBe(2);
  });

  function await_import(scope: "skills" | "mcp" | "both", deps: ImportDeps) {
    const id = (run({ scope, dryRun: true }, deps).body as { dryRunId: string }).dryRunId;
    return run({ scope, dryRun: false, dryRunId: id }, deps);
  }
});

describePosix("one request budget", () => {
  it("shares the 50 MB ceiling across skills and MCP, rather than resetting for MCP", () => {
    const { w, deps } = world();
    // 25 valid two-MB folders exactly fill the request budget; MCP alone is tiny.
    for (let i = 0; i < 25; i++) {
      const name = `skill-${i}`;
      const header = `---\nname: ${name}\ndescription: Budget fixture\n---\nBody\n`;
      const extra: Record<string, string> = {};
      for (let file = 0; file < 8; file++) extra[`part-${file}.txt`] = "x".repeat(256 * 1024 - (file === 7 ? Buffer.byteLength(header) : 0));
      skill(name, header, extra);
    }
    claudeJson({ plain: { command: "uvx" } });
    expect(run({ scope: "mcp", dryRun: true }, deps, { now: () => 0 }).status).toBe(200);
    let bytesRead = 0;
    let openedMcp = false;
    const measured: ImportFs = {
      ...realImportFs,
      openSync: (path, flags) => { if (openedPath(path) === join(home, ".claude.json")) openedMcp = true; return realImportFs.openSync(path, flags); },
      readSync: (...args) => { const n = realImportFs.readSync(...args); bytesRead += n; return n; },
    };
    const both = run({ scope: "both", dryRun: true }, deps, { fs: measured, now: () => 0 });
    expect(openedMcp).toBe(true);
    expect(bytesRead).toBe(50 * 1024 * 1024);
    expect(both.status).toBe(422);
    expect(both.body).toEqual({ error: "Could not read Claude Code files." });
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
  });

  it("shares one ten-second deadline across both readers", () => {
    const { deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    let clock = 0;
    const slow: ImportFs = { ...realImportFs, readSync: (...args) => {
      const n = realImportFs.readSync(...args);
      clock += 6000;
      return n;
    } };
    for (const scope of ["skills", "mcp"] as const) {
      clock = 0;
      expect(run({ scope, dryRun: true }, deps, { fs: slow, now: () => clock }).status).toBe(200);
    }
    clock = 0;
    expect(run({ scope: "both", dryRun: true }, deps, { fs: slow, now: () => clock }).status).toBe(422);
    expect(clock).toBe(12_000);
  });

  it("also bounds snapshot import preparation across both scopes before committing", () => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    const dryRunId = (run({ scope: "both", dryRun: true }, deps, { now: () => 0 }).body as { dryRunId: string }).dryRunId;
    let clock = 0;
    const slow: ImportDeps = {
      ...deps,
      skillPathExists: (name) => { clock += 6000; return deps.skillPathExists(name); },
      mcpCurrent: () => { clock += 6000; return deps.mcpCurrent(); },
    };
    expect(run({ scope: "both", dryRun: false, dryRunId }, slow, { now: () => clock }).status).toBe(422);
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
  });

  it("rolls back a snapshot import if the shared deadline expires during commit", () => {
    const { w, deps } = world();
    skill("Alpha");
    claudeJson({ plain: { command: "uvx" } });
    const dryRunId = (run({ scope: "both", dryRun: true }, deps, { now: () => 0 }).body as { dryRunId: string }).dryRunId;
    let clock = 0;
    const slow: ImportDeps = { ...deps, writeReceipt: (receipt) => { deps.writeReceipt(receipt); clock = 10_001; } };
    const done = run({ scope: "both", dryRun: false, dryRunId }, slow, { now: () => clock });
    expect(done.status).toBe(500);
    expect(w.skills.size).toBe(0);
    expect(w.mcp).toEqual({});
    expect(w.receipt).toEqual([]);
  });
});

describePosix("the route and the key", () => {
  let fixture: VerificationServer;
  let desktop: Record<string, string>;
  async function post(headers: Record<string, string>, body: unknown) {
    const response = await fetch(`${fixture.info.url}/api/claude-code-import`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_999, span: 10_000 } });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
    if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it("is off by default and the desktop gets 409 until the switch is on", async () => {
    const config = await (await fetch(`${fixture.info.url}/api/config`, { headers: desktop })).json() as { claudeCodeImport?: unknown };
    expect(config.claudeCodeImport).toEqual({ enabled: false, lastImportedAt: null, skills: 0, servers: 0, needsKey: 0 });
    expect((await post(desktop, { scope: "both", dryRun: true })).status).toBe(409);
  });

  it("refuses anyone who is not the desktop before a file is touched", async () => {
    const none = await post({}, { scope: "both", dryRun: true });
    expect([403, 404]).toContain(none.status);
    const phone = await post({ "x-murage-surface": "phone" }, { scope: "both", dryRun: true });
    expect([403, 404]).toContain(phone.status);
  });

  it("only the switch can be set from the config route, never the receipt", async () => {
    const send = (body: unknown) => fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { ...desktop, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await send({ claudeCodeImport: { enabled: true } })).status).toBe(200);
    expect((await send({ claudeCodeImport: { enabled: true, skills: 99 } })).status).toBe(400);
    expect((await send({ claudeCodeImport: { lastImportedAt: 5 } })).status).toBe(400);
    const config = await (await fetch(`${fixture.info.url}/api/config`, { headers: desktop })).json() as { claudeCodeImport?: { enabled: boolean; skills: number } };
    expect(config.claudeCodeImport).toMatchObject({ enabled: true, skills: 0 });
  });

  it("requires the authenticated desktop proof for both review and import", async () => {
    const dry = await post(desktop, { scope: "both", dryRun: true });
    expect(dry.status).toBe(200);
    const { dryRunId } = JSON.parse(dry.text) as { dryRunId: string };
    const wrong = { ...desktop, "x-murage-surface-secret": "wrong-owner-proof" };
    expect([403, 404]).toContain((await post(wrong, { scope: "both", dryRun: false, dryRunId })).status);
    expect((await post(desktop, { scope: "both", dryRun: false, dryRunId })).status).toBe(201);
    expect((await post(desktop, { scope: "both", dryRun: true, ownerToken: "forged" })).status).toBe(400);
  });
});

// CONTRACTS-B 1.3 (R1-R22): the Windows walk, driven through a fault-injecting fake of the native helper. Runs on every lane.
describe("windows anchored walk (fake native helper)", () => {
  const winFs = (fake: AnchoredWinFake) => ({ ...realImportFs, platform: () => "win32", winAnchor: () => fake.anchor }) as unknown as ImportFs;
  const dryBoth = (fake: AnchoredWinFake, over: Partial<Parameters<typeof handleClaudeCodeImport>[0]> = {}) => {
    const { deps } = world();
    return run({ scope: "both", dryRun: true }, deps, { fs: winFs(fake), ...over });
  };
  type Dry = { skills: Array<{ name: string }>; servers: Array<{ name: string }>; skipped: string[] };
  const settled = (fake: AnchoredWinFake) => {
    // after every request, success or refusal: nothing held, and exactly one anchorEnd for the one anchorBegin
    expect(fake.openCount()).toBe(0);
    expect(fake.ends).toBe(fake.begins);
    expect(fake.ends).toBeLessThanOrEqual(1);
  };

  it("hands anchorBegin the home exactly as given, with the remaining request budget", () => {
    const fake = standardTree();
    expect(dryBoth(fake).status).toBe(200);
    expect(fake.homeSeen).toBe(home);
    expect(fake.budgetSeen).toBeGreaterThan(0);
    expect(fake.budgetSeen).toBeLessThanOrEqual(10_000);
    settled(fake);
  });

  it.each(["EINVAL", "ENOENT", "EBUSY", "EMLINK", "EREMOTE", "EACCES", "EIO", "EBADF", "ENOTSUP", "EMFILE", "ENOTDIR", "EISDIR", "ELOOP"])(
    "an injected %s on the open of one skill folder skips only that skill, unnamed, and Beta imports", (code) => {
      const fake = standardTree().failName("Alpha", code);
      const dry = dryBoth(fake);
      expect(dry.status).toBe(200);
      const body = dry.body as Dry;
      expect(body.skills.map((s) => s.name)).toEqual(["Beta"]);
      expect(body.skipped).toEqual(["(could not read)"]);
      expect(JSON.stringify(dry.body)).not.toContain("Alpha");
      settled(fake);
    });

  it("a busy SKILL.md inside an opened folder names that folder; only a busy folder is anonymous", () => {
    const fake = standardTree().failName("SKILL.md", "EBUSY");
    const dry = dryBoth(fake);
    const body = dry.body as Dry;
    expect(body.skills).toEqual([]);
    expect(body.skipped).toEqual(["Alpha", "Beta"]);
    settled(fake);
  });

  it.each(["EINVAL", "ENOENT", "EBUSY", "EACCES", "ETIMEDOUT", "EIO", "ENOTSUP", "EREMOTE", "ELOOP"])("an injected %s from anchorBegin is the plain refusal", (code) => {
    const fake = standardTree().failOn("anchorBegin", 1, code);
    const dry = dryBoth(fake);
    expect(dry.status).toBe(422);
    expect(dry.body).toEqual({ error: "Could not read Claude Code files." });
    settled(fake);
  });

  it("ELOOP on the .claude open answers the 'reached through a link' copy, with and without a skills child", () => {
    for (const withSkills of [true, false]) {
      const fake = new AnchoredWinFake(withSkills ? { ".claude/skills/Alpha/SKILL.md": "x" } : {}).failName(".claude", "ELOOP");
      fake.mkdir(".claude");
      const { deps } = world();
      const result = run({ scope: "skills", dryRun: true }, deps, { fs: winFs(fake) });
      expect(result.status).toBe(422);
      expect(result.body).toEqual({ code: "source-linked", error: "Claude Code files are reached through a link, so Murage did not read them." });
      settled(fake);
    }
  });

  it("a missing .claude folder is an empty result, not an error", () => {
    const fake = new AnchoredWinFake({ ".claude.json": JSON.stringify({ mcpServers: {} }) });
    const dry = dryBoth(fake);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ skills: [], skipped: [] });
    settled(fake);
  });

  it.each([["fileId", { fileId: 99n }], ["size", { size: 1 }], ["nlink", { nlink: 2 }]] as const)("a %s change between the open and the post-read stat refuses the file", (_label, patch) => {
    const fake = standardTree().driftAfterRead("notes-Alpha.md", patch);
    const body = dryBoth(fake).body as Dry;
    expect(body.skills.map((s) => s.name)).toEqual(["Beta"]);
    expect(body.skipped).toEqual(["Alpha"]);
    settled(fake);
  });

  it("a changed fileId on the config file refuses the whole mcp scope", () => {
    const fake = standardTree().driftAfterRead(".claude.json", { fileId: 5n });
    const { deps } = world();
    const result = run({ scope: "mcp", dryRun: true }, deps, { fs: winFs(fake) });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "Could not read Claude Code files." });
    settled(fake);
  });

  it("a short read is continued; a premature zero read refuses the file", () => {
    const short = standardTree();
    short.shortRead = 7;
    expect((dryBoth(short).body as Dry).skills.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
    settled(short);
    const zero = standardTree().prematureZeroRead("notes-Beta.md");
    const body = dryBoth(zero).body as Dry;
    expect(body.skills.map((s) => s.name)).toEqual(["Alpha"]);
    expect(body.skipped).toEqual(["Beta"]);
    settled(zero);
  });

  it("reads in steps of at most 1 MiB", () => {
    const fake = standardTree();
    // 1.5 MiB of ignored padding in .claude.json (under its 2 MiB cap) takes at least two native reads
    fake.put(".claude.json", JSON.stringify({ pad: "a".repeat(1_500_000), mcpServers: { plain: { command: "uvx", args: ["reviewed-tool"] } } }));
    expect(readClaudeCodeServers(home, [], winFs(fake)).servers.map((s) => s.name)).toEqual(["plain"]);
    expect(fake.callsOf("anchorRead").length).toBeGreaterThanOrEqual(2);
    settled(fake);
  });

  it("a truncated listing of the skills folder emits the one marker and still imports what was listed", () => {
    const fake = standardTree().truncateListOf("Alpha");
    const body = dryBoth(fake).body as Dry;
    expect(body.skipped.filter((n) => n === "(could not read)")).toHaveLength(1);
    expect(body.skills.length).toBeGreaterThan(0);
    settled(fake);
  });

  it("a clock jump after the session starts stops the walk with the plain refusal and still ends the session", () => {
    const fake = standardTree();
    let jumped = false;
    fake.onOpen = () => { jumped = true; };
    let t = 1_000;
    const now = () => (jumped ? (t += 60_000) : t);
    const { deps } = world();
    const result = run({ scope: "both", dryRun: true }, deps, { fs: winFs(fake), now });
    expect(jumped).toBe(true);
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: "Could not read Claude Code files." });
    settled(fake);
  });

  it("no refused name appears in any output or log spy", () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    const fake = standardTree().failName("Alpha", "ELOOP").failName("notes-Beta.md", "EACCES");
    const dry = dryBoth(fake);
    const text = JSON.stringify(dry.body);
    for (const secret of ["Alpha", "notes-Beta", "ELOOP", "EACCES"]) expect(text).not.toContain(secret);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Alpha|notes-Beta|ELOOP|EACCES/);
    settled(fake);
  });

  it("the standalone readers end their own session, and a constructor failure after anchorBegin still ends it", () => {
    const skills = standardTree();
    const read = readClaudeCodeSkills(home, winFs(skills));
    expect(read.skills.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
    settled(skills);
    expect(skills.ends).toBe(1);
    const servers = standardTree();
    expect(readClaudeCodeServers(home, [], winFs(servers)).servers.map((s) => s.name)).toEqual(["plain"]);
    expect(servers.ends).toBe(1);
    settled(servers);
    const late = standardTree();
    let calls = 0;
    const clock = () => (++calls > 2 ? 10_000_000 : 1_000);
    expect(() => readClaudeCodeSkills(home, winFs(late), clock)).toThrow();
    expect(late.begins === 0 || late.ends === 1).toBe(true);
    expect(late.openCount()).toBe(0);
  });

  it("a request that throws after the walk began still shows zero open handles and one anchorEnd", () => {
    const fake = standardTree().failOn("anchorList", 2, "EIO");
    const dry = dryBoth(fake);
    expect([200, 422]).toContain(dry.status);
    settled(fake);
  });

  it("holds each directory once for the request and never opens more than 4,096 entries", () => {
    const fake = standardTree();
    dryBoth(fake);
    expect(fake.opened.filter((n) => n === ".claude")).toHaveLength(1);
    expect(fake.opened.filter((n) => n === "skills")).toHaveLength(1);
    const many = new AnchoredWinFake();
    for (let i = 0; i < 4_200; i++) many.mkdir(`.claude/skills/S${i}`);
    const { deps } = world();
    expect(run({ scope: "skills", dryRun: true }, deps, { fs: winFs(many) }).status).toBeGreaterThanOrEqual(200);
    expect(many.opened.length).toBeLessThanOrEqual(4_096 + 8);
    settled(many);
  });

  it("only the parts the importer is allowed to name reach the helper", () => {
    const fake = standardTree();
    fake.put(".claude/skills/Alpha/odd:name.md", "x");
    dryBoth(fake);
    for (const name of fake.opened) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$|^\.claude(\.json)?$/);
  });
});

// CONTRACTS-B 1.5 integration: the settle observation through the fake addon (real clock for the quick cases, an injected clock for the long one).
describe("windows settle observation (fake native helper)", () => {
  const winFs = (fake: AnchoredWinFake) => ({ ...realImportFs, platform: () => "win32", winAnchor: () => fake.anchor }) as unknown as ImportFs;
  const dry = (fake: AnchoredWinFake, over: Partial<Parameters<typeof handleClaudeCodeImport>[0]> = {}) => {
    const { deps } = world();
    return run({ scope: "both", dryRun: true }, deps, { fs: winFs(fake), ...over });
  };
  afterEach(() => { setSettleClockForTest(null); });

  it("a script [false, false, true] gives answer.settled === true after three polls", async () => {
    const fake = standardTree();
    fake.endScript = [false, false, true];
    const answer = dry(fake);
    expect(answer.status).toBe(200);
    expect(fake.ends).toBe(1);                       // the end was posted synchronously, before anything awaited
    expect(await answer.settled).toBe(true);
    expect(fake.ends).toBe(3);
    expect(fake.openCount()).toBe(0);
  });

  it("a throwing anchorEnd gives settled === false and never rejects", async () => {
    const fake = standardTree();
    fake.endScript = ["throw"];
    const answer = dry(fake);
    await expect(answer.settled).resolves.toBe(false);
    expect(fake.ends).toBe(1);
  });

  it("an end that is never true gives settled === false at fake time 2000 after exactly 47 anchorEnd calls", async () => {
    const fake = standardTree();
    fake.endScript = [false];
    let t = 0;
    setSettleClockForTest({ now: () => t, sleep: async (ms) => { t += ms; } });
    const answer = dry(fake);
    expect(await answer.settled).toBe(false);
    expect(t).toBe(2000);
    expect(fake.ends).toBe(47);
  });

  it("an early error after the reader exists yields one shared settled: one loop, one anchorEnd, a true result", async () => {
    const fake = standardTree();
    const now = () => (fake.begins > 0 ? 10_000_000_000 : 1_000);   // the budget check right after the reader is created fails
    const answer = dry(fake, { now });
    expect(answer.status).toBe(422);
    expect(answer.settled).toBeDefined();
    expect(await answer.settled).toBe(true);
    expect(fake.begins).toBe(1);
    expect(fake.ends).toBe(1);                       // the early-error call and the final call shared ONE promise
  });

  // Astra r1 fix 6: the SAME promise, not merely one native call. The early reader's end() promise is captured and the response must carry it.
  it("the response's settled is the very promise the early reader's end() returned, and stays pending while the settlement is pending", async () => {
    const fake = standardTree();
    fake.endScript = [false, false, true];
    const original = AnchoredImport.prototype.end;
    const spy = vi.spyOn(AnchoredImport.prototype, "end").mockImplementation(function (this: AnchoredImport) { return original.call(this); });
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let t = 0;
    setSettleClockForTest({ now: () => t, sleep: async (ms) => { await gate; t += ms; } });   // every wait between polls is held until released
    try {
      const now = () => (fake.begins > 0 ? 10_000_000_000 : 1_000);
      const answer = dry(fake, { now });
      expect(answer.status).toBe(422);
      expect(spy).toHaveBeenCalled();
      const captured = spy.mock.results[0]!.value as Promise<boolean>;
      expect(answer.settled).toBe(captured);          // identity, not equality of outcomes
      expect(await Promise.race([answer.settled!, Promise.resolve("pending")])).toBe("pending");   // the final result cannot resolve ahead of it
      expect(fake.ends).toBe(1);
      open();
      expect(await answer.settled).toBe(true);
      expect(fake.ends).toBe(3);
    } finally {
      open();
      spy.mockRestore();
    }
  });

  it("a refusal before the budget exists has no settled", () => {
    const fake = standardTree();
    const answer = handleClaudeCodeImport({ body: { scope: "nope" }, enabled: true, home, deps: world().deps, ownerToken: "desktop-session-a", fs: winFs(fake) });
    expect(answer.status).toBe(400);
    expect(answer.settled).toBeUndefined();
    expect(fake.begins).toBe(0);
  });

  // Astra r1 fix 7: behaviour, not text. runLockedImport is the route's whole lock/run/release/wait/respond sequence (server/index.ts passes
  // the mcpConfigBusy setter, handleClaudeCodeImport and json). An injected deferred `settled` is held pending, then resolved either way.
  describe("the import route sequence (runLockedImport) with an injected deferred settled", () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    it.each([true, false])("while settled is pending the lock is clear and nothing is written; after it resolves %s the response goes out", async (outcome) => {
      let busy = false;
      const trace: string[] = [];
      const responses: Array<[number, unknown]> = [];
      let resolveSettled: (value: boolean) => void = () => {};
      const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
      const done = runLockedImport({
        setBusy: (value) => { busy = value; trace.push(`busy=${value}`); },
        run: async () => { await tick(); expect(busy).toBe(true); return { status: 200, body: { ok: 1 }, settled }; },
        respond: (status, body) => { responses.push([status, body]); trace.push("respond"); return "sent"; },
      });
      expect(busy).toBe(true);                         // the lock is taken synchronously, before anything awaited
      await tick(); await tick();
      expect(busy).toBe(false);                        // released as soon as the import returned, while settled is still pending
      expect(responses).toEqual([]);                   // and no response yet
      resolveSettled(outcome);
      expect(await done).toBe("sent");
      expect(responses).toEqual([[200, { ok: 1 }]]);
      expect(trace).toEqual(["busy=true", "busy=false", "respond"]);
    });
    it("an answer without settled responds at once, and a throwing import still releases the lock", async () => {
      let busy = false;
      const responses: number[] = [];
      await runLockedImport({ setBusy: (value) => { busy = value; }, run: () => ({ status: 400, body: {} }), respond: (status) => { responses.push(status); } });
      expect(busy).toBe(false);
      expect(responses).toEqual([400]);
      await expect(runLockedImport({ setBusy: (value) => { busy = value; }, run: () => { throw new Error("boom"); }, respond: () => { responses.push(0); } })).rejects.toThrow("boom");
      expect(busy).toBe(false);
      expect(responses).toEqual([400]);
    });
  });
  it("server/index.ts hands the route sequence the mcpConfigBusy lock and the response writer", () => {
    const source = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
    const call = source.indexOf("return await runLockedImport({");
    expect(call, "awaited inside the route try, so a rejection reaches its catch (Astra r4)").toBeGreaterThan(0);
    const head = source.slice(call, call + 400);
    expect(head).toContain("mcpConfigBusy = busy");
    expect(head).toContain("json(res, status, body)");
  });
});

describe("config key", () => {
  it("is validated by the schema and defaults off", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
    expect(loadConfig().claudeCodeImport).toBeUndefined();
    saveConfig({ claudeCodeImport: { enabled: true, lastImportedAt: 7, skills: 2, servers: 1, needsKey: 1 } });
    expect(loadConfig().claudeCodeImport).toEqual({ enabled: true, lastImportedAt: 7, skills: 2, servers: 1, needsKey: 1 });
    expect(() => parseConfigPatch({ claudeCodeImport: { enabled: "yes" } })).toThrow();
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
});
