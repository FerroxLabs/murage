// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner time zone through the real route and into a real turn: a real
// server on a computer set to UTC+07 (TZ=Asia/Bangkok), the fake Claude CLI
// dumping each turn. Until the owner picks a zone the clock line follows the
// computer; once they pick Central, the turn's clock line names Central.
// Synthetic fixture text only; loopback server, no network or credentials.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let moss: { id: string; threadId: string };
let sequence = 0;

const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy); };

/** The message the engine was handed for the turn carrying `tag` (the clock line rides the message, never the system prompt). */
async function turnMessage(): Promise<string> {
  const tag = `ZONE_TURN_${++sequence}`;
  await api("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: `Please answer briefly. ${tag}` });
  let found = "";
  await expect.poll(() => {
    let lines: string[] = [];
    try { lines = readFileSync(fixture.fixtureDumpLogPath, "utf8").split("\n"); } catch { return false; }
    for (const line of lines) {
      if (!line) continue;
      let dump: any;
      try { dump = JSON.parse(line); } catch { continue; }
      const prompt = JSON.stringify(dump.prompt ?? null);
      if (prompt.includes(tag)) { found = prompt; return true; }
    }
    return false;
  }, { timeout: 45000 }).toBe(true);
  await expect.poll(idle, { timeout: 30000 }).toBe(true);
  return found;
}

posixOnly("owner time zone", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env, TZ: "Asia/Bangkok" }, undefined, { dumpLog: true, instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false });
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("follows the computer by default and says so", async () => {
    expect((await call("GET", "/api/owner/timezone", undefined, {})).status).toBe(404);
    expect(await api("GET", "/api/owner/timezone")).toEqual({ timeZone: "Asia/Bangkok", chosen: false, computerTimeZone: "Asia/Bangkok", canFollowComputer: true });
    expect(await turnMessage()).toContain("in the owner's time zone, Asia/Bangkok (UTC+07:00)");
  }, 60000);

  it("saves a chosen zone on the profile, and the next turn's clock names it", async () => {
    expect((await call("PUT", "/api/owner/timezone", { timeZone: "Not/AZone" })).status).toBe(400);
    expect((await call("PUT", "/api/owner/timezone", { timeZone: "America/Chicago" }, {})).status).toBe(404);
    expect(await api("PUT", "/api/owner/timezone", { timeZone: "America/Chicago" })).toEqual({ timeZone: "America/Chicago", chosen: true, computerTimeZone: "Asia/Bangkok", canFollowComputer: true, routinesMoved: true });
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).profile.timeZone).toBe("America/Chicago");
    expect(await api("GET", "/api/owner/timezone")).toMatchObject({ timeZone: "America/Chicago", chosen: true });
    const message = await turnMessage();
    expect(message).toMatch(/in the owner's time zone, America\/Chicago \(UTC-0[56]:00\)/);
    expect(message).not.toContain("Asia/Bangkok");
  }, 60000);

  it("follows the computer again when asked", async () => {
    expect(await api("PUT", "/api/owner/timezone", { timeZone: null })).toEqual({ timeZone: "Asia/Bangkok", chosen: false, computerTimeZone: "Asia/Bangkok", canFollowComputer: true, routinesMoved: true });
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).profile.timeZone).toBe("");
    expect(await turnMessage()).toContain("in the owner's time zone, Asia/Bangkok (UTC+07:00)");
  }, 60000);
});
