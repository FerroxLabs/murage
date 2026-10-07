import { murageToolList } from "../../testing/murage-tool-list.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GrokAgentDriver } from "./grok.ts";
import { FuigoAgentDriver } from "./fuigo.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { QwenAgentDriver } from "./qwen.ts";
import { HermesAgentDriver } from "./hermes.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { DroidAgentDriver } from "./droid.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { CustomAcpDriver } from "./custom.ts";
import { createOpenCodeDriver } from "./opencode-go.ts";
import { recordEvents } from "../../testing/events.ts";
import { ROOM_TOOLS_LINE, goalWakePrompt, projectCardPrompt } from "../../project-prompt.ts";
import { chiefOfStaffSystemPrompt } from "../../chief-of-staff.ts";
import { TURN_PROMPTS } from "../../bot-shapes.ts";
import { murageTool } from "../../murage-tool-surface.ts";

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const catalog = { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture" }] };
const openCode = createOpenCodeDriver(async () => catalog);
const drivers = [GrokAgentDriver, FuigoAgentDriver, KimiAgentDriver, QwenAgentDriver, HermesAgentDriver, GeminiAgentDriver, DroidAgentDriver, CursorAgentDriver, CustomAcpDriver, openCode];

it.each(drivers)("$driverKind resolves references against the real session mounts", async driver => {
  const dir = mkdtempSync(join(tmpdir(), "pf-mcp-surface-"));
  const dump = join(dir, "spawn.json"), prompt = join(dir, "prompt.json");
  const instance = await driver.create({ instanceId: "pf-surface", displayName: "PF fixture", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: true }), environment: {
      HOME: dir, USERPROFILE: dir, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_PROMPT_DUMP: prompt,
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", CURSOR_API_KEY: "fixture-only", XAI_API_KEY: "fixture-only", FUIGO_API_KEY: "sk-flux-fixture-only", OPENCODE_API_KEY: "fixture-only", FACTORY_API_KEY: "fixture-only",
    } });
  const recorder = recordEvents(instance.adapter);
  try {
    for (const [index, text] of [ROOM_TOOLS_LINE + goalWakePrompt(true, { action: "start", title: "Ship", hasCriteria: false }), ROOM_TOOLS_LINE, TURN_PROMPTS.sectionPeers, chiefOfStaffSystemPrompt("chief", [{id:"chief",name:"Chief",chiefOfStaff:true,section:"Work"},{id:"worker",name:"Worker",section:"Work"}], true), projectCardPrompt(true,{ask:"Work on card 1: Draft",brief:"Ship"}) + ROOM_TOOLS_LINE].entries()) {
      const threadId = `pf-${index}`;
      await instance.adapter.sendTurn({ threadId, text: text + murageTool("memory_search") + `\nOpen it with ${murageTool("agent_browser_open", "browser")}.`, cwd: dir,
        integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} }, memory: { command: process.execPath, args: ["fixture-memory"], env: {} }, browser:{command:process.execPath,args:["fixture-browser"],env:{}},localComputer:{command:process.execPath,args:["fixture-computer"],env:{}},custom:{notes:{command:process.execPath,args:["fixture-notes"],env:{}}} } });
      await recorder.until(event => event.threadId === threadId && event.type === "turn.completed", 15000);
      const mounted = JSON.parse(readFileSync(dump + ".mcp.json", "utf8")) as Array<{ name: string; args: string[] }>;
      const mounts = { agents: mounted.find(server => server.args.includes("fixture-agents"))?.name, memory: mounted.find(server => server.args.includes("fixture-memory"))?.name };
      expect(mounts.agents).toBeTruthy(); expect(mounts.memory).toBeTruthy();
      const shown = JSON.stringify(JSON.parse(readFileSync(prompt, "utf8")));
      for (const tool of [...text.matchAll(/\{\{murage-tool:[^:}]+:([a-z_]+)\}\}/g)].map(match => match[1]).concat("memory_search")) {
        expect(await murageToolList(tool.startsWith("memory_") ? "memory" : "agents", index === 0 ? "lead" : index === 1 || index === 4 ? "member" : "")).toContain(tool);
        const server = tool.startsWith("memory_") ? mounts.memory : mounts.agents;
        const expected = driver === FuigoAgentDriver || driver === GrokAgentDriver
          ? `use_tool with tool_name "${server}__${tool}"` : `the tool "${tool}" on MCP server "${server}"`;
        expect(shown).toContain(JSON.stringify(expected).slice(1, -1));
      }
      expect(shown).not.toContain("{{murage-tool:");
      // The browser is its own server: its tools render under its mount.
      const browser = mounted.find(server => server.args.includes("fixture-browser"))?.name;
      expect(browser).toBeTruthy();
      expect(shown).toContain(JSON.stringify(driver === FuigoAgentDriver || driver === GrokAgentDriver
        ? `use_tool with tool_name "${browser}__agent_browser_open"` : `the tool "agent_browser_open" on MCP server "${browser}"`).slice(1, -1));
      if (driver === FuigoAgentDriver || driver === GrokAgentDriver) {
        expect(shown).toContain("Murage tools are MCP tools. Call use_tool");
        for (const server of mounted) expect(shown).toContain(server.name);
        expect(shown).not.toMatch(/use (ask_bot|delegate_bot)\b/);
      }
    }
  } finally { recorder.stop(); await instance.dispose(); rmSync(dir, { recursive: true, force: true }); }
}, 60000);
