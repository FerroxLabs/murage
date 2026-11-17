// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4B-M2 T-STOP-1 (designs/L4B-M2-REDESIGN-1018.md 2.7), through the real server and the fake ACP CLI: Stop on a turn with an open tool row marks
// exactly that turn's open row "No result" through the turn index, and leaves a finished turn of the same thread alone.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { TURN_INDEX, TURN_INDEX_DDL } from "./message-tables.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { childEnv } from "./testing/murage-env.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let base: string, home: string, child: ChildProcess, headers: Record<string, string>, said = "";

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const rows = async (threadId: string) => (await call("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ id: string; turnId?: string; kind: string; tool?: { ok?: boolean; unrecorded?: boolean } }>;

describe.skipIf(process.platform === "win32")("T-STOP-1", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-turn-index-stop-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    const instance = (mode: string, toolMs: string) => ({ driver: "fuigoAgent", environment: { FAKE_ACP_MODE: mode, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_fuigo/mcp_initialized", FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_TOOL_MS: toolMs }, config: { cli: FAKE_ACP, fullAuto: false } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { held: instance("slow-tool", "120000"), quick: instance("slow-tool", "1") } }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: childEnv({ HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (said += chunk));
    child.stderr!.on("data", chunk => (said += chunk));
    // a hook has no expect.poll
    const deadline = Date.now() + 30_000;
    while (!(await fetch(`${base}/api/health`).then(reply => reply.ok).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`server never came up: ${said}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then(reply => reply.json())) as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("Stop marks exactly the stopped turn's open tool row; the finished turn's row is left as it was", async () => {
    const created = await call("POST", "/api/bots", { name: "Stopper", modelSelection: { instanceId: "quick", model: "fake-acp-model" } });
    expect(created.status, said).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await call("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
    const busy = async () => (await call("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === bot.id)?.busy;

    // a turn that runs to its end: its tool row finishes
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "first" })).status).toBeLessThan(300);
    await expect.poll(busy, { timeout: 30_000 }).toBeFalsy();
    const finished = (await rows(bot.threadId)).filter(row => row.kind === "activity" && row.tool);
    expect(finished.length, said).toBeGreaterThan(0);
    const finishedTurn = finished[0]!.turnId;
    expect(finished[0]!.tool?.unrecorded).toBeUndefined();

    // a second turn, its tool still running when the owner presses Stop
    expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "held", model: "fake-acp-model" } })).status).toBe(200);
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "second" })).status).toBeLessThan(300);
    const open = async () => (await rows(bot.threadId)).filter(row => row.kind === "activity" && row.tool && row.turnId && row.turnId !== finishedTurn);
    await expect.poll(async () => (await open()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect((await open())[0]!.tool?.unrecorded).toBeUndefined();
    expect((await call("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(busy, { timeout: 30_000 }).toBeFalsy();

    // the stopped turn leaves no step spinning: each of its tool rows is settled by the Stop or marked "No result" at the turn's end
    const stillOpen = async () => (await open()).filter(row => row.tool?.ok === undefined && row.tool?.unrecorded !== true);
    for (const deadline = Date.now() + 30_000; (await stillOpen()).length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 250));
    expect(await stillOpen(), JSON.stringify((await open()).map(row => ({ id: row.id, tool: row.tool })))).toEqual([]);
    const after = (await rows(bot.threadId)).filter(row => row.kind === "activity" && row.tool && row.turnId === finishedTurn);
    expect(after.map(row => row.id)).toEqual(finished.filter(row => row.turnId === finishedTurn).map(row => row.id));
    expect(after.every(row => row.tool?.unrecorded === undefined)).toBe(true);
  }, 120_000);

  it("the backup snapshot's schema matches what a booted server wrote: the turn index as defined, and no column the snapshot does not know", () => {
    const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
    try {
      // the same check a backup and a restore run: a table, column or index the snapshot does not expect refuses it
      expect(() => inspectInstallationDatabase(db)).not.toThrow();
      const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(TURN_INDEX) as { sql: string } | undefined;
      expect(index?.sql.replace(/\s+/g, " ")).toBe(TURN_INDEX_DDL.replace(" IF NOT EXISTS", "").replace(/\s+/g, " "));
      const sends = (db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map(column => column.name);
      // MAIN RULING 2026-11-14 INT-CONFLICT-DEFAULT: 86e591577ce / 5b51448693; the serving schema registers isolation metadata, with its exact shape.
      expect(sends).toContain("isolated");
      expect(db.prepare("SELECT type, [notnull], dflt_value FROM pragma_table_info('owner_sends') WHERE name='isolated'").get()).toEqual({ type: "INTEGER", notnull: 1, dflt_value: "0" });
    } finally { db.close(); }
  });
});
