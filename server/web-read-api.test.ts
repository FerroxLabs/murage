import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, site: Server, url: string;
let owner: Record<string, string>, token: string, bot: { id: string; threadId: string };
let hits = 0;
const text = "Sales page café 中文 😀 ".repeat(7000) + "Guarantee. Fine print. Checkout. THE_END";
const evidence: Record<string, unknown> = {};
async function api(path: string, body: unknown, auth = owner) {
  const response = await fetch(fixture.info.url + path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  site = createServer((_req, res) => { hits++; res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<html><body><p>${text}</p></body></html>`); });
  await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(site.address() as { port: number }).port}/sales`;
  fixture = await launchVerificationServer(process.env);
  evidence.fixture = fixture.info;
  const { secret } = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  bot = (await api("/api/bots", { name: "Web read fixture" })).body.bot;
  expect((await api(`/api/bots/${bot.id}/messages`, { text: "__fixture_hold_authority__", threadId: bot.threadId })).status).toBe(202);
  await vi.waitFor(() => {
    try {
      const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
      token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
      expect(token).toBeTruthy();
    } catch { throw new Error("Waiting for the isolated fixture turn."); }
  }, { timeout: 45_000 });
}, 150_000);
afterAll(async () => {
  if (fixture && bot) {
    evidence.messages = await runControlMurage(["messages", "--bot", bot.id, "--url", fixture.info.url]);
    await runControlMurage(["interrupt", "--bot", bot.id, "--url", fixture.info.url]);
    evidence.wait = await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url]);
  }
  mkdirSync(".webread-evidence", { recursive: true });
  writeFileSync(".webread-evidence/api-fixture.json", JSON.stringify(evidence, null, 2));
  await fixture?.close();
  if (fixture) writeFileSync(".webread-evidence/api-server.log", readFileSync(fixture.info.logPath));
  await new Promise<void>(done => site?.close(() => done()));
}, 60_000);
it("the authenticated reader reconstructs the saved page, validates offsets and never refetches", async () => {
  const read = (input: unknown, identity = bot.id) => api("/api/internal/web-read", { fromBotId: identity, fromThreadId: bot.threadId, input }, { authorization: `Bearer ${token}` });
  const first = await read({ url });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  let page = first.body, rebuilt = "", ranges = 0;
  const receipts: unknown[] = [];
  while (true) {
    expect(page.text.length).toBeLessThanOrEqual(16000);
    rebuilt += page.text; ranges++;
    const { text: _text, ...receipt } = page; receipts.push(receipt);
    if (page.eof) break;
    page = (await read({ handle: first.body.handle, offset: page.next_offset })).body;
  }
  expect(rebuilt).toBe(text);
  expect(hits).toBe(1);
  expect(ranges).toBeGreaterThan(8);
  for (const input of [{ offset: 12000 }, { handle: first.body.handle, offset: -1 }, { handle: first.body.handle, offset: text.length + 1 }, { handle: first.body.handle, start_index: 12000 }]) {
    const invalid = await read(input); expect(invalid.status).toBe(400); expect(invalid.body.error).toBeTruthy();
  }
  expect((await read({ handle: first.body.handle }, "other-bot")).status).toBe(403);
  expect((await read({ handle: first.body.handle, offset: text.length })).body).toMatchObject({ text: "", next_offset: null, eof: true });
  evidence.reads = receipts; evidence.reconstructed = { equal: rebuilt === text, total_length: rebuilt.length, hits, tail: rebuilt.slice(-80) };
}, 60_000);
