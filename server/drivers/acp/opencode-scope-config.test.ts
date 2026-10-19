// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The bot's scoped copy of an OpenCode config folder follows the owner's source: a deleted config removes the copy, an unreadable one
// removes it and rejects the turn (never stale settings), and config-relative file references are rebased to the source folder.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import { resetIsolationCache } from "../isolation-cache.ts";
import { ScopeUnavailableError, resetScopeBookkeeping, scopeLocalFailureOf } from "../scoped-cli-home.ts";
import { filterOpenCodeConfigFile, isolateOpenCodeGlobalInstructions, rebaseOpenCodeFileRefs } from "./opencode-go.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oc-scope-")); dirs.push(d); return d; };
beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); resetIsolationCache(); });
afterEach(() => { for (const d of dirs.splice(0)) removeTempDirSync(d); });

const scopeOf = (owner: string, bot: string): string => {
  const env: Record<string, string | undefined> = { OPENCODE_CONFIG_DIR: owner };
  isolateOpenCodeGlobalInstructions(env, bot);
  return env.OPENCODE_CONFIG_DIR!;
};
const files = (dir: string) => readdirSync(dir).filter((name) => !name.startsWith(".")).sort();

describe("the scoped OpenCode config follows the owner's source", () => {
  it("a deleted config removes the generated copy (owned files only); the engine's own files in the scope stay", () => {
    const owner = tmp();
    writeFileSync(join(owner, "opencode.json"), JSON.stringify({ model: "p/m", provider: { p: { options: { apiKey: "STALE-PROVIDER" } } } }));
    const scope = scopeOf(owner, "bot-del");
    expect(JSON.parse(readFileSync(join(scope, "opencode.json"), "utf8")).provider.p.options.apiKey).toBe("STALE-PROVIDER");
    writeFileSync(join(scope, "sessions.db"), "THE ENGINE'S OWN");
    rmSync(join(owner, "opencode.json"));
    expect(scopeOf(owner, "bot-del")).toBe(scope);
    expect(existsSync(join(scope, "opencode.json"))).toBe(false);
    expect(readFileSync(join(scope, "sessions.db"), "utf8")).toBe("THE ENGINE'S OWN");
    expect(existsSync(join(owner, "sessions.db"))).toBe(false);
  });

  it("an invalid config removes the earlier copy and rejects the turn with a structured, localizable error: never stale settings", () => {
    const owner = tmp();
    writeFileSync(join(owner, "opencode.jsonc"), '{ "model": "p/m", "provider": { "p": { "options": { "baseURL": "https://old.example" } } } }');
    const scope = scopeOf(owner, "bot-bad");
    expect(files(scope)).toEqual(["opencode.jsonc"]);
    writeFileSync(join(owner, "opencode.jsonc"), '{ "model": "p/m", "provider": { '); // half-saved
    const env: Record<string, string | undefined> = { OPENCODE_CONFIG_DIR: owner };
    let error: unknown = null;
    try { isolateOpenCodeGlobalInstructions(env, "bot-bad"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ScopeUnavailableError);
    expect((error as ScopeUnavailableError).code).toBe("config-invalid");
    expect(scopeLocalFailureOf(error as ScopeUnavailableError)).toBe("engine-config-invalid");
    expect((error as ScopeUnavailableError).engine).toBe("OpenCode");
    expect(env.OPENCODE_CONFIG_DIR).toBe(owner); // not handed on: the turn path rejects before any spawn
    expect(files(scope)).toEqual([]);
    expect(readFileSync(join(owner, "opencode.jsonc"), "utf8")).toContain('"model"'); // the owner's file is untouched
    // fixed again: the copy is made again
    writeFileSync(join(owner, "opencode.jsonc"), '{ "model": "p/m2" }');
    expect(JSON.parse(readFileSync(join(scopeOf(owner, "bot-bad"), "opencode.jsonc"), "utf8"))).toEqual({ model: "p/m2" });
  });

  it("a config that is valid JSON but not an object is invalid; a blank file holds no settings", () => {
    const owner = tmp();
    writeFileSync(join(owner, "config.json"), "[1, 2]");
    expect(() => scopeOf(owner, "bot-arr")).toThrow(ScopeUnavailableError);
    writeFileSync(join(owner, "config.json"), "  \n");
    expect(files(scopeOf(owner, "bot-arr"))).toEqual([]);
  });
});

describe("config-relative references are rebased to the source folder", () => {
  const source = resolve("/owner/oc");

  it("rebases a relative {file:} against the SOURCE directory, keeps absolute and ~/ references, and leaves a // comment line alone", () => {
    const text = [
      "{",
      '  "provider": { "p": { "options": { "apiKey": "{file:./provider-key}", "other": "{file:keys/two.txt}", "abs": "{file:/etc/key}", "home": "{file:~/.secrets/k}" } } },',
      '  // "old": "{file:./commented}",',
      '  "agent": { "a": { "prompt": "{file:../prompts/a.md}" } }',
      "}",
    ].join("\n");
    const out = rebaseOpenCodeFileRefs(text, source);
    expect(out).toContain(`{file:${resolve(source, "./provider-key").replaceAll("\\", "/")}}`);
    expect(out).toContain(`{file:${resolve(source, "keys/two.txt").replaceAll("\\", "/")}}`);
    expect(out).toContain(`{file:${resolve(source, "../prompts/a.md").replaceAll("\\", "/")}}`);
    expect(out).toContain("{file:/etc/key}");
    expect(out).toContain("{file:~/.secrets/k}");
    expect(out).toContain('// "old": "{file:./commented}"');
  });

  it("the filtered config copy resolves provider credentials in the owner's folder, not the scope", () => {
    const owner = tmp();
    writeFileSync(join(owner, "provider-key"), "SECRET-KEY");
    writeFileSync(join(owner, "opencode.json"), JSON.stringify({ provider: { p: { options: { apiKey: "{file:./provider-key}" } } }, mcp: { personal: { command: ["x"] } } }));
    const scope = scopeOf(owner, "bot-ref");
    const copy = JSON.parse(readFileSync(join(scope, "opencode.json"), "utf8"));
    expect(copy.mcp).toBeUndefined();
    const token = copy.provider.p.options.apiKey as string;
    const path = /^\{file:(.*)\}$/.exec(token)![1]!;
    expect(path).toBe(join(owner, "provider-key").replaceAll("\\", "/"));
    expect(readFileSync(path, "utf8")).toBe("SECRET-KEY"); // it resolves to the owner's file
    expect(existsSync(join(scope, "provider-key"))).toBe(false); // and the scope never held a copy of the secret
  });

  it("rebases the local paths of the `references` table and leaves git sources alone", () => {
    const out = JSON.parse(filterOpenCodeConfigFile(JSON.stringify({ references: { docs: "./docs", abs: "/srv/x", repo: "owner/repo", obj: { path: "../notes", description: "d" } } }), source)!);
    expect(out.references.docs).toBe(resolve(source, "./docs").replaceAll("\\", "/"));
    expect(out.references.abs).toBe("/srv/x");
    expect(out.references.repo).toBe("owner/repo");
    expect(out.references.obj).toEqual({ path: resolve(source, "../notes").replaceAll("\\", "/"), description: "d" });
  });

  it("still drops the keys that start or load the owner's own things, and reports an unreadable text as null", () => {
    expect(JSON.parse(filterOpenCodeConfigFile('{"model":"a","mcp":{"x":{}},"plugin":["p"],"instructions":["i"]}', source)!)).toEqual({ model: "a" });
    expect(filterOpenCodeConfigFile("{ nope", source)).toBeNull();
  });
});
