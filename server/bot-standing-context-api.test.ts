// A bot is the same bot everywhere: its own notebook (MEMORY.md), its own
// pinned memory, its own skills and its team's shared brief reach its direct
// turns AND its turns as a room member, and a room message that addresses a
// member by name reaches that member rather than the room lead. Real server,
// memory active, the repository's fake Claude CLI dumping every request.
// Synthetic fixture text only; loopback server, no network or credentials.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SECTION = "Ops";
const SECTION_BRIEF = "SECTION_BRIEF_CANARY the Ops team ships on Thursdays.";
const TEAM_MEMORY = "TEAM_MEMORY_CANARY the Ops team prefers short status notes.";
const MOSS_NOTEBOOK = "MOSS_NOTEBOOK_CANARY the owner calls the garden project Fern.";
const SABLE_NOTEBOOK = "SABLE_NOTEBOOK_CANARY the owner reviews invoices on Mondays.";
const MOSS_PINNED = "MOSS_PINNED_CANARY the greenhouse sensor id is gh-7.";
const SABLE_PINNED = "SABLE_PINNED_CANARY the ledger lives in the blue folder.";
const MOSS_CONTINUITY = "MOSS_CONTINUITY_CANARY continue the fictional harbour story.";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let sable: { id: string; threadId: string }, moss: { id: string; threadId: string }, pixel: { id: string; threadId: string };
let room: { id: string; threadId: string };
let sequence = 0;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
  return value;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const marker = () => `STANDING_TURN_${++sequence}`;

