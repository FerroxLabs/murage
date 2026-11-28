// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer;
let desktop: Record<string, string>;
type FixtureBot = { id: string; threadId: string };

async function api<T = unknown>(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.headers.get("content-type")?.includes("application/json");
  return { status: response.status, body: (json ? await response.json() : null) as T };
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: "process.env.FAKE_CLAUDE_MODE = 'hang';",
  });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const importResult = await api("POST", "/api/skills/import", {
    files: [{ path: "SKILL.md", content: "---\nname: sample-lifecycle\ndescription: Fixture instructions\n---\nKeep these details private.\n" }],
    kind: "file",
  });
  expect(importResult.status).toBe(201);
}, 60_000);

afterAll(async () => { await fixture?.close(); });

async function withSkillBot(skillRecorder: boolean, run: (bot: FixtureBot, auth: Record<string, string>) => Promise<void>) {
  expect((await api("PATCH", "/api/config", { features: { skillRecorder } })).status).toBe(200);
  const made = await api<{ bot: FixtureBot }>("POST", "/api/bots", { name: "Lifecycle fixture", modelSelection: { instanceId: "verification", model: "fake" } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  expect((await api("PUT", `/api/skills/collection:sample-lifecycle/bots/${bot.id}`, { on: true })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Show my installed skills." })).status).toBe(202);
  try {
    let bearer = "";
    await expect.poll(() => {
      try {
        const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
        const env = dump.mcpConfig?.mcpServers?.agents?.env;
        if (env?.MURAGE_BOT_ID !== bot.id || env?.MURAGE_THREAD_ID !== bot.threadId) return false;
        bearer = env.MURAGE_COMMS_TOKEN;
        return Boolean(bearer);
      } catch {
        return false;
      }
    }, { timeout: 20_000 }).toBe(true);
    await run(bot, { authorization: `Bearer ${bearer}` });
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }
}

it.each([true, false])("lists only lifecycle fields for the owner with authoring %s", async (authoring) => {
  await withSkillBot(authoring, async (bot, auth) => {
    const listed = await api<{ skills: Record<string, unknown>[] }>("GET", `/api/internal/skills?fromBotId=${bot.id}&fromThreadId=${bot.threadId}`, undefined, auth);
    expect(listed.status).toBe(200);
    expect(listed.body.skills).toHaveLength(1);
    const skill = listed.body.skills[0];
    expect(Object.keys(skill ?? {}).sort()).toEqual(["action", "name", "scope", "sha256"]);
    expect(skill).toMatchObject({ action: "turn_off", name: "sample-lifecycle", scope: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
}, 45_000);

it("queues a skill switch at Ask and leaves the skill intact when denied", async () => {
  await withSkillBot(false, async (bot, auth) => {
    const switched = await api("POST", "/api/internal/skills/switch", {
      fromBotId: bot.id, fromThreadId: bot.threadId, action: "turn_off", skill_name: "sample-lifecycle",
    }, auth);
    expect(switched.status).toBe(201);
    const view = await api<{ messages: Array<{ card?: { tool?: string; answered?: string; requestId?: string; requestHandle?: string } }> }>("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
    const message = view.body.messages.find(item => item.card?.tool === "switch_skill");
    expect(message?.card?.answered).toBeUndefined();
    expect(message?.card?.requestId).toBeUndefined();
    expect(message?.card?.requestHandle).toMatch(/^p\.[A-Za-z0-9-]+$/);
    const denied = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestHandle: message?.card?.requestHandle, action: "deny" });
    expect(denied.status).toBe(200);
    const skills = await api<{ skills: Record<string, unknown>[] }>("GET", `/api/bots/${bot.id}/skills`);
    expect(skills.body.skills).toContainEqual(expect.objectContaining({ name: "sample-lifecycle", enabled: true }));
  });
}, 45_000);
