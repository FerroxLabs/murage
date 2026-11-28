// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FRICTION P6 (F30): no "Local control is off" line on every new bot. Booted production server, the fake Claude CLI.
//   - a new bot starts on "this computer" only where local control is on (the owner's own choice always wins; a Cloud home,
//     which has no local control, keeps the automatic choice);
//   - a turn that never touches the computer carries no note, and a bot whose control is off says how to turn it on
//     only when the person asks (the system-prompt instruction), never as a status line of its own.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { CloudSessions } from "./cloud-sessions.ts";

const LINE = "Local control is off";

function harness() {
  const state = { fixture: undefined as unknown as VerificationServer, headers: {} as Record<string, string>, model: "" };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(state.fixture.info.url + path, { method, headers: { ...state.headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any };
  };
  const boot = async (from: number) => {
    state.fixture = await launchVerificationServer({}, undefined, { portRange: { from, span: 100 } });
    const proof = await api("GET", "/api/desktop-secret");
    state.headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    state.model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
  const dump = () => { try { return withTurnSecrets(JSON.parse(readFileSync(state.fixture.fixtureDumpPath, "utf8"))); } catch { return null; } };
  const create = async (name: string) => {
    const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: state.model } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.bot;
  };
  const runTurn = async (bot: any, text: string) => {
    rmSync(state.fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
    const busy = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === bot.threadId)?.busy;
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes(text), { timeout: 20_000 }).toBe(true);
    await expect.poll(busy, { timeout: 20_000 }).toBe(false);
    return dump();
  };
  const lines = async (bot: any) => (await messages(bot.threadId)).filter((m) => String(m.text ?? "").includes(LINE));
  return { state, api, boot, create, runTurn, lines, messages };
}

describe("local control is off on this machine", () => {
  const h = harness();
  beforeAll(() => h.boot(18_999), 60_000);
  afterAll(async () => { await h.state.fixture?.close(); });

  it("starts a new bot with no computer", async () => {
    const bot = await h.create("Control off default");
    expect(bot.computer).toBe("off");
  });

  it("the settings row says the same", async () => {
    expect((await h.api("GET", "/api/config")).body.newBotComputer).toBe("off");
  });

  it("keeps a bot on this computer when the owner chose that, and still says nothing on a turn that never touches it", async () => {
    expect((await h.api("PATCH", "/api/config", { computer: { defaultForNewBots: "this" } })).body.newBotComputer).toBe("this");
    const bot = await h.create("Control off explicit this");
    expect(bot.computer).toBe("local");
    const quiet = await h.runTurn(bot, "reply with one word");
    expect(quiet, "the provider turn never started").not.toBeNull();
    expect(await h.lines(bot)).toEqual([]);
    expect(JSON.stringify(quiet.mcpConfig?.mcpServers?.computer ?? null)).toBe("null");
  }, 60_000);

  it("the bot says how to turn it on only when the person asks, and never as a status line", async () => {
    const bot = (await h.api("GET", "/api/bots")).body.bots.find((b: any) => b.name === "Control off explicit this");
    const asked = await h.runTurn(bot, "use my computer to open the calendar");
    expect(String(asked.systemPrompt)).toContain("local control is not enabled yet");
    expect(String(asked.systemPrompt)).toContain("turn on local control in Settings > Computer");
    const again = await h.runTurn(bot, "use my computer again");
    expect(String(again.systemPrompt)).toContain("local control is not enabled yet");
    expect(await h.lines(bot)).toEqual([]);
  }, 60_000);
});

// Cloud home (FABLE/OPUS H1 e8c284d66a): a headless Cloud home never has a local-control descriptor, so the rule above
// must not apply there; with no owner choice a new bot keeps the automatic computer (no `computer` field), as before.
// Not a base-RED witness (base already does this): it fails only if the Cloud-home exemption is removed
// (helper M8-cloud; per call site M9-cloud-create, M10-cloud-frame).
describe("a Cloud home, which never has local control", () => {
  const origin = "https://home.example.test";
  let fixture: VerificationServer, db: DatabaseSync, auth: Record<string, string> = {};
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, { method, headers: {
      host: "home.example.test", origin, "content-type": "application/json", ...auth,
      ...(encoded ? { "content-length": String(Buffer.byteLength(encoded)) } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }); });
    });
    req.on("error", reject); req.end(encoded);
  });
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { cloud: { publicOrigin: origin, bootstrapSecret: "fixture-localline-bootstrap-32-characters" }, portRange: { from: 19_399, span: 100 } });
    db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const id = randomUUID(), now = Date.now();
    db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
      .run(id, "fixture-owner", "owner-desktop", pem, pem, now, now);
    auth = { authorization: `Bearer ${new CloudSessions(db, undefined, origin).issue(id).accessToken}` };
  }, 120_000);
  afterAll(async () => { db?.close(); await fixture?.close(); });

  it("a new owner bot keeps the automatic computer", async () => {
    const made = await call("POST", "/api/bots", { name: "Cloud home default", modelSelection: { instanceId: "verification", model: "claude-sonnet-5" } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.bot.computer).toBeUndefined();
  }, 60_000);

  it("the settings row still says this computer", async () => {
    expect((await call("GET", "/api/config")).body.newBotComputer).toBe("this");
  });
});
