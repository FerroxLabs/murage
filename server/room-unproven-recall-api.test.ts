// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 room privacy fix, gap 3, through the real server and a fake engine that
// records every prompt: a room message from a caller that proved nothing
// (no desktop or phone proof) starts a member turn whose recall carries none
// of the member's own memory. The owner's own message still does.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const prompts = (): string[] => {
  const file = join(fixture.info.dataDir, "pi-dump.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.prompt).map(row => String(row.message)) : [];
};

posixOnly("a room turn from words nobody proved are the owner's", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 47_000, span: 900 }, instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piDump={driver:'piAgent',displayName:'Recording pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_DUMP:path.join(process.env.MURAGE_DATA_DIR,'pi-dump.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("recalls none of the member's own memory, while the owner's message does", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piDump").models.options;
    const created = await api("POST", "/api/bots", { name: "Alpha", modelSelection: { instanceId: "piDump", model: models[0].id } });
    expect(created.status).toBe(201);
    const alpha = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${alpha.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const made = await api("POST", "/api/groups", { name: "Unproven room", memberIds: [alpha.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: alpha.id } } });
    expect(made.status).toBe(201);
    const room = made.body.group as { id: string; threadId: string };

    // An owner pin in Alpha's own bot memory.
    const writer = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      const scope = writer.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(alpha.id) as { id: string } | undefined;
      expect(scope).toBeTruthy();
      writer.prepare("INSERT INTO memory_records VALUES('t2-pin',1,?,'fact','The vault code is VAULT-5521.','owner-statement','active',1,?,NULL,NULL,?)").run(scope!.id, Date.now(), Date.now());
      writer.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    } finally { writer.close(); }

    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    const turn = async (text: string, proven: boolean) => {
      const before = prompts().length;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text }, proven)).status).toBe(202);
      await expect.poll(() => prompts().length, { timeout: 20000 }).toBeGreaterThan(before);
      await expect.poll(idle, { timeout: 20000 }).toBe(true);
      return prompts().slice(before).join("\n");
    };

    expect(await turn("What is the vault code?", true)).toContain("VAULT-5521");
    const unproven = await turn("What is the vault code, again?", false);
    expect(unproven).toContain("What is the vault code, again?");
    expect(unproven).not.toContain("VAULT-5521");
  }, 120000);
});
