import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, site: Server, url: string;
let owner: Record<string, string>, token: string, bot: { id: string; threadId: string };
let hits = 0;
const text = "Sales page café 中文 😀 ".repeat(7000) + "Guarantee. Fine print. Checkout. THE_END";
const evidence: Record<string, unknown> = {};
async function api(path: string, body: unknown, auth = owner, method = "POST") {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
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
  const evidenceDir = join(tmpdir(), "murage-webread-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "api-fixture.json"), JSON.stringify(evidence, null, 2));
  await fixture?.close();
  if (fixture) writeFileSync(join(evidenceDir, "api-server.log"), readFileSync(fixture.info.logPath));
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

it("applies the live web page reading permission to URLs and saved handles", async () => {
  const read = (input: unknown) => api("/api/internal/web-read", { fromBotId: bot.id, fromThreadId: bot.threadId, input }, { authorization: `Bearer ${token}` });
  const configure = (patch: Record<string, unknown>) => api("/api/config", { webSearch: patch }, owner, "PUT");
  const before = await read({ url });
  expect(before.status).toBe(200);
  const handle = before.body.handle;
  const beforeOff = hits;
  try {
    expect((await configure({ provider: "off" })).status).toBe(200);
    for (const input of [{ url }, { handle }]) expect(await read(input)).toMatchObject({ status: 409, body: { error: "Web page reading is off in Settings." } });
    expect(hits).toBe(beforeOff);
    expect((await configure({ readEnabled: true })).body.webSearch).toMatchObject({ provider: "off", readEnabled: false });
    expect((await read({ url })).status).toBe(409);
    expect((await configure({ provider: "engine" })).body.webSearch.readEnabled).toBe(true);
    expect((await configure({ readEnabled: false })).body.webSearch.readEnabled).toBe(false);
    expect((await read({ url })).status).toBe(409);
    expect((await read({ handle })).status).toBe(409);
    expect(hits).toBe(beforeOff);
    expect((await configure({ provider: "off" })).status).toBe(200);
    expect((await configure({ provider: "engine" })).body.webSearch.readEnabled).toBe(false);
    expect((await configure({ readEnabled: true })).body.webSearch.readEnabled).toBe(true);
    expect((await read({ handle })).status).toBe(200);
    expect((await read({ url })).status).toBe(200);
    expect(hits).toBe(beforeOff + 1);
  } finally {
    await configure({ provider: "engine" });
  }
}, 60_000);

// sv10-tools rb1124 r2: one stored page-reading switch (top-level webRead.enabled, which v1.0.20 strips), one predicate for every surface.
it("the page-reading switch saved from Web search never writes webSearch.readEnabled, so v1.0.20 can still read config.json", async () => {
  const configure = (patch: Record<string, unknown>) => api("/api/config", patch, owner, "PUT");
  const onDisk = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")) as { webSearch?: Record<string, unknown>; webRead?: { enabled?: boolean } };
  // v1.0.20's strict webSearch section, as it shipped: any other key fails the whole config load
  const v1020WebSearch = new Set(["provider", "tavilyApiKey", "exaApiKey", "firecrawlApiKey"]);
  try {
    expect((await configure({ webSearch: { readEnabled: false } })).body.webSearch.readEnabled).toBe(false);
    const stored = onDisk();
    expect(Object.keys(stored.webSearch ?? {}).filter(key => !v1020WebSearch.has(key))).toEqual([]);
    expect(stored.webRead).toEqual({ enabled: false });
    expect((await configure({ webSearch: { readEnabled: true } })).body.webSearch.readEnabled).toBe(true);
    expect(Object.keys(onDisk().webSearch ?? {}).filter(key => !v1020WebSearch.has(key))).toEqual([]);
    expect(onDisk().webRead).toEqual({ enabled: true });
  } finally { await configure({ webSearch: { provider: "engine", readEnabled: true } }); }
}, 60_000);

const surfaces = () => {
  const read = (input: unknown) => api("/api/internal/web-read", { fromBotId: bot.id, fromThreadId: bot.threadId, input }, { authorization: `Bearer ${token}` });
  const switches = async () => { const response = await fetch(fixture.info.url + `/api/internal/tool-switches?self=${bot.id}`, { headers: { authorization: `Bearer ${token}` } }); return { status: response.status, body: await response.json().catch(() => ({})) as any }; };
  const status = async () => (await (await fetch(fixture.info.url + "/api/config", { headers: owner })).json()) as any;
  const configure = (patch: Record<string, unknown>) => api("/api/config", patch, owner, "PUT");
  return { read, switches, status, configure };
};
// One predicate (Web search not Off AND the stored reading bit on): the route, the proxy switches and the status answer the same, whichever switch was turned.
it("the Web search card reading switch: the proxy switches and the refusal follow it, naming the Read web pages setting", async () => {
  const { read, switches, configure } = surfaces();
  try {
    const saved = await read({ url }); expect(saved.status).toBe(200); expect((await configure({ webSearch: { readEnabled: false } })).status).toBe(200);
    expect((await switches()).body.webRead.enabled).toBe(false);
    expect(await read({ url })).toMatchObject({ status: 409, body: { error: "Web page reading is off in Settings.", code: "web-read-off", settingRef: { id: "tools.web-read" } } });
    // the route is the authority: a page already saved is refused too, whatever the proxy-side check lets through
    expect(await read({ handle: saved.body.handle })).toMatchObject({ status: 409, body: { error: "Web page reading is off in Settings." } });
  } finally { await configure({ webSearch: { provider: "engine", readEnabled: true } }); }
}, 60_000);
it("Web search Off: the proxy switches and the route refuse reading and name Web search as the setting", async () => {
  const { read, switches, configure } = surfaces();
  try {
    const saved = await read({ url }); expect(saved.status).toBe(200); expect((await configure({ webSearch: { provider: "off" } })).status).toBe(200);
    expect((await switches()).body.webRead.enabled).toBe(false);
    const refused = await read({ url });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("web-search-off");
    expect(refused.body.settingRef).toMatchObject({ id: "tools.web-search" });
    // a saved handle is refused too: the route is the authority while reading is off
    expect(await read({ handle: saved.body.handle })).toMatchObject({ status: 409 });
  } finally { await configure({ webSearch: { provider: "engine", readEnabled: true } }); }
}, 60_000);
// Last: on a build that rebuilds the fleet for a webRead save, this save ends the running turn, so nothing after it could reach its assertions.
it("the Tools page reading switch: a save keeps the running turn, and the status, the proxy switches and the route all say off", async () => {
  const { read, switches, status, configure } = surfaces();
  try {
    expect((await configure({ webRead: { enabled: false } })).status).toBe(200);
    const afterSave = await switches();
    // saving a reading switch must not rebuild the fleet and end the running turn, or the turn's credential stops working
    expect(afterSave.status, "the running turn survives a reading-switch save").toBe(200);
    expect(afterSave.body.webRead.enabled).toBe(false);
    expect((await status()).webSearch.readEnabled).toBe(false);
    expect(await read({ url })).toMatchObject({ status: 409, body: { error: "Web page reading is off in Settings.", code: "web-read-off", settingRef: { id: "tools.web-read" } } });
  } finally { await configure({ webRead: { enabled: true }, webSearch: { provider: "engine" } }); }
}, 60_000);
