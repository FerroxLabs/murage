// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 14.6 (Fable's third REVISE, MurageMain's ruling): the overlay never pins "" for any name.
// Claude Code 2.1.305 copies the user, flag (our --settings overlay) and policy settings `env` into its own process.env
// WHOLESALE, "" included (applySafeConfigEnvironmentVariables); the allowlist (Ng) filters only project and local settings. So
// every "" in the overlay reached apiKeyHelper / gcpAuthRefresh / aws* helper children: GOOGLE_APPLICATION_CREDENTIALS=""
// breaks google-auth ADC, and CLOUDSDK_CONFIG, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_CA_BUNDLE and
// AWS_CONTAINER_CREDENTIALS_RELATIVE_URI break the same way. Each name is now the owner's non-empty value, Murage's non-empty
// neutral value (BASH_ENV, ENV), or absent; MurageMain ruled "" for exactly six names (CLAUDE_OVERLAY_EMPTY_ALLOWED, frozen).
// Read loosely so a base without these exports fails rather than crashes.

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { valuePins } from "../../shared/arg-vocabulary.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as claude from "./claude.ts";

const mod = claude as unknown as Record<string, any>;
const EXEC = { kind: "murage-exec", shell: "/bin/bash" };
const WIN_EXEC = { kind: "murage-exec", shell: "C:\\Program Files\\Git\\bin\\bash.exe" };
const INHERIT = { kind: "powershell-inherit", reason: "no-git-bash" };
const SHAPES = [["linux", EXEC], ["win32", WIN_EXEC], ["win32", INHERIT]] as const;

// Names Fable named: off the allowlist, read by google-auth / botocore helpers, "" differs from absent for each.
const HELPER_NAMES = ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CA_BUNDLE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
// 14.6 ruled (frozen): enforcement-critical names with no non-empty neutral value, whose readers take "" as unset.
const ALLOWED = ["CLAUDE_CODE_SHELL_PREFIX", "NODE_OPTIONS", "GIT_ASKPASS", "CLAUDE_ENV_FILE", "PYTHONINSPECT", "CLAUDE_CODE_PLUGIN_DIRS"];

function hand(platform: "linux" | "win32", extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: platform === "win32" ? "C:\\Windows\\system32" : "/usr/bin", ...extra };
  for (const [name, value] of valuePins(platform)) env[name] = value;
  env.NODE_OPTIONS = "";
  return env;
}

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-nopin-"))); });
afterEach(() => removeTempDirSync(dir));
let n = 0;
const file = (settings: Record<string, unknown>): string => {
  const path = join(dir, `s${n++}.json`);
  writeFileSync(path, JSON.stringify(settings));
  return path;
};
const allowed = (): string[] => (mod.CLAUDE_OVERLAY_EMPTY_ALLOWED as string[] | undefined) ?? [];

/** The CLI's own process.env (what a helper child it runs with no env of its own inherits): the spawn env, then the user, flag
 * (overlay) and policy settings env copied wholesale in that order ("" included), as 2.1.305's applySafeConfigEnvironmentVariables
 * does. Project and local settings are left out: their routing and sign-in names raise the card (asserted separately). */
function helperChildEnv(spawn: Record<string, string>, user: Record<string, string>, overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...spawn };
  for (const source of [user, overlay]) for (const [name, value] of Object.entries(source)) env[name] = value;
  return env;
}

