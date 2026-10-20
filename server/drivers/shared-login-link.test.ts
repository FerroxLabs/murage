// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a bot's scope shares the owner's login when a symlink is not allowed (Windows without the privilege): ONE file under two
// names (a hardlink) for an engine that writes its login in place, a rejected turn for an engine that renames over it, and
// never a copy, a reconciliation, or a choice between two login files. Tested with a fake file system (the decision table) and
// then through the real scope builder with the symlink refused.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import { scopeGrokHome } from "./acp/grok-scope.ts";
import { scopeDroidHome } from "./acp/droid.ts";
import { isolateGeminiFromPersonalSetup } from "./acp/gemini-isolation.ts";
import { scopedCodexHome } from "./codex-isolation.ts";
import { readCodexAppServerModelCatalog } from "./codex-catalog.ts";
import { resetIsolationCache } from "./isolation-cache.ts";
import * as scopedHome from "./scoped-cli-home.ts";
import { resetScopeBookkeeping, ScopeUnavailableError, scopeLocalFailureOf, setLinkIo } from "./scoped-cli-home.ts";
import * as linkModule from "./shared-login-link.ts";
import { LoginLinkUnavailableError, linkSharedEntry, nodeLinkIo, sharesFile, type LinkIo, type LinkStat } from "./shared-login-link.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

/** An in-memory file system with inodes, symlinks and the failures a Windows account without symlink rights meets. */
class FakeFs implements LinkIo {
  names = new Map<string, number>();
  links = new Map<string, string>();
  inodes = new Map<number, { bytes: Buffer }>();
  next = 1;
  symlinkError: string | null = null;
  crossVolume = false;
  put(path: string, text: string): void {
    const id = this.next++;
    this.inodes.set(id, { bytes: Buffer.from(text) });
    this.names.set(path, id);
  }
  text(path: string): string { return this.inodes.get(this.names.get(path)!)!.bytes.toString(); }
  ino(path: string): number | undefined { return this.names.get(path); }
  private stat(path: string, follow: boolean): LinkStat {
    const target = this.links.get(path);
    if (target !== undefined && follow) return this.stat(target, true);
    if (target !== undefined) return { isFile: () => false, isSymbolicLink: () => true, ino: 0, dev: 1 };
    const id = this.names.get(path);
    if (id === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return { isFile: () => true, isSymbolicLink: () => false, ino: id, dev: path.startsWith("/owner") ? 1 : this.crossVolume ? 2 : 1 };
  }
  symlinkSync(target: string, path: string): void {
    if (this.symlinkError) throw Object.assign(new Error("symlink refused"), { code: this.symlinkError });
    if (this.names.has(path) || this.links.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.links.set(path, target);
  }
  linkSync(existing: string, path: string): void {
    if (this.crossVolume) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    const id = this.names.get(existing);
    if (id === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (this.names.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.names.set(path, id);
  }
  lstatSync(path: string): LinkStat { return this.stat(path, false); }
  statSync(path: string): LinkStat { return this.stat(path, true); }
  readFileSync(path: string): Buffer { return Buffer.from(this.inodes.get(this.names.get(path)!)!.bytes); }
  writeFileSync(path: string, data: Buffer): void { this.put(path, data.toString()); }
  renameSync(from: string, to: string): void {
    const id = this.names.get(from);
    if (id === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    this.names.delete(from);
    this.names.set(to, id);
  }
  unlinkSync(path: string): void { this.names.delete(path); this.links.delete(path); }
  mkdirSync(): void { /* folders are implied */ }
}

const REAL = "/owner/auth.json";
const SCOPED = "/scope/auth.json";

describe("linkSharedEntry", () => {
  it("is a symlink where one is allowed", () => {
    const fs = new FakeFs();
    fs.put(REAL, "LOGIN");
    expect(linkSharedEntry(REAL, SCOPED, fs)).toBe("symlink");
    expect(fs.links.get(SCOPED)).toBe(REAL);
  });

  it("is a HARDLINK when the symlink is refused, the engine writes its login in place and both are on one volume", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    fs.put(REAL, "LOGIN");
    expect(linkSharedEntry(REAL, SCOPED, fs, { hardlinkOk: true })).toBe("hardlink");
    expect(fs.ino(SCOPED)).toBe(fs.ino(REAL));
  });

  it("an engine that renames over its login (the default) is REJECTED where the symlink is refused: no hardlink, no copy", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    fs.put(REAL, "LOGIN");
    expect(() => linkSharedEntry(REAL, SCOPED, fs)).toThrow(LoginLinkUnavailableError);
    expect(fs.names.has(SCOPED)).toBe(false);
    expect(fs.names.size).toBe(1);
  });

  it("is REJECTED, never a copy, when the volumes differ", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    fs.crossVolume = true;
    fs.put(REAL, "LOGIN");
    expect(() => linkSharedEntry(REAL, SCOPED, fs, { hardlinkOk: true })).toThrow(/hardlink/);
    expect(fs.names.has(SCOPED)).toBe(false);
  });

  it("links nothing for a login that does not exist yet, and never invents one in the owner's folder", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    expect(linkSharedEntry(REAL, SCOPED, fs, { hardlinkOk: true })).toBe("absent");
    expect(fs.names.size).toBe(0);
  });

  it("a lock file is only ever opened, so it is hardlinked for any engine, and left unshared (not copied) when it cannot be", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    fs.put("/owner/auth.json.lock", "");
    expect(linkSharedEntry("/owner/auth.json.lock", "/scope/auth.json.lock", fs, { lock: true })).toBe("hardlink");
    expect(fs.ino("/scope/auth.json.lock")).toBe(fs.ino("/owner/auth.json.lock"));
    fs.crossVolume = true;
    expect(linkSharedEntry("/owner/auth.json.lock", "/other/auth.json.lock", fs, { lock: true })).toBe("absent");
    expect(fs.names.has("/other/auth.json.lock")).toBe(false);
  });

  it("rethrows a failure that is not a missing privilege (a full disk is not a reason to fall back)", () => {
    const fs = new FakeFs();
    fs.symlinkError = "ENOSPC";
    fs.put(REAL, "LOGIN");
    expect(() => linkSharedEntry(REAL, SCOPED, fs, { hardlinkOk: true })).toThrow(/symlink refused/);
  });
});

