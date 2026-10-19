// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolation-all round 3: retiring a bot's engine state root never loses a login, never deletes what it cannot
// place, keeps the roots of bots that still exist, and bounds a bot's disk use by pruning only its own cache.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import { isolateGeminiFromPersonalSetup } from "./acp/gemini-isolation.ts";
import {
  QUARANTINE_MAX_AGE_MS, SCOPE_MARKER, SCOPE_QUARANTINE, SCOPE_RETIRE_MAX_AGE_MS, SESSION_CONTRACT, enforceQuarantineBounds, pruneScopeCache, quarantineBytes, resetScopeBookkeeping, retireScopes,
  awaitScopeStart, migrateAsideLogins, scopedCliHome, scopeLockPath, scopedCliHomeRoot, setLeaseWaitMs, setScopeRetentionHooks,
} from "./scoped-cli-home.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

function ownerHome(login: string | null): string {
  const home = tmp("murage-scope-r3-");
  const g = join(home, ".gemini");
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  if (login !== null) writeFileSync(join(g, "oauth_creds.json"), login);
  return home;
}
const botScope = (home: string, bot: string): string => {
  const env: Record<string, string | undefined> = { HOME: home };
  isolateGeminiFromPersonalSetup(env, bot);
  return env.GEMINI_CLI_HOME!;
};
const quarantine = () => join(scopedCliHomeRoot("gemini"), SCOPE_QUARANTINE);

beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); setScopeRetentionHooks({ botExists: () => false }); });
afterEach(() => {
  setScopeRetentionHooks({});
  for (const d of dirs.splice(0)) removeTempDirSync(d);
});

/** A scope as the earlier content-addressed Gemini build left it: `.gemini/.murage-scope`, no root marker. */
function legacyGeminiScope(name: string, files: Record<string, string>): string {
  const root = join(scopedCliHomeRoot("gemini"), name);
  mkdirSync(join(root, ".gemini"), { recursive: true });
  writeFileSync(join(root, ".gemini", ".murage-scope"), "");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, ".gemini", file), text);
  const old = ago(SCOPE_RETIRE_MAX_AGE_MS + DAY);
  utimesSync(root, old, old);
  return root;
}

