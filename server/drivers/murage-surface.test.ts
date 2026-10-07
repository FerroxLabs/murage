import { murageToolList } from "../testing/murage-tool-list.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { PiDriver, buildMcpServers } from "./pi.ts";
import { AntigravityDriver, antigravityMcpServers } from "./antigravity.ts";
import { recordEvents } from "../testing/events.ts";
import { ROOM_TOOLS_LINE, goalWakePrompt, projectCardPrompt } from "../project-prompt.ts";
import { chiefOfStaffSystemPrompt } from "../chief-of-staff.ts";
import { TURN_PROMPTS } from "../bot-shapes.ts";
import { murageTool } from "../murage-tool-surface.ts";

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

const cases = [
  { driver: ClaudeDriver, cli: "fake-claude-cli.ts", key: "FAKE_CLAUDE_DUMP" },
  { driver: CodexDriver, cli: "fake-codex-app-server.ts", key: "FAKE_CODEX_DUMP" },
  { driver: PiDriver, cli: "fake-pi-cli.ts", key: "FAKE_PI_DUMP" },
  { driver: AntigravityDriver, cli: "fake-agy-cli.ts", key: "FAKE_AGY_DUMP" },
];
it.each(cases)("$driver.driverKind renders the mounted MCP names in lead/member/direct prompts", async ({ driver, cli, key }) => {
  const dir = mkdtempSync(join(tmpdir(), "pf-direct-surface-"));
  const dump = join(dir, "dump.json"), mcpDump = join(dir, "mcp.json");
  const config = driver.decodeConfig({ cli: fileURLToPath(new URL(`../testing/${cli}`, import.meta.url)), fullAuto: true, permissionMode: "acceptEdits" });
  // Each branch is the driver's own decoded config, never a live CLI.
  const instance = await driver.create({ instanceId: "pf-fixture", displayName: "PF", enabled: true, config: config as never,
    environment: { HOME: dir, USERPROFILE: dir, [key]: dump, FAKE_AGY_MCP_DUMP: mcpDump } });
  const recorder = recordEvents(instance.adapter);
  const integrations = { agents: { command: process.execPath, args: ["fixture-agents"], env: {} }, ...(driver === AntigravityDriver ? {} : { memory: { command: process.execPath, args: ["fixture-memory"], env: {} } }) };
  try {
    for (const [index, text] of [ROOM_TOOLS_LINE + goalWakePrompt(true, { action: "start", title: "Ship", hasCriteria: false }), ROOM_TOOLS_LINE, TURN_PROMPTS.sectionPeers, chiefOfStaffSystemPrompt("chief", [{id:"chief",name:"Chief",chiefOfStaff:true,section:"Work"},{id:"worker",name:"Worker",section:"Work"}], true), projectCardPrompt(true,{ask:"Work on card 1: Draft",brief:"Ship"}) + ROOM_TOOLS_LINE].entries()) {
      const threadId = `pf-${index}`;
      await instance.adapter.sendTurn({ threadId, text: text + (integrations.memory ? murageTool("memory_search") : ""), cwd: dir, integrations });
      await recorder.until(event => event.threadId === threadId && event.type === "turn.completed", 15000);
      const raw = readFileSync(dump, "utf8");
      const rows = driver === PiDriver ? raw.trim().split("\n").map(line => JSON.parse(line)) : [JSON.parse(raw)];
      const last = rows.at(-1)!;
      let servers: Record<string, unknown>;
      if (driver === ClaudeDriver) servers = last.mcpConfig?.mcpServers ?? {};
      else if (driver === PiDriver) servers = rows.find(row => row.mcpConfig)?.mcpConfig.mcpServers ?? buildMcpServers({ threadId, text, integrations }) ?? {};
      else if (driver === AntigravityDriver) servers = JSON.parse(readFileSync(mcpDump, "utf8")).mcpServers ?? antigravityMcpServers(integrations);
      else servers = Object.fromEntries((last.argv as string[]).filter(value => /^mcp_servers\.[^.]+\.command=/.test(value)).map(value => [value.split(".")[1], true]));
      const mounts = { agents: Object.keys(servers).find(name => name === "agents" || name === "murage-agents"), memory: Object.keys(servers).find(name => name === "murage-memory") };
      expect(mounts.agents).toBeTruthy();
      if (integrations.memory) expect(mounts.memory).toBeTruthy();
      const shown = JSON.stringify(rows.map(row => ({ prompt: row.prompt, systemPrompt: row.systemPrompt, calls: row.calls, message: row.message })));
      for (const tool of [...text.matchAll(/\{\{murage-tool:[^:}]+:([a-z_]+)\}\}/g)].map(match => match[1]).concat(integrations.memory ? ["memory_search"] : [])) {
        expect(await murageToolList(tool.startsWith("memory_") ? "memory" : "agents", index === 0 ? "lead" : index === 1 || index === 4 ? "member" : "")).toContain(tool);
        const server = tool.startsWith("memory_") ? mounts.memory : mounts.agents;
        const expected = driver === ClaudeDriver || driver === CodexDriver ? `mcp__${server}__${tool}`
          : driver === PiDriver ? `${server}_${tool}`.replace(/-/g,"_") : `the tool "${tool}" on MCP server "${server}"`;
        expect(shown).toContain(JSON.stringify(expected).slice(1, -1));
      }
      expect(shown).not.toContain("{{murage-tool:");
    }
  } finally { recorder.stop(); await instance.dispose(); rmSync(dir, { recursive: true, force: true }); }
}, 60000);

