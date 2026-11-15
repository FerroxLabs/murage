import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { murageToolList } from "../testing/murage-tool-list.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenAICompatDriver as rawDriver } from "./openai-compat.ts";
import { bindOpenAIFixture } from "../testing/bound-openai-fixture.ts";
const OpenAICompatDriver = { ...rawDriver, create: async (...args: Parameters<typeof rawDriver.create>) => bindOpenAIFixture(await rawDriver.create(...args)) };
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { PiDriver, buildMcpServers } from "./pi.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { recordAdmittedEvents as recordEvents } from "../testing/admitted-events.ts";
import { ROOM_TOOLS_LINE, goalWakePrompt, projectCardPrompt } from "../project-prompt.ts";
import { chiefOfStaffSystemPrompt } from "../chief-of-staff.ts";
import { TURN_PROMPTS } from "../bot-shapes.ts";
import { THREAD_RECALL_LINE, murageTool } from "../murage-tool-surface.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixtureBoundTurn, fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { renderMurageTurn, PI_TOOL_SURFACE } from "../murage-tool-surface.ts";
import type { SendTurnInput } from "../contracts.ts";
const IDLE_MCP = fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url));
// Pi never runs a mounted turn (pi.ts sendTurn, pinned by pi.test.ts T-R3-PI-BOUND-MOUNT-REFUSED): its mounted turn gets the clean
// refusal, and the surface it would render is read from the actual producers (buildMcpServers, renderMurageTurn).
const PI_REFUSAL = "Murage keeps this bot's memory out of Pi's tools.";
async function piSurface(adapter: { sendTurn(turn: SendTurnInput): Promise<unknown> }, turn: SendTurnInput) {
  await expect(adapter.sendTurn(fixtureMountTurn(turn))).rejects.toThrow(PI_REFUSAL);
  const servers = (buildMcpServers(fixtureMountTurn(turn)) ?? {}) as Record<string, unknown>;
  const agents = Object.keys(servers).find(name => name === "agents" || name === "murage-agents");
  const rendered = renderMurageTurn(turn, PI_TOOL_SURFACE, { agents, memory: servers["murage-memory"] ? "murage-memory" : undefined, phone: servers.phone ? "phone" : undefined });
  return { servers, shown: JSON.stringify([{ prompt: rendered.text, systemPrompt: rendered.system }]) };
}

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
  const integrations = { agents: { command: process.execPath, args: [IDLE_MCP], env: {} }, ...(driver === AntigravityDriver ? {} : { memory: { command: process.execPath, args: [IDLE_MCP], env: {} } }) };
  try {
    for (const [index, text] of [ROOM_TOOLS_LINE + goalWakePrompt(true, { action: "start", title: "Ship", hasCriteria: false }), ROOM_TOOLS_LINE, TURN_PROMPTS.sectionPeers, chiefOfStaffSystemPrompt("chief", [{id:"chief",name:"Chief",chiefOfStaff:true,section:"Work"},{id:"worker",name:"Worker",section:"Work"}], true), projectCardPrompt(true,{ask:"Work on card 1: Draft",brief:"Ship"}) + ROOM_TOOLS_LINE].entries()) {
      const threadId = `pf-${index}`;
      const turn = { threadId, text: text + (integrations.memory ? murageTool("memory_search") : ""), cwd: dir, integrations };
      let servers: Record<string, unknown>, shown: string;
      if (driver === PiDriver) ({ servers, shown } = await piSurface(instance.adapter, turn));
      else {
        // MAIN RULING 1115-DIGEST-ADOPTED DR2: the managed Antigravity destination admits the real mounted turn.
        await instance.adapter.sendTurn(fixtureMountTurn(turn));
        expect(await recorder.until(event => event.threadId === threadId && event.type === "turn.completed", 15000)).toMatchObject({ ok: true });
        const rows = [JSON.parse(readFileSync(dump, "utf8"))];
        const last = rows.at(-1)!;
        if (driver === ClaudeDriver) servers = last.mcpConfig?.mcpServers ?? {};
        else if (driver === AntigravityDriver) servers = JSON.parse(readFileSync(mcpDump, "utf8")).mcpServers;
        else servers = Object.fromEntries((last.argv as string[]).filter(value => /^mcp_servers\.[^.]+\.command=/.test(value)).map(value => [value.split(".")[1], true]));
        shown = JSON.stringify(rows.map(row => ({ prompt: row.prompt, systemPrompt: row.systemPrompt, calls: row.calls, message: row.message })));
      }
      const mounts = { agents: Object.keys(servers).find(name => name === "agents" || name === "murage-agents"), memory: Object.keys(servers).find(name => name === "murage-memory") };
      expect(mounts.agents).toBeTruthy();
      if (integrations.memory) expect(mounts.memory).toBeTruthy();
      for (const tool of [...text.matchAll(/\{\{murage-tool:[^:}]+:([a-z_]+)\}\}/g)].map(match => match[1]).concat(integrations.memory ? ["memory_search"] : [])) {
        expect(await murageToolList(tool.startsWith("memory_") ? "memory" : "agents", index === 0 ? "lead" : index === 1 || index === 4 ? "member" : "")).toContain(tool);
        const server = tool.startsWith("memory_") ? mounts.memory : mounts.agents;
        const expected = driver === ClaudeDriver || driver === CodexDriver ? `mcp__${server}__${tool}`
          : driver === PiDriver ? `${server}_${tool}`.replace(/-/g,"_") : `the tool "${tool}" on MCP server "${server}"`;
        expect(shown).toContain(JSON.stringify(expected).slice(1, -1));
      }
      expect(shown).not.toContain("{{murage-tool:");
    }
  } finally { recorder.stop(); await instance.dispose(); removeTempDirSync(dir); }
}, 60000);

