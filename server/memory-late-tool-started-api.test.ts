// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OPENAI-TOOLS-109 rev 5, H1: a turn that already started a tool and is then refused over memory at a later submission (openai-chat
// submits once per round, so the fence runs again after a tool call) is never rebuilt: a rebuild would repeat the steps it already
// dispatched. It ends with the card, on a direct turn (toolStartedTurns) and on a room member's turn (its own subscriber flag) alike.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, gate: string, dump: string, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const rows = () => existsSync(dump) ? readFileSync(dump, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

describe.skipIf(process.platform === "win32")("memory refusal at a late submission after a tool started", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.handbacktool={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_TOOL_FIRST:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'tool-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'tool-dump')}};
      cfg.instances.handbacktoolteardown={driver:'fakeLateTerminal',environment:{...cfg.instances.handbacktool.environment,FAKE_LATE_TEARDOWN:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "tool-gate"); dump = join(fixture.info.dataDir, "tool-dump");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  // teardown: the engine ends a turn by closing its child (awaitTurnTeardown), so the direct release runs after the terminal fold
  // forgot the turn's tool flag; the flag must already be read (Astra code-r1 H1).
  for (const [room, teardown] of [[false, false], [true, false], [false, true]] as const) it(`${room ? "room" : "direct"}${teardown ? " (awaited teardown)" : ""}: the refused turn is carded once and never dispatched again`, async () => {
    for (const file of [gate, `${gate}.waiting`]) rmSync(file, { force: true });
    const bot = (await api("POST", "/api/bots", { name: `Tool first ${room ? "room" : "direct"}${teardown ? " teardown" : ""}`, modelSelection: { instanceId: teardown ? "handbacktoolteardown" : "handbacktool", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = room ? (await api("POST", "/api/groups", { name: "Tool first room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    const threadId = group?.threadId ?? bot.threadId;
    await api("POST", room ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`, { threadId, text: "write the file" });
    // the id is back, the tool ran on the gate's release, and the next write is refused: the revoke lands now
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    await api("PATCH", `/api/bots/${bot.id}`, { section: "Revoke after the tool" });
    writeFileSync(gate, "");
    const messages = async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[]);
    const card = (message: any) => /could not start this reply/.test(`${message.text ?? ""} ${message.tool?.name ?? ""}`);
    await expect.poll(async () => (await messages()).some(card), { timeout: 20000 }).toBe(true);
    // a rebuild would dispatch again (and wait on a fresh gate): give it the time it would take, then count
    await new Promise(resolve => setTimeout(resolve, 1500));
    const mine = rows().filter(row => row.threadId === threadId);
    expect(mine.filter(row => !row.prompt && !row.tool)).toHaveLength(1);
    expect(mine.filter(row => row.tool)).toHaveLength(1);
    expect(mine.filter(row => row.prompt)).toHaveLength(0);
    expect(existsSync(`${gate}.waiting`)).toBe(false);
    const all = await messages();
    expect(all.filter(card)).toHaveLength(1);
    expect(all.some(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late")).toBe(false);
    // the raw code never reaches the person (what they read: the text and the card line)
    expect(all.some(message => /MEMORY_CONTEXT_REVOKED|submission_refused/.test(`${message.text ?? ""} ${message.tool?.name ?? ""}`))).toBe(false);
  }, 60000);
});
