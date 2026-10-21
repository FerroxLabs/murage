// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 regression (Astra, astra-nobash-final): the overlay pinned AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE to "" when the owner had
// none, and the AWS SDK in Claude Code 2.1.305 reads "" as an invalid mode (instance-role sign-in broke). Every routing name whose
// empty string differs from absence in the 2.1.305 bundle (CLAUDE_EMPTY_UNSAFE_NAMES) is now pinned only to a non-empty owner
// value and otherwise left out, and the sign-in hold still asks about a repository value. Read loosely so a base without it fails.

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { valuePins } from "../../shared/arg-vocabulary.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as claude from "./claude.ts";

const mod = claude as unknown as Record<string, any>;
const INHERIT = { kind: "powershell-inherit", reason: "no-git-bash" };

// The audited-unsafe set (empty differs from absent), by name and reason; the test fails if the code's set drifts from it.
const UNSAFE = [
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE", "AWS_EC2_METADATA_SERVICE_ENDPOINT", "AWS_REGION",
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE", "CLAUDE_LOCAL_OAUTH_API_BASE", "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
];

function hand(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin", ...extra };
  for (const [name, value] of valuePins("linux")) env[name] = value;
  return env;
}
const exactRoutingNames = (): string[] => {
  const table = mod.CLAUDE_OWNER_ROUTING_NAMES["2.1.305"] as Array<{ name: string; prefix?: true; members?: string[] }>;
  return table.flatMap((row) => (row.prefix ? row.members ?? [] : [row.name]));
};

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-emptypin-"))); });
afterEach(() => removeTempDirSync(dir));
const file = (name: string, settings: Record<string, unknown>): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(settings));
  return path;
};

describe("empty is not absent: routing names the 2.1.305 bundle reads differently when \"\"", () => {
  it("the unsafe set is exactly the audited one, and every member is a routing name", () => {
    expect([...mod.CLAUDE_EMPTY_UNSAFE_NAMES].sort()).toEqual([...UNSAFE].sort());
    for (const name of UNSAFE) expect(mod.isClaudeOwnerRoutingName(name, "2.1.305", "linux"), name).toBe(true);
  });

  it("with no owner value, none of them is in the overlay env (absent, not \"\"), with or without a repository file", () => {
    for (const platform of ["linux", "win32"] as const) {
      const bare = mod.claudeOverlayEnv(platform, platform === "win32" ? INHERIT : { kind: "murage-exec", shell: "/bin/bash" }, hand(), []);
      for (const name of UNSAFE) expect(name in bare.env, `${platform} ${name}`).toBe(false);
      const project = file(`project-${platform}.json`, { env: Object.fromEntries(UNSAFE.map((name) => [name, `repo-${name}`])) });
      const named = mod.claudeOverlayEnv(platform, platform === "win32" ? INHERIT : { kind: "murage-exec", shell: "/bin/bash" }, hand(), [{ path: project, source: "project" }]);
      for (const name of UNSAFE) expect(name in named.env, `${platform} ${name} repo-named`).toBe(false);
    }
  });

  it("with an owner value (user settings, managed settings or the hand) each is still pinned to it", () => {
    const user = file("user.json", { env: Object.fromEntries(UNSAFE.slice(0, 4).map((name) => [name, `user-${name}`])) });
    const managed = file("managed.json", { env: { [UNSAFE[4]!]: "managed-value" } });
    const handed = Object.fromEntries(UNSAFE.slice(5).map((name) => [name, `hand-${name}`]));
    const project = file("project.json", { env: Object.fromEntries(UNSAFE.map((name) => [name, `repo-${name}`])) });
    const overlay = mod.claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, hand(handed), [{ path: user, source: "user" }, { path: project, source: "project" }], [managed]);
    for (const name of UNSAFE.slice(0, 4)) expect(overlay.env[name], name).toBe(`user-${name}`);
    expect(overlay.env[UNSAFE[4]!]).toBe("managed-value");
    for (const name of UNSAFE.slice(5)) expect(overlay.env[name], name).toBe(`hand-${name}`);
  });

  it("the sign-in hold fires when project (or local) settings set one and the owner has none, and not when the value is the owner's", () => {
    for (const name of UNSAFE) {
      for (const source of ["project", "local"]) {
        const repo = file(`${source}-${name}.json`, { env: { [name]: "repo-value" } });
        expect(mod.claudeSigninHold("linux", { PATH: "/bin" }, [{ path: repo, source }], []), `${source} ${name}`).toEqual({ keys: [], env: [name] });
        expect(mod.claudeSigninHold("linux", { PATH: "/bin", [name]: "repo-value" }, [{ path: repo, source }], []), `${source} ${name} same as owner`).toBeNull();
      }
    }
  });

  it("14.6: every other routing name is left out too when the owner has none (no \"\" pin for any name)", () => {
    const overlay = mod.claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, hand(), []);
    const safe = exactRoutingNames().filter((name) => !UNSAFE.includes(name) && !mod.isClaudeSettingsEnvAllowlisted(name));
    expect(safe.length).toBeGreaterThan(80);
    for (const name of safe) expect(name in overlay.env, name).toBe(false);
    // the case Astra found: the instance-role names reach the CLI unset, and a name the owner sets is not blanked
    expect("AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE" in overlay.env).toBe(false);
  });
});
