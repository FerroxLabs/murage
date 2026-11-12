// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

let fixture: VerificationServer | undefined;
afterAll(async () => { await fixture?.close(); });

it("ROOM-ROUTING-CONSENT Auto replies locally until the owner saves ON, then sends once", async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    portRange: { from: 45300, span: 80 },
    instrumentationSource: `
      const fs = await import('node:fs'); const path = await import('node:path');
      const configPath = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      delete config.decider;
      config.flux = { apiKey: 'sk-flux-' + 'a'.repeat(64) };
      fs.writeFileSync(configPath, JSON.stringify(config));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (String(url) !== 'https://api.fluxrouter.ai/v1/decide') return originalFetch(url, init);
        const body = JSON.parse(String(init.body));
        fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR, 'consent-decide.jsonl'), JSON.stringify(body) + '\\n');
        const ids = Object.keys(body.questions.answer.criteria);
        const choice = ids.filter(id => id !== '__everyone__')[1];
        const probabilities = Object.fromEntries(ids.map(id => [id, id === choice ? 0.9 : 0.1 / (ids.length - 1)]));
        return new Response(JSON.stringify({ answers: { answer: { type: 'choice', choice, probabilities } } }), { status: 200, headers: { 'x-flux-no-retain': 'applied' } });
      };
    `,
  });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture!.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.ok).toBe(true);
    return await response.json() as any;
  };
  const instances = await api("GET", "/api/instances");
  const model = instances.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bots: Array<{ id: string; threadId: string }> = [];
  for (const name of ["Consentone", "Consenttwo"]) {
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
    bots.push(created.bot);
    await api("PATCH", `/api/bots/${created.bot.id}`, { computer: "off", browser: false, composio: false });
  }
  const { group } = await api("POST", "/api/groups", { name: "Consent room", memberIds: bots.map(bot => bot.id), setup: { bulletin: "", defaultResponder: { kind: "auto", fallbackBotId: bots[0]!.id } } });
  const calls = () => {
    try { return readFileSync(join(fixture!.info.dataDir, "consent-decide.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const replies = async () => (await api("GET", `/api/threads/${group.threadId}/messages?limit=100`)).messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.text);
  const idle = async () => { const current = (await api("GET", "/api/bots?messages=0")).groups.find((room: any) => room.id === group.id); return !current.working && !current.busyBotId; };
  await api("POST", `/api/groups/${group.id}/messages`, { text: "Please review this first", sendId: "consent_before_123456" });
  await expect.poll(async () => (await replies()).length, { timeout: 30000 }).toBe(1);
  await expect.poll(idle, { timeout: 30000 }).toBe(true);
  expect(calls()).toHaveLength(0);
  expect((await replies()).map((message: any) => message.from.botId)).toEqual([bots[0]!.id]);
  expect((await api("GET", "/api/config")).decider).toMatchObject({ enabled: false, jobs: { roomRouting: false } });
  await api("PATCH", "/api/config", { decider: { enabled: true, jobs: { roomRouting: true } } });
  await api("POST", `/api/groups/${group.id}/messages`, { text: "Please review this next", sendId: "consent_after_123456" });
  await expect.poll(async () => (await replies()).length, { timeout: 30000 }).toBe(2);
  await expect.poll(idle, { timeout: 30000 }).toBe(true);
  expect(calls()).toHaveLength(1);
  expect((await replies()).at(-1).from.botId).toBe(bots[1]!.id);
  expect(calls()[0].state.new_message.text).toBe("Please review this next");
  expect(calls()[0].state.recent_messages.some((message: any) => message.text === "Please review this first")).toBe(true);
}, 120000);
