// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 section 14.2 (MurageMain, after Astra's code round 2, astra-nobash-code2/OUT.txt):
// N1 every owner login/routing name pinned on every turn; N2 the private overlays flat in one owner-only root in the data folder,
// recorded in a manifest and removed by leaf name only; #2 an env: target with a quote or caret, or a pin in any case, holds;
// #3 the native helper's write never opens its destination. Read loosely so a base without them fails as a test.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { valuePins } from "../../shared/arg-vocabulary.ts";
import { pinOverrideIn } from "../../shared/prompt-capable.ts";
import { DATA_DIR } from "../config.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as claude from "./claude.ts";
import * as privateFiles from "./claude-private.ts";

const mod = claude as unknown as Record<string, any>;
const priv = privateFiles as unknown as Record<string, any>;
const INHERIT = { kind: "powershell-inherit", reason: "no-git-bash" };
const posix = process.platform !== "win32";

function winHand(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\o", ...extra };
  for (const [name, value] of valuePins("win32")) env[name] = value;
  return env;
}

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-nobash-fix3-"))); });
afterEach(() => removeTempDirSync(dir));

function settings(name: string, env: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ env }));
  return path;
}

describe("14.2 N1: every owner routing name pinned on every turn, whatever the repository's files hold", () => {
  const exact = () => (mod.CLAUDE_OWNER_ROUTING_NAMES["2.1.305"] as Array<{ name: string; prefix?: true }>).filter((row) => !row.prefix).map((row) => row.name);

  it("with no settings file at all and no owner value, every exact name and documented model mapping is left out (14.6: never \"\")", () => {
    const overlay = mod.claudeOverlayEnv("win32", INHERIT, winHand(), []);
    for (const name of exact()) expect(overlay.env[name], name).toBeUndefined();
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", "ANTHROPIC_DEFAULT_MODEL"]) {
      expect(overlay.env[name], name).toBeUndefined();
    }
    expect(overlay.ownerRouting).toEqual([]);
  });

  it("the pin is the owner's effective value: user, then managed, then the hand", () => {
    const user = settings("user.json", { ANTHROPIC_BASE_URL: "https://owner-gateway.example", ANTHROPIC_AUTH_TOKEN: "owner-token-value" });
    const managed = settings("managed.json", { ANTHROPIC_MODEL: "org-model" });
    const overlay = mod.claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin", HTTPS_PROXY: "http://handed:3128" }, [{ path: user, source: "user" }], [managed]);
    expect(overlay.env.ANTHROPIC_BASE_URL).toBe("https://owner-gateway.example");
    expect(overlay.env.ANTHROPIC_AUTH_TOKEN).toBe("owner-token-value");
    expect(overlay.env.ANTHROPIC_MODEL).toBe("org-model");
    expect(overlay.env.HTTPS_PROXY).toBe("http://handed:3128");
    expect(overlay.env.ANTHROPIC_API_KEY).toBeUndefined(); // 14.6: no owner value, left out
    expect(overlay.ownerRouting).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]);
  });

  it("a family member any file or the hand names is pinned too, with the owner's value", () => {
    const project = settings("project.json", { VERTEX_REGION_CLAUDE_9_X: "attacker-region" });
    const overlay = mod.claudeOverlayEnv("win32", INHERIT, winHand(), [{ path: project, source: "project" }]);
    // 14.6: no owner value, so left out of the overlay; the sign-in card asks about the repository's value
    expect(overlay.env.VERTEX_REGION_CLAUDE_9_X).toBeUndefined();
    expect(mod.claudeSigninHold("win32", winHand(), [{ path: project, source: "project" }], [])?.env).toEqual(["VERTEX_REGION_CLAUDE_9_X"]);
  });
});

