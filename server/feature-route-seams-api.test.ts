import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// Isolated HTTP server with the fake Claude engine only. Proves the 0.1.52 K0
// route prefixes and hooks are wired through server/index.ts with the same
// surface rules as the existing desktop-only routes.
let fixture: VerificationServer, model: string, desktop: Record<string, string> = {};
const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any; try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: response.status, text, body: parsed };
};
const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
  const proof = await call("GET", "/api/desktop-secret");
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await call("GET", "/api/instances", desktop)).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("delegates workspace-file and media prefixes to their modules for the desktop only", async () => {
  // F5-T1 filled media: the bare prefix is not a route and an empty resolve
  // body is refused. R3-T1 filled workspace discovery: an unknown scope is
  // refused and the bare prefix is not a route. F4-T1 still owns write.
  const cases: Array<[string, string, unknown, number, string]> = [
    ["GET", "/api/workspace-files", undefined, 404, "not-found"],
    ["GET", "/api/workspace-files/list?botId=b&threadId=t", undefined, 404, "scope-unavailable"],
    ["POST", "/api/workspace-files/write", {}, 501, "not-implemented"],
    ["GET", "/api/media", undefined, 404, "no-such-route"],
    ["POST", "/api/media/resolve", {}, 400, "invalid-request"],
  ];
  for (const [method, path, body, status, code] of cases) {
    expect((await call(method, path, {}, body)).status, `remote ${method} ${path}`).toBe(404);
    expect((await call(method, path, { ...desktop, "x-murage-companion": "1" }, body)).status, `companion ${method} ${path}`).toBe(404);
    const owner = await call(method, path, desktop, body);
    expect(owner.status, `desktop ${method} ${path}`).toBe(status);
    if (code !== "no-such-route") expect(owner.body).toMatchObject({ code });
  }
  // Byte URLs are exempt from the desktop header (U-03 capabilities): only a
  // capability issued by resolve authorizes them (server/media-assets-http.test.ts),
  // so an unknown asset is hidden from everyone, desktop proof or not.
  expect((await call("GET", "/api/media/bytes/asset-1")).status).toBe(404);
  const head = await call("HEAD", "/api/media/bytes/asset-1");
  expect([head.status, head.text]).toEqual([404, ""]);
  expect((await call("GET", "/api/media/bytes/asset-1", desktop)).status).toBe(404);
  // A look-alike path is not captured by the prefix.
  expect((await call("GET", "/api/workspace-filesx", desktop)).status).not.toBe(501);
});

