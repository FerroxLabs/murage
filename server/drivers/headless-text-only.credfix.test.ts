// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUDE-SCOPE.md Part B (1.0.4): a text-only Claude run reads the owner's login where it lives, never a copy. F2' the namespace table,
// F3 the env assignment, F7 the macOS Keychain-presence probe (mocked `security`), F8 the Windows Credential Manager flag and seed,
// F6 the structure pins. Every owner home here is a temp fixture; nothing reads a real credential.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_ENV_KEEP, claudeAllowlistEnv, claudeKeychainItemPresent, claudeLoginNamespace, claudeTextOnlyTurn, forgetClaudeLoginProbes, ownerCredmanFlag,
  resolveClaudeLoginProbes, type ClaudeTextOnlyConfig, type KeychainLookup,
} from "./headless-text-only.ts";
import { claudeAccountEnvironment } from "../claude-accounts.ts";
import type { TempRoot, TextOnlyTurnInput } from "../memory/pip-transport.ts";
import type { ProviderTurnRoute } from "../provider-routing.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const posix = describe.skipIf(process.platform === "win32");
const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
const SEED = '{"cachedGrowthBookFeatures":{"tengu_windows_credman":true}}';
const temp: TempRoot = { root: "/t", work: "/t/work", home: "/t/home", promptFile: "/t/prompt.txt", debugFile: "/t/debug.log" };

let base: string, out: string, etc: string, home: string;
beforeEach(() => {
  forgetClaudeLoginProbes();
  base = mkdtempSync(join(tmpdir(), "pip-credfix-"));
  out = join(base, "rec.jsonl"); etc = join(base, "etc"); home = join(base, "home");
  mkdirSync(etc); mkdirSync(home);
});
afterEach(() => { vi.restoreAllMocks(); removeTempDirSync(base); });

const preflight = () => ({ etcRoot: etc, home, grokHome: join(home, ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(base, "no-managed.json") });
const input = (over: Partial<TextOnlyTurnInput> = {}): TextOnlyTurnInput => ({
  system: "SYS", text: "USER", model: "model-1", outputSchema: SCHEMA, signal: new AbortController().signal,
  maxOutputTokens: 2000, maxOutputBytes: 12 * 1024, context: { botId: "bot", runId: "run1", family: "lived", attempt: 1 }, ...over,
});
const claudeCfg = (env: NodeJS.ProcessEnv, extra: Partial<ClaudeTextOnlyConfig> = {}): ClaudeTextOnlyConfig => ({
  cli: process.execPath, cliPrefixArgs: [STUB, "--stub=ok", `--stub-out=${out}`], tmpBase: join(base, "tmp"), env: { PATH: "/usr/bin:/bin", ...env },
  preflight: preflight(), postResultGraceMs: 3000, ...extra,
});
type Rec = { env: Record<string, string>; homeFiles: string[] | null; argv: string[] };
const records = (): Rec[] => existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.argv && r.stdin === undefined) : [];
/** A fake `security`: records every argv, answers `code`. */
const fakeSecurity = (code: number | null) => {
  const calls: string[][] = [];
  const lookup: KeychainLookup = async (args) => { calls.push(args); return code; };
  return { calls, lookup };
};
const ownerHome = () => { const h = join(base, "owner"); mkdirSync(join(h, ".claude"), { recursive: true }); return h; };