describe("14.6 the overlay pins no name to \"\"", () => {
  it("(e) fail-first: GOOGLE_APPLICATION_CREDENTIALS and the other helper names are never \"\" in the overlay, on any shape or file", () => {
    for (const [platform, shell] of SHAPES) {
      const named = Object.fromEntries(HELPER_NAMES.map((name) => [name, `/repo/${name}`]));
      const repo = file({ env: named });
      const ownerBlank = file({ env: Object.fromEntries(HELPER_NAMES.map((name) => [name, ""])) });
      for (const files of [[], [{ path: repo, source: "project" }], [{ path: repo, source: "local" }], [{ path: ownerBlank, source: "user" }]]) {
        const overlay = mod.claudeOverlayEnv(platform, shell, hand(platform), files);
        for (const name of HELPER_NAMES) expect(overlay.env[name], `${platform} ${shell.kind} ${name} ${JSON.stringify(files)}`).not.toBe("");
      }
    }
  });

  it("no name at all is \"\" in the overlay except the listed pending names, whatever the files set", () => {
    expect([...allowed()].sort()).toEqual([...ALLOWED].sort());
    for (const [platform, shell] of SHAPES) {
      const repo = file({ env: { ...Object.fromEntries(HELPER_NAMES.map((name) => [name, "/repo"])), ANTHROPIC_BASE_URL: "https://repo.example", MY_TOOL_FLAG: "1", LESS: "-R", SSH_ASKPASS: "/repo/askpass" } });
      const user = file({ env: { MY_OWNER_FLAG: "", AWS_PROFILE: "", ANTHROPIC_MODEL: "" } });
      const overlay = mod.claudeOverlayEnv(platform, shell, hand(platform, { HANDED_EMPTY: "" }), [{ path: user, source: "user" }, { path: repo, source: "project" }]);
      const blank = Object.entries(overlay.env as Record<string, string>).filter(([, value]) => value === "").map(([name]) => name);
      for (const name of blank) expect(ALLOWED, `${platform} ${shell.kind}: ${name} is ""`).toContain(name);
    }
  });

  it("(e) an apiKeyHelper child sees the owner's value or nothing for each helper name, never \"\"", () => {
    for (const [platform, shell] of SHAPES) {
      const helper = file({ apiKeyHelper: "/owner/helper" });
      // owner has none: absent
      let overlay = mod.claudeOverlayEnv(platform, shell, hand(platform), [{ path: helper, source: "user" }]);
      let child = helperChildEnv(hand(platform), {}, overlay.env);
      for (const name of HELPER_NAMES) expect(name in child, `${platform} ${shell.kind} ${name} absent`).toBe(false);
      // owner has them in the spawn env (the hand)
      const owned = Object.fromEntries(HELPER_NAMES.map((name) => [name, `/owner/${name}`]));
      overlay = mod.claudeOverlayEnv(platform, shell, hand(platform, owned), [{ path: helper, source: "user" }]);
      child = helperChildEnv(hand(platform, owned), {}, overlay.env);
      for (const name of HELPER_NAMES) expect(child[name], `${platform} ${name} from the hand`).toBe(owned[name]);
      // owner has them in user settings only
      const userEnv = file({ apiKeyHelper: "/owner/helper", env: owned });
      overlay = mod.claudeOverlayEnv(platform, shell, hand(platform), [{ path: userEnv, source: "user" }]);
      child = helperChildEnv(hand(platform), owned, overlay.env);
      for (const name of HELPER_NAMES) expect(child[name], `${platform} ${name} from user settings`).toBe(owned[name]);
    }
  });

  it("a repository's file setting a helper routing name (owner has none) is left out of the overlay and raises the sign-in card", () => {
    // AWS_CA_BUNDLE is not on the routing inventory (no card; escalated in 14.6 with the other non-routing repository names)
    for (const name of HELPER_NAMES.filter((name) => name !== "AWS_CA_BUNDLE")) {
      const repo = file({ env: { [name]: "/repo/creds" } });
      const files = [{ path: repo, source: "project" }];
      expect(name in mod.claudeOverlayEnv("linux", EXEC, hand("linux"), files).env, name).toBe(false);
      expect(mod.claudeSigninHold("linux", hand("linux"), files, [])?.env, name).toEqual([name]);
    }
  });
});