describe("scoped engine home retirement", () => {
  it("stamps the session contract on every root it builds", () => {
    const scope = botScope(ownerHome("LOGIN"), "bot-contract");
    const marker = JSON.parse(readFileSync(join(scope, SCOPE_MARKER), "utf8"));
    expect(marker.contract).toBe(SESSION_CONTRACT);
    expect(marker.owner.pid).toBe(process.pid);
  });

  it("adopts an earlier Gemini scope's only login into the owner folder on first use, before anything can retire it", () => {
    const home = ownerHome(null);
    const legacy = legacyGeminiScope("0123456789abcdef", { "oauth_creds.json": "ONLY-REFRESHED-LOGIN" });
    botScope(home, "bot-a"); // first scope use of this process
    expect(readFileSync(join(home, ".gemini", "oauth_creds.json"), "utf8")).toBe("ONLY-REFRESHED-LOGIN");
    // the scope is now spent (old sessions are never copied): its retirement is fine, its login is already placed
    expect(existsSync(legacy) ? readFileSync(join(legacy, ".gemini", "oauth_creds.json"), "utf8") : "ONLY-REFRESHED-LOGIN").toBe("ONLY-REFRESHED-LOGIN");
  });

  it("does not retire an earlier Gemini scope while no owner folder is known to adopt its login into", () => {
    const legacy = legacyGeminiScope("0011223344556677", { "oauth_creds.json": "WAITING-LOGIN" });
    expect(retireScopes("gemini", join(scopedCliHomeRoot("gemini"), "somewhere-else"), Date.now(), true)).toEqual([]);
    expect(readFileSync(join(legacy, ".gemini", "oauth_creds.json"), "utf8")).toBe("WAITING-LOGIN");
  });

  it("retires an earlier Gemini scope only after its login was placed, and never replaces the owner's different login", () => {
    const home = ownerHome("OWNER-NEWER");
    const legacy = legacyGeminiScope("fedcba9876543210", { "oauth_creds.json": "OLDER-SCOPED-TOKEN" });
    const keep = botScope(home, "bot-a");
    retireScopes("gemini", keep, Date.now(), true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(home, ".gemini", "oauth_creds.json"), "utf8")).toBe("OWNER-NEWER");
    const aside = join(quarantine(), "logins");
    const kept = readdirSync(aside).map((name) => readFileSync(join(aside, name), "utf8"));
    expect(kept).toContain("OLDER-SCOPED-TOKEN"); // both are kept, nothing is lost
  });

  it("an owner login that lands first is never overwritten by an adopting retirement", () => {
    const home = ownerHome(null);
    const stale = botScope(home, "gone-bot");
    const login = join(stale, ".gemini", "oauth_creds.json");
    rmSync(login);
    writeFileSync(login, "STRANDED");
    // the owner signs in between the scope's last use and its retirement
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "OWNER-SIGNED-IN");
    const old = ago(SCOPE_RETIRE_MAX_AGE_MS + DAY);
    utimesSync(join(stale, SCOPE_MARKER), old, old);
    retireScopes("gemini", botScope(home, "live-bot"), Date.now(), true);
    expect(readFileSync(join(home, ".gemini", "oauth_creds.json"), "utf8")).toBe("OWNER-SIGNED-IN");
    expect(existsSync(stale)).toBe(false);
    const aside = join(quarantine(), "logins");
    expect(readdirSync(aside).map((name) => readFileSync(join(aside, name), "utf8"))).toContain("STRANDED");
  });

  it("a deleted bot's scope keeps its set-aside login copies: they move to the retained logins, never deleted", () => {
    const home = ownerHome("L");
    const stale = botScope(home, "gone-bot");
    mkdirSync(join(stale, ".login-aside"), { recursive: true });
    writeFileSync(join(stale, ".login-aside", "000000001700000-1234-oauth_creds.json"), "ASIDE-T2");
    const old = ago(SCOPE_RETIRE_MAX_AGE_MS + DAY);
    utimesSync(join(stale, SCOPE_MARKER), old, old);
    retireScopes("gemini", botScope(home, "live-bot"), Date.now(), true);
    expect(existsSync(stale)).toBe(false);
    const aside = join(quarantine(), "logins");
    expect(readdirSync(aside).map((name) => readFileSync(join(aside, name), "utf8"))).toContain("ASIDE-T2");
  });

  it("quarantines a scope it cannot place instead of deleting it", () => {
    const home = ownerHome("L");
    const keep = botScope(home, "bot-a");
    const stray = join(scopedCliHomeRoot("gemini"), "stray-unknown");
    mkdirSync(join(stray, "sessions"), { recursive: true });
    writeFileSync(join(stray, "sessions", "chat.json"), "HISTORY");
    const old = ago(2 * DAY);
    utimesSync(stray, old, old);
    retireScopes("gemini", keep, Date.now(), true);
    expect(existsSync(stray)).toBe(false);
    const moved = readdirSync(quarantine()).find((name) => name.startsWith("stray-unknown"))!;
    expect(readFileSync(join(quarantine(), moved, "sessions", "chat.json"), "utf8")).toBe("HISTORY");
  });

  it("keeps the root of a bot that still exists, however long idle, and retires a gone bot's", () => {
    const home = ownerHome("L");
    setScopeRetentionHooks({ botExists: (id) => id === "alive" });
    const alive = botScope(home, "alive");
    const gone = botScope(home, "gone");
    for (const scope of [alive, gone]) { const old = ago(SCOPE_RETIRE_MAX_AGE_MS + 5 * DAY); utimesSync(join(scope, SCOPE_MARKER), old, old); }
    retireScopes("gemini", botScope(home, "other"), Date.now(), true);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  it("keeps a root another live server process built", () => {
    const home = ownerHome("L");
    const scope = botScope(home, "gone");
    const marker = JSON.parse(readFileSync(join(scope, SCOPE_MARKER), "utf8"));
    marker.owner = { pid: process.ppid, id: null }; // the test runner's parent is running
    writeFileSync(join(scope, SCOPE_MARKER), JSON.stringify(marker));
    const old = ago(SCOPE_RETIRE_MAX_AGE_MS + 5 * DAY);
    utimesSync(join(scope, SCOPE_MARKER), old, old);
    retireScopes("gemini", botScope(home, "other"), Date.now(), true);
    expect(existsSync(scope)).toBe(true);
  });

  it("keeps every bot's root when the server has not said which bots exist", () => {
    const home = ownerHome("L");
    setScopeRetentionHooks({});
    const scope = botScope(home, "unknown");
    const old = ago(SCOPE_RETIRE_MAX_AGE_MS + 5 * DAY);
    utimesSync(join(scope, SCOPE_MARKER), old, old);
    retireScopes("gemini", botScope(home, "other"), Date.now(), true);
    expect(existsSync(scope)).toBe(true);
  });
});

