// An Auto room never lets the decision model override a pinned room-call hand-down: the pin
// travels with the send, so the router must not run and must not replace the pinned member or
// fan out to everyone. A stub decision service on loopback answers "everyone" to every question,
// which is what would have started both members before the fix. Real server, fake Claude CLI.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, stub: Server, stubHits = 0;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const replies = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[]).filter(m => m.role === "bot" && m.kind === "text" && m.text);
const createBot = async (name: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((e: any) => e.instanceId === "verification").models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

posixOnly("auto room with a pinned responder", () => {
  beforeAll(async () => {
    stub = createServer((request, response) => {
      stubHits++;
      request.resume();
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ answers: { answer: { type: "choice", choice: "__everyone__", probabilities: { __everyone__: 0.97 } } } }));
      });
    });
    await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 44_900, span: 90 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.decider={enabled:true,provider:'flux',jobs:{roomRouting:true},byoKey:'test-key',baseUrl:'http://127.0.0.1:${port}'};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); await new Promise(resolve => stub?.close(resolve)); });

  const makeRoom = async () => {
    const first = await createBot("Autoone"), pinned = await createBot("Autotwo");
    const created = await api("POST", "/api/groups", { name: "Auto pin room", memberIds: [first.id, pinned.id], setup: { bulletin: "", defaultResponder: { kind: "auto" } } });
    expect(created.status).toBe(201);
    return { first, pinned, room: created.body.group as { id: string; threadId: string } };
  };
  const idle = (id: string) => async () => { const g = (await api("GET", "/api/bots?messages=0")).body.groups.find((x: any) => x.id === id); return !g.working && !g.busyBotId; };

  it("a pinned send with no mention reaches only the pinned member, though the router would pick everyone", async () => {
    const { first, pinned, room } = await makeRoom();
    // Control: an unpinned, unaddressed send is routed by the (stub) decision model to everyone.
    const control = await api("POST", `/api/groups/${room.id}/messages`, { text: "status please", sendId: "auto_ctrl_123456" });
    expect(control.status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 30000 }).toBe(2);
    await expect.poll(idle(room.id), { timeout: 30000 }).toBe(true);
    expect(stubHits).toBeGreaterThan(0);
    const before = (await replies(room.threadId)).length;
    const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "what is the plan", responderId: pinned.id, sendId: "auto_pin_1234567" });
    expect(sent.status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 30000 }).toBeGreaterThan(before);
    await expect.poll(idle(room.id), { timeout: 30000 }).toBe(true);
    const after = (await replies(room.threadId)).slice(before);
    expect(after.map(m => m.from.botId)).toEqual([pinned.id]);
    expect(after.some(m => m.from.botId === first.id)).toBe(false);
  }, 120000);
});
