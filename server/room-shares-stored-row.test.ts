// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROOM-SHARES-PRUNE F2, over real HTTP with the real Grok and Fuigo drivers and their real wrapper frames: the transcript row of a
// share call keeps no query-derived summary, its chip still names the tool, and another tool's wrapper keeps its summary.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const LAUNCH_PROOF = randomBytes(32).toString("hex");
const query = "private search words", foreign = "foreign search words", tool = "ask_owner_to_share";
const GROK = { "x.ai/tool": { version: 1, namespace: "grok_build", name: "use_tool", kind: "use_tool", label: "Use Tool", read_only: false } };
const FUIGO = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool", label: "Use Tool", read_only: false } };
const call = (inner: string, words: string, title: string, _meta: object) => JSON.stringify({ toolCallId: "share-1", kind: "other", title, _meta, rawInput: { variant: "UseTool", tool_name: inner, tool_input: { query: words } } });
const instance = (driver: string, toolCall: string) => ({ driver, environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANNOUNCE: "1", FAKE_ACP_PERMISSION_TOOLCALL: toolCall }, config: { cli: FAKE_CLI, fullAuto: false } });

let base: string;
let headers: Record<string, string> = {};
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messages = async (threadId: string) => ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];

/** Runs one turn to its tool row and open card, and returns the thread's stored rows and its bot. */
async function turn(name: string, instanceId: string, chip: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "go" })).status).toBe(202);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const rows = await messages(bot.threadId);
    const row = rows.find((m) => m.kind === "activity" && m.tool?.name === chip);
    if (row) return { rows, row, threadId: bot.threadId };
    if (Date.now() > deadline) throw new Error(`no ${chip} row. rows: ${JSON.stringify(rows).slice(0, 1500)} stderr: ${stderr.slice(-1500)}`);
    await sleep(200);
  }
}

async function logOnceHolding(threadId: string, dir: string, marker: string) {
  const folder = join(home, ".murage", dir);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const text = readdirSync(folder).filter((entry) => entry.startsWith(threadId)).map((file) => readFileSync(join(folder, file), "utf8")).join("");
    if (text.includes(marker)) return text;
    if (Date.now() > deadline) throw new Error(`${dir} for ${threadId} never held ${marker}. stderr: ${stderr.slice(-800)}`);
    await sleep(200);
  }
}

describe.skipIf(process.platform === "win32")("a room share call's stored transcript row", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_499, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-share-row-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        grokShare: instance("grokAgent", call(`agents__${tool}`, query, "Use Tool", GROK)),
        fuigoShare: instance("fuigoAgent", call(`agents__${tool}`, query, `agents__${tool}`, FUIGO)),
        grokForeign: instance("grokAgent", call(`other__${tool}`, foreign, "Use Tool", GROK)),
        fuigoForeign: instance("fuigoAgent", call("other__lookup", foreign, "other__lookup", FUIGO)),
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
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(150);
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it.each([["Grok", "grokShare"], ["Fuigo", "fuigoShare"]])("%s: the row names the tool and holds no query, and neither log does", async (engine, instanceId) => {
    const { rows, row, threadId } = await turn(`${engine} sharer`, instanceId, tool);
    expect(row.tool.summary).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(query);
    // an approval card, if the gate opens one, is the only row that reads the call
    expect(rows.filter((m) => JSON.stringify(m).includes(query)).every((m) => m.kind === "options")).toBe(true);
    // the positive markers prove each log was really read, with the ask in it, before it is judged
    expect(await logOnceHolding(threadId, "events", '"request.opened"'), "events").not.toContain(query);
    expect(await logOnceHolding(threadId, "native", "session/request_permission"), "native").not.toContain(query);
  }, 60_000);

  it.each([
    ["Grok, the same tool name on another server", "grokForeign", tool],
    ["Fuigo, another tool", "fuigoForeign", "lookup"],
  ])("%s: a foreign wrapper's row keeps its summary", async (_label, instanceId, chip) => {
    const { row } = await turn(`${instanceId} bot`, instanceId, chip);
    expect(row.tool.summary).toBe(foreign);
  }, 60_000);
});
