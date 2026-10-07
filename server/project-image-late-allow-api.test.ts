// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// imgflux report, confirmed here on a real server: a project card run asks
// for an image and waits on the owner's approval card (project-held, no
// timer). The engine gives up on the tool call (its own tool timeout; live,
// the proxy's ceiling), the turn goes on and ends, and then the owner clicks
// Allow. That card showed "allowed" and no image was made. Now it
// closes as expired with a plain line, and nothing is sent to the provider.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
const CLOSED_LINE = "Couldn't deliver that answer. The request is no longer open, so the action was not run.";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const bank = JSON.stringify([{ id: "c-openai", preset: "openai", label: "Fixture OpenAI", enabled: true, key: "sk-proj-FAKE_LATE_ALLOW", revision: "r1" }]);
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const imageRequests = () => { const file = join(fixture.info.dataDir, "network.log"); return (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter(url => /\/images/.test(url)); };

beforeAll(async () => {
  chmodSync(FAKE_ACP, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_MODEL_PROVIDER_CONNECTIONS: bank } as Record<string, string>, instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{ const url=String(input instanceof Request?input.url:input); if(url.startsWith('https://')){ fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'network.log'),url+'\\n'); return Promise.reject(new Error('External network blocked in this test')); } return originalFetch(input,init); };
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.imager={driver:'grokAgent',displayName:'Image fixture',environment:{FAKE_ACP_MODE:'project-image',FAKE_ACP_MCP_TIMEOUT_MS:'4000'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);
afterAll(async () => { await fixture?.close(); });

it("a late Allow on a project-held image card whose call ended closes the card as expired, with a plain line, and makes nothing", async () => {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "imager");
  const made = await api("POST", "/api/bots", { name: "Pax", modelSelection: { instanceId: "imager", model: instance.models.options[0]?.id || instance.models.default || "fixture-model" } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const bot = made.body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  const group = (await api("POST", "/api/groups", { name: "Images", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Make a cube" } })).status).toBe(200);
  const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "late-allow", title: "Cube image", assigneeBotId: bot.id, writes: false })).body.card;
  const started = await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const board = async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: any) => entry.id === card.id);
  await expect.poll(async () => (await board())?.deskThreadId, { timeout: 30000 }).toBeTruthy();
  const desk = (await board()).deskThreadId as string;
  const approval = async () => (await api("GET", `/api/threads/${desk}/messages`)).body.messages.find((message: any) => message.card?.tool === "generate_image");
  await expect.poll(async () => (await approval())?.card?.requestId, { timeout: 30000 }).toMatch(/^image-/);
  const requestId = (await approval()).card.requestId;
  // the call ends (the owner interrupts the card, or its turn ends first)
  const now = await board();
  if (now.requestId) {
    const interrupted = await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: now.revision, action: "interrupt" });
    expect([200, 409], JSON.stringify(interrupted.body)).toContain(interrupted.status);
  }
  await expect.poll(async () => (await board())?.requestId ?? null, { timeout: 30000 }).toBeNull();
  // on this fake engine the call can end at once (its turn capability is
  // gone within a second of the card, so the card may close before the
  // answer); either way a late Allow never reads as allowed and makes nothing
  const answered = await api("POST", `/api/bots/${bot.id}/respond`, { threadId: desk, requestId, behavior: "allow" });
  expect(answered.status).toBe(200);
  expect(answered.body.outcome).toBe("unavailable");
  const closed = await approval();
  expect(closed.card.answered).not.toBe("allow");
  const messages = (await api("GET", `/api/threads/${desk}/messages`)).body.messages;
  expect(messages.filter((message: any) => message.tool?.name === CLOSED_LINE)).toHaveLength(1);
  expect(messages.some((message: any) => message.kind === "image" || (message.artifactIds?.length ?? 0) > 0)).toBe(false);
  expect(imageRequests()).toEqual([]);
}, 90000);
