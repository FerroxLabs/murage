// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra a13 r3, C1b (lanes/release103/A13-FIX-DESIGN.md amendment), over real
// HTTP with the fake ACP agent asking a peer: "Always allow" on a bot-to-bot
// contact card goes through the one choke point, saves the contact grant and
// answers the card; the next contact runs with no card. The pending file is
// empty after the save.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const LAUNCH_PROOF = randomBytes(32).toString("hex");
const GROK_MCP_READY = { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" };

let base: string;
let desktopHeaders: Record<string, string> = {};
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...desktopHeaders, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}
const roster = async () => (await request("GET", "/api/bots")).body.bots as any[];
const botState = async (id: string) => (await roster()).find((bot) => bot.id === id);
const contactCard = (bot: any) => bot.messages.find((m: any) => m.kind === "options" && m.card?.requestId && m.card?.tool === "ask_bot" && !m.card.answered && !m.card.dismissed);
const peerReplies = (bot: any) => bot.messages.filter((m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:")).length;
const storedBot = (id: string) => (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as Array<{ id: string; alwaysAllow?: string[] }>).find((bot) => bot.id === id)!;
const pendingFile = () => join(home, ".murage", "pending-grants.json");

describe.skipIf(process.platform === "win32")("Astra a13 r4: Always allow on a contact card saves and later approves", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-a13-r4-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        grok: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "ask-peer" }, config: { cli: FAKE_CLI, fullAuto: true } },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_COMPANION_TOKEN: LAUNCH_PROOF,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(150);
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("C1b: the button saves ask_bot:<helper> through the choke point, answers the card, and the next contact needs no card", async () => {
    const seeded = (await roster())[0];
    await request("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const selection = { instanceId: "grok", model: "fake-model" };
    const helper = (await request("POST", "/api/bots")).body.bot;
    expect((await request("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection })).status).toBe(200);
    const asker = (await request("POST", "/api/bots")).body.bot;
    const approval = await request("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: selection, approvePeerComms: true });
    expect(approval.status).toBe(200);
    expect(approval.body.bot.approvePeerComms).toBe(true);

    expect((await request("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper needs approval" })).status).toBe(202);
    const card = await poll(async () => contactCard(await botState(asker.id)), 20_000);
    expect(card, `no contact card. stderr: ${stderr.slice(-2000)}`).not.toBeNull();
    const key = `ask_bot:${helper.id}`;
    expect(card.card.allowKey).toBe(key);
    expect(card.card.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(storedBot(asker.id).alwaysAllow ?? []).toEqual([]);

    // the client's "Always allow": one request, the key the card offered, answer true
    const saved = await request("POST", `/api/bots/${asker.id}/always-allow`, { allowKey: key, threadId: asker.threadId, requestId: card.card.requestId, answer: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.saved).toEqual([key]);
    expect(saved.body.outcome).toBe("allowed-once");
    expect(storedBot(asker.id).alwaysAllow).toContain(key);
    if (existsSync(pendingFile())) expect(JSON.parse(readFileSync(pendingFile(), "utf8"))).toEqual({});

    // the card is answered and the peer ran
    const settled = await poll(async () => {
      const a = await botState(asker.id);
      const h = await botState(helper.id);
      const answered = a.messages.find((m: any) => m.card?.requestId === card.card.requestId)?.card?.answered === "allow";
      return answered && peerReplies(a) >= 1 && !a.busy && !h.busy ? a : null;
    }, 25_000);
    expect(settled, `the peer never ran after Always allow. stderr: ${stderr.slice(-2000)}`).not.toBeNull();

    // a second answer to the settled card saves nothing new and is refused
    const again = await request("POST", `/api/bots/${asker.id}/always-allow`, { allowKey: key, threadId: asker.threadId, requestId: card.card.requestId, answer: true });
    expect(again.status, JSON.stringify(again.body)).toBe(409);

    // the next contact, from a fresh thread of the same bot (a new session; the
    // fake agent asks its peer on a session's first prompt), is approved from
    // the saved grant: no card, the peer replies again
    const later = await request("POST", `/api/bots/${asker.id}/tasks`, { title: "Later" });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    const laterThread = later.body.task.threadId as string;
    expect((await request("POST", `/api/bots/${asker.id}/messages`, { threadId: laterThread, text: "hey @Helper once more" })).status).toBe(202);
    const threadMessages = async (threadId: string) => ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
    const second = await poll(async () => {
      const rows = await threadMessages(laterThread);
      return rows.some((m) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:")) ? rows : null;
    }, 40_000);
    const tail = (rows: any[]) => JSON.stringify(rows.slice(-8).map((m: any) => ({ kind: m.kind, role: m.role, text: m.text?.slice(0, 120), card: m.card ? { tool: m.card.tool, answered: m.card.answered, dismissed: m.card.dismissed } : undefined })));
    expect(second, `the second contact never ran. thread: ${tail(await threadMessages(laterThread))} stderr: ${stderr.slice(-2000)}`).not.toBeNull();
    expect(second!.filter((m) => m.kind === "options" && m.card?.tool === "ask_bot")).toHaveLength(0);
    expect(peerReplies(await botState(asker.id))).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