it.each(["missing", "wrong", "revoked"] as const)("Antigravity refuses %s mount authority before exposing its surface", async authority => {
  const dir = mkdtempSync(join(tmpdir(), "surface-authority-")), dump = join(dir, "dump.json");
  const config = AntigravityDriver.decodeConfig({ cli: fileURLToPath(new URL("../testing/fake-agy-cli.ts", import.meta.url)), fullAuto: true });
  const instance = await AntigravityDriver.create({ instanceId: "surface-authority", displayName: "Fixture", enabled: true, config,
    environment: { HOME: dir, USERPROFILE: dir, FAKE_AGY_DUMP: dump } });
  const recorder = recordEvents(instance.adapter);
  const fixture = consumingFixture(undefined, { threadId: "surface-authority" });
  const turn = { threadId: fixture.turn.threadId, text: ROOM_TOOLS_LINE, cwd: dir,
    integrations: { agents: { command: process.execPath, args: [IDLE_MCP], env: {} } } };
  const bound = fixtureBoundTurn({ ...turn, releaseBinding: fixture.binding });
  const before = existsSync(dump) ? readFileSync(dump, "utf8") : undefined;
  try {
    if (authority === "revoked") fixture.replace();
    const mountAdmission = authority === "missing" ? undefined : authority === "wrong"
      ? fixtureMountTurn({ ...turn, threadId: "surface-other" }).mountAdmission : bound.mountAdmission;
    await expect(instance.adapter.sendTurn({ ...bound, mountAdmission })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(recorder.events).toEqual([]);
    expect(existsSync(dump) ? readFileSync(dump, "utf8") : undefined).toBe(before);
  } finally { recorder.stop(); await instance.dispose(); fixture.close(); removeTempDirSync(dir); }
});

// MAIN RULING: 2ffd134722 adds the built-in browser to Pi and OpenAI-chat engines; Box still declares none.
it("openai-compat declares the chat-tools MCP set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-chat-mcp-"));
  const instance = await OpenAICompatDriver.create({ instanceId: "pf-chat", displayName: "PF", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:1", key: "fixture-only", model: "fixture" }) as never,
    environment: { HOME: dir, USERPROFILE: dir } });
  try {
    expect(instance.adapter.mcpToolSurface).not.toEqual({ kind: "none" });
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
    expect(instance.adapter.capabilities.memoryMcp).toBe(true);
    expect(instance.adapter.capabilities.browserMcp).toBe(true);
  } finally { await instance.dispose(); removeTempDirSync(dir); }
});

