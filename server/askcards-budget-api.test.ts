// Ordinary engine calls must reach the owner's cards at Ask, even when an
// unrelated integration has a conservative permission backstop.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const { DEV_COMMANDS } = await import(new URL("../scripts/smoothness/smooth-config.mjs", import.meta.url).href) as { DEV_COMMANDS: readonly string[] };

const budgets = JSON.parse(readFileSync(new URL("../scripts/smoothness/budgets.json", import.meta.url), "utf8")).rows;
const budget = (id: string): number => {
  const row = budgets.find((row: { id: string }) => row.id === id);
  expect(row?.op).toBe("==");
  return row.value;
};
const engines = { claude: "claudeAgent", codex: "codex", fuigo: "fuigoAgent", grok: "grokAgent" };
let fixture: VerificationServer;
let headers: Record<string, string>;
let models: Record<string, string>;
const evidence: unknown[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(fixture.info.url + path, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};

beforeAll(async () => {
  const root = resolve(".");
  // Every configured CLI is a repository fake. The fixture owns its HOME,
  // data, port and child; the ordinary shell commands are never executed.
  fixture = await launchVerificationServer(process.env, undefined, {
    portRange: { from: 45100, span: 90 },
    instrumentationSource: `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      process.env.NODE_ENV = 'test';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      process.env.MURAGE_ENGINE_EXCLUSION_PATH = ${JSON.stringify(join(root, "server/testing/engine-exclusion-stub.cjs"))};
      const data = process.env.MURAGE_DATA_DIR;
      const commandFile = join(data, 'askcards-command');
      writeFileSync(commandFile, 'git status');
      const instances = {};
      for (const [id, driver] of Object.entries(${JSON.stringify(engines)})) {
        const target = id === 'claude' ? 'fake-claude-cli.ts' : id === 'codex' ? 'fake-codex-app-server.ts' : 'fake-acp-cli.ts';
        const cli = join(data, 'askcards-' + id + '.mjs');
        const body = [
          '#!/usr/bin/env -S node --experimental-strip-types',
          "import { readFileSync } from 'node:fs';",
          'const command = readFileSync(' + JSON.stringify(commandFile) + ', "utf8");',
          'process.env.FAKE_ACP_MODE = "permission";',
          'process.env.FAKE_ACP_PERMISSION_COMMAND = command;',
          'process.env.FAKE_ACP_PERMISSION_SESSION = "1";',
          'process.env.FAKE_ACP_MCP_LIST = "all:ready";',
          'process.env.FAKE_CLAUDE_PERM_TOOL = "Bash";',
          'process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({command});',
          'process.env.FAKE_CODEX_VERSION = "codex-cli 0.163.0";',
          'process.env.FAKE_CODEX_TOOLS = JSON.stringify([{kind:"shell",id:"card-budget",command}]);',
          'await import(' + JSON.stringify('file://' + ${JSON.stringify(join(root, "server/testing/"))} + target) + ');',
        ].join('\\n');
        writeFileSync(cli, body, {mode: 0o755});
        instances[id] = { driver, config: {cli} };
      }
      // Synthetic signed-in state, as in the smoothness fake fixture.
      mkdirSync(join(process.env.HOME, '.fuigo'), {recursive:true});
      writeFileSync(join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
      const file = join(data, 'config.json');
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      cfg.instances = instances;
      writeFileSync(file, JSON.stringify(cfg));
    `,
  });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const list = (await api("GET", "/api/instances")).instances;
  models = Object.fromEntries(Object.keys(engines).map(id => {
    const instance = list.find((i: any) => i.instanceId === id);
    expect(instance?.snapshot?.state, id).toBe("available");
    const first = instance.models.options[0];
    return [id, instance.models.default || (typeof first === "string" ? first : first?.id || "default")];
  }));
}, 120000);

afterAll(async () => {
  if (process.env.ASKCARDS_EVIDENCE_DIR) {
    mkdirSync(process.env.ASKCARDS_EVIDENCE_DIR, { recursive: true });
    if (fixture) writeFileSync(join(process.env.ASKCARDS_EVIDENCE_DIR, "server.log"), readFileSync(fixture.info.logPath));
    writeFileSync(join(process.env.ASKCARDS_EVIDENCE_DIR, "driver-counts.json"), JSON.stringify({ log: fixture?.info.logPath, evidence }, null, 2));
  }
  await fixture?.close();
});

for (const engine of Object.keys(engines)) for (const level of ["ask", "auto", "full", "unlimited"] as const) {
  it(`${engine} ${level}: all ten development commands reach the level's card budget`, async () => {
    const turns: any[] = [];
    const row = { engine, level, cards: 0, turns };
    evidence.push(row);
    for (const command of DEV_COMMANDS) {
      writeFileSync(join(fixture.info.dataDir, "askcards-command"), command);
      // A new bot also gives retained CLI processes a fresh session/config for
      // this exact command; a warm fake must not repeat the previous command.
      let { bot } = await api("POST", "/api/bots", {});
      await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine, model: models[engine] },
        computer: "off", browser: false, composio: false });
      bot = (await api("GET", `/api/bots/${bot.id}`)).bot;
      if (level === "full" || level === "unlimited") {
        const targetLevel = level === "unlimited" ? "no-limits" : "full";
        const route = `/api/bots/${bot.id}/permissions/refresh`;
        const preview = await api("POST", route, { scope: "open", targetLevel });
        const changed = await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true,
          fullAccess: true, acknowledgeFullAccess: true, ...(level === "unlimited" ? { noLimits: true, acknowledgeNoLimits: true } : {}), previewId: preview.previewId, ifRev: preview.botRev });
        await api("POST", route, { scope: "open", rosterId: preview.rosterId, targetLevel, afterRev: changed.permissionRev });
      } else await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: level === "auto", fullAccess: false });
      const { task } = await api("GET", `/api/bots/${bot.id}/tasks/${bot.threadId}`);
      expect(task.autoApprove === true).toBe(level !== "ask");
      expect(task.fullAccess === true).toBe(level === "full" || level === "unlimited");
      expect(task.noLimits === true).toBe(level === "unlimited");
      const seen = new Set<string>();
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId,
        text: engine === "claude" ? "__fixture_permission_tool__" : `Run exactly: ${command}` });
      let messages: any[] = [];
      await expect.poll(async () => {
        const open = await api("GET", `/api/threads/${bot.threadId}/open-cards`);
        for (const card of open.openCards ?? []) {
          const requestId = card.requestId ?? card.card?.requestId;
          if (!requestId || seen.has(requestId)) continue;
          seen.add(requestId);
          await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" });
        }
        const now = (await api("GET", `/api/bots/${bot.id}`)).bot;
        messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
        return !now.busy && messages.some(m => m.role === "bot" && m.kind === "text" && m.turnId);
      }, { timeout: 20000, interval: 50 }).toBe(true);
      const events = readFileSync(join(fixture.info.dataDir, "events", bot.threadId + ".ndjson"), "utf8")
        .trim().split("\n").map(line => JSON.parse(line));
      const decisions = events.filter(e => e.type === "request.resolved").map(e => e.behavior);
      turns.push({ command, cards: seen.size, decisions, task: { autoApprove: task.autoApprove, fullAccess: task.fullAccess, noLimits: task.noLimits }, errors: messages.filter(m => m.kind === "error"), messages });
      row.cards += seen.size;
      // Keep the isolated workspace below its bot limit across all drivers.
      await api("DELETE", `/api/bots/${bot.id}`);
    }
    // Collect every command before asserting so a broken first card cannot hide
    // the remaining nine approval decisions in the historical reproduction.
    for (const turn of turns) {
      expect.soft(turn.decisions, `${engine}/${level}/${turn.command}: never silently deny`).not.toContain("deny");
      expect.soft(turn.decisions, `${engine}/${level}/${turn.command}: engine accepted Allow`).toEqual(["allow"]);
      expect.soft(turn.errors, turn.command).toEqual([]);
    }
    const cards = turns.reduce((n, turn) => n + turn.cards, 0);
    // S4 budgets the ten-command Ask/Full runs. S10 budgets ordinary Auto
    // tasks for its three engines; Grok uses their common zero-card bound.
    const expected = level === "ask" ? budget("S4.ask") : level === "full" ? budget("S4.full") : level === "unlimited" ? budget("S4.unlimited")
      : budget(`S10.auto.${engine === "grok" ? "fuigo" : engine}`);
    expect(DEV_COMMANDS.length).toBe(budget("S4.ask"));
    expect(cards).toBe(expected);
    if (level === "ask") {
      expect(turns.every(turn => turn.cards === 1)).toBe(true);
      expect(turns.filter(turn => turn.cards > 0).length).toBe(budget("S10.askShell"));
    }
  }, 240000);
}

