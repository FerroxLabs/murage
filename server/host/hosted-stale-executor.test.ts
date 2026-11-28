// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a witness for the D1.6 admission fence (designs/1021-m2-w0 r3 D1.6, r4 B8(11) stale_executor): while a custody
// record is unresolved at boot, a Fuigo turn refuses with today's engine-unavailable row and no turn starts.
// The unresolved record is real: a custody file the reap cannot read (mode 000; the runner is not root). The control
// boot is the same fixture without the file: its turn is admitted and records a turn row (this fixture's turn then
// ends on its own memory/intake path before the fake engine, which is outside the fence).
// Owner: O1 m2 S1a builder lane (fix/1022-o1m2). Every server child here uses a temporary HOME.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const UNAVAILABLE = "This bot's AI connection is unavailable. Choose another model, or reconnect your provider in App Settings.";
const children: ChildProcess[] = [];
const homes: string[] = [];
const locked: string[] = [];
afterAll(async () => {
  for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
  for (const file of locked) if (existsSync(file)) chmodSync(file, 0o600);
  for (const home of homes) await removeTempDir(home);
});

async function bootWithFuigo(label: string, unreadableCustody: boolean, reuseHome?: string) {
  const port = await freePortBlock([0, 1], 19_620, 200);
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), `murage-s1a-fence-${label}-`));
  if (!reuseHome) homes.push(home);
  const spawnLog = join(home, "fake-acp-spawns.log");
  const promptDump = join(home, "fake-acp-prompt.json");
  const gateFile = join(home, "gate");
  writeFileSync(gateFile, "open");
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(home, ".fuigo"), { recursive: true });
  writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
    fuigo: { driver: "fuigoAgent", environment: { FAKE_ACP_PROMPT_DUMP: promptDump, FAKE_ACP_RPC_DUMP: join(home, "fake-acp-rpc.json"), FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile, FAKE_ACP_SPAWN_LOG: spawnLog },
      config: { cli: FAKE_ACP, fullAuto: false } },
  } }));
  if (unreadableCustody) {
    const custody = join(home, ".murage", "hosted-custody.jsonl");
    writeFileSync(custody, "{}\n");
    chmodSync(custody, 0o000);
    locked.push(custody);
    expect(() => readFileSync(custody), "fixture: the runner is not root, so mode 000 denies the read").toThrow(/EACCES/);
  }
  chmodSync(FAKE_ACP, 0o755);
  let out = "";
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true, cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "" },
  });
  children.push(child);
  child.stdout!.on("data", chunk => (out += chunk));
  child.stderr!.on("data", chunk => (out += chunk));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    // Our own child must be the listener (a parallel suite's server on a reused port would answer health too).
    try { if (out.includes(`murage server on ${base}`) && (await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server never came up:\n${out.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const proof = (await fetch(`${base}/api/desktop-secret`).then(res => res.json())) as { secret: string };
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  // The thread's turn rows: a turn that got past admission (turnRouting) records rows carrying its turnId.
  const thread = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
  const turnRows = async (threadId: string) => (await thread(threadId)).filter(m => typeof m.turnId === "string").length;
  const spawns = () => existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length : 0;
  const stop = async () => { await waitForExit(child, { signal: "SIGTERM" }); };
  return { home, request, thread, turnRows, spawns, stop, out: () => out };
}

async function createFuigoBot(run: Awaited<ReturnType<typeof bootWithFuigo>>, name = "Fence fixture") {
  const created = await run.request("POST", "/api/bots", { name, modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await run.request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}

async function sendFuigoTurn(run: Awaited<ReturnType<typeof bootWithFuigo>>, name?: string) {
  const bot = await createFuigoBot(run, name);
  return { bot, sent: await run.request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hello there." }) };
}

describe.skipIf(process.platform === "win32")("D1.6 admission fence: stale_executor (real server child, fake Fuigo)", () => {
  it("control: without a custody file the same Fuigo turn is admitted and starts a turn", async () => {
    const run = await bootWithFuigo("control", false);
    const { bot, sent } = await sendFuigoTurn(run);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    for (let i = 0; i < 150 && (await run.turnRows(bot.threadId)) === 0; i++) await new Promise(resolve => setTimeout(resolve, 200));
    expect(await run.turnRows(bot.threadId), run.out().slice(-2000)).toBeGreaterThan(0);
    expect(JSON.stringify(await run.thread(bot.threadId))).not.toContain(UNAVAILABLE);
  }, 120_000);

  it("an unresolved custody record refuses the Fuigo turn with the engine-unavailable row; the engine never sees it", async () => {
    const run = await bootWithFuigo("fenced", true);
    // The turn first: on a build without the fence this is where the witness goes RED (202 instead of 409).
    const { bot, sent } = await sendFuigoTurn(run);
    expect({ status: sent.status, error: sent.body?.error }).toEqual({ status: 409, error: UNAVAILABLE });
    expect(run.out(), "boot line").toMatch(/\[fuigo-mode\] mode=COORDINATOR reason=stale_executor .*custodyUnresolved=1/);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(await run.turnRows(bot.threadId), "no turn started").toBe(0);
  }, 120_000);

  // r4 class sweep (lane SITES.md). Invariant: while a custody record is unresolved, no Fuigo engine turn starts in the
  // coordinator. One row per site that starts one, each driven through its own HTTP route
  // on a server restarted onto the unresolved record (the record is left by an earlier boot, as in production order).
  it("every Fuigo start site refuses after a restart onto an unresolved record (table over SITES.md)", async () => {
    const first = await bootWithFuigo("sites", false);
    // One bot per row, so a row admitted on a build without the fence (bot busy, queue) cannot change another row's outcome.
    const direct = await createFuigoBot(first, "Direct fixture");
    const { bot: editor, sent } = await sendFuigoTurn(first, "Edit fixture");
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    for (let i = 0; i < 150 && ((await first.turnRows(editor.threadId)) === 0 || (await first.request("GET", "/api/bots")).body.bots.find((b: any) => b.id === editor.id)?.busy); i++) await new Promise(resolve => setTimeout(resolve, 200));
    const chief = await createFuigoBot(first, "Chief fixture");
    const elected = await first.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
    expect(elected.status, JSON.stringify(elected.body)).toBe(200);
    const member = await createFuigoBot(first, "Room fixture");
    const made = await first.request("POST", "/api/groups", { name: "Fence room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const room = made.body.group as { id: string; threadId: string };
    const edited = (await first.thread(editor.threadId)).find(m => m.role === "user" && m.text === "Hello there.");
    expect(edited, "fixture: the first boot's user message exists").toBeTruthy();
    expect((await first.request("GET", "/api/bots")).body.bots.find((b: any) => b.id === editor.id)?.busy, "fixture: the edited bot is idle before the restart").toBe(false);
    await first.stop();
    const spawnedBefore = first.spawns();
    const run = await bootWithFuigo("sites-fenced", true, first.home);
    const roomLine = `error: Room fixture's model is unavailable`;
    const rows: Array<[string, () => Promise<unknown>, unknown]> = [
      ["S1 direct turn (turnRouting)", async () => {
        const r = await run.request("POST", `/api/bots/${direct.id}/messages`, { threadId: direct.threadId, text: "Second turn." });
        await new Promise(resolve => setTimeout(resolve, 1_000));
        return { status: r.status, error: r.body?.error, turnRows: await run.turnRows(direct.threadId) };
      }, { status: 409, error: UNAVAILABLE, turnRows: 0 }],
      // The edit route refuses at its own check (index.ts admittedInstance before startTurn); turnRouting inside startTurn
      // refuses identically before the fork, so this row guards the edit route's outcome, not that one line (SITES.md S3).
      ["S3 edit rerun", async () => {
        const r = await run.request("POST", `/api/bots/${editor.id}/messages/${edited.id}/edit`, { text: "Edited turn.", threadId: editor.threadId });
        return { status: r.status, error: r.body?.error, branchWritten: JSON.stringify(await run.thread(editor.threadId)).includes("Edited turn.") };
      }, { status: 409, error: UNAVAILABLE, branchWritten: false }],
      ["S2 room turn", async () => {
        const r = await run.request("POST", `/api/groups/${room.id}/messages`, { text: "Room turn." });
        let refused = false;
        for (let i = 0; i < 100 && !refused; i++) { refused = JSON.stringify(await run.thread(room.threadId)).includes(roomLine); if (!refused) await new Promise(resolve => setTimeout(resolve, 200)); }
        return { accepted: r.status === 202, refusedLine: refused };
      }, { accepted: true, refusedLine: true }],
      // S4: the Chief's project proposal runs as a Fuigo turn (runChiefProposalTurn -> turnRouting). Without the fence the fake
      // engine starts (dev/1022: spawned 2, the spawn counter's positive control); the reply line is the same either way.
      ["S4 chief proposal turn", async () => {
        const before = run.spawns();
        const r = await run.request("POST", "/api/projects/proposal", { purpose: "Plan the fence fixture" });
        return { status: r.status, body: JSON.stringify(r.body).slice(0, 300), spawned: run.spawns() - before };
      }, { status: 200, body: JSON.stringify({ reason: "The Chief could not return a usable proposal. Fill in the project below." }), spawned: 0 }],
    ];
    const observed = [];
    for (const [site, drive] of rows) observed.push([site, await drive()]);
    expect(observed, run.out().slice(-2000)).toEqual(rows.map(([site, , expected]) => [site, expected]));
    expect(run.spawns() - spawnedBefore, "no Fuigo engine process started on the fenced boot").toBe(0);
  }, 240_000);
});
