// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 14.5 (Fable's REVISE on 95ee923ab): one rule for empty pins.
// 14.6 (Fable's third REVISE) replaces the 14.5 premise: 2.1.305 copies the user, flag (our --settings overlay) and policy settings `env` into its
// OWN process environment wholesale, "" included; the allowlist (bundle variable Ng) filters only project and local settings.
// So the overlay now pins NO name to "" (claude-nopin.test.ts); these tests keep the allowlist as the sign-in hold's scope and
// check the allowlisted names, AWS_PROFILE first (botocore read AWS_PROFILE="" as ProfileNotFound), are never "".
// And the sign-in card remembers the owner's answer per repository file and sign-in values, so routines are not refused.
// Read loosely so a base without these exports fails rather than crashes.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { valuePins } from "../../shared/arg-vocabulary.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import * as claude from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const mod = claude as unknown as Record<string, any>;
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const EXEC = { kind: "murage-exec", shell: "/bin/bash" };
const INHERIT = { kind: "powershell-inherit", reason: "no-git-bash" };

// The 2.1.305 bundle's Ng, spot names (the full list is the checked-in claude-settings-env-allowlist-2.1.305.ts).
const NG_SPOT = ["AWS_PROFILE", "AWS_DEFAULT_REGION", "AWS_REGION", "MAX_THINKING_TOKENS", "DISABLE_AUTOUPDATER", "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "VERTEX_REGION_CLAUDE_HAIKU_4_5", "OTEL_EXPORTER_OTLP_HEADERS", "BASH_DEFAULT_TIMEOUT_MS"];
const AWS_HELPER = ["AWS_PROFILE", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"];

function hand(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin", ...extra };
  for (const [name, value] of valuePins("linux")) env[name] = value;
  return env;
}

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-ng-"))); });
afterEach(() => removeTempDirSync(dir));
const file = (name: string, settings: Record<string, unknown>): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(settings));
  return path;
};
const ng = (): string[] => {
  const lists = mod.CLAUDE_SETTINGS_ENV_ALLOWLISTS as Record<string, string[]> | undefined;
  // a base without the checked-in list still runs the rule against Fable's spot names
  return lists?.["2.1.305"] ?? NG_SPOT;
};

/** What the CLI's own process.env (and so a helper child it runs with no env) holds after it applies the settings env, as Murage
 * composes the launch: the handed map, then each settings source's `env` in the CLI's order, the overlay (--settings) last. */
function cliProcessEnv(handed: Record<string, string>, sources: Array<Record<string, unknown>>, overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...handed };
  for (const source of [...sources, overlay]) for (const [name, value] of Object.entries(source)) env[name] = String(value);
  return env;
}

