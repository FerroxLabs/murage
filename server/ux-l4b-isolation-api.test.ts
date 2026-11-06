// UX-L4B-FULL 1.0.19 slice 1, tests 11 and 16 (designs/UX-L4B-FULL-1018.md 9.5), through the real server and the fake ACP CLI (no Flux key):
// the help panel's question (`noSteer: true`) is an isolated run that no owner send steers into, and Remove from line says why it
// found nothing to remove. Same server-spawn pattern as fuigo-steer-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";
// L4B-PHONE-TURNSTATE (1.0.20): this launch's companion secret, so the paired phone's door proof reads real turn states here too
const COMPANION = "c".repeat(64);
const phone = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION, "x-murage-door-token": COMPANION };

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...desktopHeaders, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const busy = async (botId: string) => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy;
/** Prompts the instance's engine received, across respawns: an ACP engine runs per turn (spawn, answer, close), so a per-process
 * dump (FAKE_ACP_RPC_DUMP) holds only the latest child's methods and can never count a second turn. FAKE_ACP_RPC_LOG appends. */
const prompts = (instance: string) => {
  const log = join(home, `${instance}-rpc.log`);
  return (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method: string }).method) : [])
    .filter((method) => method === "session/prompt").length;
};
const userCopies = async (threadId: string, text: string) => (await messages(threadId)).filter((m) => m.role === "user" && m.text === text);

