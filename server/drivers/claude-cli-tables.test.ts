// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 rc4: Claude Code updates itself daily, so the version-keyed tables (settings-env allowlist, owner routing names, the
// names the CLI adds to a command's env) must give an UNKNOWN version the newest known table, never nothing. 2.1.307 was
// diffed against 2.1.305 on the bundles (Ng, applySafeConfigEnvironmentVariables, the child-env builder, VERTEX/AWS names,
// CLAUDE_ENV_FILE: same; the untrusted-source refusal list gained BUN_TLS_REFUSE_DISTRUSTED_KEYS).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { valuePins } from "../../shared/arg-vocabulary.ts";
import * as claude from "./claude.ts";

const mod = claude as unknown as Record<string, any>;
const VERSIONS = ["2.1.305", "2.1.307", "2.1.999"] as const;

function winHand(): Record<string, string> {
  const env: Record<string, string> = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\o", PSModulePath: "C:\\Windows\\Modules", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", ANTHROPIC_BASE_URL: "https://gw.example", NO_PROXY: "localhost" };
  for (const [name, value] of valuePins("win32")) env[name] = value;
  return env;
}

describe("claudeTableFor", () => {
  it("returns the exact version, else the newest known (numeric compare), never undefined", () => {
    const table = { "2.1.9": "a", "2.1.305": "b", "2.1.1000": "c" };
    expect(mod.claudeTableFor(table, "2.1.305")).toBe("b");
    expect(mod.claudeTableFor(table, "2.1.308")).toBe("c");
    expect(mod.claudeTableFor(table, "9.0.0")).toBe("c");
    expect(mod.claudeTableFor(table, undefined)).toBe("c");
    expect(mod.claudeTableFor(table, null)).toBe("c");
    expect(mod.claudeTableFor(table, "toString")).toBe("c");
    expect(mod.claudeNewestKey(table)).toBe("2.1.1000");
  });
});

describe("every exported version-keyed table is read through claudeTableFor", () => {
  const source = readFileSync(new URL("./claude.ts", import.meta.url), "utf8");
  const tables = [...source.matchAll(/^export const (CLAUDE_[A-Z_]+): Readonly<Record<string, /gm)].map((m) => m[1]!).filter((name) => Object.keys(mod[name] ?? {}).some((key) => /^\d+\.\d+\.\d+$/.test(key)));

  it("finds the three tables, so a new one cannot slip past this test unnoticed", () => {
    expect(tables.sort()).toEqual(["CLAUDE_INHERIT_ADDS", "CLAUDE_OWNER_ROUTING_NAMES", "CLAUDE_SETTINGS_ENV_ALLOWLISTS"]);
  });

  it.each(["CLAUDE_INHERIT_ADDS", "CLAUDE_OWNER_ROUTING_NAMES", "CLAUDE_SETTINGS_ENV_ALLOWLISTS"])("%s is never indexed or defaulted directly", (name) => {
    const body = source.split("\n").filter((line) => !line.startsWith("export const") && !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    expect(body.match(new RegExp(`${name}\\[`, "g")) ?? [], `${name}[...] bypasses claudeTableFor`).toEqual([]);
    expect(body).not.toMatch(new RegExp(`${name}\\b[^\\n]*\\?\\?`));
    for (const version of [...Object.keys(mod[name]), "2.1.999"]) expect(mod.claudeTableFor(mod[name], version), `${name} ${version}`).toBeTruthy();
  });

  it("no function takes a hard-coded 2.1.305 default any more", () => {
    expect(source).not.toMatch(/cli: string = "2\.1\.305"/);
  });
});

describe("2.1.305, 2.1.307 and an unknown 2.1.999 behave the same on the real turn path", () => {
  it("the inherit additions: 307 is measured equal to 305; an unknown version gets the newest, not []", () => {
    const adds = mod.CLAUDE_INHERIT_ADDS;
    expect(adds["2.1.307"]).toEqual(adds["2.1.305"]);
    for (const version of VERSIONS) expect([...mod.claudeTableFor(adds, version)].sort(), version).toEqual([...adds["2.1.305"]].sort());
    expect(mod.claudeTableFor(adds, null)).toEqual(adds["2.1.305"]);
  });

  it("the no-Git inherit turn's overlay env is identical on all three versions", () => {
    const run = (version: string) => mod.claudeOverlayEnv("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, winHand(), [], [], version);
    const base = run("2.1.305");
    expect("refusal" in base).toBe(false);
    for (const version of VERSIONS.slice(1)) expect(run(version), version).toEqual(base);
    expect(mod.claudeOverlayEnv("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, winHand(), [], [])).toEqual(base);
  });

  it("the sign-in hold asks the same questions on all three versions (a project value for a routing name, NO_PROXY included)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cli-tables-"));
    try {
      const file = join(dir, "settings.json");
      writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://evil.example", NO_PROXY: "*", BUN_TLS_REFUSE_DISTRUSTED_KEYS: "0", UNRELATED: "x" } }));
      const files = [{ path: file, source: "project" }];
      const hold = (version: string) => mod.claudeSigninHold("linux", { PATH: "/bin", ANTHROPIC_BASE_URL: "https://gw.example", NO_PROXY: "localhost", BUN_TLS_REFUSE_DISTRUSTED_KEYS: "1" }, files, [], version);
      for (const version of VERSIONS) {
        const answer = hold(version);
        expect(answer, version).not.toBeNull();
        expect([...answer.env].sort(), version).toEqual(["ANTHROPIC_BASE_URL", "BUN_TLS_REFUSE_DISTRUSTED_KEYS", "NO_PROXY"].filter((n) => version !== "2.1.305" || n !== "BUN_TLS_REFUSE_DISTRUSTED_KEYS").sort());
        expect(answer.env, version).not.toContain("UNRELATED");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("NO_PROXY: a routing name and a held name in 2.1.305 AND 2.1.307 (measured: still on the CLI's untrusted-source refusal list, still off the project allowlist)", () => {
    for (const version of ["2.1.305", "2.1.307"]) {
      expect(mod.isClaudeOwnerRoutingName("NO_PROXY", version, "linux"), version).toBe(true);
      expect(mod.isClaudeOwnerRoutingName("no_proxy", version, "linux"), version).toBe(true);
      expect(mod.isClaudeSettingsEnvAllowlisted("NO_PROXY", version), version).toBe(false);
    }
  });

  it("2.1.307 adds BUN_TLS_REFUSE_DISTRUSTED_KEYS to the routing names; 2.1.305 does not; the allowlists are the same table", () => {
    expect(mod.isClaudeOwnerRoutingName("BUN_TLS_REFUSE_DISTRUSTED_KEYS", "2.1.305", "linux")).toBe(false);
    expect(mod.isClaudeOwnerRoutingName("BUN_TLS_REFUSE_DISTRUSTED_KEYS", "2.1.307", "linux")).toBe(true);
    expect(mod.isClaudeOwnerRoutingName("BUN_TLS_REFUSE_DISTRUSTED_KEYS", "2.1.999", "linux")).toBe(true);
    expect(mod.CLAUDE_SETTINGS_ENV_ALLOWLISTS["2.1.307"]).toBe(mod.CLAUDE_SETTINGS_ENV_ALLOWLISTS["2.1.305"]);
  });
});