for (const engine of Object.keys(engines)) {
  it(`${engine} unlimited: the wipe check still asks and Deny reaches the engine`, async () => {
    const command = "rm -rf /";
    writeFileSync(join(fixture.info.dataDir, "askcards-command"), command);
    let { bot } = await api("POST", "/api/bots", {});
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine, model: models[engine] },
      computer: "off", browser: false, composio: false });
    bot = (await api("GET", `/api/bots/${bot.id}`)).bot;
    const route = `/api/bots/${bot.id}/permissions/refresh`;
    const preview = await api("POST", route, { scope: "open", targetLevel: "no-limits" });
    const changed = await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true,
      fullAccess: true, noLimits: true, acknowledgeFullAccess: true, acknowledgeNoLimits: true,
      previewId: preview.previewId, ifRev: preview.botRev });
    await api("POST", route, { scope: "open", rosterId: preview.rosterId, targetLevel: "no-limits", afterRev: changed.permissionRev });
    const { task } = await api("GET", `/api/bots/${bot.id}/tasks/${bot.threadId}`);
    expect([task.autoApprove, task.fullAccess, task.noLimits]).toEqual([true, true, true]);
    const seen = new Set<string>();
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId,
      text: engine === "claude" ? "__fixture_permission_tool__" : `Run exactly: ${command}` });
    await expect.poll(async () => {
      const open = await api("GET", `/api/threads/${bot.threadId}/open-cards`);
      for (const card of open.openCards ?? []) {
        const requestId = card.requestId ?? card.card?.requestId;
        if (!requestId || seen.has(requestId)) continue;
        seen.add(requestId);
        await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "deny" });
      }
      const now = (await api("GET", `/api/bots/${bot.id}`)).bot;
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
      return !now.busy && messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.turnId);
    }, { timeout: 20000, interval: 50 }).toBe(true);
    const events = readFileSync(join(fixture.info.dataDir, "events", bot.threadId + ".ndjson"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    const decisions = events.filter(e => e.type === "request.resolved").map(e => e.behavior);
    evidence.push({ engine, level: "unlimited-wipe", cards: seen.size, turns: [{ command, decisions }] });
    expect(seen.size).toBe(1);
    expect(decisions).toEqual(["deny"]);
    await api("DELETE", `/api/bots/${bot.id}`);
  }, 30000);
}
