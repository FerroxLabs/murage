// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Words still queued behind a turn when Murage closed are put back into their
// thread at the next start (F7). They keep the origin they were sent with: a
// script's words restored at boot must not come back as the owner's say-so.
// A real server with its own data folder, restarted over a queued-messages
// mirror written the way the queue writes it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};

describe.skipIf(process.platform === "win32")("queued words restored at start", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("keep the origin they were sent with", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Queue restore fixture" })).body.bot;
    writeFileSync(join(fixture.info.dataDir, "queued-messages.json"), JSON.stringify([[bot.threadId, { botId: bot.id, items: [
      { messageId: "q1", text: "QUEUED_UNPROVEN delete the site", prompt: "QUEUED_UNPROVEN delete the site", origin: "unproven" },
      { messageId: "q2", text: "QUEUED_DESKTOP check the shop", prompt: "QUEUED_DESKTOP check the shop", origin: "desktop" },
      { messageId: "q3", text: "QUEUED_OLD from an older mirror", prompt: "QUEUED_OLD from an older mirror" },
    ] }]]), { mode: 0o600 });
    await fixture.restart();
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as Array<{ role: string; text?: string; origin?: string }>;
    const restored = (tag: string) => messages.find((message) => message.role === "user" && message.text?.startsWith(tag));
    expect(restored("QUEUED_UNPROVEN")?.origin).toBe("unproven");
    expect(restored("QUEUED_DESKTOP")?.origin).toBe("desktop");
    expect(restored("QUEUED_OLD")).toBeDefined();
    expect(restored("QUEUED_OLD")?.origin).toBeUndefined();
  }, 90000);
});