it("discovers a nested file in a conversation's managed workspace without registering it (R3-T1)", async () => {
  const created = await call("POST", "/api/bots", desktop, { name: "Discovery fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot, scope = `botId=${bot.id}&threadId=${bot.threadId}`;
  const before = await call("GET", `/api/workspace-files/root?${scope}`, desktop);
  expect(before.status).toBe(200);
  expect(before.body).toMatchObject({ state: "ready", managed: true });
  expect((await call("POST", `/api/bots/${bot.id}/messages`, desktop, { threadId: bot.threadId, text: "discovery fixture turn" })).status).toBe(202);
  await expect.poll(async () => {
    const state = (await call("GET", "/api/bots?messages=0", desktop)).body.bots.find((item: any) => item.id === bot.id);
    return state?.tasks?.find((task: any) => task.threadId === bot.threadId)?.busy;
  }, { timeout: 15000 }).toBe(false);
  const root = await call("GET", `/api/workspace-files/root?${scope}`, desktop);
  const taskWorkspace = realpathSync.native(join(fixture.info.dataDir, "workspaces", bot.id, "threads", bot.threadId));
  expect(root.body).toEqual({ scope: { botId: bot.id, threadId: bot.threadId }, state: "ready", label: "Discovery fixture", displayPath: taskWorkspace, managed: true });
  // What a shell tool would leave behind: a nested report and no register call.
  mkdirSync(join(taskWorkspace, "reports", "weekly"), { recursive: true });
  writeFileSync(join(taskWorkspace, "reports", "weekly", "result.html"), "<h1>Weekly</h1>");
  const listed = await call("GET", `/api/workspace-files/list?${scope}`, desktop);
  expect(listed.status).toBe(200);
  expect(listed.body.entries).toContainEqual(expect.objectContaining({ name: "reports", relativePath: "reports", kind: "directory", state: "local" }));
  const found = await call("GET", `/api/workspace-files/search?${scope}&query=RESULT`, desktop);
  expect(found.status).toBe(200);
  expect(found.body).toMatchObject({ incomplete: false, entries: [{ name: "result.html", relativePath: "reports/weekly/result.html", kind: "file", state: "local", bytes: 15 }] });
  expect(found.body.entries[0].revision).toMatch(/^r1\./);
  expect(found.body.entries[0]).not.toHaveProperty("producer");
  expect((await call("GET", `/api/artifacts?botId=${bot.id}`, desktop)).body.total).toBe(0);
  for (const headers of [{}, { ...desktop, "x-murage-companion": "1" }]) {
    expect((await call("GET", `/api/workspace-files/search?${scope}&query=result`, headers)).status).toBe(404);
  }
}, 30000);

it("serves resolve-image-reference only to the active turn's agents capability", async () => {
  const unauthenticated = await call("POST", "/api/internal/resolve-image-reference", {}, { source: { kind: "attachment", attachmentId: "x.png" } });
  expect(unauthenticated.status).toBe(401);
  const created = await call("POST", "/api/bots", desktop, { name: "Reference seam fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  try {
    expect((await call("POST", `/api/bots/${bot.id}/messages`, desktop, { threadId: bot.threadId, text: "__fixture_hold_authority__ reference-seam" })).status).toBe(202);
    let token = "";
    await expect.poll(() => {
      const captured = dump();
      token = captured?.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN ?? "";
      return (JSON.stringify(captured?.prompt) ?? "").includes("reference-seam") && token.length > 0;
    }, { timeout: 10000 }).toBe(true);
    const auth = { authorization: `Bearer ${token}` };
    expect((await call("GET", "/api/internal/resolve-image-reference", auth)).status).toBe(405);
    expect((await call("POST", "/api/internal/resolve-image-reference?botId=someone-else", auth, {})).status).toBe(403);
    const resolved = await call("POST", "/api/internal/resolve-image-reference", auth, { source: { kind: "workspace", relativePath: "outputs/cover.png" } });
    expect(resolved.status).toBe(501);
    expect(resolved.body).toMatchObject({ code: "not-implemented" });
    expect((await call("POST", `/api/bots/${bot.id}/interrupt`, desktop, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(async () => (await call("POST", "/api/internal/resolve-image-reference", auth, {})).status, { timeout: 10000 }).toBe(401);
  } finally {
    await call("POST", `/api/bots/${bot.id}/interrupt`, desktop, { threadId: bot.threadId });
  }
}, 30000);

it("still settles an ordinary turn through the terminal publication hook", async () => {
  const created = await call("POST", "/api/bots", desktop, { name: "Terminal hook fixture", modelSelection: { instanceId: "verification", model } });
  const bot = created.body.bot;
  expect((await call("POST", `/api/bots/${bot.id}/messages`, desktop, { threadId: bot.threadId, text: "terminal hook fixture turn" })).status).toBe(202);
  await expect.poll(async () => {
    const state = (await call("GET", "/api/bots?messages=0", desktop)).body.bots.find((item: any) => item.id === bot.id);
    return state?.tasks?.find((task: any) => task.threadId === bot.threadId)?.busy;
  }, { timeout: 15000 }).toBe(false);
  const messages = (await call("GET", `/api/threads/${bot.threadId}/messages?limit=100`, desktop)).body.messages as any[];
  expect(messages.some(message => message.role === "bot" && message.kind === "text")).toBe(true);
}, 30000);
