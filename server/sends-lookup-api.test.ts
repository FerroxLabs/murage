// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U36 (U36-DRAFT-SEND-STATE-106 section 5): GET /api/sends/:threadId/:sendId, read only, through the real server and
// its real send ledger (send-store.ts). A reloaded tab asks it whether a send its draft pinned reached the server.
// F31: the route is "conversation" in route-policy.ts, so a paired companion's lookups reach it too.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { routeClass } from "./route-policy.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const proof = async () => {
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
};
const insert = (db: DatabaseSync, row: { owner: string; thread: string; sendId: string; status: string }) =>
  db.prepare(`INSERT INTO owner_sends (kind, owner_id, thread_id, send_id, queue_id, fingerprint, text, status, dispatched, message_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("bot", row.owner, row.thread, row.sendId, `q-${row.sendId}`, createHash("sha256").update(row.sendId).digest("hex"), "", row.status, 0, null, Date.now(), Date.now());

describe("F31 the send lookup route is a conversation route", () => {
  it("is classified conversation, like the transcript it shares its visibility rule with", () => {
    expect(routeClass("GET", "/api/sends/thread-1/send-1")).toBe("conversation");
    expect(routeClass("GET", "/api/threads/thread-1/messages")).toBe("conversation");
    expect(routeClass("POST", "/api/sends/thread-1/send-1")).toBe("desktop");
  });
});

describe.skipIf(process.platform === "win32")("GET /api/sends/:threadId/:sendId", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    await proof();
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("answers the ledger's status for a known send, and 404 for an unknown send or thread", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Lookup fixture" })).body.bot as { id: string; threadId: string };
    const statuses = ["delivered", "refused", "cancelled", "failed", "unconfirmed"];
    await fixture.stop();
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      for (const status of statuses) insert(db, { owner: bot.id, thread: bot.threadId, sendId: `send-u36-${status}`, status });
    } finally { db.close(); }
    await fixture.restart();
    await proof();
    for (const status of statuses) {
      const answer = await api("GET", `/api/sends/${bot.threadId}/send-u36-${status}`);
      expect(answer, status).toMatchObject({ status: 200 });
      // a start-up pass may move an open row on (unconfirmed stays unconfirmed or settles); a settled one is as written
      if (status !== "unconfirmed") expect(answer.body).toEqual({ status });
      else expect(typeof answer.body.status).toBe("string");
    }
    expect((await api("GET", `/api/sends/${bot.threadId}/send-u36-never`)).status).toBe(404);
    expect((await api("GET", "/api/sends/no-such-thread/send-u36-delivered")).status).toBe(404);
  }, 180000);
});
