// 1.0.23 queuedsend: a line typed into a running Claude turn ("Enter sends this into the running turn") must reach the engine
// whichever way that turn ends before the engine answered it: a Stop, the background wait cap (ok:true, Murage's own note), an
// error result, the CLI dying. One row per end path, each through POST /api/bots/:id/messages on a real server with the fake
// Claude CLI. A line counts as sent when a Claude turn of its own carries it (the dump log's per-turn `prompt`), or the turn that
// was running read it (the log's `steer`) and answered it (the control row).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");


/** one row per way the turn ends; `ready` is what the test waits for before it types the line, `end` how it ends the turn */
const ROWS: Array<{ id: string; how: "answered" | "stop" | "cap" | "fail-result" | "fail-exit"; env?: Record<string, string>; config?: Record<string, unknown>; first: string }> = [
  { id: "answered", how: "answered", first: "first" },
  { id: "stop", how: "stop", first: "first" },
  { id: "cap", how: "cap", first: "first __fixture_background__", env: { FAKE_CLAUDE_BG_HOLD: "1", FAKE_CLAUDE_BG_ASKS: "0" }, config: { backgroundTaskCapMs: 3_000 } },
  { id: "fail-result", how: "fail-result", first: "first" },
  { id: "fail-exit", how: "fail-exit", first: "first", env: { FAKE_CLAUDE_FAIL_KIND: "exit" } },
];

posixOnly("a line steered into a Claude turn is sent however the turn ends", () => {
  let child: ChildProcess;
  let home = "";
  let stderr = "";
  let base = "";
  let headers: Record<string, string> = {};
  const gate = (id: string) => join(home, `${id}.reply.gate`);
  const failGate = (id: string) => join(home, `${id}.fail.gate`);
  const bgGate = (id: string) => join(home, `${id}.bg.gate`);
  const dump = (id: string) => join(home, `${id}.turns.log`);

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const turns = (id: string): Array<{ prompt?: string; steer?: string }> => (existsSync(dump(id)) ? readFileSync(dump(id), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-queued-claude-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    const instances: Record<string, unknown> = {};
    for (const row of ROWS) instances[`claude_${row.id.replaceAll("-", "_")}`] = {
      driver: "claudeAgent",
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_REPLY_GATE: gate(row.id), FAKE_CLAUDE_FAIL_GATE: failGate(row.id), FAKE_CLAUDE_DUMP_LOG: dump(row.id), FAKE_CLAUDE_BG_GATE: bgGate(row.id), ...row.env },
      config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions", ...row.config },
    };
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances }));
    child = spawn(process.execPath, [...fakeEngineImportArgs(), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"],
      env: { ...powerBlockTestEnv(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_BACKGROUND_CAP_MIN_MS: "500" },
    });
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdout!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 25_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await (await fetch(`${base}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref?.(); // the data folder is wiped only once the server has really exited
    });
    removeTempDirSync(home);
  });

  for (const row of ROWS) it(`${row.id}: the steered words are sent once, and the thread ends idle`, async () => {
    const modelSelection = { instanceId: `claude_${row.id.replaceAll("-", "_")}`, model: "claude-fake" };
    const typed = `typed into the running turn ${row.id}`;
    const created = await api("POST", "/api/bots", { modelSelection });
    expect(created.status).toBe(201);
    const id = created.body.bot.id as string;
    expect((await api("PATCH", `/api/bots/${id}`, { modelSelection })).status).toBe(200);
    expect((await api("POST", `/api/bots/${id}/messages`, { text: row.first })).status).toBe(202);
    await waitFor(async () => {
      const bot = await getBot(id);
      return bot.busy === true && (bot.messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash" && m.tool.ok === true));
    }, "the turn running");
    const steered = await api("POST", `/api/bots/${id}/messages`, { text: typed });
    expect(steered.status).toBe(202);
    expect(steered.body.steered, JSON.stringify(steered.body)).toBe(true);
    // the turn ends before the engine answers the steer (the control row lets it answer)
    if (row.how === "stop") expect((await api("POST", `/api/bots/${id}/interrupt`)).status).toBe(200);
    else if (row.how === "fail-result" || row.how === "fail-exit") writeFileSync(failGate(row.id), "fail");
    else if (row.how === "answered") writeFileSync(gate(row.id), "reply");
    else if (row.how === "cap") writeFileSync(bgGate(row.id), "go"); // the first result comes, the helpers never finish, and the cap ends the turn with Murage's note
    // the words reach a turn of the engine's: a next turn carries them, or (control) the running turn read and answered them
    const asTurn = () => turns(row.id).filter((turn) => (turn.prompt ?? "").includes(typed));
    const asSteer = () => turns(row.id).filter((turn) => (turn.steer ?? "").includes(typed));
    if (row.how === "answered") {
      await waitFor(async () => (await getBot(id)).busy === false, "the turn to end");
      expect(asSteer()).toHaveLength(1);
      expect(asTurn()).toHaveLength(0);
    } else {
      for (const deadline = Date.now() + 25_000; asTurn().length === 0 && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 150));
      expect(asTurn(), `no turn carried the line. turns: ${JSON.stringify(turns(row.id).map((t) => ({ prompt: (t.prompt ?? "").slice(-70), steer: t.steer }))).slice(0, 800)} stderr: ${stderr.slice(-1200)}`).toHaveLength(1);
      // the next turn (held at the same reply gate) is let go, and the thread ends idle with the words sent once
      writeFileSync(gate(row.id), "reply");
      await waitFor(async () => (await getBot(id)).busy === false, "the next turn to end");
    }
    await new Promise((r) => setTimeout(r, 1_500));
    expect(asTurn().length + (row.how === "answered" ? asSteer().length : 0)).toBe(1);
    const lines = (await getBot(id)).messages.filter((m: any) => m.role === "user" && m.text === typed);
    expect(lines).toHaveLength(1);
  }, 90_000);
});