describe("a bot's disk use is bounded", () => {
  it("past the cap only the declared cache folders go: sessions and the login stay", () => {
    const real = tmp("murage-cap-real-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    const spec = { kind: "captest", realHome: real, botId: "bot-cap", share: ["auth.json"] as const, cache: ["logs", "auth.json", "../escape"] as const };
    const root = scopedCliHome(spec);
    mkdirSync(join(root, "logs"), { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "logs", "big.log"), Buffer.alloc(4096, 1));
    writeFileSync(join(root, "sessions", "s.jsonl"), Buffer.alloc(4096, 2));
    const idle = ago(2 * DAY);
    utimesSync(join(root, SCOPE_MARKER), idle, idle); // unused for a day: eligible
    expect(pruneScopeCache(root, 1_000_000)).toEqual([]); // under the cap: nothing
    const removed = pruneScopeCache(root, 2048);
    expect(removed).toEqual([join(root, "logs")]);
    expect(existsSync(join(root, "sessions", "s.jsonl"))).toBe(true);
    expect(readFileSync(join(root, "auth.json"), "utf8")).toBe("LOGIN"); // still the link to the owner's login
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe("LOGIN");
    removeTempDirSync(root);
  });
});

describe("pruning never touches a scope in use", () => {
  const codexLike = (bot: string) => {
    const real = tmp("murage-prune-real-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    const root = scopedCliHome({ kind: "prunetest", realHome: real, botId: bot, share: ["auth.json"], cache: ["tmp", "shell_snapshots"] });
    for (const d of ["tmp", "shell_snapshots"]) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, "live.bin"), Buffer.alloc(4096, 3)); }
    return root;
  };

  it("a scope used within the last day keeps its tmp and shell_snapshots, even over the cap", () => {
    const root = codexLike("bot-live");
    expect(pruneScopeCache(root, 100)).toEqual([]);
    expect(existsSync(join(root, "tmp", "live.bin"))).toBe(true);
    expect(existsSync(join(root, "shell_snapshots", "live.bin"))).toBe(true);
  });

  it("a scope another live server process owns is skipped, however idle", () => {
    const root = codexLike("bot-other-live");
    const marker = JSON.parse(readFileSync(join(root, SCOPE_MARKER), "utf8"));
    marker.owner = { pid: process.ppid, id: null };
    writeFileSync(join(root, SCOPE_MARKER), JSON.stringify(marker));
    const old = ago(3 * DAY);
    utimesSync(join(root, SCOPE_MARKER), old, old);
    expect(pruneScopeCache(root, 100)).toEqual([]);
    expect(existsSync(join(root, "tmp", "live.bin"))).toBe(true);
  });

  it("a scope whose lease another live process holds is skipped; a stale lease is taken over", () => {
    const root = codexLike("bot-leased");
    const old = ago(3 * DAY);
    utimesSync(join(root, SCOPE_MARKER), old, old);
    writeFileSync(scopeLockPath(root), JSON.stringify({ pid: process.ppid, id: null }));
    expect(pruneScopeCache(root, 100)).toEqual([]);
    expect(existsSync(join(root, "tmp", "live.bin"))).toBe(true);
    writeFileSync(scopeLockPath(root), JSON.stringify({ pid: 2_147_483_000, id: null })); // no such process
    expect(pruneScopeCache(root, 100).length).toBe(2);
    expect(existsSync(scopeLockPath(root))).toBe(false); // lease released
  });
});

