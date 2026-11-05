// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U24 S1 (design T9) through the real server: the static REPLY_HABITS block
// reaches what the engine is handed, right after House Rules, in a 1:1 chat
// and in a room, on the default engine Fuigo (fake ACP CLI) and on Claude
// (fake Claude CLI), and it is the same bytes on the next turn. Fuigo sends
// its system stack once per session and again only when it changes
// (drivers/acp/core.ts), so a block that moved per turn would also cost a
// resend there. Same server-spawn pattern as images-left-out-api.test.ts.
// Synthetic fixture text only; loopback server, no network or credentials.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPLY_HABITS } from "./bot-shapes.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const HOUSE_END = "</house-rules>\n\n";

let base: string;
let headers: Record<string, string>;
let child: ChildProcess;
let home: string;
let acpDump: string;
let claudeDump: string;
let stderr = "";
let sequence = 0;

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  expect(res.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
};
const idle = async () => {
  const state = await api("GET", "/api/bots?messages=0");
  return !state.bots.some((bot: any) => bot.busy) && !(state.groups ?? []).some((group: any) => group.busyBotId || group.working);
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };

/** What the engine was handed for the turn carrying `tag`: Fuigo's prompt text, or Claude's system prompt. */
async function handed(engine: "fuigo" | "claude", tag: string): Promise<string> {
  const path = engine === "fuigo" ? acpDump : claudeDump;
  let text = "";
  await expect.poll(() => {
    const dump = readJson(path);
    if (!dump || !JSON.stringify(engine === "fuigo" ? dump : dump.prompt ?? null).includes(tag)) return false;
    text = engine === "fuigo"
      ? (Array.isArray(dump) ? dump : []).map((part: { text?: unknown }) => String(part?.text ?? "")).join("\n")
      : String(dump.systemPrompt ?? "");
    return true;
  }, { timeout: 30_000, interval: 100 }).toBe(true);
  await expect.poll(idle, { timeout: 30_000 }).toBe(true);
  return text;
}

/** The House Rules block and the reply habits after it, as one span. */
function habitsSpan(text: string): string {
  const start = text.indexOf("<house-rules>");
  expect(start, "House Rules open the prompt").toBeGreaterThanOrEqual(0);
  const end = text.indexOf(HOUSE_END, start) + HOUSE_END.length;
  expect(text.slice(end, end + REPLY_HABITS.length + 2), "reply habits right after House Rules").toBe(`${REPLY_HABITS}\n\n`);
  return text.slice(start, end + REPLY_HABITS.length + 2);
}

posixOnly("reply habits reach the engine after House Rules, 1:1 and rooms (U24 S1, T9)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-reply-habits-"));
    acpDump = join(home, "fake-acp-prompt.json");
    claudeDump = join(home, "fake-claude-dump.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        fuigo: { driver: "fuigoAgent", environment: { FAKE_ACP_PROMPT_DUMP: acpDump }, config: { cli: FAKE_ACP, fullAuto: false } },
        claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: claudeDump, FAKE_CLAUDE_DUMP_EACH_TURN: "1", FAKE_CLAUDE_STATE: join(home, "fake-state") }, config: { cli: FAKE_CLAUDE } },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, TZ: "UTC",
        MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdout!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 40_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  for (const [engine, modelSelection] of [["fuigo", { instanceId: "fuigo", model: "claude-opus-5" }], ["claude", { instanceId: "claude", model: "claude-sonnet-5" }]] as const) {
    it(`${engine}: a 1:1 chat and a room both carry the same block, turn after turn`, async () => {
      const created = await api("POST", "/api/bots", { name: `Habits ${engine}`, modelSelection });
      const bot = created.bot as { id: string; threadId: string };
      await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false });
      const direct = async () => {
        const tag = `HABITS_TURN_${++sequence}`;
        rmSync(engine === "fuigo" ? acpDump : claudeDump, { force: true });
        await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Please answer briefly. ${tag}` });
        return handed(engine, tag);
      };
      const first = habitsSpan(await direct());
      const second = await direct();
      // Claude: the same bytes again. Fuigo sends its stack once per session and
      // again only when it changes, so an unchanged stack is left out of the next turn.
      if (engine === "claude") expect(habitsSpan(second)).toBe(first);
      else expect(second).not.toContain("<house-rules>");

      const room = (await api("POST", "/api/groups", { name: `Habits room ${engine}`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group as { id: string };
      const roomTurn = async () => {
        const tag = `HABITS_TURN_${++sequence}`;
        rmSync(engine === "fuigo" ? acpDump : claudeDump, { force: true });
        await api("POST", `/api/groups/${room.id}/messages`, { text: `Please answer briefly. ${tag}` });
        return handed(engine, tag);
      };
      const inRoom = habitsSpan(await roomTurn());
      expect(inRoom).toBe(first);
      const roomAgain = await roomTurn();
      if (engine === "claude") expect(habitsSpan(roomAgain)).toBe(inRoom);
      else expect(roomAgain).not.toContain("<house-rules>");
      // "What shapes" lists the block the turn carried.
      const shapes = await api("GET", `/api/bots/${bot.id}/shapes`);
      expect(shapes.rows.find((row: any) => row.id === "reply-habits")?.text).toBe(REPLY_HABITS);
    }, 120_000);
  }
});
