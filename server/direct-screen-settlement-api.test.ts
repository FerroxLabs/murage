// #920 (adapted from OpenMausBot 368f653f): the direct final-screen settlement
// path, end to end, for the tool spellings that reach its poke site.
//
// Real harness, real dispatch, real screen poller and real turn-end fold. The
// only stand-ins are the fake Claude CLI (wrapped so its one tool is reported
// under the spelling under test) and a loopback stub of the cloud box API that
// hands back a synthetic frame. No provider, box, desktop, VM or user data is
// touched, and nothing outside the fixture's own temporary directories.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const BOX_TOKEN = "box_fixture_screen_settlement";

// `computer__screenshot` is the #920 spelling. `mcp__computer__screenshot` is
// what the Claude driver itself reports, and must keep settling. A shell over
// the computer server, in the same spelling, must never earn a picture.
const CASES = [
  { instanceId: "settle-server-tool", tool: "computer__screenshot", settles: true },
  { instanceId: "settle-mcp-tool", tool: "mcp__computer__screenshot", settles: true },
  { instanceId: "settle-server-shell", tool: "computer__computer_exec", settles: false },
] as const;

let fixture: VerificationServer | undefined;
let stub: Server | undefined;
let dir = "";
let headers: Record<string, string> = {};
let model = "";

/** Box id → the box record the stub lists, and how many frames it served. */
const boxes = new Map<string, { id: string; name: string; state: string }>();
const framesServed = new Map<string, number>();
const frameFor = (boxId: string) => Buffer.from(`synthetic-settled-frame:${boxId}`);

/** Mirrors server/box.ts boxNameFor: the listing is matched by this name. */
const boxNameFor = (botId: string) =>
  `muragebox-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;

const gatePath = (instanceId: string, gate: "tools" | "reply") => join(dir, `${instanceId}.${gate}.gate`);

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture!.info.url + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === botId);
const threadMessages = async (threadId: string) =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "murage-screen-settlement-"));

  stub = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${BOX_TOKEN}`) return send(401, { ok: false, code: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://box-stub");
    if (url.pathname === "/boxes") return send(200, { ok: true, boxes: [...boxes.values()] });
    const match = /^\/boxes\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
    const box = match ? boxes.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !box) return send(404, { ok: false, code: "not_found" });
    if (match[2] === undefined) return send(200, { ok: true, box });
    if (match[2] === "commands") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const command = String((JSON.parse(raw || "{}") as { command?: unknown }).command ?? "");
      return send(200, { exitCode: 0, stdout: command.includes("echo captured") ? "captured\n" : "", stderr: "" });
    }
    if (match[2] === "artifacts") {
      framesServed.set(box.id, (framesServed.get(box.id) ?? 0) + 1);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(frameFor(box.id));
    }
    return send(200, { ok: true });
  });
  await new Promise<void>((resolve) => stub!.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

  // Holds the fake engine's tool events until the test has seen the screen
  // poller capture, so the tool completion always meets a live poller, then
  // reports the one tool under the spelling this instance is testing.
  const wrapper = join(dir, "screen-claude.mjs");
  writeFileSync(wrapper, [
    'import { existsSync } from "node:fs";',
    'if (process.argv.includes("--input-format")) {',
    "  const write = process.stdout.write.bind(process.stdout);",
    "  const tool = JSON.stringify(process.env.FAKE_SCREEN_TOOL);",
    "  const gate = process.env.FAKE_SCREEN_TOOLS_GATE;",
    "  let held = false; const buffered = [];",
    "  process.stdout.write = (chunk, ...rest) => {",
    '    chunk = String(chunk).replaceAll(\'"name":"Bash"\', `"name":${tool}`);',
    '    if (held || chunk.includes(\'"type":"assistant"\')) { held = true; buffered.push([chunk, rest]); return true; }',
    "    return write(chunk, ...rest);",
    "  };",
    "  const timer = setInterval(() => {",
    "    if (!existsSync(gate)) return;",
    "    clearInterval(timer); process.stdout.write = write;",
    "    for (const [chunk, rest] of buffered) write(chunk, ...rest);",
    "  }, 10);",
    "}",
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "testing", "fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o600 });
  const cli = `"${process.execPath}" --experimental-strip-types "${wrapper}"`;
  const instances = Object.fromEntries(CASES.map(({ instanceId, tool }) => [instanceId, {
    FAKE_CLAUDE_MODE: "slow",
    FAKE_CLAUDE_REPLY_GATE: gatePath(instanceId, "reply"),
    FAKE_SCREEN_TOOL: tool,
    FAKE_SCREEN_TOOLS_GATE: gatePath(instanceId, "tools"),
  }]));

  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    process.env.MURAGE_BOX_API = ${JSON.stringify(stubUrl)};
    const fs = await import('node:fs'); const path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, environment] of Object.entries(${JSON.stringify(instances)})) {
      cfg.instances[id] = { ...cfg.instances.verification, displayName: 'Screen settlement ' + id,
        config: { ...cfg.instances.verification.config, cli: ${JSON.stringify(cli)} }, environment };
    }
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  expect((await api("PUT", "/api/config", { box: { token: BOX_TOKEN } })).status).toBe(200);
  model = (await api("GET", "/api/instances")).body.instances
    .find((instance: { instanceId: string }) => instance.instanceId === "verification").models.options[0].id;
}, 30_000);

