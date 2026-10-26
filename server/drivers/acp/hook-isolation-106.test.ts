// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.6 hook isolation (Fuigo 1.0.32 runs ~/.claude, ~/.cursor, ~/.codex and ~/.fuigo/hooks on every run, and on
// Windows resolves home from USERPROFILE, ignoring HOME; an unset USERPROFILE falls back to the real profile).
// Windows-shaped envs: reflection pins USERPROFILE to its temp root and closes every compat cell; bot turns force
// every hook gate to "0" over an owner "1" in any casing, and leave USERPROFILE and the non-hook opt-ins alone.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { buildReflectionEnv, FUIGO_REFLECTION_COMPAT_OFF, GROK_REFLECTION_COMPAT_OFF, pinReflectionFuigoConfig } from "../../memory/pip-transport.ts";
import { FUIGO_EXTERNAL_MCP_GATES, isolateFuigoFromExternalMcp } from "./fuigo.ts";
import { GROK_EXTERNAL_COMPAT_GATES, isolateGrokFromPersonalSetup } from "./grok.ts";
import { FUIGO_HOOK_GATES, GROK_HOOK_GATES } from "./hook-gates.ts";

const T = "C:\\Users\\owner\\AppData\\Local\\Temp\\murage-pip\\run-1-abcd";
const OWNER = "C:\\Users\\owner";
const caseInsensitive = (env: Record<string, string | undefined>, name: string) =>
  Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());

describe("reflection env pins USERPROFILE and closes every compat cell (Windows-shaped)", () => {
  for (const engine of ["fuigo", "grok"] as const) {
    it(`${engine}: USERPROFILE is the temp root, every gate is 0, a binding cannot reopen them`, () => {
      const P = engine === "fuigo" ? "FUIGO" : "GROK";
      const bound = { [`${P}_CLAUDE_HOOKS_ENABLED`]: "1", [`${P}_CLAUDE_MCPS_ENABLED`]: "1", USERPROFILE: OWNER, HOME: OWNER };
      const env = buildReflectionEnv(engine, "C:\\Windows\\System32", `${T}\\home`, T, bound);
      expect(env.USERPROFILE).toBe(T);
      expect(env.HOME).toBe(T);
      expect(env[`${P}_HOME`]).toBe(`${T}\\home`);
      const gates: readonly string[] = engine === "fuigo" ? FUIGO_EXTERNAL_MCP_GATES : GROK_EXTERNAL_COMPAT_GATES;
      for (const gate of gates) expect(env[gate], gate).toBe("0");
      for (const gate of engine === "fuigo" ? FUIGO_HOOK_GATES : GROK_HOOK_GATES) expect(env[gate], gate).toBe("0");
      expect(Object.values(env)).not.toContain(OWNER);
    });
  }

  it("the reflection cell lists match the bot-turn gate lists exactly", () => {
    expect(Object.keys(FUIGO_REFLECTION_COMPAT_OFF).sort()).toEqual([...FUIGO_EXTERNAL_MCP_GATES].sort());
    expect(Object.keys(GROK_REFLECTION_COMPAT_OFF).sort()).toEqual([...GROK_EXTERNAL_COMPAT_GATES].sort());
    for (const gate of [...FUIGO_HOOK_GATES]) expect(FUIGO_EXTERNAL_MCP_GATES as readonly string[]).toContain(gate);
    for (const gate of [...GROK_HOOK_GATES]) expect(GROK_EXTERNAL_COMPAT_GATES as readonly string[]).toContain(gate);
  });
});

describe("bot turns force every hook gate off over the owner's opt-in (Windows-shaped)", () => {
  it("fuigo: '1' in any casing becomes a single upper-case '0'; MCP opt-in and USERPROFILE untouched", () => {
    const env: Record<string, string | undefined> = {
      USERPROFILE: OWNER, HOMEDRIVE: "C:", HOMEPATH: "\\Users\\owner", Path: "C:\\Windows\\System32",
      FUIGO_CLAUDE_HOOKS_ENABLED: "1", fuigo_cursor_hooks_enabled: "true", Fuigo_Codex_Hooks_Enabled: "1",
      FUIGO_CLAUDE_MCPS_ENABLED: "1",
    };
    isolateFuigoFromExternalMcp(env);
    for (const gate of FUIGO_HOOK_GATES) {
      expect(env[gate], gate).toBe("0");
      expect(caseInsensitive(env, gate), gate).toEqual([gate]);
    }
    expect(env.FUIGO_CLAUDE_MCPS_ENABLED).toBe("1");
    expect(env.USERPROFILE).toBe(OWNER); // desktop turns keep the owner's home (native login, sessions, git/ssh); 1.0.7 item
    expect(env.FUIGO_HOME).toBeUndefined();
  });

  it("grok: same rule for the GROK hook cells", () => {
    const env: Record<string, string | undefined> = { USERPROFILE: OWNER, GROK_CLAUDE_HOOKS_ENABLED: "1", grok_codex_hooks_enabled: "1", GROK_CURSOR_MCPS_ENABLED: "1" };
    isolateGrokFromPersonalSetup(env);
    for (const gate of GROK_HOOK_GATES) {
      expect(env[gate], gate).toBe("0");
      expect(caseInsensitive(env, gate), gate).toEqual([gate]);
    }
    expect(env.GROK_CURSOR_MCPS_ENABLED).toBe("1");
    expect(env.USERPROFILE).toBe(OWNER);
  });
});

describe("reflection turns Claude plugin discovery off in the temp FUIGO_HOME", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
  const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "murage-hook106-")); dirs.push(dir); return dir; };

  it("appends [plugins] auto_discover = false after the route's config, or writes it alone", () => {
    const routed = fresh();
    writeFileSync(join(routed, "config.toml"), '[cli]\nuse_leader = false\n[models]\ndefault = "murage_selected"');
    pinReflectionFuigoConfig(routed);
    expect(readFileSync(join(routed, "config.toml"), "utf8")).toBe('[cli]\nuse_leader = false\n[models]\ndefault = "murage_selected"\n[plugins]\nauto_discover = false\n');
    const native = fresh();
    pinReflectionFuigoConfig(native);
    expect(readFileSync(join(native, "config.toml"), "utf8")).toBe("[plugins]\nauto_discover = false\n");
  });

  it("refuses a config that already has a [plugins] table instead of writing a duplicate", () => {
    const dir = fresh();
    writeFileSync(join(dir, "config.toml"), "[plugins]\nauto_discover = true\n");
    expect(() => pinReflectionFuigoConfig(dir)).toThrow("PIP_REFLECTION_PLUGINS_TABLE");
  });
});