async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  const instance = (name: string, interject: string) => ({
    driver: "fuigoAgent",
    environment: {
      FAKE_ACP_MODE: "echo-gated",
      FAKE_ACP_GATE_FILE: join(homeDir, `${name}.gate`),
      FAKE_ACP_RPC_LOG: join(homeDir, `${name}-rpc.log`),
      FAKE_ACP_INTERJECT: interject,
      FAKE_ACP_LATE_ECHO_MS: "1500",
    },
    config: { cli: FAKE_ACP, fullAuto: false },
  });
  writeFileSync(
    join(homeDir, ".murage", "config.json"),
    JSON.stringify({ engineDiscovery: "explicit", instances: { fuigo: instance("fuigo", "fallback") } }),
  );
  const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: homeDir,
      USERPROFILE: homeDir,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_COMPANION_TOKEN: COMPANION,
      MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      MURAGE_FUIGO_INTERJECT_ACK_MS: "500",
      MURAGE_FUIGO_FALLBACK_GRACE_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (stderr += c));
  proc.stdout!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  return { child: proc, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

async function newBot(name: string): Promise<{ id: string; threadId: string }> {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}

posixOnly("the help question is a turn of its own (UX-L4B-FULL 9.2, 9.4)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-l4b-iso-"));
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("test 11 + 16: an owner send on a steering engine waits behind the help turn and runs after it; Remove from line names its state", async () => {
    const bot = await newBot("Help isolation");
    const help = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "What does this screen do?", noSteer: true, sendId: "help-question-0001" });
    expect(help.status, JSON.stringify(help.body)).toBe(202);
    expect(help.body).toMatchObject({ queued: true });
    // the drain starts it as its own turn, held at the engine's gate
    await expect.poll(() => prompts("fuigo"), { timeout: 30_000 }).toBe(1);
    expect(await busy(bot.id)).toBe(true);

    // an ordinary owner send, on an engine that can steer: queued, never steered into the help turn
    const other = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Also check the totals", sendId: "owner-send-000001" });
    expect(other.status, JSON.stringify(other.body)).toBe(202);
    expect(other.body.steered).toBeUndefined();
    expect(other.body).toMatchObject({ queued: true });
    expect(await userCopies(bot.threadId, "Also check the totals")).toHaveLength(0);

    // a second help question waits too, and Remove from line takes it out; then says why it found nothing (9.4)
    const second = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "And this button?", noSteer: true, sendId: "help-question-0002" });
    expect(second.body).toMatchObject({ queued: true });
    expect(await request("DELETE", `/api/bots/${bot.id}/queue/${second.body.queueId}`)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await request("DELETE", `/api/bots/${bot.id}/queue/${second.body.queueId}`)).toMatchObject({ status: 404, body: { state: "cancelled" } });
    expect(await request("DELETE", `/api/bots/${bot.id}/queue/no-such-queue-id`)).toMatchObject({ status: 404, body: { state: "missing" } });
    const started = await request("DELETE", `/api/bots/${bot.id}/queue/${help.body.queueId}`);
    expect(started).toMatchObject({ status: 404, body: { state: "started" } });
    expect(typeof started.body.messageId).toBe("string");

    // turn state (GET /api/bots/:id/turn-state?threadId&sendId&turnId, owner surfaces only): the help question runs (its turn is the
    // server's own dispatchedIn), the owner's send waits, a removed or unknown send is "unknown" (never "ended"), no owner proof is refused
    await expect.poll(async () => (await userCopies(bot.threadId, "What does this screen do?"))[0]?.dispatchedIn, { timeout: 30_000 }).toBeTruthy();
    const helpTurn = (await userCopies(bot.threadId, "What does this screen do?"))[0].dispatchedIn as string;
    const turnState = (sendId: string, turnId?: string) =>
      request("GET", `/api/bots/${bot.id}/turn-state?${new URLSearchParams({ threadId: bot.threadId, sendId, ...(turnId ? { turnId } : {}) })}`);
    expect(await turnState("help-question-0001")).toEqual({ status: 200, body: { state: "running" } });
    expect(await turnState("owner-send-000001")).toEqual({ status: 200, body: { state: "queued" } });
    expect(await turnState("help-question-0002")).toEqual({ status: 200, body: { state: "unknown" } });
    expect(await turnState("no-such-send-0001")).toEqual({ status: 200, body: { state: "unknown" } });
    expect(await turnState("no-such-send-0001", "no-such-turn")).toEqual({ status: 200, body: { state: "unknown" } });
    // the turnId is a hint, never the authority: an unknown send is "unknown" even when it names the running turn
    expect(await turnState("no-such-send-0001", helpTurn)).toEqual({ status: 200, body: { state: "unknown" } });
    expect(await turnState("help-question-0001", "no-such-turn")).toEqual({ status: 200, body: { state: "running" } });
    expect((await request("GET", `/api/bots/${bot.id}/turn-state?sendId=help-question-0001`)).status).toBe(400);
    const unproven = await fetch(`${base}/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=help-question-0001`);
    // refused by the route gate (404) or by mayApprove (403): never a state
    expect([403, 404]).toContain(unproven.status);
    expect(((await unproven.json()) as { state?: unknown }).state).toBeUndefined();
    // L4B-PHONE-TURNSTATE: the paired phone's door proof reads the same real states as the desktop; the door marker alone reads none
    const phoneState = async (sendId: string, headers: Record<string, string> = phone) => {
      const res = await fetch(`${base}/api/bots/${bot.id}/turn-state?${new URLSearchParams({ threadId: bot.threadId, sendId })}`, { headers });
      return { status: res.status, body: (await res.json()) as { state?: string; endedAt?: number } };
    };
    expect(await phoneState("help-question-0001")).toEqual({ status: 200, body: { state: "running" } });
    expect(await phoneState("owner-send-000001")).toEqual({ status: 200, body: { state: "queued" } });
    const markerOnly = await phoneState("help-question-0001", { "x-murage-companion": "1", "x-murage-door-token": COMPANION });
    expect(markerOnly.status).toBe(403);
    expect(markerOnly.body.state).toBeUndefined();
    // the same send under another bot, and this bot's thread under another bot: never a state
    const otherBot = await newBot("Help isolation other");
    const crossSend = await fetch(`${base}/api/bots/${otherBot.id}/turn-state?${new URLSearchParams({ threadId: otherBot.threadId, sendId: "help-question-0001" })}`, { headers: phone });
    expect(crossSend.status).toBe(200);
    expect(await crossSend.json()).toEqual({ state: "unknown" });
    const crossThread = await fetch(`${base}/api/bots/${otherBot.id}/turn-state?${new URLSearchParams({ threadId: bot.threadId, sendId: "help-question-0001" })}`, { headers: phone });
    expect(crossThread.status).toBe(404);
    expect(((await crossThread.json()) as { state?: unknown }).state).toBeUndefined();

    // the help turn ends; the owner's send runs next as its own turn
    writeFileSync(join(home, "fuigo.gate"), "go");
    await expect.poll(async () => (await turnState("help-question-0001")).body.state, { timeout: 30_000 }).toBe("ended");
    expect(typeof (await turnState("help-question-0001")).body.endedAt).toBe("number");
    const phoneEnded = await phoneState("help-question-0001");
    expect(phoneEnded.status).toBe(200);
    expect(phoneEnded.body.state).toBe("ended");
    expect(Object.keys(phoneEnded.body).sort()).toEqual(["endedAt", "state"]);
    await expect.poll(() => prompts("fuigo"), { timeout: 30_000 }).toBe(2);
    await expect.poll(() => busy(bot.id), { timeout: 30_000 }).toBe(false);
    const [line] = await userCopies(bot.threadId, "Also check the totals");
    expect(line).toBeDefined();
    expect(line.steered).toBeFalsy();
    // its own turn, answered: a turn id that is not the help turn's, and an engine reply that echoes the owner's words
    expect(line.dispatchedIn).toBeTruthy();
    expect(line.dispatchedIn).not.toBe(helpTurn);
    const all = await messages(bot.threadId);
    const after = all.slice(all.findIndex((m) => m.id === line.id) + 1);
    expect(after.some((m) => m.role === "bot" && typeof m.text === "string" && m.text.startsWith("echo: ") && m.text.includes("Also check the totals"))).toBe(true);
    const [helpLine] = await userCopies(bot.threadId, "What does this screen do?");
    expect(helpLine).toBeDefined();
    expect(await userCopies(bot.threadId, "And this button?")).toHaveLength(0);
  }, 90_000);
});
