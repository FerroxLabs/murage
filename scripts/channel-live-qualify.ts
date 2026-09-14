#!/usr/bin/env -S node --experimental-strip-types
// Chief-only channel qualification for Telegram, Slack and Discord.
//
//   rehearse --platform telegram|slack|discord
//       Offline. Drives the real source server through the same steps a live
//       run uses, against scripted provider stand-ins. Evidence of the runner
//       and the server join, never of the provider.
//
// Every run owns an isolated HOME/data root and the fake Claude engine, and
// writes evidence under the OS temp directory. See scripts/channel-live-RECIPE.md.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHarness, promoteFixtureChief, ROOT, sleep, waitFor, type Harness } from "./channel-live-harness.ts";

type Outcome = "pass" | "fail" | "observed";
interface Check { id: string; criterion: string; outcome: Outcome; detail?: unknown }

export class Checks {
  readonly list: Check[] = [];
  private readonly harness: () => Harness | undefined;
  constructor(harness: () => Harness | undefined) { this.harness = harness; }
  expect(id: string, criterion: string, ok: boolean, detail?: unknown) {
    this.list.push({ id, criterion, outcome: ok ? "pass" : "fail", ...(detail === undefined ? {} : { detail }) });
    this.harness()?.record("check", { id, outcome: ok ? "pass" : "fail" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${id} ${criterion}${ok ? "" : ` ${JSON.stringify(detail)}`}\n`);
  }
  observe(id: string, criterion: string, detail: unknown) {
    this.list.push({ id, criterion, outcome: "observed", detail });
    this.harness()?.record("observation", { id });
    process.stdout.write(`OBSERVED ${id} ${criterion} ${JSON.stringify(detail)}\n`);
  }
}

export async function finishCleanup(harness: Harness | undefined, checks: Checks) {
  if (harness) await harness.close().catch(error => checks.expect("cleanup", "owned server stopped and fixture root removed", false, { error: String(error), retainedRoot: harness.root }));
}

const TELEGRAM_BOT = "123";
const TELEGRAM_OWNER = 777;
const TELEGRAM_STRANGER = 888;
const REHEARSAL_TELEGRAM_TOKEN = "123:rehearsal_token_not_real_abcdefghij";
const TELEGRAM_STAND_IN = join(ROOT, "scripts", "channel-live-telegram-fake-api.mjs");

function atomicJson(file: string, value: unknown) {
  writeFileSync(file + ".tmp", JSON.stringify(value));
  renameSync(file + ".tmp", file);
}
function jsonLines(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
const readJsonFile = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;

async function rehearseTelegram(evidenceDir: string): Promise<Check[]> {
  let harness: Harness | undefined;
  const checks = new Checks(() => harness);
  let api = "";
  let secretDelivered = false;
  const updates: Array<Record<string, unknown>> = [];
  const privateMessage = (id: number, from: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text,
    from: { id: from, is_bot: false }, chat: { id: from, type: "private" } } });
  const groupMessage = (id: number, from: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text,
    from: { id: from, is_bot: false }, chat: { id: -1001, type: "group", title: "Rehearsal group" } } });
  const writeUpdates = () => atomicJson(join(api, "updates.json"), updates);
  const arrive = (...values: Array<Record<string, unknown>>) => { updates.push(...values); writeUpdates(); };
  const faults = (value: Record<string, string>) => atomicJson(join(api, "faults.json"), value);
  const requests = () => jsonLines(join(api, "requests.jsonl"));
  const sent = () => jsonLines(join(api, "sent.jsonl"));
  const status = async () => (await harness!.request("GET", "/api/telegram/status")).body;
  const runs = async () => ((await harness!.request("GET", "/api/routines")).body?.runs ?? []).filter((run: any) => run.telegramConnectionId === TELEGRAM_BOT);
  const offsetPast = (updateId: number) => waitFor(`getUpdates offset past ${updateId}`, requests,
    list => list.some(entry => entry.method === "getUpdates" && entry.offset > updateId && !entry.fault), 20_000);
  const channelFile = () => readJsonFile(join(harness!.data, "telegram", `${TELEGRAM_BOT}.json`));
  const connectionFile = () => readJsonFile(join(harness!.data, "telegram", "connection.json"));
  const count = (method: string) => requests().filter(entry => entry.method === method).length;
  const settle = () => sleep(4_000); // more than two receive cycles at the service's 1.5 s cadence
  const newHarness = async (label: string, dir: string, secrets: boolean) => {
    const created = await createHarness({ label, evidenceDir: dir, preload: TELEGRAM_STAND_IN,
      env: () => ({ CHANNEL_LIVE_TELEGRAM_DIR: api }),
      secretEnv: (): Record<string, string> => secrets && secretDelivered ? { MURAGE_TELEGRAM_BOT_TOKEN: REHEARSAL_TELEGRAM_TOKEN } : {} });
    api = join(created.root, "telegram-api");
    mkdirSync(api, { mode: 0o700 });
    updates.length = 0;
    return created;
  };

  try {
    harness = await newHarness("telegram-rehearse", evidenceDir, true);
    await harness.boot();
    const chief = await promoteFixtureChief(harness, "Rehearsal Chief");

    // A1 — saved token, pairing and a healthy receiver are separate states.
    const saved = await harness.request("PATCH", "/api/config?secretStorage=external", { telegram: { botToken: REHEARSAL_TELEGRAM_TOKEN } });
    secretDelivered = true; // the desktop shell delivers the encrypted token as env on every later boot
    const afterSave = await status();
    checks.expect("A1.save", "saving a token does not verify, connect or pair", saved.status === 200 && afterSave.configured === true
      && afterSave.paired === false && afterSave.enabled === false && requests().length === 0, { http: saved.status, status: pick(afterSave), providerCalls: requests().length });
    const config = readJsonFile(join(harness.data, "config.json"));
    checks.expect("A1.custody", "external secret storage leaves only a tombstone in config.json", config?.telegram?.botToken === "" && !JSON.stringify(config).includes(REHEARSAL_TELEGRAM_TOKEN));
    const pairing = await harness.request("POST", "/api/telegram/pair", {});
    const afterPair = await status();
    checks.expect("A1.pairing", "a pairing code is not a paired owner", pairing.status === 200 && typeof pairing.body?.code === "string" && afterPair.paired === false,
      { http: pairing.status, status: pick(afterPair) });
    checks.expect("A5.target", "pairing binds the server-resolved workspace Chief", afterPair.targetBotId === chief.id && connectionFile()?.targetBotId === chief.id);

    // A10 — the code in a group, or a wrong code from a stranger, binds nobody.
    arrive(groupMessage(1, TELEGRAM_OWNER, `/pair ${pairing.body.code}`), privateMessage(2, TELEGRAM_STRANGER, `/pair ${"0".repeat(64)}`));
    await offsetPast(2);
    checks.expect("A10.pairing", "group delivery and a wrong private code do not bind", (await status()).paired === false && channelFile()?.binding === null);
    arrive(privateMessage(3, TELEGRAM_OWNER, `/pair ${pairing.body.code}`));
    const paired = await waitFor("paired", status, value => value.paired === true);
    checks.expect("A1.healthy", "the owner's private code yields a paired, active, error-free receiver", paired.resumeState === "active" && paired.error === null, pick(paired));
    const ownerBinding = JSON.stringify({ senderId: String(TELEGRAM_OWNER), chatId: String(TELEGRAM_OWNER) });
    checks.expect("A5.owner", "the binding is the exact owner sender and private chat", JSON.stringify(channelFile()?.binding) === ownerBinding, channelFile()?.binding);
    await waitFor("pairing acknowledgement", sent, list => list.length >= 1);

    // A6 — one accepted owner message: one run, one correct reply.
    arrive(privateMessage(4, TELEGRAM_OWNER, "Rehearsal request one: reply once."));
    await waitFor("first reply", sent, list => list.length >= 2, 30_000);
    const firstRuns = await runs();
    checks.expect("A6.one", "one owner message creates one run and one reply to the owner chat", firstRuns.length === 1 && sent().length === 2
      && sent()[1].chatId === String(TELEGRAM_OWNER) && sent()[1].text === "hello from fake claude", { runs: firstRuns.map(summaryRun), sent: sent() });
    arrive(privateMessage(5, TELEGRAM_STRANGER, "Stranger asks for work."), groupMessage(6, TELEGRAM_OWNER, "Owner posts in a group."));
    await offsetPast(6); await settle();
    checks.expect("A10.intake", "a stranger's private message and the owner's group message create no run or reply", (await runs()).length === 1 && sent().length === 2);

    // A2 — a normal same-data restart keeps the pairing, with no new code.
    const connectionBefore = JSON.stringify(connectionFile()), offsetBefore = channelFile()?.offset, getMeBefore = count("getMe");
    const exit = await harness.restart();
    const resumed = await waitFor("resumed after restart", status, value => value.paired === true && value.resumeState === "active");
    checks.expect("A2.restart", "same-data restart resumes the saved pairing without pairing again", exit.exitCode === 0 && resumed.error === null
      && JSON.stringify(channelFile()?.binding) === ownerBinding && JSON.stringify(connectionFile()) === connectionBefore && channelFile()?.offset >= offsetBefore
      && count("getMe") === getMeBefore + 1, { exit, status: pick(resumed), getMe: count("getMe") - getMeBefore });

    // A7 — a provider redelivery of an accepted update is not repeated work.
    arrive({ ...privateMessage(4, TELEGRAM_OWNER, "Rehearsal request one: reply once."), redeliver: true });
    await settle();
    checks.expect("A7.redelivery", "an already-accepted update redelivered after restart creates no run or reply", (await runs()).length === 1 && sent().length === 2
      && requests().some(entry => entry.method === "getUpdates" && entry.offset > 4));
    updates.splice(updates.findIndex(update => update.redeliver === true), 1); writeUpdates();
    arrive(privateMessage(7, TELEGRAM_OWNER, "Rehearsal request two after restart."));
    await waitFor("post-restart reply", sent, list => list.length >= 3, 30_000);
    checks.expect("A6.restart", "the first owner message after restart creates exactly one more run and reply", (await runs()).length === 2 && sent().length === 3);

    // A3 — a transient receive failure recovers by itself.
    faults({ getUpdates: "offline" });
    await waitFor("offline receive error", status, value => value.error === "offline");
    faults({});
    const recovered = await waitFor("receive recovery", status, value => value.error === null && value.resumeState === "active", 45_000);
    checks.expect("A3.session", "an offline receive recovers and clears its error without Retry or Refresh", recovered.paired === true, pick(recovered));

    // A3 — offline at startup reconnects automatically once the network returns.
    await harness.stop();
    faults({ getMe: "offline", getUpdates: "offline" });
    await harness.boot();
    const retrying = await waitFor("retry state", status, value => value.resumeState === "retry");
    checks.expect("A1.retry", "an offline start reports a saved connection retrying, not an unpaired token", retrying.paired === false && retrying.requiresRevoke === true
      && typeof retrying.nextRetryAt === "number", pick(retrying));
    await sleep(2_000);
    faults({});
    const back = await waitFor("automatic reconnect", status, value => value.resumeState === "active" && value.paired === true, 60_000);
    checks.expect("A3.startup", "the saved pairing reconnects automatically after an offline start", back.error === null && JSON.stringify(channelFile()?.binding) === ownerBinding, pick(back));

    // A8 — an ambiguous send stays uncertain and is not replayed after restart.
    faults({ sendMessage: "bad-gateway" });
    const attemptsBefore = count("sendMessage"), runsBefore = (await runs()).length;
    arrive(privateMessage(8, TELEGRAM_OWNER, "Rehearsal request three during a provider failure."));
    const uncertain = await waitFor("uncertain delivery", status, value => value.uncertain >= 1, 30_000);
    faults({});
    await settle();
    const attemptsAfter = count("sendMessage");
    await harness.restart();
    await waitFor("resumed after uncertain", status, value => value.resumeState === "active");
    await settle();
    checks.expect("A8.uncertain", "a post-dispatch 502 reply is uncertain, attempted once, never resent after restart and not rerun",
      attemptsAfter === attemptsBefore + 1 && count("sendMessage") === attemptsAfter && (await runs()).length === runsBefore + 1 && (await status()).uncertain === 1,
      { uncertain: pick(uncertain), attemptsBefore, attemptsAfter, attemptsAfterRestart: count("sendMessage") });

    // A4 — definitive receiver failures: truthful, and what can the owner do?
    for (const [fault, code] of [["conflict", "conflict"], ["unauthorized", "auth"]] as const) {
      faults({ getUpdates: fault });
      const blocked = await waitFor(`${fault} pause`, status, value => value.resumeState === "blocked" && value.error === code, 30_000);
      const pollsAtPause = count("getUpdates");
      faults({});
      await sleep(1_800);
      checks.expect(`A4.${fault}.truthful`, `a ${fault} pauses receiving, keeps the saved pairing and reports the cause`,
        count("getUpdates") === pollsAtPause && connectionFile()?.enabled === true && JSON.stringify(channelFile()?.binding) === ownerBinding, { status: pick(blocked) });
      const retry = await harness.request("POST", "/api/telegram/resume", {});
      const repair = await harness.request("POST", "/api/telegram/pair", {});
      await sleep(8_000);
      const later = await status();
      checks.observe(`A4.${fault}.actions`, `owner actions available while ${fault}-paused`, { resumeMessage: blocked.resumeMessage,
        retryRoute: { http: retry.status, error: retry.body?.error }, pairRoute: { http: repair.status, error: repair.body?.error }, eightSecondsAfterClear: pick(later) });
      checks.expect(`A4.${fault}.actionable`, `once the ${fault} is resolved the owner has a way to resume that is not revoke + re-pair`,
        retry.status === 200 || later.resumeState === "active", { retryHttp: retry.status, retryError: retry.body?.error, laterState: later.resumeState });
      await harness.restart();
      const afterRestart = await waitFor(`restart after ${fault}`, status, value => value.resumeState === "active" && value.paired === true, 30_000);
      checks.observe(`A4.${fault}.restart`, "a same-data restart resumes without re-pairing", { status: pick(afterRestart), bindingUnchanged: JSON.stringify(channelFile()?.binding) === ownerBinding });
    }

    // Roster edits that keep the Chief never pause the binding.
    const renamed = await harness.request("PATCH", `/api/bots/${chief.id}`, { name: "Renamed Rehearsal Chief" });
    await settle();
    checks.expect("A5.chief-edit", "editing the current Chief keeps the binding active and unpaused", renamed.status === 200 && (await status()).resumeState === "active" && connectionFile()?.paused === undefined);

    // A9 — Chief change pauses durably; revoke affects only this binding.
    const demoted = await harness.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    const paused = await waitFor("Chief-change pause", status, value => value.resumeState === "blocked", 20_000);
    const runsAtPause = (await runs()).length, sentAtPause = sent().length;
    arrive(privateMessage(9, TELEGRAM_OWNER, "Rehearsal request after the Chief changed."));
    await settle();
    checks.expect("A9.chief", "a Chief change pauses durably and admits no further owner work", demoted.status === 200 && connectionFile()?.paused === true
      && (await runs()).length === runsAtPause && sent().length === sentAtPause, pick(paused));
    const callsBeforeBoot = requests().length;
    await harness.restart();
    await sleep(3_000);
    const stillPaused = await status();
    checks.expect("A9.restart", "the Chief-change pause survives restart without contacting Telegram", stillPaused.resumeState === "blocked" && requests().length === callsBeforeBoot, pick(stillPaused));
    const revoked = await harness.request("POST", "/api/telegram/revoke", {});
    const afterRevoke = await status();
    checks.expect("A9.revoke", "revoke disables this installation's connection", revoked.status === 200 && afterRevoke.paired === false
      && afterRevoke.requiresRevoke === false && connectionFile()?.enabled === false, pick(afterRevoke));
    checks.observe("A9.revoke-residue", "channel owner binding bytes after revoking a connection paused before this boot", { binding: channelFile()?.binding ?? null, enabled: channelFile()?.enabled });
    const callsBeforeIdleBoot = requests().length;
    await harness.restart();
    await sleep(3_000);
    checks.expect("A9.revoked-restart", "a revoked connection stays idle across restart and never contacts Telegram", (await status()).paired === false && requests().length === callsBeforeIdleBoot);

    copyEvidence(api, evidenceDir, ["requests.jsonl", "sent.jsonl"], "telegram-desktop-");
    copyEvidence(join(harness.data, "telegram"), evidenceDir, ["connection.json", `${TELEGRAM_BOT}.json`], "telegram-desktop-state-");
    await harness.close();
    harness = undefined;

    // A2 on the non-desktop path: the token lives in config.json, no env at boot.
    harness = await newHarness("telegram-rehearse-plain", join(evidenceDir, "plain-config"), false);
    await harness.boot();
    await promoteFixtureChief(harness, "Plain Config Chief");
    const plainSave = await harness.request("PATCH", "/api/config", { telegram: { botToken: REHEARSAL_TELEGRAM_TOKEN } });
    const plainPair = await harness.request("POST", "/api/telegram/pair", {});
    arrive(privateMessage(1, TELEGRAM_OWNER, `/pair ${plainPair.body?.code}`));
    await waitFor("plain paired", status, value => value.paired === true);
    const plainExit = await harness.restart();
    const plainResumed = await waitFor("plain resumed", status, value => value.paired === true && value.resumeState === "active", 30_000);
    checks.expect("A2.plain", "the non-desktop plaintext-config path also resumes the pairing after restart", plainSave.status === 200 && plainPair.status === 200
      && plainExit.exitCode === 0 && plainResumed.error === null, pick(plainResumed));
    await harness.close();
    harness = undefined;
  } catch (error) {
    checks.expect("fixture.completed", "the rehearsal reached its final step", false, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await finishCleanup(harness, checks);
  }
  const leaked = scanForSecret(evidenceDir, REHEARSAL_TELEGRAM_TOKEN);
  checks.expect("custody.evidence", "no token bytes appear in evidence or server logs", leaked.length === 0, leaked);
  return checks.list;
}

function pick(value: any) {
  if (!value || typeof value !== "object") return value;
  const { configured, enabled, paired, pending, uncertain, rejected, error, deliveryError, nextRetryAt, connecting, requiresRevoke, resumeState, resumeMessage, state, needsReview } = value;
  return { configured, enabled, paired, pending, uncertain, rejected, error, deliveryError, nextRetryAt, connecting, requiresRevoke, resumeState, resumeMessage, state, needsReview };
}
const summaryRun = (run: any) => ({ id: run.id, status: run.status, deliveryId: run.deliveryId, botId: run.botId });

function copyEvidence(from: string, to: string, names: string[], prefix: string) {
  for (const name of names) if (existsSync(join(from, name))) copyFileSync(join(from, name), join(to, prefix + name));
}

function scanForSecret(dir: string, secret: string): string[] {
  const hits: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (readFileSync(full).includes(secret)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const flag = (name: string) => { const index = rest.indexOf(name); return index === -1 ? undefined : rest[index + 1]; };
  const platform = flag("--platform");
  if (command === "rehearse" && platform === "telegram") {
    const evidenceDir = mkdtempSync(join(tmpdir(), "murage-channel-live-evidence-telegram-rehearse-"));
    process.stdout.write(`evidence ${evidenceDir}\n`);
    const started = Date.now();
    const checks = await rehearseTelegram(evidenceDir);
    const summary = { platform, mode: "rehearsal", provider: "scripted Telegram Bot API stand-in", engine: "fake Claude CLI", node: process.version,
      seconds: Math.round((Date.now() - started) / 1000), passed: checks.filter(c => c.outcome === "pass").length,
      failed: checks.filter(c => c.outcome === "fail").map(c => c.id), observed: checks.filter(c => c.outcome === "observed").length, checks };
    writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    process.stdout.write(`result ${JSON.stringify({ passed: summary.passed, failed: summary.failed, observed: summary.observed, seconds: summary.seconds })}\n`);
    return summary.failed.length ? 1 : 0;
  }
  if ((command === "plan" || command === "rehearse" || command === "run") && (platform === "telegram" || platform === "slack" || platform === "discord")) {
    const { qualifyProvider } = await import("./channel-live-providers.ts");
    return qualifyProvider(command, platform, { inputs: flag("--inputs"), authority: flag("--authority") });
  }
  process.stderr.write([
    "usage: channel-live-qualify.ts <command> --platform telegram|slack|discord [--inputs FILE] [--authority TEXT]",
    "  plan      offline manifest validation; prints the redacted plan and budget, launches nothing",
    "  rehearse  offline; real source server against scripted provider stand-ins (not provider evidence)",
    "  run       LIVE; interactive terminal, dedicated test identities, exact authority text from the manifest",
    "See scripts/channel-live-RECIPE.md.",
  ].join("\n") + "\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
