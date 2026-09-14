import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

type Bot = { id: string; threadId: string; tasks: Array<{ threadId: string; cwd?: string | null; localOutputs?: true }> };
type Card = { id: string; artifactIds?: string[] };
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result as T;
};
const identify = async () => {
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
beforeAll(async () => {
  // The only state migration is fixture-owned and happens before Store loads,
  // while the restart launcher has confirmed its previous child exited.
  const instrumentationSource = [
    "import fs from 'node:fs'; import path from 'node:path';",
    "process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';",
    "const dir = process.env.MURAGE_DATA_DIR; const seed = path.join(dir, 'b11-legacy-seed');",
    "if (fs.existsSync(seed)) { const id = fs.readFileSync(seed, 'utf8'); const file = path.join(dir, 'bots.json'); const bots = JSON.parse(fs.readFileSync(file, 'utf8')); const bot = bots.find(bot => bot.id === id); if (!bot) throw new Error('legacy fixture missing'); bot.tasks[0].cwd = null; bot.tasks[0].resumeCursors = {verification:'b11-retained-session'}; delete bot.tasks[0].localOutputs; bot.resumeCursors = {...bot.tasks[0].resumeCursors}; fs.writeFileSync(file, JSON.stringify(bots)); fs.unlinkSync(seed); }",
  ].join("\n");
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  await identify();
  await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
  console.log(`B11 isolated API ${fixture.info.url}; log ${fixture.info.logPath}`);
}, 30_000);
afterAll(async () => { await fixture?.close(); });

const createBot = async (name: string) => {
  const { bot } = await api<{ bot: Bot }>("POST", "/api/bots", { name });
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", persona: "Old instruction: save documents under ~/.sable/scratch." });
  return bot;
};
const observations = () => existsSync(join(fixture.info.dataDir, "b11-destinations.jsonl"))
  ? readFileSync(join(fixture.info.dataDir, "b11-destinations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { name: string; destination: string; cwd: string; resumed: boolean }) : [];
const cards = async (threadId: string) => (await api<{ messages: Card[] }>("GET", `/api/threads/${threadId}/messages?limit=100`)).messages.filter(message => message.artifactIds?.length);
const checkFiles = async (bot: Bot, threadId: string, expectedCards: number) => {
  await expect.poll(async () => (await cards(threadId)).length, { timeout: 10_000 }).toBe(expectedCards);
  const current = await cards(threadId);
  const ids = current.flatMap(card => card.artifactIds!);
  expect(ids).toHaveLength(expectedCards * 3);
  const root = await api<{ state: string; displayPath: string; managed: boolean }>("GET", `/api/workspace-files/root?botId=${bot.id}&threadId=${threadId}`);
  expect(root).toMatchObject({ state: "ready", managed: true });
  expect(root.displayPath).toBe(join(realpathSync.native(fixture.info.dataDir), "workspaces", bot.id, "threads", threadId));
  for (const id of ids) {
    const preview = await api<{ content: string; artifact: { relativePath: string } }>("GET", `/api/artifacts/${id}/preview`);
    expect(preview.content).toContain("B11");
    const response = await fetch(fixture.info.url + `/api/artifacts/${id}/download`, { headers });
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(readFileSync(join(root.displayPath, preview.artifact.relativePath), "utf8"));
  }
  return current;
};

it("ordinary fresh and restarted resumed Claude requests consume the current destination and preserve cards", async () => {
  const bot = await createBot("B11 direct");
  await api("PATCH", `/api/bots/${bot.id}`, { localOutputs: true, tasks: [{ threadId: bot.threadId, localOutputs: true }] });
  const initial = await api<{ bots: Bot[] }>("GET", "/api/bots?messages=0");
  expect(initial.bots.find(item => item.id === bot.id)!.tasks[0]!.localOutputs).toBeUndefined();
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Create HTML, MD and TXT files named b11-fresh" });
  const first = await checkFiles(bot, bot.threadId, 1);
  await fixture.restart(); await identify();
  expect(await cards(bot.threadId)).toEqual(first);
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Create HTML, MD and TXT files named b11-resumed" });
  await checkFiles(bot, bot.threadId, 2);
  const [fresh, resumed] = ["b11-fresh", "b11-resumed"].map(name => observations().find(item => item.name === name)!);
  expect(resumed.resumed).toBe(true);
  expect(resumed.destination).toBe(fresh.destination);
  expect(resumed.cwd).toBe(fresh.cwd);
}, 30_000);

it("legacy null CWD receives a separate durable file desk without moving the resumed engine", async () => {
  const bot = await createBot("B11 legacy");
  writeFileSync(join(fixture.info.dataDir, "b11-legacy-seed"), bot.id);
  await fixture.restart(); await identify();
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Create HTML, MD and TXT files named b11-legacy" });
  await checkFiles(bot, bot.threadId, 1);
  const observed = observations().find(item => item.name === "b11-legacy")!;
  expect(observed.resumed).toBe(true);
  expect(observed.cwd).toBe(realpathSync.native(fixture.info.dataDir));
  expect(observed.destination).not.toBe(join(observed.cwd, "outputs"));
  const state = await api<{ bots: Bot[] }>("GET", "/api/bots?messages=0");
  expect(state.bots.find(item => item.id === bot.id)!.tasks[0]).toMatchObject({ cwd: null, localOutputs: true });
  await fixture.restart(); await identify();
  await checkFiles(bot, bot.threadId, 1);
}, 30_000);

it("default room dispatch publishes in its member/thread desk and keeps the engine bot CWD", async () => {
  const bot = await createBot("B11 room member");
  const { group } = await api<{ group: { id: string; threadId: string } }>("POST", "/api/groups", { name: "B11 room", memberIds: [bot.id], setup: { bulletin: "Use ~/.sable/scratch for older work", defaultResponder: { kind: "member", botId: bot.id } } });
  await api("POST", `/api/groups/${group.id}/messages`, { threadId: group.threadId, text: "Create HTML, MD and TXT files named b11-room" });
  await checkFiles(bot, group.threadId, 1);
  const observed = observations().find(item => item.name === "b11-room")!;
  expect(observed.cwd).toBe(join(realpathSync.native(fixture.info.dataDir), "workspaces", bot.id));
  expect(observed.destination).toBe(join(observed.cwd, "threads", group.threadId, "outputs"));
}, 20_000);

it("custom root uses the same destination and explicit relative artifact registration", async () => {
  const bot = await createBot("B11 custom"), root = join(fixture.info.dataDir, "workspaces", "custom-project");
  mkdirSync(root, { recursive: true });
  await api("PATCH", `/api/bots/${bot.id}`, { cwd: root });
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Create HTML, MD and TXT files named b11-custom" });
  await expect.poll(() => observations().some(item => item.name === "b11-custom"), { timeout: 10_000 }).toBe(true);
  expect(observations().find(item => item.name === "b11-custom")!.destination).toBe(realpathSync.native(root));
  expect(await cards(bot.threadId)).toEqual([]);
  for (const extension of ["html", "md", "txt"]) {
    const { artifact } = await api<{ artifact: { id: string } }>("POST", "/api/artifacts/register", { botId: bot.id, threadId: bot.threadId, relativePath: `b11-custom.${extension}` });
    expect((await api<{ content: string }>("GET", `/api/artifacts/${artifact.id}/preview`)).content).toContain("B11");
  }
}, 20_000);