describe("sharesFile", () => {
  it("is true for one file under two names and for a symlink", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    fs.put(REAL, "L");
    linkSharedEntry(REAL, SCOPED, fs, { hardlinkOk: true });
    expect(sharesFile(REAL, SCOPED, fs)).toBe(true);
    const linked = new FakeFs();
    linked.put(REAL, "L");
    linked.symlinkSync(REAL, SCOPED);
    expect(sharesFile(REAL, SCOPED, linked)).toBe(true);
  });

  it("is false when either name was replaced by another file, whichever is newer: nothing decides between them", () => {
    const fs = new FakeFs();
    fs.symlinkError = "EPERM";
    fs.put(REAL, "OLD");
    linkSharedEntry(REAL, SCOPED, fs, { hardlinkOk: true });
    fs.put("/scope/tmp", "REFRESHED");
    fs.renameSync("/scope/tmp", SCOPED); // a rename replaces the scope's name only
    expect(sharesFile(REAL, SCOPED, fs)).toBe(false);
    expect(fs.text(REAL)).toBe("OLD");
    expect(fs.text(SCOPED)).toBe("REFRESHED");
    const other = new FakeFs();
    other.symlinkError = "EPERM";
    other.put(REAL, "OLD");
    linkSharedEntry(REAL, SCOPED, other, { hardlinkOk: true });
    other.put("/owner/tmp", "OWNER-NEW");
    other.renameSync("/owner/tmp", REAL); // the owner's own sign-in
    expect(sharesFile(REAL, SCOPED, other)).toBe(false);
  });

  it("is false when one name is missing, true when both are", () => {
    const fs = new FakeFs();
    fs.put(REAL, "L");
    expect(sharesFile(REAL, SCOPED, fs)).toBe(false);
    expect(sharesFile("/owner/none", "/scope/none", fs)).toBe(true);
  });
});

describe("no reconciliation exists", () => {
  it("the module exports no reconcile, set-aside or copy path, and the scope module has no after-turn reconcile", () => {
    expect(Object.keys(linkModule).sort()).toEqual(["LoginLinkUnavailableError", "linkSharedEntry", "nodeLinkIo", "sharesFile"]);
    expect("afterScopeTurn" in scopedHome).toBe(false);
    expect("reconcileScopeLogins" in scopedHome).toBe(false);
  });
});