async function captured(tag: string) {
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return { prompt: JSON.stringify(dump.prompt), system: String(dump.systemPrompt ?? "") };
}
async function directTurn(bot: { id: string; threadId: string }) {
  const tag = marker();
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Please answer briefly. ${tag}` });
  return captured(tag);
}
async function roomTurn(text: string) {
  const tag = marker();
  await api("POST", `/api/groups/${room.id}/messages`, { text: `${text} ${tag}` });
  return captured(tag);
}
const speaker = (system: string) => /^You are ([^,]+), a bot in the room/.exec(system)?.[1];

posixOnly("a bot carries its own notebook, memory, skills and team brief into every turn", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    const create = async (name: string, section: string) => {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, section });
      return bot as { id: string; threadId: string };
    };
    sable = await create("Sable", SECTION); moss = await create("Moss", SECTION); pixel = await create("Pixel", "Design");
    // Skills are pinned per task at a bot's first turn, so they are linked first.
    await api("POST", `/api/bots/${moss.id}/skills/library`, { ids: ["abstract-writing"] });
    await api("POST", `/api/bots/${sable.id}/skills/library`, { ids: ["academic-writer"] });
    room = (await api("POST", "/api/groups", { name: "Ops room", memberIds: [sable.id, moss.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: sable.id } } })).group;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("delivers the section's shared brief to its bots' direct turns and room member turns only", async () => {
    await api("PUT", `/api/section-context?section=${SECTION}`, { text: SECTION_BRIEF });
    expect((await directTurn(moss)).system).toContain(SECTION_BRIEF);
    expect((await directTurn(pixel)).system).not.toContain(SECTION_BRIEF);
    const lead = await roomTurn("Please answer briefly.");
    expect(speaker(lead.system)).toBe("Sable");
    expect(lead.system).toContain(SECTION_BRIEF);
  }, 90000);

  it("delivers each bot's own MEMORY.md to its direct and room turns, never a teammate's", async () => {
    await api("PUT", `/api/bots/${moss.id}/memory`, { text: `# Memory\n\n- ${MOSS_NOTEBOOK}\n` });
    await api("PUT", `/api/bots/${sable.id}/memory`, { text: `# Memory\n\n- ${SABLE_NOTEBOOK}\n` });
    const direct = await directTurn(moss);
    expect(direct.system).toContain("Your memory (MEMORY.md)");
    expect(direct.system).toContain(MOSS_NOTEBOOK);
    expect(direct.system).not.toContain(SABLE_NOTEBOOK);
    const member = await roomTurn("@Moss please answer briefly.");
    expect(speaker(member.system)).toBe("Moss");
    expect(member.system).toContain(MOSS_NOTEBOOK);
    expect(member.system + member.prompt).not.toContain(SABLE_NOTEBOOK);
  }, 90000);

  it("invites edits to the notebook only when asked, and gives a routine run it read-only", async () => {
    await api("PUT", `/api/bots/${moss.id}/memory`, { text: `# Memory\n\n- ${MOSS_NOTEBOOK}\n` });
    const direct = await directTurn(moss);
    expect(direct.system).toContain("only when the person asks you to remember");
    expect(direct.system).not.toContain("leave it unchanged on this turn");
    // Nobody is watching a routine run, so an edit would wait for an approval nobody gives.
    const tag = marker();
    const routine = (await api("POST", "/api/routines", { botId: moss.id, name: "Notebook check", prompt: `Please answer briefly. ${tag}`, schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine;
    await api("POST", `/api/routines/${routine.id}/run`, {});
    const run = await captured(tag);
    expect(run.system).toContain(MOSS_NOTEBOOK);
    expect(run.system).toContain("leave it unchanged on this turn");
    expect(run.system).not.toContain("Edit it with your file tools");
  }, 90000);

  it("gives a room member its own bot and team memory, but not a teammate's or its private continuity", async () => {
    const pinImport = async (selections: unknown[]) => {
      const preview = await api("POST", "/api/memory/action", { action: "import-preview", selections });
      const committed = await api("POST", "/api/memory/action", { action: "import-commit", previewId: preview.previewId, track: false });
      for (const id of committed.recordIds as string[]) await api("POST", "/api/memory/action", { action: "pin", id, version: 1, pinned: true });
    };
    for (const [bot, text] of [[moss, MOSS_PINNED], [sable, SABLE_PINNED]] as const) {
      mkdirSync(join(fixture.info.dataDir, "workspaces", bot.id, "memory"), { recursive: true });
      writeFileSync(join(fixture.info.dataDir, "workspaces", bot.id, "memory", "room-notes.md"), text);
    }
    await pinImport([{ kind: "bot", botId: moss.id, topic: "room-notes.md" }, { kind: "bot", botId: sable.id, topic: "room-notes.md" }]);
    // Team memory distinct from the live brief: import one text, then change the brief.
    await api("PUT", `/api/section-context?section=${SECTION}`, { text: TEAM_MEMORY });
    await pinImport([{ kind: "section", section: SECTION }]);
    await api("PUT", `/api/section-context?section=${SECTION}`, { text: SECTION_BRIEF });
    // Owner-private continuity, pinned: it must stay out of rooms without failing the turn.
    const continuity = await api("POST", "/api/memory/action", { action: "identity-write", botId: moss.id, expectedVersion: 0, basis: "fiction", audience: "owner-private", kind: "continuity-brief", key: "core", text: MOSS_CONTINUITY });
    await api("POST", "/api/memory/action", { action: "pin", id: continuity.id, version: continuity.version, pinned: true });

    const member = await roomTurn("@Moss please answer briefly.");
    expect(speaker(member.system)).toBe("Moss");
    expect(member.prompt).toContain(MOSS_PINNED);
    expect(member.prompt).toContain(TEAM_MEMORY);
    expect(member.prompt + member.system).not.toContain(SABLE_PINNED);
    expect(member.prompt + member.system).not.toContain(MOSS_CONTINUITY);
    // The same private continuity still reaches Moss's own direct turn.
    expect((await directTurn(moss)).prompt).toContain(MOSS_CONTINUITY);
  }, 120000);

  it("routes a message that addresses a member by name to that member, and tells members not to answer for each other", async () => {
    const addressed = await roomTurn("Moss, can you confirm you are here?");
    expect(speaker(addressed.system)).toBe("Moss");
    expect(addressed.system).toContain("Never write lines as another member or answer on their behalf");
    const mentioned = await roomTurn("Please ask Moss later how the garden is doing.");
    expect(speaker(mentioned.system)).toBe("Sable");
  }, 90000);

  it("gives each room member its own linked skills, not the lead's", async () => {
    const member = await roomTurn("@Moss please answer briefly.");
    expect(speaker(member.system)).toBe("Moss");
    expect(member.system).toContain("abstract-writing");
    expect(member.system).not.toContain("academic-writer");
    const lead = await roomTurn("Please answer briefly.");
    expect(speaker(lead.system)).toBe("Sable");
    expect(lead.system).toContain("academic-writer");
    expect(lead.system).not.toContain("abstract-writing");
  }, 90000);
});
