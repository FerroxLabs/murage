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
const fakeApp = "xapp-fixture-private-not-real", fakeBot = "xoxb-fixture-private-not-real";
interface Trace { kind: string; op: string; channel?: string; text?: string; eventId?: string }
it.each([false, true])("joins owner DM binding, restart and revocation (scripted model: %s)", async (withModel) => {
  const home = mkdtempSync(join(tmpdir(), "murage-slack-api-")), data = join(home, "data"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Slack fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
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
      ...(restored ? { MURAGE_SLACK_APP_TOKEN: fakeApp, MURAGE_SLACK_BOT_TOKEN: fakeBot } : {}) };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", join(root, "server/testing/slack-sdk-preload.mjs"), join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", chunk => { stderr += chunk; }); child.on("message", value => { if ((value as Trace)?.kind === "slack-fixture") traces.push(value as Trace); });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error("Fixture exited: " + stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  };
  const event = (id: string, text: string, user = "UOWNER", channel = "DOWNER") => child!.send({ kind: "slack-fixture-event", body: {
    type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: id, event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel, user, text },
  } });
  try {
    await boot();
    const candidate = (await request("GET", "/api/bots")).body.bots[0]; expect(candidate).toBeTruthy();
    // Establish the prerequisite explicitly: a fresh bot is intentionally not a Chief.
    // The existing local fake CLI declares leadership capability but receives no turn.
    const promoted = await request("PATCH", `/api/bots/${candidate.id}`, { name: "Fictional Slack Chief", chiefOfStaff: true, chiefScope: "workspace", computer: "off",
      modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    const chief = (await request("GET", "/api/bots")).body.bots.find((b: any) => b.chiefOfStaff && b.chiefScope === "workspace"); expect(chief?.id).toBe(candidate.id);
    for (const path of ["status", "pair", "resume", "revoke"]) expect((await request(path === "status" ? "GET" : "POST", "/api/slack/" + path, path === "status" ? undefined : {}, false)).status).toBe(404);
    expect((await request("PATCH", "/api/config", { slack: { appToken: fakeApp } }, false)).status).toBe(404);
    expect((await request("PATCH", "/api/config", { slack: { appToken: fakeApp } })).status).toBe(409);
    expect((await request("PATCH", "/api/config?secretStorage=external", { slack: { appToken: fakeApp, botToken: fakeBot, teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" } })).status).toBe(200);
    expect((await request("GET", "/api/slack/status")).body).toMatchObject({ configured: true, paired: false, enabled: false });
    expect(traces).toEqual([]); // Saving did not verify or connect.
    const saved = readFileSync(join(data, "config.json"), "utf8"); expect(saved).not.toContain(fakeApp); expect(saved).not.toContain(fakeBot);
    expect(JSON.parse(saved).slack).toMatchObject({ appToken: "", botToken: "", ownerUserId: "UOWNER" });
    expect((await request("PATCH", "/api/config", { slack: { targetBotId: "other" } })).status).toBe(409);
    expect((await request("POST", "/api/slack/pair", { targetBotId: "other" })).status).toBe(409);
    const paired = await request("POST", "/api/slack/pair", { targetBotId: chief.id }); expect(paired.status).toBe(200);
    event("EvWRONG", "/pair " + paired.body.code, "UOTHER");
    await expect.poll(() => traces.filter(t => t.op === "ack").length).toBe(1);
    expect((await request("GET", "/api/slack/status")).body.paired).toBe(false);
    event("EvPAIR", "/pair " + paired.body.code);
    await expect.poll(async () => (await request("GET", "/api/slack/status")).body.paired).toBe(true);
    await expect.poll(() => traces.filter(t => t.op === "send").length).toBe(1);
    event("EvYES", "yes");
    await expect.poll(() => traces.filter(t => t.op === "send").length).toBe(2);
    expect(traces.filter(t => t.op === "send").every(t => t.channel === "DOWNER")).toBe(true);
    expect(traces.filter(t => t.op === "send")[1].text).toContain("Review approvals in Murage");
    if (withModel) {
      // Channel messages run only for a linked person: link the verified
      // pairing sender as the workspace owner, as the owner does in settings.
      const bindings = (await request("POST", "/api/memory/action", { action: "humans" })).body.bindings; expect(bindings).toHaveLength(1);
      expect((await request("POST", "/api/memory/action", { action: "human-link", bindingId: bindings[0].id, expectedRevision: bindings[0].revision, as: "owner" })).status).toBe(200);
      event("EvWORK", "Summarize this synthetic note: the blue fixture is ready.");
      await expect.poll(() => traces.filter(t => t.op === "send").length, { timeout: 15000 }).toBe(3);
      expect(traces.filter(t => t.op === "send")[2]).toMatchObject({ channel: "DOWNER", text: "hello from fake claude" });
      const model = JSON.parse(readFileSync(join(home, "unexpected-model-turn.json"), "utf8"));
      expect(JSON.stringify(model.prompt)).toContain("the blue fixture is ready");
    }
    expect((await request("PATCH", "/api/config?secretStorage=external", { slack: { botToken: "replacement" } })).status).toBe(409);
    await waitForExit(child, { signal: "SIGTERM" }); expect(child!.exitCode, stderr).toBe(0);
    await boot(true);
    await expect.poll(async () => (await request("GET", "/api/slack/status")).body.enabled).toBe(true);
    const count = traces.filter(t => t.op === "send").length;
    event("EvYES", "yes"); event("EvOTHERDM", "yes", "UOWNER", "DOTHER");
    if (withModel) event("EvWORK", "Summarize this synthetic note: the blue fixture is ready.");
    await expect.poll(() => traces.filter(t => t.op === "ack" && t.eventId === "EvOTHERDM").length).toBe(1);
    expect(traces.filter(t => t.op === "send")).toHaveLength(count);
    expect((await request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false })).status).toBe(200);
    await expect.poll(async () => (await request("GET", "/api/slack/status")).body.state).toBe("blocked");
    expect((await request("POST", "/api/slack/revoke", {})).status).toBe(200);
    expect((await request("GET", "/api/slack/status")).body).toMatchObject({ paired: false, enabled: false, requiresRevoke: false });
    expect((await request("PATCH", "/api/config?secretStorage=external", { slack: { appToken: "", botToken: "" } })).status).toBe(200);
    const publicConfig = JSON.stringify((await request("GET", "/api/config", undefined, false)).body);
    expect(publicConfig + stderr + JSON.stringify(traces)).not.toContain(fakeApp); expect(publicConfig + stderr + JSON.stringify(traces)).not.toContain(fakeBot);
    expect(existsSync(join(home, "unexpected-model-turn.json"))).toBe(withModel);
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); }
}, 40000);
