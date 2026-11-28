// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// M9 W12 and W26 through the real server (designs/BEDROCK-ENGINE-1023.md R6 and Limit backup).
// W12: a bot pinned to a Bedrock account that was deleted (or disabled)
// sends a real message. The turn is refused with the existing engine-unavailable row, and nothing falls back to the default Claude account:
// the default account's CLI and the removed account's CLI are each spawned 0 times. Control: a bot on the default account does spawn its CLI
// through the same server, so the spawn counter is live.
// W26: a bot on a Bedrock account names a backup engine for its limit. A throttling frame (the SDK-named text and the text Claude Code
// relays on Bedrock) starts the limit continuation on the backup (its prompt reaches the backup CLI once); an expired sign-in, an access
// denial, a validation error and an unmatched 403 each give their own row and the backup gets 0 prompts, also when the AWS text carries
// words that read like a limit. IDENTITY answers offline through
// testing/bedrock-identity-offline-preload.mjs (the STS call is the only thing replaced); the CLI error frames come from the fake CLI.
// Same server-spawn pattern as typed-stop-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { limitRefusal } from "./limit-refusal.ts";
import { freePortBlock } from "./testing/ports.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
/** The existing engine-unavailable refusal (server/index.ts unavailableModelMessage), the row R6 reuses. */
const UNAVAILABLE = "This bot's AI connection is unavailable. Choose another model, or reconnect your provider in App Settings.";

