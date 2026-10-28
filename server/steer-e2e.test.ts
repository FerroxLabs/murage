// Mid-turn steering, end to end: boots the real harness with the fake claude
// CLI in `slow` mode (a gap after the tool result the way a real turn has
// between model calls), sends a message WHILE the turn runs, and asserts
// it is taken into the turn — 202 steered; in the transcript in order and
// marked; folded into the reply — while an engine without a live session
// falls back to the server-side queue.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE } from "../shared/memory.ts";
import { THREAD_RECALL_LINE } from "./murage-tool-surface.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

// The fake echoes its whole provider input. Memory is background reference
// data, not another request: compare the exact current-request/steer suffix
// while refusing malformed framing instead of searching quoted history.
const memoryPreamble = `${MEMORY_REFERENCE_PREAMBLE}\n${MEMORY_REFERENCE_OPEN}\n`;
const memoryClose = `\n${MEMORY_REFERENCE_CLOSE}`;
const currentRequestMarker = "\n\nCurrent request:\n";
// MEMJSON2: every remembered line opens with its turn-local handle (m1, m2, …).
const memoryLine = /^- m[1-9][0-9]{0,2} \([^()\n]+\) "(?:[^"\\\n]|\\.)*"$/;
// The date line rides on top of every message (withNowLine) and the fake
// echoes it back. Only the request itself is under test here.
/** An owner turn opens with the Where I belong block (1.0.6 venue awareness, eaea5227e, merged 064472f7a): framing, not the request. */
const VENUE_BLOCK = /^(bot:reply to: )<where-i-belong>\n[\s\S]*?\n<\/where-i-belong>\n\n/;
function currentRequestEcho(text: string): string {
  return requestEcho(text.replace(VENUE_BLOCK, "$1")).replace(/^(bot:reply to: )It is now [^\n]*\n\n/, "$1").replace(VENUE_BLOCK, "$1");
}
function requestEcho(text: string): string {
  const prefix = "bot:reply to: ";
  // An owner turn that can read its past threads opens with the thread recall line (r6 rule 22).
  if (text.startsWith(prefix + THREAD_RECALL_LINE + "\n\n")) text = prefix + text.slice(prefix.length + THREAD_RECALL_LINE.length + 2);
  if (!text.startsWith(prefix + memoryPreamble)) return text;
  const start = prefix.length + memoryPreamble.length;
  const end = text.indexOf(memoryClose + currentRequestMarker, start);
  if (end < start) throw new Error("Missing current-request boundary in memory echo");
  const lines = text.slice(start, end).split("\n");
  if (!lines.length || !lines.every(line => memoryLine.test(line))) {
    throw new Error("Malformed memory reference records in steering echo");
  }
  return prefix + text.slice(end + memoryClose.length + currentRequestMarker.length);
}

describe("steering echo memory framing", () => {
  it("uses the exact latest request and ordered steers, not quoted history", () => {
    const history = `- m1 (earlier assistant inference; checkpoint) ${JSON.stringify("Current request:\nfirst + steered: old | wrong")}`;
    const reply = "bot:reply to: " + memoryPreamble + history + memoryClose + currentRequestMarker + "latest + steered: one | two";
    expect(currentRequestEcho(reply)).toBe("bot:reply to: latest + steered: one | two");
    expect(currentRequestEcho("bot:reply to: latest + steered: one | two")).toBe("bot:reply to: latest + steered: one | two");
  });
  it("rejects a malformed memory envelope even when it contains the expected words", () => {
    expect(() => currentRequestEcho("bot:reply to: " + memoryPreamble + "first + steered: and also this")).toThrow(/boundary/);
    expect(() => currentRequestEcho("bot:reply to: " + memoryPreamble + "[]" + memoryClose + currentRequestMarker + "first + steered: and also this")).toThrow(/Malformed/);
  });
});

