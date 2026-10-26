// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Linux CI only. The runner launches its own temporary HOME/data and fake engine.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { turnSecret } from "./turn-credential.ts";

describe.skipIf(process.platform !== "linux")("venue reader through an isolated server", () => {
  let fixture: VerificationServer, headers: Record<string, string>, model: string;
  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(new URL(path, fixture.info.url), { method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  }
  const idle = async () => {
    const state = await api("GET", "/api/bots?messages=0");
    return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working);
  };
  const dump = () => { try { return existsSync(fixture.fixtureDumpPath) ? JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) : null; } catch { return null; } };
  function agentsEnv(value: any): Record<string, string> | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.env?.MURAGE_COMMS_TOKEN === "string" || typeof value.env?.MURAGE_CRED_FILE === "string" && value.env?.MURAGE_VENUE_READ === "1") return value.env;
    for (const child of Object.values(value)) { const found = agentsEnv(child); if (found) return found; }
    return undefined;
  }
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(new URL("/api/desktop-secret", fixture.info.url))).json() as { secret: string }).secret };
    model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("T16/T31 dispatch mounts the reader, the route reads, and revoked or forged claims get 401", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Venue reader", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
    const group = (await api("POST", "/api/groups", { name: "Fixture channel", memberIds: [bot.id],
      setup: { bulletin: "Fixture notes.", defaultResponder: { kind: "member", botId: bot.id } } })).group;
    await api("POST", `/api/groups/${group.id}/messages`, { text: "VENUE_FIXTURE_LINE" });
    await expect.poll(() => JSON.stringify(dump()?.prompt).includes("VENUE_FIXTURE_LINE"), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "VENUE_DIRECT_HOLD\n__fixture_hold_authority__" });
    await expect.poll(() => JSON.stringify(dump()?.prompt).includes("VENUE_DIRECT_HOLD"), { timeout: 20000 }).toBe(true);
    const held = dump();
    // the direct owner turn carries the Where I belong block naming this channel (part 1, end to end)
    expect(JSON.stringify(held.prompt)).toContain("<where-i-belong>");
    expect(JSON.stringify(held.prompt)).toMatch(/- Channel \\*"Fixture channel\\*": /);
    let token = "";
    const post = async (bearer: string, body: unknown) => {
      const response = await fetch(new URL("/api/internal/venue/read-messages", fixture.info.url), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      const env = agentsEnv(held.mcpConfig);
      expect(env?.MURAGE_VENUE_READ).toBe("1"); expect(env?.MURAGE_PROJECT_ROLE).toBeUndefined();
      token = turnSecret("MURAGE_COMMS_TOKEN", env!);
      const first = await post(token, { venueId: group.id });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.threadId).toBe(group.threadId);
      expect(first.body.messages.some((line: { text: string }) => line.text.includes("VENUE_FIXTURE_LINE"))).toBe(true);
      const foreign = await post(token, { venueId: group.id, venueThreadId: bot.threadId });
      expect(foreign).toEqual({ status: 403, body: { error: "That conversation is not available from here." } });
      expect((await post("0".repeat(48), { venueId: group.id })).status).toBe(401);
    } finally {
      writeFileSync(join(fixture.fixtureFinishGateDir, String(held.pid)), "");
      await expect.poll(idle, { timeout: 20000 }).toBe(true);
    }
    expect((await post(token, { venueId: group.id })).status).toBe(401);
  }, 90000);
});
