// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fuigo 1.0.47 S1 (COMPAT-1047 C2), through the REAL route: a booted Murage server, the real fuigoAgent driver and the
// server's decision path, against a fake ACP engine that asks for an outside-workspace delete only when Murage's initialize
// said `fuigo/permissionPrompts` (as Fuigo does for a non-Generic client). What the engine was answered is read from the
// engine's own dump (FAKE_ACP_DUMP `decision`), never from Murage's side:
//   No limits: the ask is answered allow_once with no card; a wipe of a protected root still shows the Run/Don't card.
//   Auto and Ask: the same ask shows the card, and the owner's Allow reaches the engine as allow_once.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const OUTSIDE = "/srv/elsewhere/old-build";
/** The tool call shape Fuigo's S1 sends: the command plus the outside-workspace note on the title. */
const s1Ask = (command: string, path: string) => ({ toolCallId: "s1-rm", kind: "execute", rawInput: { command },
  title: `${command} — This would delete or change \`${path}\`, which is outside the workspace and was not named by you` });

let fixture: VerificationServer;
let headers: Record<string, string>;
let model = "default";
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};

beforeAll(async () => {
  const root = resolve(".");
  // The only engine is the repository fake; it reads the next ask and its dump path from files the test writes per row.
  fixture = await launchVerificationServer(process.env, undefined, {
    portRange: { from: 45300, span: 90 },
    instrumentationSource: `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      process.env.NODE_ENV = 'test';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      process.env.MURAGE_ENGINE_EXCLUSION_PATH = ${JSON.stringify(join(root, "server/testing/engine-exclusion-stub.cjs"))};
      const data = process.env.MURAGE_DATA_DIR;
      writeFileSync(join(data, 'f1047-ask'), '{}');
      writeFileSync(join(data, 'f1047-dump'), join(data, 'f1047-unused.json'));
      const cli = join(data, 'f1047-fuigo.mjs');
      writeFileSync(cli, [
        '#!/usr/bin/env -S node --experimental-strip-types',
        "import { readFileSync } from 'node:fs';",
        'process.env.FAKE_ACP_MODE = "permission";',
        'process.env.FAKE_ACP_REQUIRE_PERMISSION_PROMPTS = "1";',
        'process.env.FAKE_ACP_PERMISSION_SESSION = "1";',
        'process.env.FAKE_ACP_MCP_LIST = "all:ready";',
        'process.env.FAKE_ACP_PERMISSION_TOOLCALL = readFileSync(' + JSON.stringify(join(data, 'f1047-ask')) + ', "utf8");',
        'process.env.FAKE_ACP_DUMP = readFileSync(' + JSON.stringify(join(data, 'f1047-dump')) + ', "utf8");',
        'await import(' + JSON.stringify('file://' + ${JSON.stringify(join(root, "server/testing/"))} + 'fake-acp-cli.ts') + ');',
      ].join('\\n'), {mode: 0o755});
      mkdirSync(join(process.env.HOME, '.fuigo'), {recursive:true});
      writeFileSync(join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
      const file = join(data, 'config.json');
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      cfg.instances = { fuigo: { driver: 'fuigoAgent', config: { cli } } };
      writeFileSync(file, JSON.stringify(cfg));
    `,
  });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const instance = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === "fuigo");
  expect(instance?.snapshot?.state).toBe("available");
  const first = instance.models.options[0];
  model = instance.models.default || (typeof first === "string" ? first : first?.id || "default");
}, 120_000);

afterAll(async () => { await fixture?.close(); });

/** One row: a fresh bot (fresh thread, fresh engine process) at `level`, one turn whose engine asks `ask`. Cards are answered
 *  with `answer` through the same respond route the renderer uses. Returns the cards seen, the server's resolved behaviors
 *  and the engine's own record of what it was answered. */