describe("14.5 the one rule: no settings-env allowlist name is ever pinned to \"\"", () => {
  it("the allowlist is the 2.1.305 bundle's Ng (216 names) and holds the names Fable named", () => {
    expect(ng().length).toBe(216);
    for (const name of NG_SPOT) expect(ng(), name).toContain(name);
  });

  it("(a) no Ng name is in the empty-pin set: with no owner value none is \"\" in the overlay, bare, repo-named or owner-named", () => {
    expect(ng().length).toBeGreaterThan(0);
    for (const platform of ["linux", "win32"] as const) {
      const shell = platform === "win32" ? INHERIT : EXEC;
      const allNamed = Object.fromEntries(ng().map((name) => [name, `v-${name}`]));
      const repo = file(`repo-${platform}.json`, { env: allNamed });
      const user = file(`user-${platform}.json`, { env: Object.fromEntries(ng().map((name) => [name, ""])) });
      for (const files of [[], [{ path: repo, source: "project" }], [{ path: repo, source: "local" }], [{ path: user, source: "user" }]]) {
        const overlay = mod.claudeOverlayEnv(platform, shell, hand(), files);
        for (const name of ng()) expect(overlay.env[name], `${platform} ${name} ${JSON.stringify(files)}`).not.toBe("");
      }
    }
  });

  it("AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE are never blank either (not on Ng, never-blank by audit)", () => {
    for (const name of ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) {
      expect(mod.isClaudeNeverBlankName(name, "linux"), name).toBe(true);
      const overlay = mod.claudeOverlayEnv("linux", EXEC, hand(), [{ path: file(`r-${name}.json`, { env: { [name]: "/repo/aws" } }), source: "project" }]);
      expect(name in overlay.env, name).toBe(false);
      expect(mod.claudeOverlayEnv("linux", EXEC, hand({ [name]: "/owner/aws" }), []).env[name]).toBe("/owner/aws");
    }
  });

  it("14.6: names off the allowlist are left out too when the owner has no value (no \"\" pin for any name)", () => {
    const overlay = mod.claudeOverlayEnv("linux", EXEC, hand(), []);
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(name in overlay.env, name).toBe(false);
  });

  it("(b) a helper child (apiKeyHelper) sees the owner's AWS_PROFILE / AWS_DEFAULT_REGION / AWS files, or none, never \"\"", () => {
    // the owner has them in the hand
    const owned = { AWS_PROFILE: "prod", AWS_DEFAULT_REGION: "eu-west-1", AWS_CONFIG_FILE: "/home/o/.aws/config", AWS_SHARED_CREDENTIALS_FILE: "/home/o/.aws/credentials" };
    const userFile = file("user-helper.json", { apiKeyHelper: "/owner/helper.sh" });
    let overlay = mod.claudeOverlayEnv("linux", EXEC, hand(owned), [{ path: userFile, source: "user" }]);
    let child = cliProcessEnv(hand(owned), [{}], overlay.env);
    for (const name of AWS_HELPER) expect(child[name], name).toBe(owned[name as keyof typeof owned]);
    // the owner has them in user settings only
    const userEnv = file("user-env.json", { apiKeyHelper: "/owner/helper.sh", env: owned });
    overlay = mod.claudeOverlayEnv("linux", EXEC, hand(), [{ path: userEnv, source: "user" }]);
    child = cliProcessEnv(hand(), [owned], overlay.env);
    for (const name of AWS_HELPER) expect(child[name], name).toBe(owned[name as keyof typeof owned]);
    // the owner has none: absent, not ""
    overlay = mod.claudeOverlayEnv("linux", EXEC, hand(), [{ path: userFile, source: "user" }]);
    child = cliProcessEnv(hand(), [{}], overlay.env);
    for (const name of AWS_HELPER) expect(name in child, name).toBe(false);
  });

  it("(c) the owner's own MAX_THINKING_TOKENS / DISABLE_AUTOUPDATER: no card on two turns, and the values reach the CLI unchanged", () => {
    const owner = { MAX_THINKING_TOKENS: "16000", DISABLE_AUTOUPDATER: "1" };
    const user = file("user-own.json", { env: owner });
    for (let turn = 1; turn <= 2; turn++) {
      const files = [{ path: user, source: "user" }, { path: join(dir, "absent-project.json"), source: "project" }];
      expect(mod.claudeSigninHold("linux", hand(), files, []), `turn ${turn}`).toBeNull();
      const overlay = mod.claudeOverlayEnv("linux", EXEC, hand(), files);
      for (const [name, value] of Object.entries(owner)) {
        expect(overlay.env[name] === undefined || overlay.env[name] === value, `turn ${turn} ${name}`).toBe(true);
        expect(cliProcessEnv(hand(), [owner], overlay.env)[name], `turn ${turn} ${name} in the CLI`).toBe(value);
      }
    }
  });

  it("(c) the card asks only about a repository value that differs from the owner's", () => {
    const user = file("user-c.json", { env: { MAX_THINKING_TOKENS: "16000" } });
    const same = file("same.json", { env: { MAX_THINKING_TOKENS: "16000" } });
    const differs = file("differs.json", { env: { MAX_THINKING_TOKENS: "1", AWS_PROFILE: "repo" } });
    expect(mod.claudeSigninHold("linux", hand(), [{ path: user, source: "user" }, { path: same, source: "project" }], [])).toBeNull();
    expect(mod.claudeSigninHold("linux", hand(), [{ path: user, source: "user" }, { path: differs, source: "local" }], [])).toEqual({ keys: [], env: ["AWS_PROFILE", "MAX_THINKING_TOKENS"] });
    // and the overlay pins the owner's value over the repository's
    const overlay = mod.claudeOverlayEnv("linux", EXEC, hand(), [{ path: user, source: "user" }, { path: differs, source: "local" }]);
    expect(overlay.env.MAX_THINKING_TOKENS).toBe("16000");
    expect("AWS_PROFILE" in overlay.env).toBe(false);
  });
});

