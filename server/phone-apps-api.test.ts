// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S7: per-bot phone grants over the real routes. Owner-only PATCH, absent key = off,
// flag off = the field does not exist. Loopback fixture server and the fake engine; synthetic data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer;
let owner: Record<string, string>;
let bot: { id: string; threadId: string };

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = owner) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const stored = async (id: string) => (await call("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === id);
const secret = async () => ({ "x-murage-surface": "desktop", "x-murage-surface-secret": ((await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json()) as { secret: string }).secret });

posixOnly("per-bot phone grants (S7)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.FAKE_CLAUDE_MODE='hang';" });
    owner = await secret();
    const model = (await call("GET", "/api/instances")).body.instances.find((e: any) => e.instanceId === "verification").models.options[0].id;
    bot = (await call("POST", "/api/bots", { name: "Phoebe", modelSelection: { instanceId: "verification", model } })).body.bot;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("refuses the field while the flag is off, so an older client never writes it", async () => {
    const off = await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: { calendar: "read" } });
    expect(off.status).toBe(404);
    expect(off.body).toEqual({ error: "unknown field" });
    expect((await stored(bot.id)).phoneApps).toBeUndefined();
  }, 60000);

  describe("flag on", () => {
    beforeAll(async () => { expect((await call("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200); }, 60000);

    it("a new bot has no phoneApps; a grant persists across restart; a bad value is 400", async () => {
      expect((await stored(bot.id)).phoneApps).toBeUndefined();
      expect((await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: { calendar: "read" } })).status).toBe(200);
      expect((await stored(bot.id)).phoneApps).toEqual({ calendar: "read" });
      const bad = await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: { calendar: "delete" } });
      expect(bad.status).toBe(400);
      expect(typeof bad.body.error).toBe("string");
      expect((await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: "all" })).status).toBe(400);
      await fixture.restart();
      owner = await secret();
      expect((await stored(bot.id)).phoneApps).toEqual({ calendar: "read" });
    }, 120000);

    it("an empty object clears the grant", async () => {
      expect((await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: {} })).status).toBe(200);
      expect((await stored(bot.id)).phoneApps).toBeUndefined();
    }, 60000);

    it("the companion door header alone gets 404 and changes nothing", async () => {
      const door = await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: { contacts: "read" } }, { "x-murage-companion": "1" });
      expect(door.status).toBe(404);
      expect((await stored(bot.id)).phoneApps).toBeUndefined();
    }, 60000);

    it("a bot's internal Bearer token is refused by route policy and changes nothing", async () => {
      expect((await call("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__ phone" })).status).toBe(202);
      let token: string | undefined;
      await expect.poll(() => {
        try {
          const line = readFileSync(fixture.fixtureDumpLogPath, "utf8").split("\n").find(l => l.includes("__fixture_hold_authority__ phone"));
          if (!line) return undefined;
          token = (withTurnSecrets(JSON.parse(line)) as any).mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;
          return token;
        } catch { return undefined; }
      }, { timeout: 20000 }).toBeTruthy();
      const internal = await call("PATCH", `/api/bots/${bot.id}`, { phoneApps: { calls: "dial" } }, { authorization: `Bearer ${token}` });
      expect([401, 403, 404]).toContain(internal.status);
      expect((await stored(bot.id)).phoneApps).toBeUndefined();
    }, 60000);
  });
});
