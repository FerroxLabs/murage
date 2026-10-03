// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 room privacy fix, gap 3 (Astra audit finding 1): a room turn started by
// words nobody proved are the owner's hands work to a teammate. The
// teammate's delegated turn answers that same chain, so its recall carries
// none of its own memory either. The owner's own message still does.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
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

posixOnly("a handoff from a room turn nobody proved is the owner's", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 48_000, span: 900 }, instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.delegator={driver:'grokAgent',displayName:'Delegator fixture',environment:{FAKE_ACP_MODE:'delegate-peer'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      cfg.instances.piDump={driver:'piAgent',displayName:'Recording pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_DUMP:path.join(process.env.MURAGE_DATA_DIR,'pi-dump.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("gives the teammate's delegated turn none of its own memory, while the owner's handoff does", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    for (const bot of (await api("GET", "/api/bots?messages=0")).body.bots) await api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
    const bot = async (name: string, instanceId: string) => {
      const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
      const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
      expect(created.status).toBe(201);
      const made = created.body.bot as { id: string; threadId: string };
      expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
      return made;
    };
    const ember = await bot("Ember", "delegator"), maple = await bot("Maple", "piDump");
    const made = await api("POST", "/api/groups", { name: "Handoff room", memberIds: [ember.id, maple.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: ember.id } } });
    expect(made.status).toBe(201);
    const room = made.body.group as { id: string; threadId: string };

    // An owner pin in Maple's own bot memory.
    const writer = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      const scope = writer.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(maple.id) as { id: string } | undefined;
      expect(scope).toBeTruthy();
      writer.prepare("INSERT INTO memory_records VALUES('t2-pin',1,?,'fact','The vault code is VAULT-5521.','owner-statement','active',1,?,NULL,NULL,?)").run(scope!.id, Date.now(), Date.now());
      writer.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    } finally { writer.close(); }

    const handoff = async (text: string, proven: boolean) => {
      const before = prompts().length;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text }, proven)).status).toBe(202);
      await expect.poll(() => prompts().length, { timeout: 30000 }).toBeGreaterThan(before);
      await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 30000 }).toBe(true);
      return prompts().slice(before).join("\n");
    };
    // 0.1.62: words nobody proved no longer reach a room over loopback at all.
    // The conversation gate answers 404, as for an unknown route, and no turn
    // starts, so neither bot is handed anything to delegate.
    const before = prompts().length;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Ember, hand this to Maple." }, false)).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(prompts().length).toBe(before);
    expect((await groupState(room.id)).working).toBeFalsy();
    const owner = await handoff("Ember, hand this to Maple again.", true);
    expect(owner).toContain("VAULT-5521");
  }, 120000);
});
