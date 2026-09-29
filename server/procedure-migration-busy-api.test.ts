// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A brand-new bot's first turn runs the one-time move of skill discovery
// into task desks (skills.ts migrateSkillDiscoveryToTasks). AFTER-REVIEW
// (0161 lanes/review): that first turn failed with "Procedure migration is
// waiting for another active task" when another turn of the same bot was
// already under way, and the room it failed in stayed marked busy. A new
// bot has nothing to move, so its migration never has to wait; and a turn
// that does fail before dispatch hands the room back.
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, gate: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const state = async () => (await api("GET", "/api/bots?messages=0")).body as { bots: any[]; groups: any[] };
const lines = (thread: any[]) => thread.map((m) => `${m.from?.name ?? m.actorKind ?? m.role}: ${m.tool?.name ?? String(m.text ?? "").slice(0, 120)}`).join("\n");
// a room reply names its speaker; a desk reply is the bot's own line
const replied = (thread: any[], botId: string) => thread.some((m) => (m.from ? m.from.botId === botId : m.role === "bot") && m.kind === "text" && m.text === "Hello from pi");
// the migration refusing, as the room says it (roomSetupFailureLine) or as a desk error
const migrationError = (thread: any[]) => thread.some((m) => /Procedure migration|PROCEDURE_DISCOVERY|could not answer: it (is still finishing other work|could not get ready)/.test(`${m.text ?? ""} ${m.tool?.name ?? ""}`));
const rawCodes = (thread: any[]) => thread.some((m) => /PROCEDURE_|Procedure migration|EACCES|\/workspaces\//.test(`${m.text ?? ""} ${m.tool?.name ?? ""}`));

// chmod 0500 holds nothing back from root
const asRoot = process.getuid?.() === 0;

posixOnly("the first turn of a new bot while another of its turns runs", () => {
  beforeAll(async () => {
    chmodSync(FAKE_PI, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piGate={driver:'piAgent',displayName:'Gated pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'pi-session-gate')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "pi-session-gate");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const bot = async (name: string) => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piGate").models.options;
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "piGate", model: models[0].id } });
    expect(created.status).toBe(201);
    const made = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return made;
  };
  const room = async (name: string, memberIds: string[]) => {
    const created = await api("POST", "/api/groups", { name, memberIds, setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.group as { id: string; threadId: string };
  };
  const hold = () => { rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true }); };
  const hideEveryone = async () => { for (const existing of (await state()).bots) await api("PATCH", `/api/bots/${existing.id}`, { hidden: true }); };
  const settled = async (roomId: string, botId: string) => {
    const now = await state();
    const group = now.groups.find((g) => g.id === roomId);
    return Boolean(group) && !group.working && !group.busyBotId && now.bots.find((b) => b.id === botId)?.busy !== true;
  };

  // The sim's case: a fresh member gets a room turn and a card (or a desk
  // message) at the same moment. Both turns are under way before either
  // reaches the migration, so whichever gets there first saw the other and
  // failed.
  it("a new bot asked in its room and at its desk at the same moment answers both", async () => {
    await hideEveryone();
    for (const name of ["Quinn", "Quade", "Quest"]) {
      const quinn = await bot(name);
      const office = await room(`${name}'s room`, [quinn.id]);
      hold();
      const [sent, dm] = await Promise.all([
        api("POST", `/api/groups/${office.id}/messages`, { text: "One line, please." }),
        api("POST", `/api/bots/${quinn.id}/messages`, { text: "A quick one here." }),
      ]);
      expect(sent.status).toBe(202);
      expect(dm.status).toBeLessThan(300);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      writeFileSync(gate, "");
      const report = async () => `desk:\n${lines(await messages(quinn.threadId))}\nroom:\n${lines(await messages(office.threadId))}\nstate: ${JSON.stringify((await state()).groups.find((g) => g.id === office.id))}`;
      await expect.poll(async () => replied(await messages(quinn.threadId), quinn.id) && replied(await messages(office.threadId), quinn.id), { timeout: 15000 }).toBe(true)
        .catch(async (error) => { throw new Error(`${name}: ${error}\n${await report()}`); });
      expect(migrationError(await messages(quinn.threadId))).toBe(false);
      expect(migrationError(await messages(office.threadId))).toBe(false);
      await expect.poll(() => settled(office.id, quinn.id), { timeout: 15000 }).toBe(true)
        .catch(async (error) => { throw new Error(`${name}: ${error}\n${await report()}`); });
    }
  }, 120000);

  // Parallel desks: two tasks of a new bot asked at the same moment. Both
  // are under way before either reaches the migration.
  it("a new bot asked in two of its tasks at the same moment answers both", async () => {
    await hideEveryone();
    for (const name of ["Tamsin", "Tobin", "Tully"]) {
      const quinn = await bot(name);
      const one = (await api("POST", `/api/bots/${quinn.id}/tasks`, { title: "One" })).body.task as { threadId: string };
      const two = (await api("POST", `/api/bots/${quinn.id}/tasks`, { title: "Two" })).body.task as { threadId: string };
      hold();
      const sent = await Promise.all([one, two].map((task) => api("POST", `/api/bots/${quinn.id}/messages`, { threadId: task.threadId, text: "A quick one." })));
      for (const response of sent) expect(response.status).toBeLessThan(300);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      writeFileSync(gate, "");
      const report = async () => `one:\n${lines(await messages(one.threadId))}\ntwo:\n${lines(await messages(two.threadId))}`;
      await expect.poll(async () => replied(await messages(one.threadId), quinn.id) && replied(await messages(two.threadId), quinn.id), { timeout: 15000 }).toBe(true)
        .catch(async (error) => { throw new Error(`${name}: ${error}\n${await report()}`); });
      expect(migrationError(await messages(one.threadId)) || migrationError(await messages(two.threadId))).toBe(false);
    }
  }, 120000);

  // Nothing else of the bot runs, but the old link cannot be moved (its
  // folder is read-only): the migration refuses, and the room is handed
  // back all the same.
  it.skipIf(asRoot)("a room turn whose one-time migration cannot finish hands the room back", async () => {
    await hideEveryone();
    const quinn = await bot("Quarry");
    const desk = await room("Stuck desk", [quinn.id]);
    const root = join(fixture.info.dataDir, "workspaces", quinn.id), links = join(root, ".agents", "skills");
    mkdirSync(join(root, "skills", "old-habit"), { recursive: true });
    writeFileSync(join(root, "skills", "old-habit", "SKILL.md"), "---\nname: old-habit\ndescription: An old habit\n---\nBe old.\n");
    mkdirSync(links, { recursive: true });
    symlinkSync("../../skills/old-habit", join(links, "old-habit"));
    rmSync(join(fixture.info.dataDir, "skill-state", quinn.id, "task-discovery.json"), { force: true });
    chmodSync(links, 0o500);
    try {
      writeFileSync(gate, "");
      expect((await api("POST", `/api/groups/${desk.id}/messages`, { text: "one line here" })).status).toBe(202);
      const report = async () => `room:\n${lines(await messages(desk.threadId))}\nstate: ${JSON.stringify((await state()).groups.find((g) => g.id === desk.id))}`;
      await expect.poll(async () => {
        const group = (await state()).groups.find((g) => g.id === desk.id);
        return migrationError(await messages(desk.threadId)) && !group.busyBotId && !group.working;
      }, { timeout: 15000 }).toBe(true).catch(async (error) => { throw new Error(`${error}\n${await report()}`); });
      await expect.poll(() => settled(desk.id, quinn.id), { timeout: 15000 }).toBe(true);
      expect(rawCodes(await messages(desk.threadId))).toBe(false);
    } finally { chmodSync(links, 0o700); }
    // the folder writable again: the next message moves the link and is answered
    expect((await api("POST", `/api/groups/${desk.id}/messages`, { text: "one more line" })).status).toBe(202);
    await expect.poll(async () => replied(await messages(desk.threadId), quinn.id), { timeout: 20000 }).toBe(true);
    await expect.poll(() => settled(desk.id, quinn.id), { timeout: 15000 }).toBe(true);
    expect(existsSync(join(links, "old-habit"))).toBe(false);
  }, 120000);
});
