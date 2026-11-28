// 1.0.23 queuedsend: a line steered into a Claude turn that runs with the "Checking the browser" note on screen (the BrowserCheckTurns
// entry the terminal fold settles) and then FAILS must still be sent as the next turn (the fold's one requeue call, server/index.ts:13793,
// reached after browserCheckTurns.terminal). Real server + the fake Claude CLI; the one fixture is the platform engine probe
// (settledBrowserEngineStatus), which on this host cannot report "checking" the way a packaged Mac does.
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


const ROW = { id: "browser-failed", first: "first" };
const ROWS = [ROW];
/** the engine probe reports a check in flight: the note is begun (BrowserCheckTurns.begin), the wait ends unfinished, the turn runs without the browser */
const PROBE_HOOK = `
const fs = await import("node:fs"); const { registerHooks } = await import("node:module");
globalThis.__fixtureProbe = async (_options, settle) => { settle.onChecking?.("Murage is checking the browser that comes with it. This takes a few seconds the first time."); return { kind: "unavailable", installable: false, unfinished: true, reason: "Murage is still checking the browser that comes with it. This can take a minute when the computer is busy. Try again shortly." }; };
registerHooks({ load(url, context, next) {
  if (!url.endsWith("/server/index.ts")) return next(url, context);
  let source = fs.readFileSync(new URL(url), "utf8");
  const anchor = "await settledBrowserEngineStatus({}, {";
  if (!source.includes(anchor)) throw Error("browser probe anchor moved");
  return { format: "module-typescript", shortCircuit: true, source: source.replace(anchor, "await globalThis.__fixtureProbe({}, {") };
} });
`;

posixOnly("a line steered into a Claude turn that failed with its browser check note on screen is sent", () => {
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
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_REPLY_GATE: gate(row.id), FAKE_CLAUDE_FAIL_GATE: failGate(row.id), FAKE_CLAUDE_DUMP_LOG: dump(row.id), FAKE_CLAUDE_BG_GATE: bgGate(row.id) },
      config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
    };
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances, features: { browser: true } }));
    child = spawn(process.execPath, [...fakeEngineImportArgs(), "--import", "data:text/javascript," + encodeURIComponent(PROBE_HOOK), join(SERVER_DIR, "index.ts")], {
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
    expect((await api("PATCH", `/api/bots/${id}`, { modelSelection, browser: true })).status).toBe(200);
    expect((await api("POST", `/api/bots/${id}/messages`, { text: row.first })).status).toBe(202);
    await waitFor(async () => {
      const bot = await getBot(id);
      return bot.busy === true && (bot.messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash" && m.tool.ok === true));
    }, "the turn running");
    const steered = await api("POST", `/api/bots/${id}/messages`, { text: typed });
    expect(steered.status).toBe(202);
    expect(steered.body.steered, JSON.stringify(steered.body)).toBe(true);
    // the browser check note is on screen for this turn (the BrowserCheckTurns entry the terminal fold settles)
    expect((await getBot(id)).messages.some((m: any) => m.kind === "activity" && /checking the browser/i.test(String(m.tool?.name ?? ""))), "the checking-the-browser note").toBe(true);
    // the turn FAILS before the engine answers the steer (an error result)
    writeFileSync(failGate(ROW.id), "fail");
    const asTurn = () => turns(ROW.id).filter((turn) => (turn.prompt ?? "").includes(typed));
    for (const deadline = Date.now() + 25_000; asTurn().length === 0 && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 150));
    expect(asTurn(), `no turn carried the line. turns: ${JSON.stringify(turns(ROW.id).map((t) => ({ prompt: (t.prompt ?? "").slice(-70), steer: t.steer }))).slice(0, 800)} stderr: ${stderr.slice(-1200)}`).toHaveLength(1);
    // the next turn (held at the same reply gate) is let go, and the thread ends idle with the words sent once
    writeFileSync(gate(ROW.id), "reply");
    await waitFor(async () => (await getBot(id)).busy === false, "the next turn to end");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(asTurn()).toHaveLength(1);
    const lines = (await getBot(id)).messages.filter((m: any) => m.role === "user" && m.text === typed);
    expect(lines).toHaveLength(1);
  }, 90_000);
});
