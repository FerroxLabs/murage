import { readFileSync } from "node:fs";
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
  const cases: Array<[string, string, unknown]> = [
    ["GET", "/api/workspace-files", undefined],
    ["GET", "/api/workspace-files/list?botId=b&threadId=t", undefined],
    ["POST", "/api/workspace-files/write", {}],
    ["GET", "/api/media", undefined],
    ["POST", "/api/media/resolve", {}],
  ];
  for (const [method, path, body] of cases) {
    expect((await call(method, path, {}, body)).status, `remote ${method} ${path}`).toBe(404);
    expect((await call(method, path, { ...desktop, "x-murage-companion": "1" }, body)).status, `companion ${method} ${path}`).toBe(404);
    const owner = await call(method, path, desktop, body);
    expect(owner.status, `desktop ${method} ${path}`).toBe(501);
    expect(owner.body).toMatchObject({ code: "not-implemented" });
  }
  // Byte URLs are exempt from the desktop header (U-03 capabilities) but stay
  // hidden from everyone else until F5-T1 can issue a capability.
  expect((await call("GET", "/api/media/bytes/asset-1")).status).toBe(404);
  const head = await call("HEAD", "/api/media/bytes/asset-1");
  expect([head.status, head.text]).toEqual([404, ""]);
  expect((await call("GET", "/api/media/bytes/asset-1", desktop)).status).toBe(501);
  // A look-alike path is not captured by the prefix.
  expect((await call("GET", "/api/workspace-filesx", desktop)).status).not.toBe(501);
});

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