describe("a scope built where the symlink is refused (Windows without the privilege), on the real file system", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const refuseSymlinks: LinkIo = { ...nodeLinkIo, symlinkSync: () => { throw Object.assign(new Error("A required privilege is not held by the client"), { code: "EPERM" }); } };
  beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); resetIsolationCache(); setLinkIo(refuseSymlinks); });
  afterEach(() => { setLinkIo(null); for (const d of dirs.splice(0)) removeTempDirSync(d); });
  const thrown = (run: () => unknown): ScopeUnavailableError => {
    try { run(); } catch (error) { return error as ScopeUnavailableError; }
    throw new Error("expected a ScopeUnavailableError");
  };

  it("Codex: never the real CODEX_HOME; auth.json is a hardlink and a refresh written in place by either name is the one file", () => {
    const codex = tmp("iso10-codex-");
    writeFileSync(join(codex, "auth.json"), "LOGIN-1");
    writeFileSync(join(codex, "AGENTS.md"), "PERSONAL");
    const env = { HOME: codex, CODEX_HOME: codex };
    const scope = scopedCodexHome(env, "codex-cli 0.150.0", "bot-win")!;
    expect(scope).not.toBe(codex);
    expect(existsSync(join(scope, "AGENTS.md"))).toBe(false);
    expect(lstatSync(join(scope, "auth.json")).isSymbolicLink()).toBe(false);
    expect(statSync(join(scope, "auth.json")).ino).toBe(statSync(join(codex, "auth.json")).ino);
    // Codex FileAuthStorage::save: open, truncate, write the same inode. Both names see it, nothing to reconcile.
    writeFileSync(join(scope, "auth.json"), "LOGIN-2");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("LOGIN-2");
    writeFileSync(join(codex, "auth.json"), "LOGIN-3"); // the owner's own refresh
    expect(readFileSync(join(scope, "auth.json"), "utf8")).toBe("LOGIN-3");
    // each turn start re-checks that it is still one file, and the next turn builds on the same scope
    expect(scopedCodexHome(env, "codex-cli 0.150.0", "bot-win")).toBe(scope);
    expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toBe("PERSONAL");
    // nothing was set aside and no copy exists: no quarantine folder of logins
    expect(existsSync(join(dirname(scope), scopedHome.SCOPE_QUARANTINE, "logins"))).toBe(false);
  });

  const CODEX = "codex-cli 0.150.0";
  const replaceOwner = (dir: string, text: string) => { writeFileSync(join(dir, "auth.json.new"), text); renameSync(join(dir, "auth.json.new"), join(dir, "auth.json")); };
  const rootOf = (home: string): string => (/^login-g\d+$/.test(basename(home)) ? dirname(home) : home);
  const gens = (home: string): string[] => readdirSync(rootOf(home)).filter((n) => /^login-g\d+$/.test(n)).sort();
  const retained = (home: string): string[] => {
    const dir = join(dirname(rootOf(home)), scopedHome.SCOPE_QUARANTINE, "logins");
    try { return readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).sort(); } catch { return []; }
  };

  it("the owner replaces their login: the NEXT launch is on a new generation linked to the owner's file, the old generation is left exactly as it was, and the bot's state follows", () => {
    const codex = tmp("iso12-rec-");
    writeFileSync(join(codex, "auth.json"), "LOGIN-1");
    writeFileSync(join(codex, "config.toml"), 'model = "x"');
    const env = { HOME: codex, CODEX_HOME: codex };
    const events: unknown[] = [];
    scopedHome.setLoginSplitHook((event) => events.push(event));
    try {
      const first = scopedCodexHome(env, CODEX, "bot-rec")!;
      mkdirSync(join(first, "sessions"), { recursive: true });
      writeFileSync(join(first, "sessions", "thread-1.jsonl"), "HISTORY");
      replaceOwner(codex, "OWNER-NEW");
      const second = scopedCodexHome(env, CODEX, "bot-rec")!; // not rejected: a fresh generation
      expect(second).not.toBe(first);
      expect(second).toBe(join(first, "login-g1"));
      expect(events).toEqual([{ kind: "codex", botId: "bot-rec" }]); // idle engines on the old path are drained
      // the new generation is the owner's current file, the old one was not touched
      expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("OWNER-NEW");
      expect(statSync(join(second, "auth.json")).ino).toBe(statSync(join(codex, "auth.json")).ino);
      expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("LOGIN-1");
      // the bot's own state is one state whichever generation runs
      expect(readFileSync(join(second, "sessions", "thread-1.jsonl"), "utf8")).toBe("HISTORY");
      writeFileSync(join(second, "sessions", "thread-2.jsonl"), "NEW");
      expect(readFileSync(join(first, "sessions", "thread-2.jsonl"), "utf8")).toBe("NEW");
      expect(readFileSync(join(second, "config.toml"), "utf8")).toBe('model = "x"');
      // it stays on the new generation, with no more events
      expect(scopedCodexHome(env, CODEX, "bot-rec")).toBe(second);
      expect(events.length).toBe(1);
      // an environment that still names the old path launches on the current generation
      expect(scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-rec")).toBe(second);
      expect(scopedCodexHome({ HOME: codex, CODEX_HOME: second }, CODEX, "bot-rec")).toBe(second);
    } finally { scopedHome.setLoginSplitHook(null); }
  });

  it("Developer Mode: when symlinks become available the new generation's login is a symlink", () => {
    const codex = tmp("iso12-dev-");
    writeFileSync(join(codex, "auth.json"), "LOGIN-1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-dev")!;
    replaceOwner(codex, "OWNER-NEW");
    setLinkIo(null); // symlinks work now
    const second = scopedCodexHome(env, CODEX, "bot-dev")!;
    expect(second).not.toBe(first);
    expect(lstatSync(join(second, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("OWNER-NEW");
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("LOGIN-1");
  });

  it("the owner signed out: rejected with the sign-in message and NO generation is made; signing in later makes one", () => {
    const codex = tmp("iso12-out-");
    writeFileSync(join(codex, "auth.json"), "LOGIN-1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-out")!;
    rmSync(join(codex, "auth.json"));
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-out")).code).toBe("login-link-lost");
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-out")).code).toBe("login-link-lost");
    expect(gens(first)).toEqual([]);
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("LOGIN-1");
    writeFileSync(join(codex, "auth.json"), "SIGNED-IN");
    const second = scopedCodexHome(env, CODEX, "bot-out")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("SIGNED-IN");
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("LOGIN-1");
  });

  it("T1/T2: a token the bot refreshed in place on the detached file is never deleted or moved, whatever the owner does next", () => {
    const codex = tmp("iso12-t2-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-t2")!;
    replaceOwner(codex, "T1"); // an owner tool replaces its file with another T1
    writeFileSync(join(first, "auth.json"), "T2"); // the running bot refreshes in place onto the detached file
    const second = scopedCodexHome(env, CODEX, "bot-t2")!;
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T1");
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("T2");
    replaceOwner(codex, "T3");
    const third = scopedCodexHome(env, CODEX, "bot-t2")!;
    expect([first, second, third].map((h) => basename(h))).toEqual([basename(first), "login-g1", "login-g2"]);
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("T2");
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("T1"); // the generation the owner's T1 replaced keeps its file too
    expect(readFileSync(join(third, "auth.json"), "utf8")).toBe("T3");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T3");
  });

  it("an old engine's delayed in-place write goes to its own generation and never reaches the owner's file, with no process tracking", () => {
    const codex = tmp("iso12-busy-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-busy")!; // an engine process was launched with this path and is still running
    replaceOwner(codex, "OWNER-T1B"); // an owner tool replaces its file
    const second = scopedCodexHome(env, CODEX, "bot-busy")!; // the very next launch is already on a new generation
    replaceOwner(codex, "T3"); // the owner signs in again
    const third = scopedCodexHome(env, CODEX, "bot-busy")!;
    writeFileSync(join(first, "auth.json"), "T2-LATE"); // the old process's delayed in-place refresh, by the path it was given
    writeFileSync(join(second, "auth.json.late"), "x");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T3");
    expect(readFileSync(join(third, "auth.json"), "utf8")).toBe("T3");
    expect(statSync(join(third, "auth.json")).ino).toBe(statSync(join(codex, "auth.json")).ino);
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("T2-LATE"); // kept where it was written
    expect("trackScopeProcess" in scopedHome).toBe(false);
    expect("scopeProcessesLive" in scopedHome).toBe(false);
  });

  it("Codex: the scope's own name replaced by rename is a split too: a new generation, the replaced file kept in the old one, the owner's file untouched", () => {
    const codex2 = tmp("iso12-codex-split2-");
    writeFileSync(join(codex2, "auth.json"), "OWNER-OLD");
    const env2 = { HOME: codex2, CODEX_HOME: codex2 };
    const scope2 = scopedCodexHome(env2, CODEX, "bot-split2")!;
    writeFileSync(join(scope2, "auth.json.tmp"), "NEWER-IN-SCOPE");
    renameSync(join(scope2, "auth.json.tmp"), join(scope2, "auth.json"));
    const next = scopedCodexHome(env2, CODEX, "bot-split2")!;
    expect(next).toBe(join(scope2, "login-g1"));
    expect(readFileSync(join(codex2, "auth.json"), "utf8")).toBe("OWNER-OLD");
    expect(readFileSync(join(scope2, "auth.json"), "utf8")).toBe("NEWER-IN-SCOPE");
    expect(readFileSync(join(next, "auth.json"), "utf8")).toBe("OWNER-OLD");
    expect(readdirSync(codex2).sort()).toEqual(["auth.json"]);
  });

  it("a deleted bot's scope retains the logins of every generation (the newest copies are kept aside), never losing a refreshed token", () => {
    const codex = tmp("iso12-retire-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-gone")!;
    replaceOwner(codex, "T1");
    writeFileSync(join(first, "auth.json"), "T2-OLD-GENERATION");
    const second = scopedCodexHome(env, CODEX, "bot-gone")!;
    writeFileSync(join(second, "auth.json"), "T3-IN-PLACE"); // hardlink: this is the owner's file too
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T3-IN-PLACE");
    const old = new Date(Date.now() - scopedHome.SCOPE_RETIRE_MAX_AGE_MS - 86_400_000);
    utimesSync(join(first, scopedHome.SCOPE_MARKER), old, old);
    scopedHome.setScopeRetentionHooks({ botExists: () => false });
    try {
      scopedHome.retireScopes("codex", join(scopedHome.scopedCliHomeRoot("codex"), "some-other-scope"), Date.now(), true);
    } finally { scopedHome.setScopeRetentionHooks({}); }
    expect(existsSync(first)).toBe(false);
    expect(retained(first)).toContain("T2-OLD-GENERATION");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T3-IN-PLACE");
  });

  it("an older generation unused for 30 days is retired: its login is retained first, its state is kept, and the current generation is untouched", () => {
    const codex = tmp("iso12-age-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-age")!;
    mkdirSync(join(first, "sessions"), { recursive: true });
    writeFileSync(join(first, "sessions", "chat.jsonl"), "HISTORY");
    replaceOwner(codex, "T1B");
    writeFileSync(join(first, "auth.json"), "T2-OLD");
    const second = scopedCodexHome(env, CODEX, "bot-age")!;
    const future = Date.now() + scopedHome.GENERATION_RETIRE_MAX_AGE_MS + 86_400_000;
    // within 30 days: nothing is retired
    scopedHome.noteScopeUse("codex", first, Date.now() + 3_600_000 * 2);
    expect(existsSync(join(first, "auth.json"))).toBe(true);
    scopedHome.noteScopeUse("codex", first, future);
    expect(existsSync(join(first, "auth.json"))).toBe(false);
    expect(retained(first)).toContain("T2-OLD");
    expect(readFileSync(join(first, "sessions", "chat.jsonl"), "utf8")).toBe("HISTORY"); // state is never deleted
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("T1B");
    expect(readFileSync(join(second, "sessions", "chat.jsonl"), "utf8")).toBe("HISTORY");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T1B");
  });

  it("Codex: the owner signing out (their auth.json removed) is a lost link, not a login that keeps working in the bot", () => {
    const codex = tmp("iso10-codex-logout-");
    writeFileSync(join(codex, "auth.json"), "LOGIN-1");
    const env = { HOME: codex, CODEX_HOME: codex };
    scopedCodexHome(env, "codex-cli 0.150.0", "bot-out");
    rmSync(join(codex, "auth.json"));
    const error = thrown(() => scopedCodexHome(env, "codex-cli 0.150.0", "bot-out"));
    expect(error.code).toBe("login-link-lost");
    expect(scopeLocalFailureOf(error)).toBe("engine-login-link-lost");
  });

  it("Gemini: the launch path is resolved at EVERY launch, so a split after the scope was first worked out still reaches the new generation", () => {
    const home = tmp("iso12-gem-");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "G1");
    const launch = () => { const env: Record<string, string | undefined> = { HOME: home }; isolateGeminiFromPersonalSetup(env, "bot-gem", true); return env.GEMINI_CLI_HOME!; };
    const first = launch();
    expect(launch()).toBe(first);
    writeFileSync(join(home, ".gemini", "oauth_creds.json.new"), "G2");
    renameSync(join(home, ".gemini", "oauth_creds.json.new"), join(home, ".gemini", "oauth_creds.json"));
    const second = launch();
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, ".gemini", "oauth_creds.json"), "utf8")).toBe("G2");
    expect(readFileSync(join(first, ".gemini", "oauth_creds.json"), "utf8")).toBe("G1");
    // the owner folder is found from either generation's path
    expect(scopedHome.scopeSourceOf(second)).toBe(join(home, ".gemini"));
  });

  it("Grok renames over auth.json, so without symlink rights the turn is rejected with the symlink guidance: no hardlink, no copy, nothing in the scope", () => {
    const home = tmp("iso10-grok-");
    const grok = join(home, ".grok");
    mkdirSync(grok, { recursive: true });
    writeFileSync(join(grok, "auth.json"), "GROK-LOGIN");
    writeFileSync(join(grok, "auth.json.lock"), "");
    const env: Record<string, string | undefined> = { HOME: home, USERPROFILE: home };
    const error = thrown(() => scopeGrokHome(env, "grok 1.0.50", "bot-win"));
    expect(error).toBeInstanceOf(ScopeUnavailableError);
    expect(error.code).toBe("symlink-required");
    expect(scopeLocalFailureOf(error)).toBe("engine-symlink-required");
    expect(env.GROK_HOME).toBeUndefined();
    expect(readFileSync(join(grok, "auth.json"), "utf8")).toBe("GROK-LOGIN");
    expect(readdirSync(grok).sort()).toEqual(["auth.json", "auth.json.lock"]);
  });

  it("Droid (atomically renames onto the path) is rejected the same way", () => {
    const home = tmp("iso10-droid-");
    mkdirSync(join(home, ".factory"), { recursive: true });
    writeFileSync(join(home, ".factory", "auth.v2.file"), "DROID-LOGIN");
    const env: Record<string, string | undefined> = { HOME: home };
    expect(thrown(() => scopeDroidHome(env, "droid 0.238.0", "bot-win")).code).toBe("symlink-required");
    expect(env.FACTORY_HOME_OVERRIDE).toBeUndefined();
  });

  it("when neither a symlink nor a hardlink can be made the turn setup throws (the turn is rejected, never run in the real home)", () => {
    const codex = tmp("iso10-codex-fail-");
    writeFileSync(join(codex, "auth.json"), "LOGIN");
    setLinkIo({ ...refuseSymlinks, linkSync: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } });
    expect(thrown(() => scopedCodexHome({ HOME: codex, CODEX_HOME: codex }, "codex-cli 0.150.0", "bot-nolink")).code).toBe("symlink-required");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("LOGIN");
  });
});

