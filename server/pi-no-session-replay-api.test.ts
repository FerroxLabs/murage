// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PI-NO-SESSION-RESUME, through the real server. Pi runs with --no-session, so no cursor is ever stored and every turn after
// the first replays the thread. That replay says the session was restarted. It says the bot was switched over only when it was.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const RESTARTED = "Murage started a fresh engine session for this conversation";
const SWITCHED = "this bot was switched over to you";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const prompts = (): string[] => {
  const file = join(fixture.info.dataDir, "pi-commands.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; message?: string }).filter((command) => command.type === "prompt").map((command) => command.message ?? "");
};
const models = async (instanceId: string) => (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options as Array<{ id: string }>;

posixOnly("a Pi replay says what happened", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const environment={FAKE_PI_NO_SESSION:'1',FAKE_PI_COMMAND_LOG:path.join(process.env.MURAGE_DATA_DIR,'pi-commands.jsonl')};
      for(const name of ['piOne','piTwo'])cfg.instances[name]={driver:'piAgent',displayName:name,config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},environment};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("the same engine reads as restarted on every turn; an engine switch still reads as a switch", async () => {
    const created = await api("POST", "/api/bots", { name: "Replay fixture", modelSelection: { instanceId: "piOne", model: (await models("piOne"))[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const say = async (text: string) => {
      const before = prompts().length;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
      await expect.poll(() => prompts().length, { timeout: 15000 }).toBe(before + 1);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((row: any) => row.id === bot.id).busy, { timeout: 15000 }).toBe(false);
      return prompts().at(-1)!;
    };

    const first = await say("the first thing");
    expect(first).not.toContain(RESTARTED);
    expect(first).not.toContain(SWITCHED);

    const second = await say("the second thing");
    expect(second).toContain(RESTARTED);
    expect(second).not.toContain(SWITCHED);
    expect(second).toContain("the first thing");

    const third = await say("the third thing");
    expect(third).toContain(RESTARTED);
    expect(third).toContain("the second thing");

    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "piTwo", model: (await models("piTwo"))[0].id } })).status).toBe(200);
    const moved = await say("the fourth thing");
    expect(moved).toContain(SWITCHED);
    expect(moved).not.toContain(RESTARTED);
  }, 60000);
});