async function row(level: "ask" | "auto" | "no-limits", ask: object, answer: "allow" | "deny") {
  const dump = join(fixture.info.dataDir, `f1047-dump-${level}-${Date.now()}.json`);
  writeFileSync(join(fixture.info.dataDir, "f1047-ask"), JSON.stringify(ask));
  writeFileSync(join(fixture.info.dataDir, "f1047-dump"), dump);
  let { bot } = await api("POST", "/api/bots", {});
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "fuigo", model }, computer: "off", browser: false, composio: false });
  bot = (await api("GET", `/api/bots/${bot.id}`)).bot;
  if (level === "no-limits") {
    const route = `/api/bots/${bot.id}/permissions/refresh`;
    const preview = await api("POST", route, { scope: "open", targetLevel: "no-limits" });
    const changed = await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true, fullAccess: true, noLimits: true,
      acknowledgeFullAccess: true, acknowledgeNoLimits: true, previewId: preview.previewId, ifRev: preview.botRev });
    await api("POST", route, { scope: "open", rosterId: preview.rosterId, targetLevel: "no-limits", afterRev: changed.permissionRev });
  } else await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: level === "auto", fullAccess: false });
  const { task } = await api("GET", `/api/bots/${bot.id}/tasks/${bot.threadId}`);
  expect(task.noLimits === true).toBe(level === "no-limits");
  const cards: any[] = [];
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "clean up the old build" });
  await expect.poll(async () => {
    for (const card of (await api("GET", `/api/threads/${bot.threadId}/open-cards`)).openCards ?? []) {
      const handle = card.requestHandle ?? card.card?.requestHandle;
      if (!handle || cards.some(seen => seen.handle === handle)) continue;
      cards.push({ handle, card });
      await api("POST", `/api/threads/${bot.threadId}/respond`, { requestHandle: handle, action: answer });
    }
    // the turn is over once the bot is idle and its reply is in (the dump exists from the engine's start, so it is no signal)
    const now = (await api("GET", `/api/bots/${bot.id}`)).bot;
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
    return !now.busy && messages.some(m => m.role === "bot" && m.kind === "text" && m.turnId) && existsSync(dump);
  }, { timeout: 30_000, interval: 100 }).toBe(true);
  const events = readFileSync(join(fixture.info.dataDir, "events", bot.threadId + ".ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const engine = JSON.parse(readFileSync(dump, "utf8")) as { decision?: { outcome?: { outcome?: string; optionId?: string } } };
  rmSync(dump, { force: true });
  await api("DELETE", `/api/bots/${bot.id}`);
  return { cards, resolved: events.filter(e => e.type === "request.resolved").map(e => e.behavior), opened: events.filter(e => e.type === "request.opened"), engine };
}

describe("Fuigo 1.0.47 S1 through the booted server (ASTRA High 2)", () => {
  it("No limits: the engine's outside-workspace ask reaches Murage and is answered allow_once, with no card", async () => {
    const r = await row("no-limits", s1Ask(`rm -rf ${OUTSIDE}`, OUTSIDE), "deny");
    expect(r.engine.decision?.outcome?.optionId).toBe("allow-once");
    // the ask reached the server as one request (the journal keeps no command text, only the class)
    expect(r.opened).toHaveLength(1);
    expect(r.cards).toHaveLength(0);
    expect(r.resolved).toEqual(["allow"]);
  }, 120_000);

  it("No limits: a wipe of the home folder still shows the Run/Don't card, and Don't reaches the engine as reject", async () => {
    const r = await row("no-limits", s1Ask("rm -rf ~", "~"), "deny");
    expect(r.cards).toHaveLength(1);
    expect(JSON.stringify(r.cards[0].card)).toContain('"Run"');
    expect(r.engine.decision?.outcome?.optionId).toBe("reject");
  }, 120_000);

  it("Auto: an outside-workspace delete is not auto-run; it shows the card, and Allow reaches the engine as allow_once", async () => {
    const r = await row("auto", s1Ask(`rm -rf ${OUTSIDE}`, OUTSIDE), "allow");
    expect(r.cards).toHaveLength(1);
    expect(r.engine.decision?.outcome?.optionId).toBe("allow-once");
    expect(r.resolved).toEqual(["allow"]);
  }, 120_000);

  it("Ask: the same outside-workspace ask shows the card, and the owner's Allow reaches the engine as allow_once", async () => {
    const r = await row("ask", s1Ask(`rm -rf ${OUTSIDE}`, OUTSIDE), "allow");
    expect(r.cards).toHaveLength(1);
    expect(r.engine.decision?.outcome?.optionId).toBe("allow-once");
    expect(r.resolved).toEqual(["allow"]);
  }, 120_000);
});