let home = "";
let base = "";
let port = 0;
let child: ChildProcess | undefined;
let desktop: Record<string, string> = {};
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...desktop, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const dumpOf = (id: string) => join(home, `${id}-launch.json`);
/** The fake CLI writes its launch dump at every spawn (FAKE_CLAUDE_DUMP, per instance). */
const spawned = (id: string) => existsSync(dumpOf(id));
const inputsOf = (id: string) => join(home, `${id}-inputs.log`);
const rpcOf = (id: string) => join(home, `${id}-rpc.log`);
/** Prompts the backup engine (fake ACP CLI) received (FAKE_ACP_RPC_LOG, one JSON line per request, across spawns). */
const backupPrompts = () => (existsSync(rpcOf("backup")) ? readFileSync(rpcOf("backup"), "utf8").split("\n").filter(Boolean).filter((line) => (JSON.parse(line) as { method: string }).method === "session/prompt").length : 0);
const backupEntry = () => ({ driver: "customAcp", displayName: "Backup engine", environment: { FAKE_ACP_RPC_LOG: rpcOf("backup"), FAKE_ACP_MODELS: "fake-acp-model" }, config: { cli: FAKE_ACP, fullAuto: false } });
/** Did the instance's CLI receive this text (FAKE_CLAUDE_INPUT_LOG, every input it read, across spawns)? */
const received = (id: string, text: string) => existsSync(inputsOf(id)) && readFileSync(inputsOf(id), "utf8").includes(text);
const claude = (id: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => ({ driver: "claudeAgent", displayName: id === "claude" ? "Claude" : `Claude on Bedrock ${id}`,
  environment: { FAKE_CLAUDE_DUMP: dumpOf(id), FAKE_CLAUDE_INPUT_LOG: inputsOf(id), ...env }, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits", ...extra } });
const bedrockEntry = (id: string, env: Record<string, string> = {}, profile = "personal") => {
  mkdirSync(join(home, `${id}-account`), { recursive: true });
  return claude(id, { configDir: join(home, `${id}-account`), bedrock: { profile, region: "us-east-1", accountId: "111111111111", epoch: 1 } }, env);
};
const awsEntry = () => bedrockEntry("aws");

function writeConfig(instances: Record<string, unknown>) {
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances }));
}
async function boot(): Promise<void> {
  const url = `http://127.0.0.1:${port}`;
  stderr = "";
  const proc = spawn(process.execPath, [...fakeEngineImportArgs(), "--import", pathToFileURL(join(SERVER_DIR, "testing", "bedrock-identity-offline-preload.mjs")).href,
    "--import", "data:text/javascript," + encodeURIComponent(`const { customAcpSupport: localFixtureHost } = await import(${JSON.stringify(new URL("./drivers/acp/custom.ts", import.meta.url).href)}); localFixtureHost.fluxReach = () => "elsewhere";`), join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    env: { ...powerBlockTestEnv(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (stderr += c));
  proc.stdout!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  child = proc; base = url; desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
async function stop(): Promise<void> {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  child = undefined;
}
/** Sends one message and waits until the thread holds an assistant/error row after it (the turn is over either way). */
async function sendAndSettle(bot: { id: string; threadId: string }, text: string) {
  const before = (await messages(bot.threadId)).length;
  const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  if (sent.status === 202) {
    await expect.poll(async () => (await messages(bot.threadId)).slice(before).some((m) => m.role !== "user"), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30_000 }).toBe(false);
  }
  return { sent, rows: (await messages(bot.threadId)).slice(before) };
}

async function freshHome(prefix: string) {
  chmodSync(FAKE_CLAUDE, 0o755);
  home = mkdtempSync(join(tmpdir(), prefix));
  port = await freePortBlock([0, 1]);
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(home, ".aws", "config"), "[profile personal]\nregion = us-east-1\n[profile rate-limit-lab]\nregion = us-east-1\n");
}
async function newBot(name: string, instanceId: string): Promise<{ id: string; threadId: string }> {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "sonnet" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}

/** A second Bedrock account that stays enabled in every W12 config; its CLI relays the frame Claude Code shows for an expired AWS sign-in. */
const LIVE_EXPIRED = "API Error: 403 The security token included in the request is expired";
const liveEntry = () => bedrockEntry("live", { FAKE_CLAUDE_MODE: "api-error", FAKE_CLAUDE_API_ERROR: LIVE_EXPIRED });

posixOnly("W12 a bot pinned to a removed Bedrock account (real server, real dispatch)", () => {
  let bot: { id: string; threadId: string };
  let live: { id: string; threadId: string };
  beforeAll(async () => {
    await freshHome("bedrock-removed-");
    writeConfig({ claude: claude("claude"), aws: awsEntry(), live: liveEntry() });
    await boot();
    bot = await newBot("Bedrock pinned", "aws");
    live = await newBot("Bedrock live", "live");
  }, 90_000);
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });

  it("control: a message to a bot on the default Claude account spawns that account's CLI", async () => {
    const { sent } = await sendAndSettle(await newBot("Default pinned", "claude"), "fixture control message");
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(spawned("claude"), "control: the counter sees a default-account spawn").toBe(true);
  }, 120_000);

  for (const [name, removed] of [["deleted", () => ({ claude: claude("claude"), live: liveEntry() })], ["disabled", () => ({ claude: claude("claude"), live: liveEntry(), aws: { ...awsEntry(), enabled: false } })]] as const) {
    it(`W12 ${name}: the kept Bedrock account's relayed expiry gets the expired row (REGRESSION: the removed account's 409, 0 default spawns)`, async () => {
      await stop();
      for (const id of ["claude", "aws", "live"]) { rmSync(dumpOf(id), { force: true }); rmSync(inputsOf(id), { force: true }); }
      writeConfig(removed());
      await boot();
      const { sent, rows } = await sendAndSettle(bot, `fixture message after the account was ${name}`);
      expect(spawned("claude"), `REGRESSION W12 ${name}: the default Claude account is spawned 0 times`).toBe(false); // W12
      expect(spawned("aws"), `REGRESSION W12 ${name}: the removed account is spawned 0 times`).toBe(false);
      expect({ status: sent.status, error: sent.body.error }, `REGRESSION W12 ${name}: the existing engine-unavailable refusal (R6)`).toEqual({ status: 409, error: UNAVAILABLE }); // W12-row
      expect(rows.filter((m) => m.role !== "user"), `REGRESSION W12 ${name}: no turn ran, so no reply row`).toEqual([]);
      // Live control on the same boot: a bot on the Bedrock account that is still there does reach its CLI, and an expired AWS sign-in
      // that Claude Code relays (`API Error: 403 ...`, no exception name) gets the expired row (r6 reads the relayed text; before it, the catch-all row).
      const control = await sendAndSettle(live, `fixture live message after the account was ${name}`);
      expect(control.sent.status, JSON.stringify(control.sent.body)).toBe(202);
      expect(received("live", `fixture live message after the account was ${name}`), `W12 ${name}: the kept Bedrock account's CLI got its prompt`).toBe(true);
      expect(errorRows(control.rows), `W12 ${name}: the kept account's relayed expiry gets the expired row`).toEqual([{ errorKind: "bedrock_refused", text: expiredRow("personal") }]); // W12-live-row
    }, 120_000);
  }
});