describe("14.6 enforcement-critical names: a non-empty neutral value, and the owner's user settings cannot defeat it", () => {
  it("BASH_ENV and ENV are /dev/null in the overlay; an owner user-settings value loses (flag settings outrank user settings)", () => {
    expect(mod.CLAUDE_OVERLAY_NEUTRAL).toEqual({ BASH_ENV: "/dev/null", ENV: "/dev/null" });
    const owner = { BASH_ENV: "/owner/startup.sh", ENV: "/owner/env.sh" };
    for (const [platform, shell] of SHAPES) {
      const user = file({ env: owner });
      const overlay = mod.claudeOverlayEnv(platform, shell, hand(platform), [{ path: user, source: "user" }]);
      const child = helperChildEnv(hand(platform), owner, overlay.env);
      for (const name of ["BASH_ENV", "ENV"]) {
        expect(overlay.env[name], `${platform} ${shell.kind} ${name}`).toBe("/dev/null");
        expect(child[name], `${platform} ${shell.kind} ${name}: the overlay value wins`).toBe("/dev/null");
      }
    }
  });

  it("SSH_ASKPASS and LESS are dropped: the overlay's non-empty SSH_ASKPASS_REQUIRE=never and pagers=cat make an owner value irrelevant", () => {
    const owner = { SSH_ASKPASS: "/owner/askpass", SSH_ASKPASS_REQUIRE: "force", LESS: "+F", PAGER: "less", GIT_PAGER: "less", MANPAGER: "less" };
    for (const [platform, shell] of SHAPES) {
      const user = file({ env: owner });
      const overlay = mod.claudeOverlayEnv(platform, shell, hand(platform), [{ path: user, source: "user" }]);
      expect("SSH_ASKPASS" in overlay.env, platform).toBe(false);
      expect("LESS" in overlay.env, platform).toBe(false);
      const child = helperChildEnv(hand(platform), owner, overlay.env);
      expect(child.SSH_ASKPASS_REQUIRE, `${platform}: ssh never runs an askpass program`).toBe("never");
      for (const name of ["PAGER", "GIT_PAGER", "MANPAGER"]) expect(child[name], `${platform} ${name}: less is never the pager`).toBe("cat");
    }
  });

  it("the six ruled names are pinned to \"\", and an owner user-settings value still loses", () => {
    const owner = { NODE_OPTIONS: "--require /owner/x.js", GIT_ASKPASS: "/owner/askpass", PYTHONINSPECT: "1", CLAUDE_ENV_FILE: "/owner/env", CLAUDE_CODE_PLUGIN_DIRS: "/owner/plugins", CLAUDE_CODE_SHELL_PREFIX: "/owner/prefix" };
    const user = file({ env: owner });
    const overlay = mod.claudeOverlayEnv("win32", INHERIT, hand("win32"), [{ path: user, source: "user" }]);
    const child = helperChildEnv(hand("win32"), owner, overlay.env);
    for (const name of ALLOWED) expect(child[name], name).toBe("");
  });
});

describe("14.6 the ruled \"\" list is frozen", () => {
  it("the names the overlay pins to \"\" EQUAL CLAUDE_OVERLAY_EMPTY_ALLOWED (inherit) and that list less the prefix (Bash path)", () => {
    const everything = file({ env: { ...Object.fromEntries(HELPER_NAMES.map((name) => [name, ""])), ANTHROPIC_BASE_URL: "", MY_TOOL_FLAG: "", LESS: "", SSH_ASKPASS: "", BASH_ENV: "" } });
    for (const [platform, shell] of SHAPES) {
      for (const files of [[], [{ path: everything, source: "user" }], [{ path: everything, source: "project" }]]) {
        const overlay = mod.claudeOverlayEnv(platform, shell, hand(platform, { HANDED_EMPTY: "", PSModulePath: "" }), files);
        const blank = Object.keys(overlay.env).filter((name) => overlay.env[name] === "").sort();
        const want = shell.kind === "powershell-inherit" ? [...ALLOWED] : ALLOWED.filter((name) => name !== "CLAUDE_CODE_SHELL_PREFIX");
        expect(blank, `${platform} ${shell.kind} ${JSON.stringify(files)}`).toEqual(want.sort());
      }
    }
    // the isolation settings the CLI is handed add nothing to it
    const iso = (claude as unknown as { claudeIsolationSettings: (...args: unknown[]) => { env: Record<string, string> } }).claudeIsolationSettings({}, dir, "win32", mod.claudeOverlayEnv("win32", INHERIT, hand("win32"), []).env);
    expect(Object.keys(iso.env).filter((name) => iso.env[name] === "").sort()).toEqual([...ALLOWED].sort());
  });

  it("CLAUDE_ENV_FILE stays \"\": 2.1.305 reads it as `h=a.CLAUDE_ENV_FILE;if(h)` (strings offset 25098417), so \"\" is unset, never a path", () => {
    for (const [platform, shell] of SHAPES) {
      const overlay = mod.claudeOverlayEnv(platform, shell, hand(platform, { CLAUDE_ENV_FILE: "/owner/env.sh" }), [{ path: file({ env: { CLAUDE_ENV_FILE: "/owner/user-env.sh" } }), source: "user" }]);
      expect(overlay.env.CLAUDE_ENV_FILE, `${platform} ${shell.kind}`).toBe("");
    }
    // the reader, as the bundle has it: an empty value is never read or stat'ed
    const reads: string[] = [];
    const uje = (env: Record<string, string | undefined>) => { const h = env.CLAUDE_ENV_FILE; if (h) reads.push(h); };
    uje({ CLAUDE_ENV_FILE: "" });
    uje({});
    expect(reads).toEqual([]);
  });
});
