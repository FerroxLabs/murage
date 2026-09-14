import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const secret = "0123456789abcdef".repeat(4);
const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const fakeBot = "discord-fixture-private-not-real";
interface Trace { kind: string; op: string; channel?: string; text?: string; eventId?: string }
it.each([true])("joins owner DM binding, restart and revocation (scripted model: %s)", async (withModel) => {
  const home = mkdtempSync(join(tmpdir(), "murage-discord-api-")), data = join(home, "data"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Discord fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
    ghost: { driver: "fixture-unavailable" }, fixtureClaude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
  } }));
  const port = await freePortBlock([0, 1]); let child: ChildProcess | undefined; let stderr = ""; const traces: Trace[] = [];
  const request = async (method: string, path: string, body?: unknown, owner = true): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(owner ? desktop : {}), "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() };
  };
  const boot = async (restored = false) => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, PATH: process.env.PATH, FAKE_CLAUDE_DUMP: join(home, "unexpected-model-turn.json"),
      ...(restored ? { MURAGE_DISCORD_BOT_TOKEN: fakeBot } : {}) };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", join(root, "server/testing/discord-sdk-preload.mjs"), join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", chunk => { stderr += chunk; }); child.on("message", value => { if ((value as Trace)?.kind === "discord-fixture") traces.push(value as Trace); });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error("Fixture exited: " + stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  };
  const ids = new Map<string,string>();
  const event = (id: string, text: string, user = "13", channel = "14") => {
    if (!ids.has(id)) ids.set(id,String(100+ids.size));
    child!.send({kind:"discord-fixture-event",body:{id:ids.get(id),channelId:channel,channel:{type:1},author:{id:user,bot:false},guildId:null,webhookId:null,type:0,content:text,createdTimestamp:Date.now(),attachments:{size:0},components:[]}});
  };
  try {
    await boot();
    const candidate = (await request("GET", "/api/bots")).body.bots[0]; expect(candidate).toBeTruthy();
    // Establish the prerequisite explicitly: a fresh bot is intentionally not a Chief.
    // The existing local fake CLI declares leadership capability but receives no turn.
    const promoted = await request("PATCH", `/api/bots/${candidate.id}`, { name: "Fictional Discord Chief", chiefOfStaff: true, chiefScope: "workspace", computer: "off",
      modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    const chief = (await request("GET", "/api/bots")).body.bots.find((b: any) => b.chiefOfStaff && b.chiefScope === "workspace"); expect(chief?.id).toBe(candidate.id);
    for (const path of ["status", "pair", "resume", "revoke"]) expect((await request(path === "status" ? "GET" : "POST", "/api/discord/" + path, path === "status" ? undefined : {}, false)).status).toBe(404);
    expect((await request("PATCH", "/api/config", { discord: { botToken: fakeBot } }, false)).status).toBe(404);
    expect((await request("PATCH", "/api/config", { discord: { botToken: fakeBot } })).status).toBe(409);
    expect((await request("PATCH", "/api/config?secretStorage=external", { discord: { botToken: fakeBot, applicationId: "11", ownerUserId: "13" } })).status).toBe(200);
    expect((await request("GET", "/api/discord/status")).body).toMatchObject({ configured: true, paired: false, enabled: false });
    expect(traces).toEqual([]); // Saving did not verify or connect.
    const saved = readFileSync(join(data, "config.json"), "utf8"); expect(saved).not.toContain(fakeBot);
    expect(JSON.parse(saved).discord).toMatchObject({ botToken: "", ownerUserId: "13" });
    expect((await request("PATCH", "/api/config", { discord: { targetBotId: "other" } })).status).toBe(409);
    expect((await request("POST", "/api/discord/pair", { targetBotId: "other" })).status).toBe(409);
    const paired = await request("POST", "/api/discord/pair", { targetBotId: chief.id }); expect(paired.status).toBe(200);
    event("EvWRONG", "/pair " + paired.body.code, "88");
    await expect.poll(() => traces.filter(t => t.op === "received").length).toBe(1);
    expect((await request("GET", "/api/discord/status")).body.paired).toBe(false);
    event("EvPAIR", "/pair " + paired.body.code);
    await expect.poll(async () => (await request("GET", "/api/discord/status")).body.paired).toBe(true);
    await expect.poll(() => traces.filter(t => t.op === "send").length).toBe(1);
    event("EvYES", "yes");
    await expect.poll(() => traces.filter(t => t.op === "send").length).toBe(2);
    expect(traces.filter(t => t.op === "send").every(t => t.channel === "14")).toBe(true);
    expect(traces.filter(t => t.op === "send")[1].text).toContain("Review approvals in Murage");
    if (withModel) {
      event("EvWORK", "Summarize this synthetic note: the blue fixture is ready.");
      await expect.poll(() => traces.filter(t => t.op === "send").length, { timeout: 15000 }).toBe(3);
      expect(traces.filter(t => t.op === "send")[2]).toMatchObject({ channel: "14", text: "hello from fake claude" });
      const model = JSON.parse(readFileSync(join(home, "unexpected-model-turn.json"), "utf8"));
      expect(JSON.stringify(model.prompt)).toContain("the blue fixture is ready");
    }
    expect((await request("PATCH", "/api/config?secretStorage=external", { discord: { botToken: "replacement" } })).status).toBe(409);
    await waitForExit(child, { signal: "SIGTERM" }); expect(child!.exitCode, stderr).toBe(0);
    await boot(true);
    await expect.poll(async () => (await request("GET", "/api/discord/status")).body.enabled).toBe(true);
    const count = traces.filter(t => t.op === "send").length;
    event("EvYES", "yes"); event("EvOTHERDM", "yes", "13", "89");
    if (withModel) event("EvWORK", "Summarize this synthetic note: the blue fixture is ready.");
    await expect.poll(() => traces.filter(t => t.op === "received" && t.eventId === ids.get("EvOTHERDM")).length).toBe(1);
    expect(traces.filter(t => t.op === "send")).toHaveLength(count);
    expect((await request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false })).status).toBe(200);
    await expect.poll(async () => (await request("GET", "/api/discord/status")).body.state).toBe("blocked");
    expect((await request("POST", "/api/discord/revoke", {})).status).toBe(200);
    expect((await request("GET", "/api/discord/status")).body).toMatchObject({ paired: false, enabled: false, requiresRevoke: false });
    expect((await request("PATCH", "/api/config?secretStorage=external", { discord: { botToken: "" } })).status).toBe(200);
    const publicConfig = JSON.stringify((await request("GET", "/api/config", undefined, false)).body);
    expect(publicConfig + stderr + JSON.stringify(traces)).not.toContain(fakeBot);
    expect(existsSync(join(home, "unexpected-model-turn.json"))).toBe(withModel);
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); }
}, 40000);