describe("14.2 N2: flat private files in the data folder, a manifest, removal by leaf name only", () => {
  it("the overlay root is in the data folder, never the OS temp folder", () => {
    expect(mod.claudeOverlays.dir()).toBe(join(DATA_DIR, "claude-private"));
  });

  it("no recursive or path-walking delete anywhere in the private-file module", () => {
    const source = readFileSync(new URL("./claude-private.ts", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
    expect(source).not.toMatch(/\brmSync|rmdirSync\([^)]*,|readdirSync|tmpdir/);
    for (const line of source.split("\n").filter((l) => /recursive/.test(l))) expect(line).toMatch(/mkdirSync\(/);
  });

  it.skipIf(!posix)("an overlay is a flat 0600 file in the 0700 root, recorded in the manifest, and gone with the root when released", () => {
    const root = join(dir, "claude-private");
    const store = new priv.ClaudeOverlayStore(() => root, undefined, () => {});
    const path = store.acquire("{\"env\":{}}");
    expect(path.startsWith(`${root}/`)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))).toEqual([path.slice(root.length + 1)]);
    store.release(path);
    expect(existsSync(root)).toBe(false);
  });

  it.skipIf(!posix)("boot sweep: a planted symlink and a swapped-in directory link at recorded names, and a root swapped for a link, leave the foreign tree untouched", () => {
    const foreign = join(dir, "foreign");
    mkdirSync(join(foreign, "deep"), { recursive: true });
    writeFileSync(join(foreign, "keep.txt"), "keep");
    writeFileSync(join(foreign, "deep", "keep.txt"), "keep");
    const root = join(dir, "claude-private");
    mkdirSync(root, { mode: 0o700 });
    const a = "a".repeat(32) + ".json", b = "b".repeat(32) + ".json", c = "c".repeat(32) + ".json";
    writeFileSync(join(root, a), "{\"env\":{\"X\":\"restated\"}}", { mode: 0o600 });
    symlinkSync(join(foreign, "keep.txt"), join(root, b));
    symlinkSync(foreign, join(root, c)); // the junction swap
    writeFileSync(join(root, "unrecorded.json"), "{}", { mode: 0o600 });
    writeFileSync(join(root, "manifest.json"), JSON.stringify([a, b, c, "../foreign/keep.txt"]), { mode: 0o600 });
    const logged: string[] = [];
    const removed = priv.sweepClaudePrivate(root, undefined, (line: string) => logged.push(line));
    expect(removed).toEqual([join(root, a)]);
    expect(lstatSync(join(root, b)).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, c)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "unrecorded.json"))).toBe(true);
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(foreign, "deep", "keep.txt"), "utf8")).toBe("keep");
    expect(logged.join("\n")).toMatch(/b{32}\.json is not a regular file/);
    expect(logged.join("\n")).toMatch(/c{32}\.json is not a regular file/);
    // the root itself swapped for a link to the foreign tree: left alone
    const moved = join(dir, "moved");
    renameSync(root, moved);
    symlinkSync(foreign, root);
    writeFileSync(join(foreign, "manifest.json"), JSON.stringify(["keep.txt"]));
    expect(priv.sweepClaudePrivate(root, undefined, () => {})).toEqual([]);
    expect(readdirSync(foreign).sort()).toEqual(["deep", "keep.txt", "manifest.json"]);
  });

  it.skipIf(!posix)("an empty root is removed after the sweep; a missing root is a no-op", () => {
    const root = join(dir, "claude-private");
    mkdirSync(root, { mode: 0o700 });
    const a = "d".repeat(32) + ".json";
    writeFileSync(join(root, a), "{}", { mode: 0o600 });
    writeFileSync(join(root, "manifest.json"), JSON.stringify([a]), { mode: 0o600 });
    expect(priv.sweepClaudePrivate(root, undefined, () => {})).toEqual([join(root, a)]);
    expect(existsSync(root)).toBe(false);
    expect(priv.sweepClaudePrivate(join(dir, "none"), undefined, () => {})).toEqual([]);
  });
});

describe("14.2 #2: an env: target with a quote or caret, or a pinned name in any case, holds", () => {
  const pins = valuePins("win32");
  it("quote concatenation, typographic quotes and carets in the target hold, case-insensitively", () => {
    for (const command of [
      "si -LiteralPath env:pa\"ger\" -Value less",
      "Set-Item env:pa'ger' less",
      "ni -Path env:\\Pa\u201Cger\u201D -Value less",
      "Set-Item -Path env:git_ss'h_command' -Value x",
      "Remove-Item env:\"pager\"",
      "Get-Item env:pa^ger",
      "Set-Item env:x\\pager less",
    ]) expect(pinOverrideIn(command, pins, "pwsh"), command).not.toBeNull();
  });

  it("a plain quoted path and a benign name still pass", () => {
    for (const command of ["Set-Item -Path \"env:MY_FLAG\" -Value \"1\"", "$env:FOO=\"1\"", "Get-ChildItem env:", "(Get-Item 'env:Path').Value", "echo \"$env:USERPROFILE\"", "\"$env:PATH\".Split(';')"]) {
      expect(pinOverrideIn(command, pins, "pwsh"), command).toBeNull();
    }
  });
});

describe("14.2 #3: the native helper's write never opens its destination", () => {
  it("writePrivate: a CREATE_NEW temp with the owner-only descriptor, renamed over the destination; no read path", () => {
    const source = readFileSync(new URL("../../native/browser-extension/transport.cpp", import.meta.url), "utf8");
    const start = source.indexOf("void writePrivate(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).not.toMatch(/readPrivate|GENERIC_READ|OPEN_EXISTING|GetFileAttributes|ReadFile/);
    // the destination path is named only by the rename
    expect(body.match(/CreateFileW\(([^,]+),/g)).toEqual(["CreateFileW(temporary.c_str(),"]);
    expect(body).toMatch(/CREATE_NEW/);
    expect(body).toMatch(/MoveFileExW\(temporary\.c_str\(\),path\.c_str\(\)/);
  });
});
