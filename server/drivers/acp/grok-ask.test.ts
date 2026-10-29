// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// At Ask, Grok Build sends every shell command, edit and write to Murage before it runs (grok-scope.ts
// GROK_ASK_RULES): `--permission-mode default` alone let grok 1.0.62 run its own read-only commands (echo, touch,
// mkdir) with no card. A grok the rules are not proven on is refused at Ask (grok.ts GROK_ASK_HOLD_MIN).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { AskStopRefusal, ASK_STOP_GROK_OLD_NOTE } from "../ask-stop.ts";
import { GROK_ASK_RULES, scopedGrokConfigToml } from "./grok-scope.ts";
import { GROK_ASK_HOLD_MIN, GrokAgentDriver, requireGrokAskHold } from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) removeTempDirSync(home); });

const ASK_LINE = 'ask = ["Bash", "Edit", "Write", "Read(**)", "Grep"]';

/** An owner whose own grok config allows every shell command and edit. */
function ownerHome(): string {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-ask-"));
  homes.push(home);
  const grok = join(home, ".grok");
  mkdirSync(grok, { recursive: true });
  writeFileSync(join(grok, "config.toml"), '[models]\ndefault = "grok-4.7"\n\n[permission]\nallow = ["Bash", "Edit"]\n');
  writeFileSync(join(grok, "auth.json"), "{}");
  return home;
}

async function turn(home: string, version: string, level: "ask" | "auto") {
  const dump = join(home, `spawn-${level}-${version.replace(/\W+/g, "_")}.json`);
  // Murage remembers a CLI's version per path for the whole process: each owner home gets its own path to the fixture.
  const ownCli = join(home, "grok-fixture.ts");
  if (!existsSync(ownCli)) symlinkSync(cli, ownCli);
  const instance = await GrokAgentDriver.create({ instanceId: `grok-ask-${level}`, displayName: "Grok", enabled: true,
    config: GrokAgentDriver.decodeConfig({ cli: ownCli, fullAuto: false }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION: version,
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" } });
  const recorder = recordEvents(instance.adapter);
  const threadId = `grok-ask-${level}-${Math.random().toString(36).slice(2)}`;
  try {
    // A turn refused before its engine starts rejects sendTurn (as an update-required grok does); one that ran completes.
    let refused: Error | undefined;
    try {
      await instance.adapter.sendTurn({ threadId, text: "write a file", cwd: home, routeAsks: true, ...(level === "ask" ? { askLevel: true as const } : {}) });
    } catch (error) { refused = error as Error; }
    const done = refused ? undefined : await recorder.until((event) => event.threadId === threadId && event.type === "turn.completed", 15000) as { ok?: boolean };
    const spawned = existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> } : undefined;
    return { done, refused, spawned };
  } finally { recorder.stop(); await instance.dispose(); }
}

describe("grok at Ask asks Murage before every shell command, edit and write", () => {
  it("the scoped config carries Murage's ask rules and none of the owner's permission rules, in one [permission] table", () => {
    expect([...GROK_ASK_RULES]).toEqual(["Bash", "Edit", "Write", "Read(**)", "Grep"]);
    const owner = [
      '[models]', 'default = "grok-4.7"', '',
      '[permission]', 'allow = ["Bash", "Edit"]', 'ask = []', '',
      '[[permission.rules]]', 'action = "allow"', 'tool = "bash"', '',
      '[ui]', 'theme = "dark"', '',
    ].join("\n");
    const out = scopedGrokConfigToml(owner, []);
    expect(out.match(/^\[permission\]$/gm)).toHaveLength(1);
    expect(out).not.toMatch(/allow = \["Bash"|permission\.rules|action = "allow"/);
    expect(out).toContain('[models]\ndefault = "grok-4.7"');
    expect(out).toContain('[ui]\ntheme = "dark"');
    expect(out.endsWith(`[permission]\n${ASK_LINE}\n`)).toBe(true);
    // dotted and quoted spellings of the owner's permission keys are dropped too
    expect(scopedGrokConfigToml('permission.allow = ["Bash"]\n"permission" . deny = []\nkeep = 1\n', ["s"])).toBe(
      `keep = 1\n\n[skills]\ndisabled = ["s"]\n\n[permission]\n${ASK_LINE}\n`);
    // with no owner config, or one the scanner cannot read, the rules are still written
    expect(scopedGrokConfigToml("", [])).toBe(`[permission]\n${ASK_LINE}\n`);
    expect(scopedGrokConfigToml('mcp_servers = { a = "unterminated\n', [])).toBe(`[permission]\n${ASK_LINE}\n`);
  });

  it("an Ask turn on a proven grok runs with the ask rules in its GROK_HOME config", async () => {
    const home = ownerHome();
    const { done, refused, spawned } = await turn(home, "grok 1.0.62 (fixture)", "ask");
    expect(refused).toBeUndefined();
    expect(done?.ok).toBe(true);
    expect(spawned).toBeTruthy();
    expect(spawned!.argv.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    const config = readFileSync(join(spawned!.env.GROK_HOME!, "config.toml"), "utf8");
    expect(config).toContain(`[permission]\n${ASK_LINE}\n`);
    expect(config).not.toContain('allow = ["Bash", "Edit"]');
    // the owner's own file is untouched
    expect(readFileSync(join(home, ".grok", "config.toml"), "utf8")).toContain('allow = ["Bash", "Edit"]');
  }, 30000);

  it("fails closed: at Ask a grok below the proven version is refused before it starts, with the plain note", async () => {
    const home = ownerHome();
    const { done, refused, spawned } = await turn(home, "grok 1.0.55 (fixture)", "ask");
    expect(done).toBeUndefined();
    expect(refused).toBeInstanceOf(AskStopRefusal);
    expect(refused?.message).toBe(ASK_STOP_GROK_OLD_NOTE);
    // only the version probe ran: grok itself (`agent ... stdio`) never started
    expect(spawned?.argv ?? ["--version"]).toEqual(["--version"]);
    expect(ASK_STOP_GROK_OLD_NOTE).not.toMatch(/—|\bsafe|unsafe|safety/i);
  }, 30000);

  it("Auto runs on that older grok as before", async () => {
    const home = ownerHome();
    const { done, refused, spawned } = await turn(home, "grok 1.0.55 (fixture)", "auto");
    expect(refused).toBeUndefined();
    expect(done?.ok).toBe(true);
    expect(spawned?.argv.slice(0, 2)).toEqual(["--permission-mode", "default"]);
  }, 30000);

  it("the version floor: unknown or older refuses at Ask only", () => {
    expect([...GROK_ASK_HOLD_MIN]).toEqual([1, 0, 62]);
    expect(() => requireGrokAskHold(true, "grok 1.0.62 (x)")).not.toThrow();
    expect(() => requireGrokAskHold(true, "grok 1.1.0")).not.toThrow();
    for (const version of ["grok 1.0.61 (x)", "", undefined, "grok"]) expect(() => requireGrokAskHold(true, version)).toThrow(ASK_STOP_GROK_OLD_NOTE);
    for (const version of ["grok 1.0.61 (x)", undefined]) expect(() => requireGrokAskHold(false, version)).not.toThrow();
  });
});