afterAll(async () => {
  try {
    if (dir) for (const { instanceId } of CASES) {
      writeFileSync(gatePath(instanceId, "tools"), "release");
      writeFileSync(gatePath(instanceId, "reply"), "release");
    }
    if (fixture) console.info(JSON.stringify({ fixture: fixture.info }));
    await fixture?.close();
  } finally {
    await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
    if (dir) await removeTempDir(dir);
  }
});

it.each(CASES)("settles $tool into the transcript only when it touched the screen", async ({ instanceId, tool, settles }) => {
  const created = await api("POST", "/api/bots", { name: `Screen ${instanceId}`, modelSelection: { instanceId, model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  const boxId = `box-${instanceId}`;
  boxes.set(boxId, { id: boxId, name: boxNameFor(bot.id), state: "ready" });
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", browser: false, composio: false })).status).toBe(200);

  const prompt = `SETTLE ${instanceId}`;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: prompt })).status).toBe(202);
  // A frame served for this bot's box proves its turn's screen poller exists
  // before the tool completion reaches the poke site.
  await expect.poll(() => framesServed.get(boxId) ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  writeFileSync(gatePath(instanceId, "tools"), "release");
  await expect.poll(async () => (await threadMessages(bot.threadId))
    .some((message) => message.tool?.name === tool && message.tool?.ok === true), { timeout: 10_000 }).toBe(true);
  writeFileSync(gatePath(instanceId, "reply"), "release");

  // busy drops only in the settle step that runs after the final frame was
  // (or was not) inserted, so the transcript read below is the settled one.
  await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 15_000 }).toBe(false);
  const messages = await threadMessages(bot.threadId);
  // The fake engine echoes the whole dispatched prompt (memory preamble
  // included) after "reply to: ", so match the turn's terminal reply by its
  // shape and by the request it ends with.
  const reply = messages.findIndex((message) => message.kind === "text"
    && message.text?.startsWith("reply to: ") && message.text.endsWith(prompt));
  expect(reply, JSON.stringify(messages)).toBeGreaterThanOrEqual(0);
  const screens = messages.filter((message) => message.kind === "screen");
  if (!settles) {
    expect(screens).toEqual([]);
    return;
  }
  expect(screens).toHaveLength(1);
  expect(messages.indexOf(screens[0])).toBeGreaterThan(reply);
  // The page route slims pixels away; the image route serves the settled
  // frame itself, which must be the one this bot's box handed back.
  const image = await fetch(`${fixture!.info.url}/api/threads/${bot.threadId}/messages/${screens[0].id}/image`, { headers });
  expect(image.status).toBe(200);
  expect(Buffer.from(await image.arrayBuffer()).equals(frameFor(boxId))).toBe(true);
}, 45_000);