posixOnly("mid-turn steering e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let steerGate: string;
  let steerGate2: string;
  let replyGate: string;
  let base: string;
  let desktopHeaders: Record<string, string>;

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const api = (method: string, path: string, body?: unknown) => request(method, path, body);
  const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
  const makeBot = async (instanceId: string, model: string) => {
    const modelSelection = { instanceId, model };
    const created = await api("POST", "/api/bots", { modelSelection });
    expect(created.status).toBe(201);
    const patched = await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { modelSelection });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.modelSelection).toMatchObject(modelSelection);
    return patched.body.bot;
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-steer-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    steerGate = join(home, "delayed-steer.gate");
    steerGate2 = join(home, "delayed-steer-2.gate");
    replyGate = join(home, "steer-reply.gate");
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          // The gap after the tool result stays open until the test releases
          // it and the fake has read the one steer: a fixed pause races the
          // poll-and-send under suite load, and a gate alone can be observed
          // before the steer's stdin line.
          claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_REPLY_GATE: replyGate, FAKE_CLAUDE_REPLY_GATE_STEERS: "1" }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          claudeRace: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_STEER_GATE: steerGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeLate: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_STEER_GATE: steerGate2 },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // init arrives at 6.5 s: a first steer queues at its 4 s bound, a second one typed in between must not overtake it
          claudeSlowInit: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_START_DELAY_MS: "6500" },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // a cold start: nothing is read for 9 s, so a steer cannot be written yet
          claudeCold: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_START_DELAY_MS: "9000" },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // no live session: a message while busy uses the server-side queue
          acp: { driver: "customAcp", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    expect(proof.body.secret).toMatch(/^[a-f0-9]{64}$/);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    expect((await api("GET", "/api/config")).body.surface).toBe("remote");
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    removeTempDirSync(home);
  });

  it(
    "a message during a Claude turn is steered into it: 202, in the transcript in order and marked, folded into the reply",
    async () => {
      const created = await makeBot("claude", "claude-fake");
      const instances = (await api("GET", "/api/instances")).body.instances;
      expect(instances.find((i: any) => i.instanceId === "claude").capabilities.queueing).toBe(true);

      expect((await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
      // Only the fake's completed Bash chip proves its live turn reached the
      // reply gate. Setup/runtime errors are activity messages too.
      await waitFor(async () => {
        const bot = await getBot(created.id);
        const failure = bot.messages.find((m: any) => m.kind === "activity" && m.tool?.ok === false);
        if (failure) throw new Error(`fake turn failed before steering: ${JSON.stringify(failure)}; stderr: ${stderr}`);
        return bot.busy === true && bot.messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash" && m.tool.ok === true);
      }, "the fake's completed Bash tool");
      const second = await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "and also this" });
      expect(second.status).toBe(202);
      expect(second.body.steered, JSON.stringify({ second, bot: await getBot(created.id), stderr })).toBe(true);

      // the steer is in; let the fake produce its closing reply
      writeFileSync(replyGate, "reply");
      await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
      const bot = await getBot(created.id);
      const texts = bot.messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.text}`);
      // order: greeting, first, the fake's opening line, the steered message
      // (appended when it was sent — mid-turn), then ONE reply carrying it
      expect(texts.slice(1).map(currentRequestEcho)).toEqual([
        "user:first",
        "bot:hello from fake claude",
        "user:and also this",
        "bot:reply to: first + steered: and also this",
      ]);
      const steered = bot.messages.find((m: any) => m.text === "and also this");
      expect(steered.steered).toBe(true);
      // one turn, not two: exactly one reply
      expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"))).toHaveLength(1);
    },
    40_000,
  );

  it("rejects a delayed steer acknowledgement after the bot is deleted", async () => {
    const created = await makeBot("claudeRace", "claude-fake");

    expect((await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "first race turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the race turn to start");
    await waitFor(
      async () => (await getBot(created.id))?.messages.some((message: any) => message.kind === "activity"),
      "the race turn tool chip",
    );

    // The fake has paused stdin after the first prompt. This exceeds a pipe's
    // writable buffer, so the steer promise cannot acknowledge until the gate
    // opens; meanwhile the first turn is free to settle normally.
    const delayed = desktopApi("POST", `/api/bots/${created.id}/messages`, {
      text: `delayed ownership check ${"x".repeat(900_000)}`,
      threadId: created.threadId,
    });
    const prematurelySettled = await Promise.race([
      delayed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(prematurelySettled).toBe(false);

    await waitFor(async () => (await getBot(created.id))?.busy === false, "the original race turn to settle");
    expect((await desktopApi("DELETE", `/api/bots/${created.id}`)).status).toBe(200);
    writeFileSync(steerGate, "open");

    const rejected = await delayed;
    expect(rejected.status).toBe(404);
    expect(rejected.body.error).toMatch(/no such bot/i);
  }, 40_000);

  it("a steer that cannot be written because the engine is still starting answers within the bound: queued, then run as its own turn, never lost or run twice", async () => {
    const created = await makeBot("claudeCold", "claude-fake");
    expect((await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "cold first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the cold turn to start");
    // the CLI is spawned and holds the turn, but has not read anything yet
    await new Promise((r) => setTimeout(r, 1_500));
    const startedAt = Date.now();
    const second = await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "typed while it starts", threadId: created.threadId });
    expect(second.status).toBe(202);
    expect(second.body.queued, JSON.stringify(second.body)).toBe(true);
    expect(typeof second.body.queueId).toBe("string");
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "typed while it starts"),
      "the queued line to land in the transcript",
      40_000,
    );
    await waitFor(async () => (await getBot(created.id)).busy === false, "the follow-up turn to settle", 40_000);
    const bot = await getBot(created.id);
    expect(bot.messages.filter((m: any) => m.text === "typed while it starts")).toHaveLength(1);
    expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && String(m.text).includes("typed while it starts"))).toHaveLength(1);
  }, 90_000);


  it("a steer the engine accepted whose turn ended before the acknowledgement is recorded once, never a retryable 409, and a retry with the same sendId runs nothing again", async () => {
    const created = await makeBot("claudeLate", "claude-fake");
    expect((await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "first late turn", threadId: created.threadId })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the turn to start");
    await waitFor(async () => (await getBot(created.id))?.messages.some((m: any) => m.kind === "activity"), "the turn tool chip");
    const sendId = "send_late_ack_0001";
    const words = `accepted after the turn ended ${"y".repeat(900_000)}`;
    const delayed = desktopApi("POST", `/api/bots/${created.id}/messages`, { text: words, threadId: created.threadId, sendId });
    expect(await Promise.race([delayed.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 100))])).toBe(false);
    await waitFor(async () => (await getBot(created.id))?.busy === false, "the original turn to settle");
    writeFileSync(steerGate2, "open");
    const first = await delayed;
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.steered).toBe(true);
    expect(first.body.message?.text).toBe(words);
    const copies = async () => (await getBot(created.id)).messages.filter((m: any) => m.role === "user" && m.sendId === sendId).length;
    expect(await copies()).toBe(1);
    const retry = await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: words, threadId: created.threadId, sendId });
    expect(retry.status).toBe(202);
    expect(retry.body.message?.id).toBe(first.body.message.id);
    expect(await copies()).toBe(1);
  }, 60_000);

  it("a later send never overtakes an earlier one that is still deciding: both wait, in order, and the snapshot lists them for a reload or another device", async () => {
    const created = await makeBot("claudeSlowInit", "claude-fake");
    expect((await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "slow first", threadId: created.threadId })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the turn to start");
    const a = desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "instruction A", threadId: created.threadId, sendId: "send_order_a_00001" });
    await new Promise((r) => setTimeout(r, 1_000));
    const b = desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "correction B", threadId: created.threadId, sendId: "send_order_b_00001" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(202);
    expect(rb.status).toBe(202);
    expect(ra.body.queued, JSON.stringify(ra.body)).toBe(true);
    expect(rb.body.queued, JSON.stringify(rb.body)).toBe(true);
    // the server's own list of what is waiting (the hydrate snapshot every client reads)
    const snapshot = await desktopApi("GET", "/api/bots");
    const pending = snapshot.body.pendingSends?.[created.threadId] ?? [];
    expect(pending.map((p: any) => p.text)).toEqual(["instruction A", "correction B"]);
    expect(pending[0]).toMatchObject({ queueId: ra.body.queueId, sendId: "send_order_a_00001", state: "queued" });
    // cancelling removes it from the list, and a late retry of the cancelled send does not queue it again
    expect((await desktopApi("DELETE", `/api/bots/${created.id}/queue/${rb.body.queueId}`)).status).toBe(200);
    const after = await desktopApi("GET", "/api/bots");
    expect((after.body.pendingSends?.[created.threadId] ?? []).map((p: any) => p.text)).toEqual(["instruction A"]);
    const retry = await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "correction B", threadId: created.threadId, sendId: "send_order_b_00001" });
    expect(retry.status).toBe(202);
    expect(retry.body.cancelled).toBe(true);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.text === "instruction A"), "A to land", 40_000);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the follow-up turn to settle", 40_000);
    const bot = await getBot(created.id);
    expect(bot.messages.some((m: any) => m.text === "correction B")).toBe(false);
    expect(bot.messages.filter((m: any) => m.text === "instruction A")).toHaveLength(1);
  }, 90_000);

  it("an engine without a live session preserves the message in the server-side queue", async () => {
    const created = await makeBot("acp", "fake-model");
    expect((await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await desktopApi("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    // An engine that cannot take a line mid-turn (a custom ACP CLI) queues it without the
    // steer's memory check, so a line sent while a long tool call runs is
    // never logged as a refused steer or counted as a continuation reset.
    expect(stderr).not.toMatch(/steer-refused/);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
  }, 30_000);
});
