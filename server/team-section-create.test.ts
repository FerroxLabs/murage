// A team lead builds a client team in a NEW team of its own, and still cannot
// add bots to a team it did not start (1.0.16 TEAM-SECTION, Sean 11-04).
//
// Sean's "Demo Director" (lead of Demo Machine) ran a playbook that makes a
// client team of four with its own lead in a new sidebar team. create_bot
// refused the new team, and the bot then made all four in Demo Machine. This
// drives the real create-bot route with the lead's live turn token:
//   1. the new team and its lead are created, then specialists join it, and
//      nothing lands in the lead's own team;
//   2. a team the lead did not start is refused, with "stop and tell the owner";
//   3. after that refusal, the same turn cannot file the bots in its own team.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const MODEL = { instanceId: "claude", model: "claude-sonnet-5" };

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let claudeDump: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const allBots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; name: string; section?: string; chiefOfStaff?: boolean }>;

async function makeBot(name: string, section: string, lead: boolean) {
  const bot = (await api("POST", "/api/bots", { modelSelection: MODEL })).body.bot;
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { name, section, ...(lead ? { chiefOfStaff: true } : {}) })).status).toBe(200);
  return bot as { id: string; threadId: string };
}

posixOnly("a team lead starts a client team, and only its own", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-team-section-"));
    claudeDump = join(home, "fake-claude-dump.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, "finish-fake"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: { claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE } } },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        FAKE_CLAUDE_MODE: "hang",
        FAKE_CLAUDE_DUMP: claudeDump,
        FAKE_CLAUDE_FINISH_GATE_DIR: join(home, "finish-fake"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("creates the client team with its lead in a new team, refuses a foreign team, and never scatters", async () => {
    const director = await makeBot("Demo Director", "Demo Machine", true);
    await makeBot("Sales Lead", "Sales", true);
    await makeBot("Closer", "Sales", false);

    // The lead's held turn is what gives create_bot its authority.
    expect((await desktopApi("POST", `/api/bots/${director.id}/messages`, { text: "__fixture_hold_authority__", threadId: director.threadId })).status).toBe(202);
    let turn: { pid: number; mcpConfig: { mcpServers: { agents: { env: Record<string, string> } } } } | undefined;
    await expect.poll(() => {
      try { turn = withTurnSecrets(JSON.parse(readFileSync(claudeDump, "utf8"))); return true; } catch { return false; }
    }, { timeout: 45_000 }).toBe(true);
    const env = turn!.mcpConfig.mcpServers.agents.env;
    expect(env.MURAGE_BOT_ID).toBe(director.id);
    const create = async (fields: Record<string, unknown>) => {
      const res = await fetch(`${base}/api/internal/create-bot`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ fromBotId: director.id, fromThreadId: director.threadId, role: "Roofing specialist", instructions: "Serve the client.", modelSelection: MODEL, ...fields }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    // 1. the client team: its lead first, then specialists into the team the lead just started
    const team = "Berwald Roofing AI Team";
    const lead = await create({ name: "Berwald Lead", section: team, lead: true });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    expect(lead.body).toMatchObject({ section: team, lead: true });
    for (const name of ["Estimator", "Scheduler", "Follow-up"]) {
      const made = await create({ name, section: team });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body).toMatchObject({ section: team, lead: false });
    }
    const after = await allBots();
    expect(after.filter((bot) => bot.section === team).map((bot) => bot.name).sort()).toEqual(["Berwald Lead", "Estimator", "Follow-up", "Scheduler"]);
    expect(after.find((bot) => bot.name === "Berwald Lead")?.chiefOfStaff).toBe(true);
    expect(after.filter((bot) => bot.section === "Demo Machine").map((bot) => bot.name)).toEqual(["Demo Director"]);
    expect(after.find((bot) => bot.id === director.id)?.chiefOfStaff).toBe(true);

    // 2. a team the lead did not start stays closed to it, in any spelling
    for (const section of ["Sales", "sales "]) {
      const foreign = await create({ name: "Intruder", section });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error).toMatch(/stop and tell the owner/);
    }
    const leadInto = await create({ name: "Usurper", section: "Sales", lead: true });
    expect(leadInto.status).toBe(403);

    // 3. and the refusal is not followed by the bots landing in the lead's own team
    const scatter = await create({ name: "Intruder" });
    expect(scatter.status).toBe(409);
    expect(scatter.body.error).toMatch(/refused the team Sales earlier in this turn/);
    const final = await allBots();
    expect(final.filter((bot) => bot.section === "Sales").map((bot) => bot.name).sort()).toEqual(["Closer", "Sales Lead"]);
    expect(final.some((bot) => ["Intruder", "Usurper"].includes(bot.name))).toBe(false);
    expect(final.filter((bot) => bot.section === "Demo Machine")).toHaveLength(1);

    writeFileSync(join(home, "finish-fake", String(turn!.pid)), "finish");
  }, 150_000);
});