describe("r14: an established generation's login is never created, recreated or relinked; a missing or split one starts a new generation", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const refuseSymlinks: LinkIo = { ...nodeLinkIo, symlinkSync: () => { throw Object.assign(new Error("A required privilege is not held by the client"), { code: "EPERM" }); } };
  const CODEX = "codex-cli 0.150.0";
  const thrown = (run: () => unknown): ScopeUnavailableError => {
    try { run(); } catch (error) { return error as ScopeUnavailableError; }
    throw new Error("expected a ScopeUnavailableError");
  };
  const replaceOwner = (dir: string, text: string) => { writeFileSync(join(dir, "auth.json.new"), text); renameSync(join(dir, "auth.json.new"), join(dir, "auth.json")); };
  beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); resetIsolationCache(); setLinkIo(refuseSymlinks); });
  afterEach(() => { setLinkIo(null); vi.useRealTimers(); for (const d of dirs.splice(0)) removeTempDirSync(d); });

  it("P1: a missing generation-0 login is NOT rebuilt in place (an old process would overwrite the owner's); a new generation is linked to the owner's current login", () => {
    const codex = tmp("iso14-p1-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-p1")!;
    rmSync(join(first, "auth.json")); // the scope's name is gone while an engine process still holds the path
    replaceOwner(codex, "T3");
    const second = scopedCodexHome(env, CODEX, "bot-p1")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(existsSync(join(first, "auth.json"))).toBe(false); // never recreated in the established generation
    expect(statSync(join(second, "auth.json")).ino).toBe(statSync(join(codex, "auth.json")).ino);
    writeFileSync(join(first, "auth.json"), "T2"); // the old process writes by the path it was given
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("T3");
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("T3");
  });

  it("P1: a symlinked login that went missing in an established generation also starts a new generation; with the owner signed out the turn is rejected and nothing is recreated", () => {
    setLinkIo(null);
    const codex = tmp("iso14-p1s-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-p1s")!;
    rmSync(join(first, "auth.json"));
    rmSync(join(codex, "auth.json"));
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-p1s")).code).toBe("login-link-lost");
    expect(existsSync(join(first, "auth.json"))).toBe(false);
    expect(existsSync(join(first, "login-g1"))).toBe(false);
    writeFileSync(join(codex, "auth.json"), "T4");
    const second = scopedCodexHome(env, CODEX, "bot-p1s")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(lstatSync(join(second, "auth.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(first, "auth.json"))).toBe(false);
  });

  it("P2: an unreadable or empty marker rejects the turn (retryable), for the inherited path too: it never falls back to the old path", () => {
    const codex = tmp("iso14-p2-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-p2")!;
    const marker = join(first, scopedHome.SCOPE_MARKER);
    const good = readFileSync(marker, "utf8");
    for (const bad of ["", '{"contract":2,"realHome":']) {
      writeFileSync(marker, bad);
      const inherited = thrown(() => scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-p2"));
      expect(inherited.busy).toBe(true);
      expect(thrown(() => scopedCodexHome(env, CODEX, "bot-p2")).busy).toBe(true);
    }
    writeFileSync(marker, good);
    expect(scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-p2")).toBe(first);
    expect(readdirSync(first).filter((n) => n.includes(".tmp-"))).toEqual([]); // marker writes go through a temporary file renamed over it
  });

  it("P2: the catalog gives NO catalog on a scope error and never launches with the inherited path", async () => {
    const codex = tmp("iso14-cat-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-cat")!;
    const seen = join(codex, "..", `seen-${basename(codex)}.txt`);
    dirs.push(seen);
    const cli = join(tmp("iso14-cli-"), "fake-codex.sh");
    writeFileSync(cli, `#!/bin/sh\necho "$CODEX_HOME" > "${seen}"\n`);
    chmodSync(cli, 0o755);
    rmSync(join(codex, "auth.json")); // the owner signed out: the stale login in the scope must not be used
    const catalog = await readCodexAppServerModelCatalog(cli, { ...process.env, HOME: codex, CODEX_HOME: first }, 2_000);
    expect(catalog).toBeNull();
    expect(existsSync(seen)).toBe(false);
  });

  it("P2: generated config files follow the owner's source in the CURRENT generation: removal and recreation propagate (a hardlinked copy is replaced, not relied on)", () => {
    const codex = tmp("iso14-gen-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "old-provider"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-gen")!;
    replaceOwner(codex, "T2");
    const second = scopedCodexHome(env, CODEX, "bot-gen")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, "config.toml"), "utf8")).toContain("old-provider");
    rmSync(join(codex, "config.toml"));
    expect(scopedCodexHome(env, CODEX, "bot-gen")).toBe(second);
    expect(existsSync(join(second, "config.toml"))).toBe(false);
    writeFileSync(join(codex, "config.toml"), 'model = "new-provider"\n');
    expect(scopedCodexHome(env, CODEX, "bot-gen")).toBe(second);
    expect(readFileSync(join(second, "config.toml"), "utf8")).toContain("new-provider");
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toContain("new-provider");
    // and a later generation starts with the current copy of it, not a link to an older one
    replaceOwner(codex, "T3");
    const third = scopedCodexHome(env, CODEX, "bot-gen")!;
    expect(third).toBe(join(first, "login-g2"));
    expect(readFileSync(join(third, "config.toml"), "utf8")).toContain("new-provider");
    expect(lstatSync(join(third, "config.toml")).isSymbolicLink()).toBe(false);
  });

  it("P2: an old generation retires on ITS OWN last-launch age even though the active scope is touched every turn", () => {
    const codex = tmp("iso14-ret-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-ret")!;
    replaceOwner(codex, "T1B");
    writeFileSync(join(first, "auth.json"), "T2-OLD");
    const second = scopedCodexHome(env, CODEX, "bot-ret")!;
    expect(existsSync(join(first, "auth.json"))).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + scopedHome.GENERATION_RETIRE_MAX_AGE_MS + 86_400_000);
    for (let i = 0; i < 3; i++) expect(scopedCodexHome(env, CODEX, "bot-ret")).toBe(second); // every turn touches the scope
    expect(existsSync(join(first, "auth.json"))).toBe(false);
    const kept = join(dirname(first), scopedHome.SCOPE_QUARANTINE, "logins");
    expect(readdirSync(kept).map((n) => readFileSync(join(kept, n), "utf8"))).toContain("T2-OLD");
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("T1B");
  });
});

