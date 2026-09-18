// A key saved for a new OpenAI-compatible endpoint must reach that endpoint
// only. Two loopback providers stand in for "the provider the user left" and
// "the provider the user moved to"; each records every Authorization header
// it sees, so a replacement key reaching the old host fails the test.
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

type Received = { provider: string; path: string; key: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startProviders(allowed: Record<string, string[]>) {
  const received: Received[] = [];
  const servers: Server[] = Object.keys(allowed).map((name) => createServer((req, res) => {
    const key = req.headers.authorization ?? "";
    received.push({ provider: name, path: req.url ?? "", key });
    req.resume();
    if (!allowed[name].includes(key)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid fixture credential" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-shared-model" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `${name} provider reply` } }] })}\n\ndata: [DONE]\n\n`);
  }));
  const urls = await Promise.all(servers.map(async (server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture provider has no port");
    return `http://127.0.0.1:${address.port}/v1`;
  }));
  cleanups.push(() => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(() => undefined));
  return { received, urls };
}

async function startMurage(seed: (config: Record<string, unknown>) => Record<string, unknown>) {
  // Never the live app's port: fixtures stay in their own range.
  const fixture: VerificationServer = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_799, span: 10_000 } });
  cleanups.push(() => fixture.close());
  const configPath = join(fixture.info.dataDir, "config.json");
  writeFileSync(configPath, JSON.stringify(seed(JSON.parse(readFileSync(configPath, "utf8")))));
  await fixture.restart();
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
  if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const sse: SseRecorder = await openSse(`${fixture.info.url}/api/events`, headers);
  cleanups.push(() => sse.close());
  const send = async (target: { id: string; threadId: string }, expectedReply: string) => {
    // until() also matches frames already seen; only this send's reply counts.
    const earlier = new Set(sse.frames);
    await api("POST", `/api/bots/${target.id}/messages`, { text: "Reply briefly for the endpoint test.", threadId: target.threadId });
    const replyFrame = await sse.until((frame) => !earlier.has(frame) && frame.kind === "message" && frame.threadId === target.threadId
      && frame.message?.role === "bot" && typeof frame.message?.text === "string" && frame.message.text.includes("provider reply"), 15_000);
    expect(replyFrame.message.text).toBe(expectedReply);
    const { bots } = await api("GET", "/api/bots?messages=10");
    const current = bots.find((candidate: { id: string }) => candidate.id === target.id);
    if (current?.busy) await sse.until((frame) => frame.kind === "bot" && frame.bot?.id === target.id && !frame.bot.busy
      && frame.seq > replyFrame.seq, 15_000);
  };
  return { fixture, api, send, configPath };
}

it("an engine toggle does not freeze the endpoint: a replacement key never reaches the previous provider", async () => {
  const { received, urls: [first, second] } = await startProviders({
    first: ["Bearer fixture-first-key"],
    second: ["Bearer fixture-second-key"],
  });
  const { api, send, configPath } = await startMurage((config) => ({
    ...config,
    openaiCompat: { url: first, key: "fixture-first-key" },
    instances: { ...(config.instances as object), openaiCompat: { driver: "openai-compat" } },
  }));

  // Any engine's on/off switch rewrites the instances map.
  await api("PATCH", "/api/instances/verification", { enabled: false });
  await api("PATCH", "/api/instances/verification", { enabled: true });
  const afterToggle = JSON.parse(readFileSync(configPath, "utf8"));

  // Settings: move to the second provider and paste its key.
  await api("PUT", "/api/config", { openaiCompat: { url: second, key: "fixture-second-key" } });
  const { bot } = await api("POST", "/api/bots", {
    name: "Endpoint switch fixture", modelSelection: { instanceId: "openaiCompat", model: "fixture-shared-model" },
  });
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "Reply briefly for the endpoint test.", threadId: bot.threadId });
  const deadline = Date.now() + 15_000;
  while (!received.some((request) => request.path === "/v1/chat/completions") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const chats = received.filter((request) => request.path === "/v1/chat/completions");

  expect(received.filter((request) => request.provider === "first").map((request) => request.key))
    .not.toContain("Bearer fixture-second-key");
  expect(chats).toEqual([{ provider: "second", path: "/v1/chat/completions", key: "Bearer fixture-second-key" }]);
  // The toggle wrote nothing the connection did not already own.
  expect(afterToggle.instances.openaiCompat).toEqual({ driver: "openai-compat" });
  await send(bot, "second provider reply");
}, 60_000);

// Ported from upstream #1393 (provider-key-flow.test.ts), adapted: Murage has
// no refresh-models route and refuses `instances` on /api/config, so the
// stale snapshot an older version wrote is seeded straight into config.json.
it("switching the workspace endpoint moves existing chats without changing a private connection", async () => {
  const { received, urls } = await startProviders({
    first: ["Bearer fixture-first-key", "Bearer fixture-private-key"],
    second: ["Bearer fixture-second-key"],
  });
  const privateConnection = { driver: "openai-compat", config: { url: urls[0], key: "fixture-private-key" } };
  const { api, send, fixture } = await startMurage((config) => ({
    ...config,
    openaiCompat: { url: urls[0], key: "fixture-first-key" },
    instances: {
      ...(config.instances as object),
      // What an engine toggle in 0.1.55 or earlier left behind.
      openaiCompat: { driver: "openai-compat", config: { url: urls[0] } },
      privateApi: privateConnection,
    },
  }));
  const { bot } = await api("POST", "/api/bots", {
    name: "Endpoint switch fixture", modelSelection: { instanceId: "openaiCompat", model: "fixture-shared-model" },
  });
  await send(bot, "first provider reply");

  // Settings changes the workspace fields only.
  await api("PUT", "/api/config", { openaiCompat: { url: urls[1], key: "fixture-second-key" } });
  await send(bot, "second provider reply");
  expect(received).toContainEqual({ provider: "second", path: "/v1/chat/completions", key: "Bearer fixture-second-key" });

  const { bot: privateBot } = await api("POST", "/api/bots", {
    name: "Private endpoint fixture", modelSelection: { instanceId: "privateApi", model: "fixture-shared-model" },
  });
  await send(privateBot, "first provider reply");
  expect(received).toContainEqual({ provider: "first", path: "/v1/chat/completions", key: "Bearer fixture-private-key" });
  const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  expect(disk.instances.privateApi).toEqual(privateConnection);
  expect(received.filter((request) => request.provider === "first").map((request) => request.key))
    .not.toContain("Bearer fixture-second-key");
}, 60_000);