describe("quarantine is bounded", () => {
  const aside = () => join(quarantine(), "logins");
  beforeEach(() => { removeTempDirSync(quarantine()); });
  const strand = (home: string, bot: string, text: string) => {
    const stale = botScope(home, bot);
    const login = join(stale, ".gemini", "oauth_creds.json");
    rmSync(login);
    writeFileSync(login, text);
    const old = ago(SCOPE_RETIRE_MAX_AGE_MS + DAY);
    utimesSync(join(stale, SCOPE_MARKER), old, old);
    return stale;
  };

  it("the same conflicting login set aside many times is stored once", () => {
    const home = ownerHome("OWNER");
    const keep = botScope(home, "keeper");
    for (let i = 0; i < 5; i++) { strand(home, `gone-${i}`, "SAME-TOKEN"); retireScopes("gemini", keep, Date.now(), true); }
    expect(readdirSync(aside())).toHaveLength(1);
    expect(readFileSync(join(aside(), readdirSync(aside())[0]!), "utf8")).toBe("SAME-TOKEN");
  });

  it("distinct logins past 30 days age out except the newest copy of each login name, which is never dropped", () => {
    const home = ownerHome("OWNER");
    const keep = botScope(home, "keeper");
    for (const text of ["T1", "T2", "T3"]) { strand(home, `g-${text}`, text); retireScopes("gemini", keep, Date.now(), true); }
    // age every copy beyond the window
    const names = readdirSync(aside());
    expect(names).toHaveLength(3);
    const future = Date.now() + QUARANTINE_MAX_AGE_MS + 5 * DAY;
    enforceQuarantineBounds("gemini", future);
    const left = readdirSync(aside()).map((n) => readFileSync(join(aside(), n), "utf8"));
    expect(left).toHaveLength(1); // sole copy of the login is kept
  });

  it("a parked scope past its age or the size cap goes, its login set aside first; a sole login is never lost", () => {
    const home = ownerHome("OWNER");
    const keep = botScope(home, "keeper");
    const stray = join(scopedCliHomeRoot("gemini"), "stray-big");
    mkdirSync(join(stray, ".gemini"), { recursive: true });
    writeFileSync(join(stray, ".gemini", "oauth_creds.json"), "STRAY-LOGIN");
    writeFileSync(join(stray, "history.bin"), Buffer.alloc(50_000, 7));
    const old = ago(2 * DAY);
    utimesSync(stray, old, old);
    retireScopes("gemini", keep, Date.now(), true);
    expect(readdirSync(quarantine()).some((n) => n.startsWith("stray-big"))).toBe(true);
    expect(quarantineBytes("gemini")).toBeGreaterThan(50_000);
    enforceQuarantineBounds("gemini", Date.now(), 10_000); // over a tiny cap
    expect(readdirSync(quarantine()).some((n) => n.startsWith("stray-big"))).toBe(false);
    const kept = readdirSync(aside()).map((n) => readFileSync(join(aside(), n), "utf8"));
    expect(kept).toContain("STRAY-LOGIN");
  });
});