it.each([OpenAICompatDriver, BoxAgentDriver])("$driverKind declares no mounted MCP tools", async driver => {
  const dir = mkdtempSync(join(tmpdir(), "pf-no-mcp-"));
  const instance = await driver.create({ instanceId: "pf-none", displayName: "PF", enabled: true,
    config: driver.decodeConfig({ url: "http://127.0.0.1:1", key: "fixture-only", model: "fixture" }) as never,
    environment: { HOME: dir, USERPROFILE: dir } });
  try {
    expect(instance.adapter.mcpToolSurface).toEqual({ kind: "none" });
    expect(instance.adapter.capabilities.agentsMcp).not.toBe(true);
    expect(instance.adapter.capabilities.memoryMcp).not.toBe(true);
  } finally { await instance.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

// The phone and the browser are their own servers: a reference to one of
// their tools renders against the name this driver mounts it under.
it.each([
  { driver: ClaudeDriver, cli: "fake-claude-cli.ts", key: "FAKE_CLAUDE_DUMP", phone: "mcp__phone__tap_text", browser: "mcp__browser__agent_browser_open" },
  { driver: CodexDriver, cli: "fake-codex-app-server.ts", key: "FAKE_CODEX_DUMP", phone: "mcp__murage_phone__tap_text", browser: "mcp__browser__agent_browser_open" },
  { driver: PiDriver, cli: "fake-pi-cli.ts", key: "FAKE_PI_DUMP", phone: "phone_tap_text", browser: null },
])("$driver.driverKind names the phone and browser tools under the names it mounts them as", async ({ driver, cli, key, phone, browser }) => {
  const dir = mkdtempSync(join(tmpdir(), "relfix-phone-surface-"));
  const dump = join(dir, "dump.json");
  const config = driver.decodeConfig({ cli: fileURLToPath(new URL(`../testing/${cli}`, import.meta.url)), fullAuto: true, permissionMode: "acceptEdits" });
  const instance = await driver.create({ instanceId: "relfix-fixture", displayName: "PF", enabled: true, config: config as never, environment: { HOME: dir, USERPROFILE: dir, [key]: dump } });
  const recorder = recordEvents(instance.adapter);
  const integrations = { agents: { command: process.execPath, args: ["fixture-agents"], env: {} }, phone: { command: process.execPath, args: ["fixture-phone"], env: {} },
    ...(browser ? { browser: { command: process.execPath, args: ["fixture-browser"], env: {} } } : {}) };
  try {
    const text = `Read the screen, then call ${murageTool("tap_text", "phone")}.` + (browser ? `\nOpen it with ${murageTool("agent_browser_open", "browser")}.` : "");
    await instance.adapter.sendTurn({ threadId: "relfix-phone", text, cwd: dir, integrations });
    await recorder.until(event => event.threadId === "relfix-phone" && event.type === "turn.completed", 15000);
    const raw = readFileSync(dump, "utf8");
    const rows = driver === PiDriver ? raw.trim().split("\n").map(line => JSON.parse(line)) : [JSON.parse(raw)];
    const shown = JSON.stringify(rows.map(row => ({ prompt: row.prompt, systemPrompt: row.systemPrompt, calls: row.calls, message: row.message })));
    expect(shown).toContain(phone);
    if (browser) expect(shown).toContain(browser);
    expect(shown).not.toContain("{{murage-tool:");
  } finally { recorder.stop(); await instance.dispose(); rmSync(dir, { recursive: true, force: true }); }
}, 60000);