/** A limit: Bedrock throttling. `named` is the SDK shape the design table names; `relayed` is the frame Claude Code shows on Bedrock
 * (`API Error: <status> <AWS message>`: the exception name is a response header, so the text has none). */
const LIMITS = {
  throttle: "ThrottlingException: Too many requests, please wait before trying again.",
  tokens: "API Error: 429 Too many tokens, please wait before trying again.",
} as const;
const expiredRow = (profile: string) => `Your AWS sign-in for profile \`${profile}\` expired. Run \`aws sso login --profile ${profile}\` (or renew its keys), then send again.`;
const DENIED_ROW = "Your AWS account …1111 has no access to this model in us-east-1. Turn it on under Model access in the Bedrock console, then send again.";
const otherRow = (shown: string) => `Bedrock refused this message for AWS account …1111 (${shown}). Nothing switched. Fix it in AWS, or Check again in Settings, then send again.`;
const IAM_DENIAL = (role: string, resource: string) => `User: arn:aws:sts::111111111111:assumed-role/${role}/dev is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: ${resource} because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action`;
const IAM_SHOWN = "User: arn:…1111 is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:…1111 because no identity-based policy allows the bedrock:InvokeModelWithResponseStr";
/** An expired sign-in whose relayed frame also names the throttle the CLI retried before the token ran out. Composed for the test (no captured
 * frame carries both): an expiry is never a limit, whatever else the text names. Before r6 the relayed expiry sentence was not read, so the
 * throttle name won and the backup started (the base RED for the backup assertions below). */
const EXPIRED_AFTER_THROTTLE = "API Error: 403 The security token included in the request is expired (retried after ThrottlingException)";
/** A refusal: never a limit, whatever its words say. All but the last are AWS's own texts.
 * The shared limit matcher (server/limit-refusal.ts LIMIT) reads the turn's row, so a refusal row that carries limit-like words is held back
 * only by the Bedrock refusal check in limitRefusalOfTurn. Two rows can carry such words:
 * `expiredProfile`: the expired row names the AWS profile, and the owner named this one `rate-limit-lab`;
 * `otherLimit`: the catch-all row quotes the AWS text. No captured Bedrock refusal says "usage limit", so this one text is composed for the test.
 * The two IAM cases have a limit-like role name inside the ARN AWS echoes; the row masks every ARN, so those words never reach the matcher. */
const REFUSALS = {
  expired: { text: "ExpiredTokenException: The security token included in the request is expired", row: expiredRow("personal") },
  expiredRelayed: { text: "API Error: 403 The security token included in the request is expired", row: expiredRow("personal") },
  expiredProfile: { text: "API Error: 403 The security token included in the request is expired", row: expiredRow("rate-limit-lab"), profile: "rate-limit-lab" },
  denied: { text: "AccessDeniedException: You don't have access to the model with the specified model ID.", row: DENIED_ROW },
  deniedIam: { text: `AccessDeniedException: ${IAM_DENIAL("usage-limit-review", "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0")}`, row: DENIED_ROW },
  other: { text: "API Error: 403 The security token included in the request is invalid.", row: otherRow("API Error: 403 The security token included in the request is invalid.") },
  otherIam: { text: `API Error: 403 ${IAM_DENIAL("rate-limit-lab", "arn:aws:bedrock:us-east-1:111111111111:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0")}`, row: otherRow(`API Error: 403 ${IAM_SHOWN}`) },
  otherLimit: { text: "API Error: 403 Usage limit reached for this AWS account.", row: otherRow("API Error: 403 Usage limit reached for this AWS account.") },
  expiredAfterThrottle: { text: EXPIRED_AFTER_THROTTLE, row: expiredRow("rate-limit-lab"), profile: "rate-limit-lab" },
} as const satisfies Record<string, { text: string; row: string; profile?: string }>;
/** The refusal rows that carry limit-like words (see above): with the Bedrock refusal check removed, exactly these reach the backup. */
const GUARDED: readonly string[] = ["expiredProfile", "otherLimit", "expiredAfterThrottle"];
/** The same check on the routine caller (routineLimitRefusal): a routine run on its own Bedrock account, with the two rows that read like a
 * limit, the expiry that names a throttle, and, as the live control, a throttle with its exception name (that run waits on the limit; the relayed
 * throttle has its own row). */
