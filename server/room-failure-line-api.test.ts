// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 room transcript fix, F9: a room member whose turn fails used to leave only a tool
// row under its own name, which a room with tool calls hidden could fold
// away, so the owner saw silence. The room now gets one line from Murage
// (no sender) saying who could not answer and why.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);

posixOnly("a room member's failed turn", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piErr={driver:'piAgent',displayName:'Failing pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},environment:{FAKE_PI_MODE:'turn-error'}};
      cfg.instances.acpPartial={driver:'grokAgent',displayName:'Partial fixture',environment:{FAKE_ACP_MODE:'fail-after-text'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("posts one line from Murage, with no sender, that tool-call folding never hides", async () => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piErr").models.options;
    const created = await api("POST", "/api/bots", { name: "Finch", modelSelection: { instanceId: "piErr", model: models[0].id } });
    const finch = created.body.bot as { id: string };
    expect((await api("PATCH", `/api/bots/${finch.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const room = (await api("POST", "/api/groups", { name: "Closing", memberIds: [finch.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: finch.id } } })).body.group as { id: string; threadId: string };

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Can you show me the closing machine now?" })).status).toBe(202);
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await messages(room.threadId)).filter(message => message.kind === "activity" && !message.from && message.tool?.name?.startsWith("Finch could not answer: ")).length, { timeout: 10000 }).toBe(1);
    const thread = await messages(room.threadId);
    const line = thread.find(message => message.kind === "activity" && !message.from && message.tool?.name?.startsWith("Finch could not answer: "));
    expect(line.tool).toMatchObject({ ok: false, name: "Finch could not answer: Invalid schema for function 'computer_browser_prepare'" });
    // nothing under Finch's name reads as a reply
    expect(thread.some(message => message.kind === "text" && message.from?.botId === finch.id)).toBe(false);
    // ok:false: the transcripts never fold a failed row into a run of tool
    // calls (src/lib/activity-runs.ts foldable), so it shows with them hidden
    expect(line.tool.name).not.toMatch(/—|\bsafe/i);
  }, 60000);

  it("says so when a member stopped partway, keeping what it did say", async () => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "acpPartial").models.options;
    const dax = (await api("POST", "/api/bots", { name: "Dax", modelSelection: { instanceId: "acpPartial", model: models[0]?.id } })).body.bot as { id: string };
    expect((await api("PATCH", `/api/bots/${dax.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const room = (await api("POST", "/api/groups", { name: "Ops", memberIds: [dax.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: dax.id } } })).body.group as { id: string; threadId: string };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Status on the sweep?" })).status).toBe(202);
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await messages(room.threadId)).filter(message => message.kind === "activity" && !message.from && message.tool?.name?.startsWith("Dax stopped before finishing: ")).length, { timeout: 10000 }).toBe(1);
    expect((await messages(room.threadId)).some(message => message.kind === "text" && message.from?.botId === dax.id && message.text)).toBe(true);
  }, 60000);
});
