// A Chief-created operator that inherited Auto is still bounded by what Auto
// means for any bot a person enabled it on (AUTOOP1).
//
// The unit tests in auto-approve.test.ts pin the RULE (a question outranks
// every grant; guards outrank auto mode). This pins the WIRING for the one
// bot that no person configured directly: an operator the Chief created
// while the person had the Chief in Auto. If the inheritance ever bypassed
// the permission host — a flag the host does not read, a task the profile
// does not mirror — the question below would be answered by the machine and
// the credential card would never appear.
//
//   1. the operator inherits Auto (computer off, peer comms off)
//   2. its engine's AskUserQuestion still reaches the person as a live,
//      unanswered card that offers no "Always allow"
//   3. its request_credential still lands as a secret card for the person,
//      while the same Auto turn is in flight
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let claudeDump: string;
let acpDump: string;
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
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === botId);

async function readJsonWhenReady<T>(file: string, timeout = 20_000): Promise<T> {
  let parsed: unknown;
  await expect.poll(() => {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
      return true;
    } catch {
      return false;
    }
  }, { timeout }).toBe(true);
  return parsed as T;
}

/** The agents MCP env an ACP session was handed, as `{name, value}` rows. */
function acpAgentsEnv(file: string): Record<string, string> {
  const servers = JSON.parse(readFileSync(file, "utf8")) as Array<{ name: string; env?: Array<{ name: string; value: string }> }>;
  const agents = servers.find((server) => server.name === "agents");
  expect(agents, "the operator's turn was not given the agents MCP server").toBeTruthy();
  return Object.fromEntries((agents!.env ?? []).map((row) => [row.name, row.value]));
}

posixOnly("Auto operators created by the Chief still ask the person", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-auto-operator-"));
    claudeDump = join(home, "fake-claude-dump.json");
    acpDump = join(home, "fake-acp-dump.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, "finish-fake"), { recursive: true });
    // grok's ACP support requires a sign-in marker
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "{}");
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        engineDiscovery: "explicit",
        instances: {
          // the Chief: holds its turn open so create_bot has live authority
          claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE } },
          // the operator's engine: routes its AskUserQuestion through the
          // permission request, the way Claude Code reaches the permission host
          asker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "question-tool", FAKE_ACP_DUMP: acpDump },
            config: { cli: FAKE_ACP, fullAuto: false },
          },
        },
      }),
    );
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

  it(
    "an inherited-Auto operator's questions and credential requests still reach the person",
    async () => {
      const chief = (await api("POST", "/api/bots", { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, {
        name: "Chief",
        section: "Auto operator test",
        chiefOfStaff: true,
        // A Chief that never chose a computer drives this Mac in Auto, so the
        // desktop dialog's acknowledgement rides along (AUTOOP2 finding 1).
        autoApprove: true,
        acknowledgeLocalAuto: true,
      })).status).toBe(200);

      // The Chief's held turn is what gives create_bot its authority.
      rmSync(claudeDump, { force: true });
      expect((await api("POST", `/api/bots/${chief.id}/messages`, { text: "__fixture_hold_authority__", threadId: chief.threadId })).status).toBe(202);
      const chiefTurn = await readJsonWhenReady<{ pid: number; mcpConfig: { mcpServers: { agents: { env: Record<string, string> } } } }>(claudeDump);
      const chiefEnv = chiefTurn.mcpConfig.mcpServers.agents.env;
      expect(chiefEnv.MURAGE_BOT_ID).toBe(chief.id);

      const created = await fetch(`${base}/api/internal/create-bot`, {
        method: "POST",
        headers: { authorization: `Bearer ${chiefEnv.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          fromBotId: chief.id,
          fromThreadId: chief.threadId,
          name: "Curious operator",
          role: "Research operator",
          instructions: "Ask before assuming.",
          modelSelection: { instanceId: "asker", model: "grok-4.6" },
        }),
      });
      expect(created.status).toBe(201);
      const operatorId = ((await created.json()) as { id: string; auto: boolean });
      expect(operatorId.auto).toBe(true);
      const operator = await botState(operatorId.id);
      // 1. inherited Auto, bounded
      expect(operator).toMatchObject({ autoApprove: true, computer: "off", approvePeerComms: false, composio: false });
      expect(operator.tasks[0]).toMatchObject({ autoApprove: true });
      // the Chief's turn is no longer needed
      writeFileSync(join(home, "finish-fake", String(chiefTurn.pid)), "finish");

      // 2. the operator's engine asks the person a question mid-turn. Auto
      //    mode must not answer it: the card must be live, unanswered, held
      //    as a question, and offer no "Always allow".
      rmSync(acpDump, { force: true });
      rmSync(`${acpDump}.mcp.json`, { force: true });
      expect((await api("POST", `/api/bots/${operator.id}/messages`, { text: "go", threadId: operator.threadId })).status).toBe(202);
      let card: any = null;
      await expect.poll(async () => {
        card = (await messages(operator.threadId)).find((m) => m.kind === "options" && m.card?.requestId) ?? null;
        return Boolean(card);
      }, { timeout: 30_000 }).toBe(true);
      expect(card.card.tool).toBe("AskUserQuestion");
      expect(card.card.answered, "the question was answered by Auto mode instead of reaching the person").toBeUndefined();
      expect(card.card.allowKey, "a question card must not offer Always allow").toBeUndefined();
      expect(card.card.held).toMatch(/question/i);
      // and no machine approval chip was written for it
      expect((await messages(operator.threadId)).some((m) => m.kind === "activity" && /auto-approved/i.test(m.tool?.name ?? ""))).toBe(false);

      // 3. while that same Auto turn is in flight, a credential request from
      //    the operator lands as a secret card for the person, not an answer.
      await expect.poll(() => existsSync(`${acpDump}.mcp.json`), { timeout: 10_000 }).toBe(true);
      const operatorEnv = acpAgentsEnv(`${acpDump}.mcp.json`);
      expect(operatorEnv.MURAGE_BOT_ID).toBe(operator.id);
      const credential = await fetch(`${base}/api/internal/request-credential`, {
        method: "POST",
        headers: { authorization: `Bearer ${operatorEnv.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ fromBotId: operator.id, fromThreadId: operator.threadId, credentialId: "xaiApiKey", reason: "Needed for the research." }),
      });
      expect(credential.status).toBe(201);
      const { messageId } = (await credential.json()) as { messageId: string };
      const secretCard = (await messages(operator.threadId)).find((m) => m.id === messageId);
      expect(secretCard).toMatchObject({ kind: "secret", secret: { target: "xaiApiKey", label: "xAI API key" } });
      expect(secretCard.secret.answered ?? secretCard.secret.saved ?? undefined).toBeUndefined();

      // the person decides; only then does the turn move
      expect((await api("POST", `/api/bots/${operator.id}/respond`, { requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
      await expect.poll(async () => (await botState(operator.id))?.busy, { timeout: 20_000 }).toBe(false);
    },
    90_000,
  );
});
