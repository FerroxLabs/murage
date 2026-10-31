// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Grok runs `--permission-mode default` at every level, Full access included (FUIGO-SCOPE-1010 R1/R2 Medium):
// under bypassPermissions grok never asks, so neither its scoped ask rules nor Murage's guard would see a call.
// A Full access turn with no stop line and no routed asks is the one that used to bypass. Murage answers its asks
// itself, and only with a one-time allow: an allow-always would leave a standing grant in grok that answers later
// requests, Ask-level turns on the same home included, without Murage.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { GrokAgentDriver } from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) removeTempDirSync(home); });

type Spawned = { argv: string[]; env: Record<string, string>; decision?: unknown };

async function fullAccessTurn(mode: string, label: string): Promise<Spawned> {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-full-"));
  homes.push(home);
  mkdirSync(join(home, ".grok"), { recursive: true });
  // The owner's own terminal setting must not apply inside Murage either.
  writeFileSync(join(home, ".grok", "config.toml"), '[permission]\nmode = "bypassPermissions"\n');
  writeFileSync(join(home, ".grok", "auth.json"), "{}");
  const dump = join(home, "spawn.json");
  // Murage remembers a CLI's version per path for the whole process: each home gets its own path to the fixture.
  const ownCli = join(home, "grok-fixture.ts");
  symlinkSync(cli, ownCli);
  const instance = await GrokAgentDriver.create({ instanceId: `grok-full-${label}`, displayName: "Grok", enabled: true,
    config: GrokAgentDriver.decodeConfig({ cli: ownCli, fullAuto: true }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: mode, FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION: "grok 1.0.70 (fixture)",
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" } });
  const recorder = recordEvents(instance.adapter);
  const threadId = `grok-full-${label}-${Math.random().toString(36).slice(2)}`;
  try {
    // No routeAsks, no stopLine: the turn keeps the instance's fullAuto.
    await instance.adapter.sendTurn({ threadId, text: "run it", cwd: home });
    await recorder.until((event) => event.threadId === threadId && event.type === "turn.completed", 15000);
    expect(existsSync(dump)).toBe(true);
    return JSON.parse(readFileSync(dump, "utf8")) as Spawned;
  } finally { recorder.stop(); await instance.dispose(); }
}

describe("Grok Full access: `default` always, one-time allows only", () => {
  it("spawns --permission-mode default, once, and never bypassPermissions", async () => {
    const { argv } = await fullAccessTurn("happy", "argv");
    expect(argv.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    expect(argv.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).not.toContain("acceptEdits");
  }, 30000);

  it("picks allow_once even when grok lists allow_always first", async () => {
    const { decision } = await fullAccessTurn("permission-session-first", "once");
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  }, 30000);

  it("cancels when grok offers only allow_always, rather than leave a standing grant", async () => {
    const { decision } = await fullAccessTurn("permission-always-only", "always");
    expect(decision).toEqual({ outcome: { outcome: "cancelled" } });
  }, 30000);
});