describe("r15: persistence failures block the launch; deletions are durable; inherited homes refresh; every login mode is verified", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const refuseSymlinks: LinkIo = { ...nodeLinkIo, symlinkSync: () => { throw Object.assign(new Error("A required privilege is not held by the client"), { code: "EPERM" }); } };
  const CODEX = "codex-cli 0.150.0";
  const thrown = (run: () => unknown): ScopeUnavailableError => {
    try { run(); } catch (error) { return error as ScopeUnavailableError; }
    throw new Error("expected a ScopeUnavailableError");
  };
  const replaceOwner = (dir: string, text: string) => { writeFileSync(join(dir, "auth.json.new"), text); renameSync(join(dir, "auth.json.new"), join(dir, "auth.json")); };
  const allText = (dir: string): string[] => readdirSync(dir).flatMap((n) => { try { return lstatSync(join(dir, n)).isDirectory() ? [] : [readFileSync(join(dir, n), "utf8")]; } catch { return []; } });
  beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); resetIsolationCache(); setLinkIo(refuseSymlinks); });
  afterEach(() => { setLinkIo(null); for (const d of dirs.splice(0)) removeTempDirSync(d); });

  it("P1: a marker that cannot be written blocks the launch with a retryable busy rejection (first build, and the generation pointer)", () => {
    const codex = tmp("iso15-p1-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const root = join(scopedHome.scopedCliHomeRoot("codex"), scopedHome.scopeId(codex, "bot-p1w"));
    mkdirSync(join(root, `${scopedHome.SCOPE_MARKER}.tmp-${process.pid}`), { recursive: true }); // the marker's temporary file cannot be created
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-p1w")).busy).toBe(true);
    expect(existsSync(join(root, scopedHome.SCOPE_MARKER))).toBe(false);
    removeTempDirSync(join(root, `${scopedHome.SCOPE_MARKER}.tmp-${process.pid}`));
    const first = scopedCodexHome(env, CODEX, "bot-p1w")!;
    // a split whose generation pointer cannot be saved is not launched on
    replaceOwner(codex, "T2");
    mkdirSync(join(first, `${scopedHome.SCOPE_MARKER}.tmp-${process.pid}`));
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-p1w")).busy).toBe(true);
    removeTempDirSync(join(first, `${scopedHome.SCOPE_MARKER}.tmp-${process.pid}`));
    expect(scopedCodexHome(env, CODEX, "bot-p1w")).toBe(join(first, "login-g1"));
  });

  it("P2: a generated copy the owner deleted stays deleted through every rotation (no OLD-PROVIDER anywhere in the current generation); recreating it clears the record", () => {
    const codex = tmp("iso15-del-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "OLD-PROVIDER"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-del")!;
    replaceOwner(codex, "T2");
    const second = scopedCodexHome(env, CODEX, "bot-del")!;
    expect(second).toBe(join(first, "login-g1"));
    rmSync(join(codex, "config.toml"));
    replaceOwner(codex, "T3");
    const third = scopedCodexHome(env, CODEX, "bot-del")!;
    expect(third).toBe(join(first, "login-g2"));
    replaceOwner(codex, "T4");
    const fourth = scopedCodexHome(env, CODEX, "bot-del")!;
    expect(fourth).toBe(join(first, "login-g3"));
    for (const dir of [third, fourth]) {
      expect(existsSync(join(dir, "config.toml"))).toBe(false);
      expect(allText(dir).join("\n")).not.toContain("OLD-PROVIDER");
    }
    expect(JSON.parse(readFileSync(join(first, scopedHome.SCOPE_MARKER), "utf8")).deletedGenerated).toEqual(["config.toml"]);
    writeFileSync(join(codex, "config.toml"), 'model = "NEW-PROVIDER"\n');
    expect(scopedCodexHome(env, CODEX, "bot-del")).toBe(fourth);
    expect(readFileSync(join(fourth, "config.toml"), "utf8")).toContain("NEW-PROVIDER");
    expect(JSON.parse(readFileSync(join(first, scopedHome.SCOPE_MARKER), "utf8")).deletedGenerated).toEqual([]);
  });

  it("P2: an owner config that stops parsing is recorded as removed too: a later rotation does not bring an older copy back", () => {
    const codex = tmp("iso15-bad-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "OLD-PROVIDER"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-bad")!;
    const marker = join(first, scopedHome.SCOPE_MARKER);
    // the copy is a plain file the owner's source feeds; make the source unreadable (a folder in its place)
    rmSync(join(codex, "config.toml"));
    mkdirSync(join(codex, "config.toml"));
    try { scopedCodexHome(env, CODEX, "bot-bad"); } catch { /* rejected or tolerated: either way the record below must hold */ }
    replaceOwner(codex, "T2");
    removeTempDirSync(join(codex, "config.toml"));
    const second = scopedCodexHome(env, CODEX, "bot-bad")!;
    expect(existsSync(join(second, "config.toml"))).toBe(false);
    expect(allText(second).join("\n")).not.toContain("OLD-PROVIDER");
    expect(JSON.parse(readFileSync(marker, "utf8")).deletedGenerated).toEqual(["config.toml"]);
  });

  it("P2: an inherited home (the path an earlier launch named) refreshes the generated copies before it resolves and rotates", () => {
    const codex = tmp("iso15-inh-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "OLD-PROVIDER"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-inh")!;
    replaceOwner(codex, "T2");
    writeFileSync(join(codex, "config.toml"), 'model = "NEW-PROVIDER"\n');
    const second = scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-inh")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, "config.toml"), "utf8")).toContain("NEW-PROVIDER");
    // and without a rotation the inherited path alone also follows the owner's change
    writeFileSync(join(codex, "config.toml"), 'model = "NEWER-PROVIDER"\n');
    expect(scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-inh")).toBe(second);
    expect(readFileSync(join(second, "config.toml"), "utf8")).toContain("NEWER-PROVIDER");
  });

  it("P2: a symlink that no longer leads to the owner's login is verified: with the owner signed out nothing launches (turn and catalog); with a login the scope moves to a new generation", async () => {
    setLinkIo(null);
    const codex = tmp("iso15-sym-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-sym")!;
    const stale = join(tmp("iso15-stale-"), "auth.json");
    writeFileSync(stale, "STALE");
    rmSync(join(first, "auth.json"));
    symlinkSync(stale, join(first, "auth.json")); // detached: still a symlink, to a login that is not the owner's
    rmSync(join(codex, "auth.json"));
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-sym")).code).toBe("login-link-lost");
    expect(thrown(() => scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-sym")).code).toBe("login-link-lost");
    const seen = join(tmp("iso15-seen-"), "seen.txt");
    const cli = join(tmp("iso15-cli-"), "fake-codex.sh");
    writeFileSync(cli, `#!/bin/sh\necho "$CODEX_HOME" > "${seen}"\n`);
    chmodSync(cli, 0o755);
    expect(await readCodexAppServerModelCatalog(cli, { ...process.env, HOME: codex, CODEX_HOME: first }, 2_000)).toBeNull();
    expect(existsSync(seen)).toBe(false);
    writeFileSync(join(codex, "auth.json"), "T2");
    const second = scopedCodexHome(env, CODEX, "bot-sym")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("T2");
    expect(readFileSync(stale, "utf8")).toBe("STALE");
  });

  it("P2: a login the engine wrote in the scope (absent mode) is checked once the owner has one: a split moves to a new generation, the scope's own login is kept", () => {
    const codex = tmp("iso15-abs-");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-abs")!; // owner not signed in: nothing linked
    expect(JSON.parse(readFileSync(join(first, scopedHome.SCOPE_MARKER), "utf8")).shareMode["auth.json"]).toBe("absent");
    writeFileSync(join(first, "auth.json"), "SCOPE-OWN"); // the bot signed in inside its scope
    expect(scopedCodexHome(env, CODEX, "bot-abs")).toBe(first); // the owner still has none: the scope's own login stands
    writeFileSync(join(codex, "auth.json"), "OWNER");
    const second = scopedCodexHome(env, CODEX, "bot-abs")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("OWNER");
    expect(readFileSync(join(first, "auth.json"), "utf8")).toBe("SCOPE-OWN");
  });
});

describe("r16: symlinks are verified in every mode; generated files come only from the owner's source or the committed generation; an inherited scope is refreshed or rejected", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const refuseSymlinks: LinkIo = { ...nodeLinkIo, symlinkSync: () => { throw Object.assign(new Error("A required privilege is not held by the client"), { code: "EPERM" }); } };
  const CODEX = "codex-cli 0.150.0";
  const thrown = (run: () => unknown): ScopeUnavailableError => {
    try { run(); } catch (error) { return error as ScopeUnavailableError; }
    throw new Error("expected a ScopeUnavailableError");
  };
  const replaceOwner = (dir: string, text: string) => { writeFileSync(join(dir, "auth.json.new"), text); renameSync(join(dir, "auth.json.new"), join(dir, "auth.json")); };
  beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); resetIsolationCache(); setLinkIo(refuseSymlinks); });
  afterEach(() => {
    setLinkIo(null);
    for (const d of dirs.splice(0)) removeTempDirSync(d);
  });

  it("P2: a detached symlink in a hardlink-mode scope is not trusted: owner signed out rejects (turn and catalog), owner present rotates", async () => {
    const codex = tmp("iso16-sym-");
    writeFileSync(join(codex, "auth.json"), "T1");
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-hsym")!;
    expect(JSON.parse(readFileSync(join(first, scopedHome.SCOPE_MARKER), "utf8")).shareMode["auth.json"]).toBe("hardlink");
    const stale = join(tmp("iso16-stale-"), "auth.json");
    writeFileSync(stale, "STALE");
    rmSync(join(first, "auth.json"));
    symlinkSync(stale, join(first, "auth.json")); // detached
    rmSync(join(codex, "auth.json"));
    expect(thrown(() => scopedCodexHome(env, CODEX, "bot-hsym")).code).toBe("login-link-lost");
    const seen = join(tmp("iso16-seen-"), "seen.txt");
    const cli = join(tmp("iso16-cli-"), "fake-codex.sh");
    writeFileSync(cli, `#!/bin/sh\necho "$CODEX_HOME" > "${seen}"\n`);
    chmodSync(cli, 0o755);
    expect(await readCodexAppServerModelCatalog(cli, { ...process.env, HOME: codex, CODEX_HOME: first }, 2_000)).toBeNull();
    expect(existsSync(seen)).toBe(false);
    writeFileSync(join(codex, "auth.json"), "T2");
    const second = scopedCodexHome(env, CODEX, "bot-hsym")!;
    expect(second).toBe(join(first, "login-g1"));
    expect(readFileSync(join(second, "auth.json"), "utf8")).toBe("T2");
  });

  it("P2: a generation left by a failed pointer write is never a source: the retry gets the owner's CURRENT config, and the orphan is cleaned", () => {
    const codex = tmp("iso16-orph-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "OLD-PROVIDER"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-orph")!;
    // the state a switch whose pointer write failed leaves: generation 1 on disk (OLD copy, a login of its own), the marker still at 0
    const orphan = join(first, "login-g1");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "config.toml"), 'model = "OLD-PROVIDER"\n');
    writeFileSync(join(orphan, "auth.json"), "ORPHAN-LOGIN");
    replaceOwner(codex, "T2");
    writeFileSync(join(codex, "config.toml"), 'model = "NEW-PROVIDER-2"\n');
    const second = scopedCodexHome(env, CODEX, "bot-orph")!;
    expect(readFileSync(join(second, "config.toml"), "utf8")).toContain("NEW-PROVIDER-2");
    expect(readFileSync(join(second, "config.toml"), "utf8")).not.toContain("OLD-PROVIDER");
    expect(second).toBe(join(first, "login-g1")); // the orphan was cleaned, its number reused
    const kept = join(dirname(first), scopedHome.SCOPE_QUARANTINE, "logins");
    expect(readdirSync(kept).map((n) => readFileSync(join(kept, n), "utf8"))).toContain("ORPHAN-LOGIN"); // its login is retained
  });

  // chmod 000 is what makes the copy unreadable; on Windows chmod only sets read-only, so the file stays readable there.
  it.skipIf(process.platform === "win32")("P2: a generated copy that cannot be made rejects the launch (retryable); an older generation's copy is never used instead", () => {
    const codex = tmp("iso16-copy-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "V1-PROVIDER"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-copy")!;
    writeFileSync(join(codex, "config.toml"), 'model = "V2-PROVIDER"\n');
    replaceOwner(codex, "T2");
    const second = scopedCodexHome(env, CODEX, "bot-copy")!;
    expect(second).toBe(join(first, "login-g1"));
    replaceOwner(codex, "T3"); // the next split
    chmodSync(join(second, "config.toml"), 0o000); // the committed copy cannot be read
    const error = thrown(() => scopedHome.verifyScopeLogins(first, "codex"));
    expect(error.busy).toBe(true);
    expect(existsSync(join(first, "login-g2"))).toBe(false);
    chmodSync(join(second, "config.toml"), 0o600);
  });

  it("P2: a fresh process launching an inherited scope refreshes the generated config from the owner like the builder; one it cannot rebuild is rejected (retryable)", () => {
    const codex = tmp("iso16-fresh-");
    writeFileSync(join(codex, "auth.json"), "T1");
    writeFileSync(join(codex, "config.toml"), 'model = "OLD-PROVIDER"\n');
    const env = { HOME: codex, CODEX_HOME: codex };
    const first = scopedCodexHome(env, CODEX, "bot-fresh")!;
    resetScopeBookkeeping(); // a different process: it never built this scope
    resetIsolationCache();
    writeFileSync(join(codex, "config.toml"), 'model = "NEW-PROVIDER-2"\n');
    const home = scopedCodexHome({ HOME: codex, CODEX_HOME: first }, CODEX, "bot-fresh")!;
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("NEW-PROVIDER-2");
    // a scope of a kind nothing can rebuild, with generated copies: rejected, not launched on a possibly stale copy
    setLinkIo(null);
    const owner = tmp("iso16-owner-");
    const unknown = scopedHome.scopedCliHome({ kind: "unknown-kind", realHome: owner, botId: "b", share: [], generated: () => ({ "c.toml": "x" }) });
    resetScopeBookkeeping();
    expect(thrown(() => scopedHome.currentScopeHome("unknown-kind", unknown)).busy).toBe(true);
  });
});