describe("F2': claudeLoginNamespace, each row of B.1 step 2", () => {
  it("SECURESTORAGE non-empty and a set CLAUDE_CONFIG_DIR are passed verbatim on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(claudeLoginNamespace({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s", CLAUDE_CONFIG_DIR: "/c", HOME: "/h" }, platform)).toBe("/s");
      expect(claudeLoginNamespace({ CLAUDE_CONFIG_DIR: "~/x", HOME: "/h" }, platform)).toBe("~/x");
      expect(claudeLoginNamespace({ CLAUDE_CONFIG_DIR: "C:\\Users\\u\\acct" }, platform, { credman: true, keychainItem: false })).toBe("C:\\Users\\u\\acct");
    }
  });
  it("a named account's D is passed verbatim everywhere, and a non-NFC D is never normalized", () => {
    const D = join(base, "accounts", "work");
    const named = claudeAccountEnvironment({ HOME: "/h", USERPROFILE: "C:\\Users\\u", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/owner-secure" }, D);
    for (const platform of ["darwin", "linux", "win32"] as const) expect(claudeLoginNamespace(named, platform)).toBe(D);
    const nfd = "/accounts/Cafe\u0301";
    expect(nfd.normalize("NFC")).not.toBe(nfd);
    for (const platform of ["darwin", "linux", "win32"] as const) expect(claudeLoginNamespace({ CLAUDE_CONFIG_DIR: nfd }, platform)).toBe(nfd);
  });
  it("the default store: linux gets the owner's absolute folder (never \"\"), inherited \"\" included", () => {
    expect(claudeLoginNamespace({ HOME: "/h" }, "linux")).toBe("/h/.claude");
    expect(claudeLoginNamespace({ HOME: "/h", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, "linux")).toBe("/h/.claude");
    expect(claudeLoginNamespace({ HOME: "/h", CLAUDE_SECURESTORAGE_CONFIG_DIR: "", CLAUDE_CONFIG_DIR: "/c" }, "linux")).toBe("/h/.claude");
    expect(claudeLoginNamespace({ HOME: "/h", CLAUDE_CONFIG_DIR: "" }, "linux")).toBe("/h/.claude");
  });
  it("the default store on win32: plaintext gets USERPROFILE\\.claude, Credential Manager gets \"\"", () => {
    expect(claudeLoginNamespace({ USERPROFILE: "C:\\Users\\u", HOME: "/not/this" }, "win32")).toBe("C:\\Users\\u\\.claude");
    expect(claudeLoginNamespace({ USERPROFILE: "C:\\Users\\u", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, "win32", { credman: false })).toBe("C:\\Users\\u\\.claude");
    expect(claudeLoginNamespace({ USERPROFILE: "C:\\Users\\u" }, "win32", { credman: true })).toBe("");
  });
  it("the default store on darwin: \"\" (the default Keychain item) unless the probe found no item", () => {
    expect(claudeLoginNamespace({ HOME: "/h" }, "darwin")).toBe("");
    expect(claudeLoginNamespace({ HOME: "/h", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, "darwin", { keychainItem: true })).toBe("");
    expect(claudeLoginNamespace({ HOME: "/h" }, "darwin", { keychainItem: false })).toBe("/h/.claude");
  });
});

describe("F3: claudeAllowlistEnv sets the namespace outside the keep loop", () => {
  it("a routed run (null) carries no CLAUDE_SECURESTORAGE_CONFIG_DIR; a native one carries it, \"\" included", () => {
    expect(claudeAllowlistEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, temp, 10, null)).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(claudeAllowlistEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s" }, temp, 10)).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(claudeAllowlistEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, temp, 10, "").CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    expect(claudeAllowlistEnv({}, temp, 10, "/h/.claude").CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/h/.claude");
  });
  it("CLAUDE_CODE_FORCE_WINDOWS_CREDMAN is kept; HOME stays the temp root", () => {
    expect(CLAUDE_ENV_KEEP).toContain("CLAUDE_CODE_FORCE_WINDOWS_CREDMAN");
    const env = claudeAllowlistEnv({ CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1", HOME: "/owner" }, temp, 10, "");
    expect(env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN).toBe("1");
    expect(env.HOME).toBe("/t");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/t/home");
  });
});

describe("F7: the macOS Keychain-presence probe (a fake security)", () => {
  it("file present + exit 44 -> the absolute folder; exit 0 -> \"\"; attributes only (no -w, no -g)", async () => {
    const h = ownerHome(); writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    const none = fakeSecurity(44);
    const probes = await resolveClaudeLoginProbes({ HOME: h, USER: "owner" }, "darwin", none.lookup);
    expect(probes).toEqual({ keychainItem: false });
    expect(claudeLoginNamespace({ HOME: h, USER: "owner" }, "darwin", probes)).toBe(join(h, ".claude"));
    expect(none.calls).toEqual([["find-generic-password", "-s", "Claude Code-credentials", "-a", "owner"]]);
    for (const args of none.calls) { expect(args).not.toContain("-w"); expect(args).not.toContain("-g"); }
    forgetClaudeLoginProbes();
    const present = fakeSecurity(0);
    const found = await resolveClaudeLoginProbes({ HOME: h, USER: "owner" }, "darwin", present.lookup);
    expect(claudeLoginNamespace({ HOME: h, USER: "owner" }, "darwin", found)).toBe("");
  });
  it("file absent -> \"\" with NO security spawn; a non-default store never asks", async () => {
    const h = ownerHome();
    const fake = fakeSecurity(44);
    const probes = await resolveClaudeLoginProbes({ HOME: h, USER: "owner" }, "darwin", fake.lookup);
    expect(claudeLoginNamespace({ HOME: h }, "darwin", probes)).toBe("");
    writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    expect(await resolveClaudeLoginProbes({ HOME: h, CLAUDE_CONFIG_DIR: "/acct" }, "darwin", fake.lookup)).toEqual({});
    expect(await resolveClaudeLoginProbes({ HOME: h, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s" }, "darwin", fake.lookup)).toEqual({});
    expect(await resolveClaudeLoginProbes({ HOME: h }, "linux", fake.lookup)).toEqual({});
    expect(fake.calls).toEqual([]);
  });
  it("a probe timeout or error -> \"\" (the default store)", async () => {
    const h = ownerHome(); writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    expect(await claudeKeychainItemPresent({ HOME: h, USER: "owner" }, fakeSecurity(null).lookup)).toBe(true);
    forgetClaudeLoginProbes();
    expect(await claudeKeychainItemPresent({ HOME: h, USER: "owner" }, async () => { throw new Error("spawn failed"); })).toBe(true);
    forgetClaudeLoginProbes();
    expect(await claudeKeychainItemPresent({ HOME: h, USER: "owner" }, fakeSecurity(36).lookup)).toBe(true);
  });
  it("memoized per (user, file mtime) until forgotten", async () => {
    const h = ownerHome(); writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    const fake = fakeSecurity(44);
    await claudeKeychainItemPresent({ HOME: h, USER: "owner" }, fake.lookup);
    await claudeKeychainItemPresent({ HOME: h, USER: "owner" }, fake.lookup);
    expect(fake.calls).toHaveLength(1);
    await claudeKeychainItemPresent({ HOME: h, USER: "other" }, fake.lookup);
    expect(fake.calls).toHaveLength(2);
    forgetClaudeLoginProbes();
    await claudeKeychainItemPresent({ HOME: h, USER: "owner" }, fake.lookup);
    expect(fake.calls).toHaveLength(3);
  });
});

describe("F8: ownerCredmanFlag mirrors the CLI's own switch", () => {
  const owner = () => { const h = ownerHome(); return { h, dir: join(h, ".claude") }; };
  it("the env flag; .config.json true wins over .claude.json false; an empty .config.json falls through", () => {
    const { h, dir } = owner();
    expect(ownerCredmanFlag({ USERPROFILE: h })).toBe(false);
    expect(ownerCredmanFlag({ USERPROFILE: h, CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" })).toBe(true);
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: false } }));
    writeFileSync(join(dir, ".config.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    expect(ownerCredmanFlag({ USERPROFILE: h })).toBe(true);
    writeFileSync(join(dir, ".config.json"), "");
    expect(ownerCredmanFlag({ USERPROFILE: h })).toBe(false);
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    expect(ownerCredmanFlag({ USERPROFILE: h })).toBe(true);
    // a truthy non-true value is not the flag
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: "true" } }));
    expect(ownerCredmanFlag({ USERPROFILE: h })).toBe(false);
  });
  it("a named account reads D's own files; an unreadable or non-JSON file is false (plaintext)", () => {
    const { h } = owner();
    const D = join(base, "acct"); mkdirSync(D);
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    expect(ownerCredmanFlag({ USERPROFILE: h, CLAUDE_CONFIG_DIR: D })).toBe(false);
    writeFileSync(join(D, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    expect(ownerCredmanFlag({ USERPROFILE: h, CLAUDE_CONFIG_DIR: D })).toBe(true);
    writeFileSync(join(D, ".config.json"), "{not json");
    expect(ownerCredmanFlag({ USERPROFILE: h, CLAUDE_CONFIG_DIR: D })).toBe(false);
    const E = join(base, "acct-dir"); mkdirSync(join(E, ".config.json"), { recursive: true });
    writeFileSync(join(E, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    expect(ownerCredmanFlag({ USERPROFILE: h, CLAUDE_CONFIG_DIR: E })).toBe(false);
  });
});

posix("Part B through claudeTextOnlyTurn", () => {
  it("win32 flag true: the temp .claude.json is exactly the seed, the namespace is \"\", the env flag reaches the child, no owner secret leaks", async () => {
    const h = ownerHome();
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ primaryApiKey: "fixture-primary-value-0000", cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    const logs: string[] = [];
    for (const level of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    let seed: string | null = null, rootFiles: string[] = [];
    const result = await claudeTextOnlyTurn(input({ transport: { hooks: { onIntent: async (i) => {
      seed = readFileSync(join(i.tempRoot, "home", ".claude.json"), "utf8");
      rootFiles = readdirSync(i.tempRoot, { recursive: true }).map(String);
    } } } }), claudeCfg({ USERPROFILE: h, CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" }, { platform: "win32" }));
    expect(result.verdict.state).toBe("validated");
    expect(seed).toBe(SEED);
    const [r] = records();
    expect(r.homeFiles).toEqual([".claude.json"]);
    expect(r.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    expect(r.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN).toBe("1");
    expect(JSON.stringify(r.env)).not.toContain("fixture-primary-value");
    expect(readFileSync(out, "utf8")).not.toContain("fixture-primary-value");
    expect(logs.join("\n")).not.toContain("fixture-primary-value");
    expect(rootFiles.filter((f) => f.endsWith(".credentials.json"))).toEqual([]);
  });
  it("win32 plaintext owner: no seed, the namespace is USERPROFILE\\.claude", async () => {
    const h = ownerHome();
    await claudeTextOnlyTurn(input(), claudeCfg({ USERPROFILE: h }, { platform: "win32" }));
    const [r] = records();
    expect(r.homeFiles).toEqual([]);
    expect(r.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(win32Path.join(h, ".claude"));
  });
  it("darwin plaintext-only owner (no Keychain item): the namespace is the owner's absolute folder; nothing is copied", async () => {
    const h = ownerHome(); writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    const fake = fakeSecurity(44);
    await claudeTextOnlyTurn(input(), claudeCfg({ HOME: h, USER: "owner" }, { platform: "darwin", keychainLookup: fake.lookup }));
    const [r] = records();
    expect(r.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(h, ".claude"));
    expect(r.homeFiles).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
  it("darwin Keychain owner: the namespace is \"\"; a run that does not validate forgets the probe", async () => {
    const h = ownerHome(); writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    const fake = fakeSecurity(0);
    await claudeTextOnlyTurn(input(), claudeCfg({ HOME: h, USER: "owner" }, { platform: "darwin", keychainLookup: fake.lookup }));
    expect(records()[0].env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    await claudeTextOnlyTurn(input(), claudeCfg({ HOME: h, USER: "owner" }, { platform: "darwin", keychainLookup: fake.lookup }));
    expect(fake.calls).toHaveLength(1);
    await claudeTextOnlyTurn(input(), claudeCfg({ HOME: h, USER: "owner" }, { platform: "darwin", keychainLookup: fake.lookup, cliPrefixArgs: [STUB, "--stub=big", `--stub-out=${out}`] }));
    await claudeTextOnlyTurn(input(), claudeCfg({ HOME: h, USER: "owner" }, { platform: "darwin", keychainLookup: fake.lookup }));
    expect(fake.calls).toHaveLength(2);
  });
  it("B5: a routed run gets no namespace, no seed and no flag read", async () => {
    const h = ownerHome();
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
    const route: ProviderTurnRoute = { connectionId: "conn-a", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "route-key-1", model: "route-model", revision: "r1" };
    const fake = fakeSecurity(44);
    await claudeTextOnlyTurn(input({ providerRoute: route }), claudeCfg({ USERPROFILE: h, HOME: h }, { platform: "win32", keychainLookup: fake.lookup }));
    const [r] = records();
    expect(r.env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(r.homeFiles).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("F6 and F8 structure", () => {
  const server = fileURLToPath(new URL("..", import.meta.url));
  const source = readFileSync(fileURLToPath(new URL("./headless-text-only.ts", import.meta.url)), "utf8");
  const productFiles = (readdirSync(server, { recursive: true }) as string[]).map(String)
    .filter((f) => /\.(ts|mts|cts)$/.test(f) && !/\.test\.ts$/.test(f) && !f.split(/[\\/]/).includes("node_modules"));
  it("no copy: copyFileSync and .credentials.json do not occur in headless-text-only.ts; credentialsDir nowhere in server/", () => {
    expect(source).not.toContain("copyFileSync");
    // r3 supersedes r2's F6 here: the one mention is the macOS existence probe (B.1 step 3), never a read or a copy
    const at = [...source.matchAll(/\.credentials\.json/g)].map((m) => m.index ?? -1);
    const probe = source.indexOf("export async function claudeKeychainItemPresent"), probeEnd = source.indexOf("\n}\n", probe);
    expect(at).toHaveLength(1);
    expect(at[0] > probe && at[0] < probeEnd).toBe(true);
    for (const f of productFiles) expect(readFileSync(join(server, f), "utf8"), f).not.toContain("credentialsDir");
  });
  it("ownerCredmanFlag returns boolean and is the only parser of an owner .claude.json in server/", () => {
    expect(source).toMatch(/export function ownerCredmanFlag\(full: NodeJS\.ProcessEnv\): boolean \{/);
    const literal = /["']\.claude\.json["']/;
    expect(productFiles.filter((f) => literal.test(readFileSync(join(server, f), "utf8")))).toEqual([join("drivers", "headless-text-only.ts")]);
    expect(source.match(/["']\.claude\.json["']/g)).toHaveLength(1);
    const body = source.slice(source.indexOf("export function ownerCredmanFlag"), source.indexOf("\n}\n", source.indexOf("export function ownerCredmanFlag")));
    expect(body).toContain("JSON.parse");
    expect(body).not.toMatch(/console\.|writeFile|appendFile/);
  });
});