describe("startup and pruning exclude each other", () => {
  const spec = (real: string, bot: string) => ({ kind: "leasetest", realHome: real, botId: bot, share: ["auth.json"], cache: ["tmp"] });
  afterEach(() => { setLeaseWaitMs(30_000); });

  it("a lease held 3 s: startup waits asynchronously, the event loop stays free, a notice fires once, and the scope is only used after release", async () => {
    const real = tmp("murage-lease-real-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    const root = scopedCliHome(spec(real, "bot-lease")); // now cached
    const lock = scopeLockPath(root);
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, id: null }));
    expect(() => scopedCliHome(spec(real, "bot-lease"))).toThrow(/tidied up/); // the sync build never hands out a scope mid-prune, cached or not
    const child = spawn(process.execPath, ["-e", `setTimeout(()=>{try{require("fs").unlinkSync(${JSON.stringify(lock)})}catch{}},3000)`], { stdio: "ignore", detached: true });
    child.unref();
    let last = Date.now(); let maxGap = 0;
    const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
    let notices = 0;
    const started = Date.now();
    await awaitScopeStart("leasetest", () => { notices += 1; });
    clearInterval(tick);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    expect(notices).toBe(1);
    expect(maxGap).toBeLessThan(50 + 10); // interval period plus the 50 ms budget
    expect(existsSync(lock)).toBe(false);
    expect(scopedCliHome(spec(real, "bot-lease"))).toBe(root);
  });

  it("startup HOLDS the lease while it builds the scope and records its use, and releases it after", () => {
    const real = tmp("murage-lease-real-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    let seen: { held: boolean; pid: number | null; pruned: string[] } | null = null;
    removeTempDirSync(scopedCliHomeRoot("leasetest")); // earlier tests' scopes would make the lookup below order-dependent
    const root = scopedCliHome({
      ...spec(real, "bot-hold"),
      generated: () => {
        const scopeRoot = join(scopedCliHomeRoot("leasetest"), readdirSync(scopedCliHomeRoot("leasetest")).find((n) => !n.startsWith(".")) ?? "");
        const lock = scopeLockPath(scopeRoot);
        const held = existsSync(lock);
        // a pruner arriving mid-build must be refused: it finds the lease taken
        const pruned = pruneScopeCache(scopeRoot, 0, Date.now() + 10 * DAY);
        seen = { held, pid: held ? (JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid : null, pruned };
        return {};
      },
    });
    expect(seen).toEqual({ held: true, pid: process.pid, pruned: [] });
    expect(existsSync(scopeLockPath(root))).toBe(false);
  });

  it("a lease that never clears makes startup reject cleanly", async () => {
    const real = tmp("murage-lease-real-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    const root = scopedCliHome(spec(real, "bot-stuck"));
    writeFileSync(scopeLockPath(root), JSON.stringify({ pid: process.ppid, id: null }));
    setLeaseWaitMs(400);
    await expect(awaitScopeStart("leasetest")).rejects.toThrow(/tidied up/);
    rmSync(scopeLockPath(root), { force: true });
  });

  it("no wait and no notice when nothing is pruning", async () => {
    let notices = 0;
    await awaitScopeStart("leasetest", () => { notices += 1; });
    expect(notices).toBe(0);
  });
});

describe("quarantine byte pressure and old-format logins", () => {
  const aside = () => join(quarantine(), "logins");
  beforeEach(() => { removeTempDirSync(quarantine()); mkdirSync(aside(), { recursive: true }); });
  const put = (file: string, size: number, fill: number) => writeFileSync(join(aside(), file), Buffer.alloc(size, fill));
  const hex = (c: string) => c.repeat(16);

  it("3 versions of one login over the byte cap: only the newest is kept", () => {
    const now = Date.now();
    put(`s1__oauth_creds.json__${hex("a")}__${now - 3000}`, 40_000, 1);
    put(`s2__oauth_creds.json__${hex("b")}__${now - 2000}`, 40_000, 2);
    put(`s3__oauth_creds.json__${hex("c")}__${now - 1000}`, 40_000, 3);
    enforceQuarantineBounds("gemini", now, 50_000);
    const left = readdirSync(aside());
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(hex("c"));
  });

  it("each login name keeps its newest copy even when still over the cap", () => {
    const now = Date.now();
    put(`s1__a.json__${hex("a")}__${now - 2000}`, 40_000, 1);
    put(`s2__b.json__${hex("b")}__${now - 1000}`, 40_000, 2);
    enforceQuarantineBounds("gemini", now, 10_000);
    expect(readdirSync(aside())).toHaveLength(2);
  });

  it("a legacy duplicate of a login keeps the NEWEST timestamp, so byte pressure never keeps the older login", () => {
    const now = Date.now();
    const A = Buffer.alloc(40_000, 1); const B = Buffer.alloc(40_000, 2);
    const h = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
    writeFileSync(join(aside(), `s1__oauth_creds.json__${h(A)}__${now - 3000}`), A); // token A at t1
    writeFileSync(join(aside(), `s2__oauth_creds.json__${h(B)}__${now - 2000}`), B); // token B at t2
    writeFileSync(join(aside(), `scopeX-oauth_creds.json-${now - 1000}`), A); // legacy token A at t3, the newest
    migrateAsideLogins(join(quarantine(), ".."));
    enforceQuarantineBounds("gemini", now, 50_000);
    const left = readdirSync(aside());
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(h(A));
  });

  it("several legacy copies of one login: current A@t1, legacy A@t2, current B@t3, legacy A@t4 keeps A@t4 and B", () => {
    const now = Date.now();
    const A = Buffer.alloc(40_000, 1); const B = Buffer.alloc(40_000, 2);
    const h = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
    writeFileSync(join(aside(), `s1__oauth_creds.json__${h(A)}__${now - 4000}`), A); // current A at t1
    writeFileSync(join(aside(), `scopeX-oauth_creds.json-${now - 3000}`), A); // legacy A at t2
    writeFileSync(join(aside(), `s3__oauth_creds.json__${h(B)}__${now - 2000}`), B); // current B at t3
    writeFileSync(join(aside(), `scopeY-oauth_creds.json-${now - 1000}`), A); // legacy A at t4, the newest of all
    migrateAsideLogins(join(quarantine(), ".."));
    const names = readdirSync(aside());
    expect(names.some((n) => n.includes(h(A)) && n.endsWith(`__${now - 1000}`))).toBe(true); // A carries t4
    expect(names.filter((n) => n.includes(h(A)))).toHaveLength(1);
    expect(names.some((n) => n.includes(h(B)))).toBe(true);
    expect(names.every((n) => n.includes("__"))).toBe(true);
    // byte pressure keeps the newest login: A (t4), not B, goes last
    enforceQuarantineBounds("gemini", now, 50_000);
    const left = readdirSync(aside());
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(h(A));
  });

  it("an old-format login file is migrated into the new naming, counted, and then bounded and aged", () => {
    const now = Date.now();
    const old = now - 100 * DAY;
    put(`scopeX-oauth_creds.json-${old}`, 100, 9);
    put(`scopeY-oauth_creds.json-${old + 5}`, 100, 8);
    expect(migrateAsideLogins(join(quarantine(), ".."))).toBe(2);
    const names = readdirSync(aside());
    expect(names.every((n) => n.includes("__"))).toBe(true);
    expect(names.some((n) => n.startsWith("scopeX__oauth_creds.json__"))).toBe(true);
    enforceQuarantineBounds("gemini", now); // 100 days old: the superseded one ages out, the newest stays
    expect(readdirSync(aside())).toHaveLength(1);
  });
});