const ROUTINES = {
  routineExpiredProfile: { text: REFUSALS.expiredProfile.text, profile: "rate-limit-lab", limit: false },
  routineOtherLimit: { text: REFUSALS.otherLimit.text, limit: false },
  routineExpiredAfterThrottle: { text: EXPIRED_AFTER_THROTTLE, profile: "rate-limit-lab", limit: false },
  routineThrottle: { text: LIMITS.throttle, limit: true },
  routineTokens: { text: LIMITS.tokens, limit: true },
} as const satisfies Record<string, { text: string; profile?: string; limit: boolean }>;
type LimitCase = keyof typeof LIMITS;
type RefusalCase = keyof typeof REFUSALS;
/** `control` is its own bot (a limit puts a bot on the backup until it resets, so the control cannot share one with a limit case). */
const CASES: Record<string, { text: string; profile?: string }> = { ...Object.fromEntries(Object.entries(LIMITS).map(([id, text]) => [id, { text }])), control: { text: LIMITS.throttle }, ...REFUSALS, ...ROUTINES };
const THROTTLED_ROW = "AWS throttled this account's Bedrock use (quota in us-east-1). Wait or raise the quota in AWS, then send again.";
const errorRows = (rows: any[]) => rows.filter((m) => m.kind === "activity" && m.tool?.ok === false && m.tool?.errorKind).map((m) => ({ errorKind: m.tool.errorKind, text: m.tool.errorDetails }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits (no assertion) until the check holds or the time is up; the caller asserts the value afterwards. */
async function until(check: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end && !check();) await sleep(100);
}

posixOnly("W26 Bedrock errors and the owner's limit backup (real server, real limit path)", () => {
  const bots = {} as Record<string, { id: string; threadId: string }>;
  beforeAll(async () => {
    await freshHome("bedrock-limit-");
    chmodSync(FAKE_ACP, 0o755);
    writeConfig({ claude: claude("claude"), backup: backupEntry(), ...Object.fromEntries(Object.entries(CASES).map(([id, c]) => [id, bedrockEntry(id, { FAKE_CLAUDE_MODE: "api-error", FAKE_CLAUDE_API_ERROR: c.text }, c.profile)])) });
    await boot();
    for (const id of Object.keys(CASES)) {
      bots[id] = await newBot(`Bedrock ${id}`, id);
      const saved = await request("PUT", `/api/bots/${bots[id].id}/limit-backup`, { selection: { instanceId: "backup", model: "fake-acp-model" } });
      expect(saved.status, `the backup is saved: ${JSON.stringify(saved.body)}`).toBe(200);
    }
  }, 180_000);
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });

  it("W26 the rows that read like a limit do read like one to the shared matcher (so only the Bedrock check holds them back)", () => {
    for (const id of Object.keys(REFUSALS) as RefusalCase[]) expect(limitRefusal("claude", { text: REFUSALS[id].row }) !== null, `W26 ${id}`).toBe(GUARDED.includes(id));
  });
  /** The live control for every "backup gets 0 prompts" assertion: a throttle with its exception name, through the same server and backup, does start
   * the backup (once). Without it a dead backup path would pass them all. Runs once, in the first test that asks. */
  let limitControl: Promise<number> | undefined;
  const backupStartsOnThrottle = () => limitControl ??= (async () => {
    const before = backupPrompts();
    await sendAndSettle(bots.control, "fixture limit control");
    await until(() => backupPrompts() - before > 0, 30_000);
    await sleep(1500);
    return backupPrompts() - before;
  })();
  for (const id of Object.keys(REFUSALS) as RefusalCase[]) {
    it(`${regression(id)}W26 ${id}: its own row, never a limit, and the backup gets 0 prompts`, async () => {
      expect(await backupStartsOnThrottle(), `W26 ${id}: control: a throttle on the same server starts the backup once`).toBe(1); // W26-control
      const before = backupPrompts();
      const { sent } = await sendAndSettle(bots[id], `fixture message for ${id}`);
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      await expect.poll(() => received(id, `fixture message for ${id}`), { timeout: 15_000, message: `W26 ${id}: the Bedrock CLI got the prompt` }).toBe(true);
      await until(() => backupPrompts() - before > 0, 4000); // a continuation would have prompted the backup by now (the limit cases below take under 2 s)
      expect(backupPrompts() - before, `${regression(id)}W26 ${id}: the backup gets 0 prompts`).toBe(0); // W26-other
      const after = await messages(bots[id].threadId);
      expect(errorRows(after), `${regression(id)}W26 ${id}: its own row, not a limit`).toEqual([{ errorKind: "bedrock_refused", text: REFUSALS[id].row }]); // W26-row
      expect(after.some((m) => /hit its limit/.test(m.tool?.name ?? "")), `W26 ${id}: no switch line`).toBe(false);
    }, 120_000);
  }

  for (const id of Object.keys(LIMITS) as LimitCase[]) {
    it(`W26 ${id}: the limit continuation runs on the backup once, with its switch line`, async () => {
      const before = backupPrompts();
      const { sent } = await sendAndSettle(bots[id], `fixture message for ${id}`);
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      await expect.poll(() => received(id, `fixture message for ${id}`), { timeout: 15_000, message: `W26 ${id}: the Bedrock CLI got the prompt` }).toBe(true);
      await until(() => backupPrompts() - before > 0, 30_000);
      await sleep(1500); // a second prompt would have arrived by now
      expect(backupPrompts() - before, `W26 ${id}: the backup is prompted exactly once`).toBe(1); // W26-limit
      const rows = await messages(bots[id].threadId);
      expect(errorRows(rows)[0], `W26 ${id}: the throttling row, as a limit`).toEqual({ errorKind: "rate_limited", text: `${THROTTLED_ROW}\nEngine error kind: rate_limited` }); // W26-limit-row (1.0.22: an error row that carries an engine kind names it)
      expect(rows.map((m) => m.tool?.name), `W26 ${id}: the limit continuation's switch line`).toContain(`Claude on Bedrock ${id} hit its limit; Backup engine took over until it resets`); // W26-switch
    }, 120_000);
  }

  const runState = async (id: string) => (await request("GET", "/api/routines")).body.runs.find((run: any) => run.id === id) as { status: string; limitWait?: { engineKey: string } } | undefined;
  async function routineRun(id: keyof typeof ROUTINES) {
    {
      const created = await request("POST", "/api/routines", { name: `Routine ${id}`, prompt: `fixture routine for ${id}`, botId: bots[id].id, enabled: false,
        schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20 });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const started = await request("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const runId = started.body.run.id as string;
      await expect.poll(() => received(id, `fixture routine for ${id}`), { timeout: 30_000, message: `W26 ${id}: the Bedrock CLI got the routine's prompt` }).toBe(true);
      let run = await runState(runId);
      for (const end = Date.now() + 30_000; Date.now() < end && !run?.limitWait && !["completed", "failed", "cancelled"].includes(run?.status ?? ""); run = await runState(runId)) await sleep(150);
      return run;
    }
  }
  /** The live control for the routine caller: the throttled run does wait on the limit (runs once; the throttle test below reuses it). */
  let routineThrottle: ReturnType<typeof routineRun> | undefined;
  const throttledRoutine = () => routineThrottle ??= routineRun("routineThrottle");
  for (const id of Object.keys(ROUTINES) as (keyof typeof ROUTINES)[]) {
    it(`${regression(id)}W26 ${id}: a routine run ${ROUTINES[id].limit ? "that AWS throttles waits on the limit" : "that Bedrock refuses fails as itself and never waits on a limit"}`, async () => {
      const control = await throttledRoutine();
      expect(Boolean(control?.limitWait), `W26 ${id}: control: the throttled routine run waits on the limit (status ${control?.status})`).toBe(true); // W26-routine-limit
      if (id === "routineThrottle") return;
      const run = await routineRun(id);
      if (ROUTINES[id].limit) {
        expect(Boolean(run?.limitWait), `W26 ${id}: the relayed throttle's routine run waits on the limit (status ${run?.status})`).toBe(true); // W26-routine-relayed
        return;
      }
      expect({ status: run?.status, limitWait: run?.limitWait ?? null }, `${regression(id)}W26 ${id}: the refused run fails, with no limit wait`).toEqual({ status: "failed", limitWait: null }); // W26-routine
    }, 120_000);
  }
});
/** r9 (BASE-NOTE.md in the job dir): rows whose every assertion already holds on the pre-fix sha 67db0d0d09, because its classifier
 * (bedrock-env.ts:207-211), the bedrock_refused check in limitRefusalOfTurn (index.ts:15786) and turnRouting's 409 (index.ts:15503-15506) already
 * refuse them. They guard against a regression; they are not witnesses for the r5-r8 change. A function, so the titles above can call it. */
function regression(id: string): string {
  return ["expired", "denied", "deniedIam", "other", "otherIam", "otherLimit", "routineExpiredProfile", "routineOtherLimit"].includes(id) ? "REGRESSION " : "";
}
