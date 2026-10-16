// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 §5, N7/N7b on three engines through the real server: the owner's row is stamped `dispatchedIn` with
// the provider turn its words were released to, at the server's own submission fence plus acceptance, whichever comes second.
// Claude fences before it hands its id back; Fuigo (ACP) and Codex hand it back first. Parity is the point: the same stamp on
// every engine, and a later turn never moves an earlier row's stamp.
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { slimMessage } from "./transcript-page.ts";
import { transcriptForDriver } from "./turn-context.ts";
import type { Message } from "./store.ts";

const SERVER = fileURLToPath(new URL(".", import.meta.url));
const FAKE_ACP = join(SERVER, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER, "testing", "fake-codex-app-server.ts");
const ENGINES = [["Claude", "verification"], ["Fuigo", "attr-fuigo"], ["Codex", "attr-codex"]] as const;

describe.skipIf(process.platform === "win32")("dispatchedIn on every engine", () => {
  let fixture: VerificationServer;
  let fixtureRoot = "";
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  beforeAll(async () => {
    fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "attr-fixtures-")));
    vi.stubEnv("TMPDIR", fixtureRoot);
    for (const path of [FAKE_ACP, FAKE_CODEX]) chmodSync(path, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
      cfg.instances['attr-fuigo']={driver:'fuigoAgent',displayName:'Fuigo fixture',environment:{FAKE_ACP_MCP_READY:'1'},config:{cli:${JSON.stringify(FAKE_ACP)}}};
      cfg.instances['attr-codex']={driver:'codex',displayName:'Codex fixture',environment:{FAKE_CODEX_MODE:'happy'},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
  }, 120_000);
  afterAll(async () => { await fixture?.close(); if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  const transcript = async (botId: string): Promise<any[]> => ((await api("GET", "/api/bots?messages=40")).body.bots.find((bot: any) => bot.id === botId)?.messages ?? []);
  const settled = async (botId: string, text: string) => {
    let rows: any[] = [];
    await expect.poll(async () => {
      const bot = (await api("GET", "/api/bots?messages=40")).body.bots.find((entry: any) => entry.id === botId);
      rows = bot?.messages ?? [];
      const sent = rows.findIndex((row) => row.role === "user" && row.text === text);
      return bot?.busy !== true && sent >= 0 && rows.slice(sent + 1).some((row) => row.role === "bot" && row.kind === "text" && row.turnId);
    }, { timeout: 60_000, interval: 200 }).toBe(true);
    const sent = rows.findIndex((row) => row.role === "user" && row.text === text);
    return { user: rows[sent], reply: rows.slice(sent + 1).find((row) => row.role === "bot" && row.kind === "text" && row.turnId) };
  };

  it.each(ENGINES)("N7/N7b on %s: each sentence names the turn that answered it, and a later turn leaves the earlier stamp", async (_name, instanceId) => {
    const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
    expect(instance, instanceId).toBeTruthy();
    const model = instance.models.options[0]?.id || instance.models.default || "fixture-model";
    const made = await api("POST", "/api/bots", { name: `Attributed ${instanceId}`, modelSelection: { instanceId, model } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const bot = made.body.bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "first sentence", threadId: bot.threadId })).status).toBe(202);
    const one = await settled(bot.id, "first sentence");
    expect(one.user.dispatchedIn, JSON.stringify(one.user)).toBe(one.reply.turnId);
    expect(one.user.turnId).toBeUndefined();

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "second sentence", threadId: bot.threadId })).status).toBe(202);
    const two = await settled(bot.id, "second sentence");
    expect(two.user.dispatchedIn).toBe(two.reply.turnId);
    expect(two.user.dispatchedIn).not.toBe(one.user.dispatchedIn);
    // the earlier row keeps the turn its words went to; replayed history is never stamped again
    expect((await transcript(bot.id)).find((row) => row.id === one.user.id)?.dispatchedIn).toBe(one.user.dispatchedIn);
  }, 150_000);
});

describe("dispatchedIn exposure", () => {
  it("rides a page row wherever the row's turnId already does, and never reaches an engine's replay", () => {
    const user = { id: "u", at: 1, role: "user", kind: "text", text: "hi", dispatchedIn: "T1" } as Message;
    const reply = { id: "b", at: 2, role: "bot", kind: "text", text: "hello", turnId: "T1" } as Message;
    expect(slimMessage(user)).toMatchObject({ dispatchedIn: "T1" });
    expect(slimMessage(reply)).toMatchObject({ turnId: "T1" });
    const replay = transcriptForDriver([{ ...user, role: "user" } as any, { ...reply, role: "assistant" } as any]);
    for (const entry of replay) {
      expect(entry).not.toHaveProperty("dispatchedIn");
      expect(entry).not.toHaveProperty("turnId");
    }
  });
});