it.each([BoxAgentDriver])("$driverKind declares no mounted MCP tools", async driver => {
  const dir = mkdtempSync(join(tmpdir(), "pf-no-mcp-"));
  const instance = await driver.create({ instanceId: "pf-none", displayName: "PF", enabled: true,
    config: driver.decodeConfig({ url: "http://127.0.0.1:1", key: "fixture-only", model: "fixture" }) as never,
    environment: { HOME: dir, USERPROFILE: dir } });
  try {
    expect(instance.adapter.mcpToolSurface).toEqual({ kind: "none" });
    expect(instance.adapter.capabilities.agentsMcp).not.toBe(true);
    expect(instance.adapter.capabilities.memoryMcp).not.toBe(true);
  } finally { await instance.dispose(); removeTempDirSync(dir); }
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
  const integrations = { agents: { command: process.execPath, args: [IDLE_MCP], env: {} }, phone: { command: process.execPath, args: [IDLE_MCP], env: {} },
    ...(browser ? { browser: { command: process.execPath, args: [IDLE_MCP], env: {} } } : {}) };
  try {
    const text = `Read the screen, then call ${murageTool("tap_text", "phone")}.` + (browser ? `\nOpen it with ${murageTool("agent_browser_open", "browser")}.` : "");
    const turn = { threadId: "relfix-phone", text, cwd: dir, integrations };
    let shown: string;
    if (driver === PiDriver) ({ shown } = await piSurface(instance.adapter, turn));
    else {
      await instance.adapter.sendTurn(fixtureMountTurn(turn));
      await recorder.until(event => event.threadId === "relfix-phone" && event.type === "turn.completed", 15000);
      const rows = [JSON.parse(readFileSync(dump, "utf8"))];
      shown = JSON.stringify(rows.map(row => ({ prompt: row.prompt, systemPrompt: row.systemPrompt, calls: row.calls, message: row.message })));
    }
    expect(shown).toContain(phone);
    if (browser) expect(shown).toContain(browser);
    expect(shown).not.toContain("{{murage-tool:");
  } finally { recorder.stop(); await instance.dispose(); removeTempDirSync(dir); }
}, 60000);

// Thread recall (r6 rules 18 and 22): the memory mount carries the thread tools, and the turn text says so only for an eligible turn.
it.each(cases.slice(0, 3))("$driver.driverKind says thread recall once, only for an eligible turn with a memory mount", async ({ driver, cli, key }) => {
  const dir = mkdtempSync(join(tmpdir(), "tr-surface-"));
  const dump = join(dir, "dump.json");
  const config = driver.decodeConfig({ cli: fileURLToPath(new URL(`../testing/${cli}`, import.meta.url)), fullAuto: true, permissionMode: "acceptEdits" });
  const instance = await driver.create({ instanceId: "tr-fixture", displayName: "TR", enabled: true, config: config as never, environment: { HOME: dir, USERPROFILE: dir, [key]: dump } });
  const recorder = recordEvents(instance.adapter);
  const memory = { command: process.execPath, args: [IDLE_MCP], env: {} };
  const shownFor = async (threadId: string, extra: Record<string, unknown>) => {
    const turn = { threadId, text: `Hello ${threadId}.`, cwd: dir, ...extra } as SendTurnInput;
    if (driver === PiDriver) {
      // a mounted Pi turn refuses (see piSurface); a mount-free Pi turn still runs
      if (Object.keys((extra.integrations ?? {}) as object).length) return (await piSurface(instance.adapter, turn)).shown;
      await instance.adapter.sendTurn(turn);
      await recorder.until(event => event.threadId === threadId && event.type === "turn.completed", 15000);
      const rows = readFileSync(dump, "utf8").trim().split("\n").map(line => JSON.parse(line)).slice(-1);
      return JSON.stringify(rows.map(row => ({ prompt: row.prompt, systemPrompt: row.systemPrompt, calls: row.calls, message: row.message })));
    }
    await instance.adapter.sendTurn(fixtureMountTurn(turn));
    await recorder.until(event => event.threadId === threadId && event.type === "turn.completed", 15000);
    const rows = [JSON.parse(readFileSync(dump, "utf8"))];
    return JSON.stringify(rows.map(row => ({ prompt: row.prompt, systemPrompt: row.systemPrompt, calls: row.calls, message: row.message })));
  };
  try {
    const say = JSON.stringify(THREAD_RECALL_LINE).slice(1, -1);
    expect(await shownFor("tr-yes", { integrations: { memory }, threadRecall: true })).toContain(say);
    expect(await shownFor("tr-not-eligible", { integrations: { memory } })).not.toContain(say);
    expect(await shownFor("tr-no-mount", { integrations: {}, threadRecall: true })).not.toContain(say);
  } finally { recorder.stop(); await instance.dispose(); removeTempDirSync(dir); }
}, 60000);
it("the shipped memory proxy lists the four memory tools and the three thread tools", async () => {
  expect([...await murageToolList("memory", "")].sort()).toEqual(["memory_get", "memory_propose_correction", "memory_save", "memory_search", "thread_list", "thread_read", "thread_search"]);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