describe("14.5 the sign-in card remembers the owner's answer (routines and unattended turns)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  const create = async () => {
    instance = await claude.ClaudeDriver.create({ instanceId: "claude-ng-test", displayName: "Claude Ng Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    invalidateCliVersions();
    resetClaudeVersionGate();
    for (const level of ["info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    vi.restoreAllMocks();
    invalidateCliVersions();
    resetClaudeVersionGate();
  });

  const repo = (name: string, settings: Record<string, unknown>): string => {
    const cwd = join(dir, name);
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(settings));
    return cwd;
  };
  /** A turn with nobody present: it either opens the card or completes; which came first. */
  const unattended = async (threadId: string, cwd: string): Promise<RuntimeEvent> => {
    void instance!.adapter.sendTurn({ threadId, text: "routine", cwd });
    return recorder!.until((e) => e.threadId === threadId && (e.type === "request.opened" || e.type === "turn.completed"));
  };
  const answer = async (threadId: string, cwd: string, pick: "Allow" | "Don't allow") => {
    const sent = instance!.adapter.sendTurn({ threadId, text: "hi", cwd });
    const opened = await recorder!.until((e) => e.type === "request.opened" && e.threadId === threadId) as Extract<RuntimeEvent, { type: "request.opened" }>;
    await instance!.adapter.respondToRequest(threadId, opened.requestId!, { behavior: "answer", answers: [{ id: "signin", selected: [pick] }] });
    await sent;
    return recorder!.until((e) => e.type === "turn.completed" && e.threadId === threadId);
  };

  it("answered once, later unattended turns run with no card; a changed value asks again; a remembered Don't allow refuses with no card; a different file asks", async () => {
    await create();
    const cwd = repo("repo", { env: { ANTHROPIC_MODEL: "repo-model" } });
    expect(await answer("t-first", cwd, "Allow")).toMatchObject({ type: "turn.completed" });

    // routine-style: nobody present, same file and values: no card, the turn runs
    const second = await unattended("t-routine-1", cwd);
    expect(second.type).toBe("turn.completed");
    expect(await unattended("t-routine-2", cwd)).toMatchObject({ type: "turn.completed" });

    // a changed value asks again; the owner says Don't allow
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "repo-model-2" } }));
    expect((await unattended("t-changed", cwd)).type).toBe("request.opened");
    const opened = recorder!.events.find((e) => e.type === "request.opened" && e.threadId === "t-changed") as Extract<RuntimeEvent, { type: "request.opened" }>;
    await instance!.adapter.respondToRequest("t-changed", opened.requestId!, { behavior: "answer", answers: [{ id: "signin", selected: ["Don't allow"] }] });
    expect(await recorder!.until((e) => e.type === "turn.completed" && e.threadId === "t-changed")).toMatchObject({ ok: false });

    // the remembered Don't allow: refused, plain message, no card
    const refused = await unattended("t-denied", cwd);
    expect(refused).toMatchObject({ type: "turn.completed", ok: false });
    expect(JSON.stringify(recorder!.events.filter((e) => e.threadId === "t-denied"))).toContain("you chose not to allow that");
    expect(recorder!.events.some((e) => e.type === "request.opened" && e.threadId === "t-denied")).toBe(false);

    // a different repository file with the same values asks
    const other = repo("repo-other", { env: { ANTHROPIC_MODEL: "repo-model-2" } });
    expect((await unattended("t-other", other)).type).toBe("request.opened");
  }, 60_000);

  it("the stored answers hold no path, name or value in plain text", async () => {
    const answers = new (await import("./claude-signin-answers.ts")).ClaudeSigninAnswers(() => join(dir, "answers.json"));
    const scope = mod.claudeSigninScope("linux", [{ path: file("p.json", { apiKeyHelper: "/secret/helper", env: { AWS_PROFILE: "secret-profile" } }), source: "project" }]);
    answers.remember(scope, true);
    const { readFileSync, statSync } = await import("node:fs");
    const text = readFileSync(join(dir, "answers.json"), "utf8");
    for (const leak of ["secret", "AWS_PROFILE", "apiKeyHelper", dir]) expect(text, leak).not.toContain(leak);
    expect(statSync(join(dir, "answers.json")).mode & 0o777).toBe(0o600);
    expect(answers.recall(scope)).toBe(true);
    const fresh = new (await import("./claude-signin-answers.ts")).ClaudeSigninAnswers(() => join(dir, "answers.json"));
    expect(fresh.recall(scope)).toBe(true);
    expect(fresh.recall({ ...scope, canonical: `${scope.canonical} ` })).toBeUndefined();
  });
});
