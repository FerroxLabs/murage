#!/usr/bin/env -S node --experimental-strip-types
// Slack/Discord rehearsal and the live qualification run for all three channels.
//
//   plan     --platform telegram|slack|discord --inputs FILE
//            Offline: validates the dedicated-identity manifest and prints the
//            redacted step plan and message budget. Never launches anything.
//   rehearse --platform slack|discord
//            Offline: the live run's steps against the real source server with
//            the repository's scripted SDK stand-ins. Runner/join evidence only.
//   run      --platform telegram|slack|discord --inputs FILE --authority TEXT
//            LIVE: dedicated test identity, real provider, fake Claude engine by
//            default or one admitted real engine (inputs engine.descriptorFile),
//            interactive operator. Refuses unless every gate holds.
// (Telegram rehearsal lives in channel-live-qualify.ts.)
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { createHarness, linkChannelOwner, promoteFixtureChief, ROOT, sleep, waitFor, type Harness } from "./channel-live-harness.ts";
import { LIVE_MODEL_RUNS, loadEngine, loadManifestFile, loadSecrets, ManifestError, redactEngine, type AdmittedEngine, type Manifest, type Platform, type RedactedEngine } from "./channel-live-inputs.ts";
import { assertRealEngineIdentity, taskIdentityProblems, type B08EngineDescriptor, type DescribedInstance } from "../src/e2e/b08-template-behavior-fixture.ts";

type Outcome = "pass" | "fail" | "observed" | "not-run";
interface Check { id: string; criterion: string; outcome: Outcome; detail?: unknown }

class Checks {
  readonly list: Check[] = [];
  private readonly harness: () => Harness | undefined;
  constructor(harness: () => Harness | undefined) { this.harness = harness; }
  private add(check: Check, label: string) {
    this.list.push(check);
    try { this.harness()?.record("check", { id: check.id, outcome: check.outcome }); } catch { /* evidence dir already gone */ }
    process.stdout.write(`${label} ${check.id} ${check.criterion}${check.outcome === "fail" || check.outcome === "observed" ? ` ${JSON.stringify(check.detail)}` : ""}\n`);
  }
  expect(id: string, criterion: string, ok: boolean, detail?: unknown) { this.add({ id, criterion, outcome: ok ? "pass" : "fail", ...(detail === undefined ? {} : { detail }) }, ok ? "PASS" : "FAIL"); }
  observe(id: string, criterion: string, detail: unknown) { this.add({ id, criterion, outcome: "observed", detail }, "OBSERVED"); }
  notRun(id: string, criterion: string, reason: string) { this.add({ id, criterion, outcome: "not-run", detail: reason }, "NOT-RUN"); }
}

const readJson = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
/** The fixture Chief's persisted tasks (the store's bots file), for engine/task identity. */
function chiefTasks(data: string, chiefId: string): any[] {
  const file = readJson(join(data, "bots.json"));
  const bots = Array.isArray(file) ? file : file?.bots ?? [];
  return bots.find((bot: any) => bot.id === chiefId)?.tasks ?? [];
}
function pick(value: any) {
  if (!value || typeof value !== "object") return value;
  const { configured, enabled, paired, state, error, deliveryError, deliveryRetryAt, requiresRevoke, pending, uncertain, rejected, needsReview, resumeState, resumeMessage } = value;
  return { configured, enabled, paired, state, error, deliveryError, deliveryRetryAt, requiresRevoke, pending, uncertain, rejected, needsReview, resumeState, resumeMessage };
}
function scanForSecrets(dir: string, secrets: string[]): string[] {
  const hits: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else { const bytes = readFileSync(full); if (secrets.some(secret => secret && bytes.includes(secret))) hits.push(full); }
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}
function pidGone(pid: number | undefined) {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function finish(platform: Platform, mode: string, evidenceDir: string, checks: Check[], started: number, extra: Record<string, unknown>) {
  const summary = { platform, mode, node: process.version, seconds: Math.round((Date.now() - started) / 1000), ...extra,
    passed: checks.filter(c => c.outcome === "pass").length, failed: checks.filter(c => c.outcome === "fail").map(c => c.id),
    observed: checks.filter(c => c.outcome === "observed").length, notRun: checks.filter(c => c.outcome === "not-run").map(c => c.id), checks };
  writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  process.stdout.write(`result ${JSON.stringify({ passed: summary.passed, failed: summary.failed, observed: summary.observed, notRun: summary.notRun, seconds: summary.seconds })}\n`);
  return summary.failed.length ? 1 : 0;
}

// ── Slack/Discord rehearsal ─────────────────────────────────────────────────

interface RehearsalSpec {
  platform: "slack" | "discord";
  preload: string;
  traceKind: string;
  eventKind: string;
  tokens: Record<string, string>;
  save: Record<string, unknown>;
  owner: string; dm: string; stranger: string; otherDm: string;
  identity: Record<string, string>;
  receivedOp: "ack" | "received";
  body(eventId: string, text: string, user: string, channel: string): unknown;
  traceId(eventId: string): string;
}

export function slackSpec(): RehearsalSpec {
  const tokens = { MURAGE_SLACK_APP_TOKEN: "xapp-fixture-private-not-real", MURAGE_SLACK_BOT_TOKEN: "xoxb-fixture-private-not-real" };
  return { platform: "slack", preload: join(ROOT, "server", "testing", "slack-sdk-preload.mjs"), traceKind: "slack-fixture", eventKind: "slack-fixture-event", tokens,
    save: { slack: { appToken: tokens.MURAGE_SLACK_APP_TOKEN, botToken: tokens.MURAGE_SLACK_BOT_TOKEN, teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" } },
    owner: "UOWNER", dm: "DOWNER", stranger: "UOTHER", otherDm: "DOTHER", identity: { teamId: "TEAM", userId: "UBOT", botId: "BOT" }, receivedOp: "ack",
    body: (eventId, text, user, channel) => ({ type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: eventId, event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel, user, text } }),
    traceId: eventId => eventId };
}

export function discordSpec(): RehearsalSpec {
  const tokens = { MURAGE_DISCORD_BOT_TOKEN: "discord-fixture-private-not-real" };
  const ids = new Map<string, string>();
  const snowflake = (eventId: string) => { if (!ids.has(eventId)) ids.set(eventId, String(100 + ids.size)); return ids.get(eventId)!; };
  return { platform: "discord", preload: join(ROOT, "server", "testing", "discord-sdk-preload.mjs"), traceKind: "discord-fixture", eventKind: "discord-fixture-event", tokens,
    save: { discord: { botToken: tokens.MURAGE_DISCORD_BOT_TOKEN, applicationId: "11", ownerUserId: "13" } },
    owner: "13", dm: "14", stranger: "88", otherDm: "89", identity: { applicationId: "11", botUserId: "12" }, receivedOp: "received",
    body: (eventId, text, user, channel) => ({ id: snowflake(eventId), channelId: channel, channel: { type: 1 }, author: { id: user, bot: false }, guildId: null, webhookId: null,
      type: 0, content: text, createdTimestamp: Date.now(), attachments: { size: 0 }, components: [] }),
    traceId: eventId => snowflake(eventId) };
}

async function rehearseChannel(spec: RehearsalSpec, evidenceDir: string): Promise<Check[]> {
  let harness: Harness | undefined;
  const checks = new Checks(() => harness);
  const traces: Array<{ op: string; channel?: string; text?: string; eventId?: string }> = [];
  const pids: Array<number | undefined> = [];
  let delivered = false, root = "";
  const api = (route: string) => `/api/${spec.platform}/${route}`;
  const status = async () => (await harness!.request("GET", api("status"))).body;
  const runs = async () => ((await harness!.request("GET", "/api/routines")).body?.runs ?? []).filter((run: any) => run.channelOrigin?.platform === spec.platform);
  const sends = () => traces.filter(trace => trace.op === "send");
  const connection = () => readJson(join(harness!.data, "channels", spec.platform, "connection.json"));
  const event = (eventId: string, text: string, user = spec.owner, channel = spec.dm) =>
    harness!.child()!.send({ kind: spec.eventKind, body: spec.body(eventId, text, user, channel) });
  const received = (eventId: string) => traces.filter(trace => trace.op === spec.receivedOp && trace.eventId === spec.traceId(eventId)).length;
  const settle = () => sleep(3_000); // exact counts are read only after more than one drain cycle
  const bootTracked = async () => { await harness!.boot(); pids.push(harness!.child()?.pid); };

  try {
    harness = await createHarness({ label: `${spec.platform}-rehearse`, evidenceDir, preload: spec.preload, ipc: true,
      secretEnv: (): Record<string, string> => delivered ? spec.tokens : {} });
    root = harness.root;
    harness.onMessage(value => { const trace = value as any; if (trace?.kind === spec.traceKind) traces.push(trace); });
    await bootTracked();
    const chief = await promoteFixtureChief(harness, `Rehearsal ${spec.platform} Chief`);

    // A1 — saved credentials, pairing and a healthy receiver are distinct.
    const saved = await harness.request("PATCH", "/api/config?secretStorage=external", spec.save);
    delivered = true; // the desktop shell delivers encrypted credentials as env on later boots
    const afterSave = await status();
    checks.expect("A1.save", "saving credentials does not verify, connect or pair", saved.status === 200 && afterSave.configured === true
      && afterSave.paired === false && afterSave.enabled === false && traces.length === 0, { http: saved.status, status: pick(afterSave), traces: traces.length });
    const config = readJson(join(harness.data, "config.json"));
    checks.expect("A1.custody", "config.json keeps only empty credential tombstones", !Object.values(spec.tokens).some(token => JSON.stringify(config).includes(token)));
    const pairing = await harness.request("POST", api("pair"), { targetBotId: chief.id });
    checks.expect("A1.pairing", "a pairing code is not a paired owner", pairing.status === 200 && typeof pairing.body?.code === "string" && (await status()).paired === false,
      { http: pairing.status });

    // A10 — the right code from the wrong member binds nobody.
    event("EvWRONG", `/pair ${pairing.body.code}`, spec.stranger);
    await waitFor("wrong-owner event observed", () => received("EvWRONG"), n => n >= 1);
    checks.expect("A10.pairing", "a stranger sending the owner's code does not bind", (await status()).paired === false && connection()?.binding === null);
    event("EvPAIR", `/pair ${pairing.body.code}`);
    const paired = await waitFor("paired", status, value => value.paired === true);
    await waitFor("pairing acknowledgement", sends, list => list.length >= 1);
    await settle();
    checks.expect("A1.healthy", "the owner's code yields a paired, connected receiver and exactly one acknowledgement", paired.state === "connected" && paired.error === null
      && sends().length === 1 && sends()[0].channel === spec.dm, { status: pick(paired), sends: sends().length });
    const binding = connection()?.binding;
    checks.expect("A5.binding", "binding holds the exact owner, DM, identity and current Chief", binding?.ownerUserId === spec.owner && binding?.dmId === spec.dm
      && binding?.chiefBotId === chief.id && JSON.stringify(connection()?.identity) === JSON.stringify(spec.identity), { binding, identity: connection()?.identity });

    // Approval-shaped text is review guidance, never an approval.
    event("EvYES", "yes");
    await waitFor("review reply", sends, list => list.length >= 2);
    await settle();
    checks.expect("A6.review", "'yes' returns exactly one review reply to the bound DM and starts no run", sends().length === 2 && sends()[1].channel === spec.dm
      && String(sends()[1].text).includes("Review approvals in Murage") && (await runs()).length === 0, { sends: sends().length, send: sends()[1] });
    const link = await linkChannelOwner(harness, spec.platform, spec.owner);
    checks.expect("A5.link", "the paired owner's account is linked to the workspace owner before any work", link.stateBefore === "link-required", link);

    // A6 — one owner request: one run, one reply.
    event("EvWORK", "Rehearsal request one: reply once.");
    await waitFor("first reply", sends, list => list.length >= 3, 30_000);
    await settle();
    checks.expect("A6.one", "one owner request creates exactly one run and one reply to the bound DM", (await runs()).length === 1 && sends().length === 3
      && sends()[2].channel === spec.dm && sends()[2].text === "hello from fake claude", { runs: (await runs()).length, sends: sends().length, send: sends()[2] });
    event("EvOTHERDM", "Owner writes in another DM.", spec.owner, spec.otherDm);
    await waitFor("other-DM event observed", () => received("EvOTHERDM"), n => n >= 1);
    await settle();
    checks.expect("A10.dm", "a message in a different DM creates no run or reply", (await runs()).length === 1 && sends().length === 3);

    // A2 — same-data restart keeps the binding without a new pair.
    const connectionBefore = JSON.stringify(connection());
    const exit = await harness.stop();
    await bootTracked();
    const resumed = await waitFor("resumed after restart", status, value => value.enabled === true && value.paired === true && value.state === "connected", 30_000);
    checks.expect("A2.restart", "same-data restart reconnects the saved binding without pairing again", exit.exitCode === 0 && JSON.stringify(connection()) === connectionBefore,
      { exit, status: pick(resumed) });

    // A7 — redelivered events do not repeat work.
    event("EvWORK", "Rehearsal request one: reply once.");
    event("EvYES", "yes");
    await waitFor("redelivery observed", () => received("EvWORK"), n => n >= 2);
    await settle();
    checks.expect("A7.redelivery", "redelivered request and approval-text events after restart create no run or reply", (await runs()).length === 1 && sends().length === 3);
    event("EvWORK2", "Rehearsal request two after restart.");
    await waitFor("post-restart reply", sends, list => list.length >= 4, 30_000);
    await settle();
    checks.expect("A6.restart", "the first new request after restart creates exactly one more run and reply", (await runs()).length === 2 && sends().length === 4 && sends()[3].channel === spec.dm);

    // Chief edits keep the binding; a Chief change pauses it durably.
    const renamed = await harness.request("PATCH", `/api/bots/${chief.id}`, { name: `Renamed ${spec.platform} Chief` });
    await settle();
    checks.expect("A5.chief-edit", "editing the current Chief keeps the binding connected and unpaused", renamed.status === 200 && (await status()).state === "connected" && connection()?.paused === false);
    const demoted = await harness.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    const blocked = await waitFor("Chief-change pause", status, value => value.state === "blocked", 20_000);
    const runsAtPause = (await runs()).length, sendsAtPause = sends().length;
    event("EvWORK3", "Rehearsal request after the Chief changed.");
    await settle();
    checks.expect("A9.chief", "a Chief change pauses durably and admits no further owner work", demoted.status === 200 && connection()?.paused === true
      && (await runs()).length === runsAtPause && sends().length === sendsAtPause, pick(blocked));
    const tracesBeforeBoot = traces.length;
    await harness.stop();
    await bootTracked();
    await sleep(3_000);
    const stillBlocked = await status();
    checks.expect("A9.restart", "the pause survives restart without connecting to the provider", stillBlocked.state === "blocked"
      && !traces.slice(tracesBeforeBoot).some(trace => trace.op === "connect" || trace.op === "verify"), { status: pick(stillBlocked), newTraces: traces.slice(tracesBeforeBoot) });
    const revoked = await harness.request("POST", api("revoke"), {});
    const afterRevoke = await status();
    checks.expect("A9.revoke", "revoke leaves this installation unpaired and disabled", revoked.status === 200 && afterRevoke.paired === false && afterRevoke.enabled === false
      && afterRevoke.requiresRevoke === false && connection()?.enabled === false, pick(afterRevoke));

    writeFileSync(join(evidenceDir, "traces.json"), JSON.stringify(traces, null, 2), { mode: 0o600 });
    writeFileSync(join(evidenceDir, "connection-final.json"), JSON.stringify(connection(), null, 2), { mode: 0o600 });
  } finally {
    if (harness) await harness.close().catch(error => process.stderr.write(`cleanup failed: ${String(error)}\n`));
  }
  checks.expect("cleanup", "every owned server process has exited and the fixture root is removed", pids.every(pidGone) && !existsSync(root), { pids, rootRemoved: !existsSync(root) });
  const leaked = scanForSecrets(evidenceDir, Object.values(spec.tokens));
  checks.expect("custody.evidence", "no credential bytes appear in evidence or server logs", leaked.length === 0, leaked);
  return checks.list;
}

// ── Live-run stop machinery (exported for offline unit checks) ──────────────

export class LiveStop extends Error {
  constructor(message: string) { super(message); this.name = "LiveStop"; }
}

interface SignalSource { on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown }

/** One abort for the whole run: Ctrl-C at a prompt, or SIGINT/SIGTERM/SIGHUP to the runner.
 * Handlers stay installed until dispose(), so a second signal cannot kill the runner mid-cleanup. */
export function createRunAbort(rl: SignalSource | undefined, proc: SignalSource, notify: (text: string) => void = text => { process.stderr.write(text); }) {
  const controller = new AbortController();
  const installed: Array<[SignalSource, string, () => void]> = [];
  const handler = (name: string) => () => {
    if (controller.signal.aborted) { notify("\nCleanup is in progress (revoke, Chief demotion, server stop). Wait for it to finish.\n"); return; }
    notify(`\n${name} received: stopping the run, then revoking and cleaning up.\n`);
    controller.abort(new LiveStop(`operator interrupted the run (${name})`));
  };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) { const listener = handler(name); proc.on(name, listener); installed.push([proc, name, listener]); }
  if (rl) { const listener = handler("SIGINT"); rl.on("SIGINT", listener); installed.push([rl, "SIGINT", listener]); }
  return { signal: controller.signal, dispose() { for (const [source, name, listener] of installed.splice(0)) source.off(name, listener); } };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function abortableWait<T>(label: string, probe: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs: number, intervalMs: number, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const value = await probe();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new LiveStop(`timed out waiting for ${label}`);
    await abortableSleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/** An operator prompt that ends on abort or at the run's time limit, both as LiveStop. */
export async function askOperator(rl: { question(query: string, options: { signal: AbortSignal }): Promise<string> }, query: string, signal: AbortSignal, remainingMs: number): Promise<string> {
  if (signal.aborted) throw signal.reason;
  const limit = AbortSignal.timeout(Math.max(1, remainingMs));
  try { return await rl.question(query, { signal: AbortSignal.any([signal, limit]) }); }
  catch (error) {
    if (signal.aborted) throw signal.reason;
    if (limit.aborted) throw new LiveStop("the run's time limit was reached while waiting for the operator");
    throw error;
  }
}

export interface FinalizeInput {
  harness?: { request: Harness["request"]; record: Harness["record"]; close: Harness["close"] };
  revokePath: string; statusPath: string; statePaired: (status: any) => boolean;
  pairingStarted: boolean; revokeConfirmed: boolean; chiefId?: string; chiefDemoted: boolean;
}
export interface FinalizeOutcome { revoke: "not-needed" | "confirmed" | "failed"; revokeDetail?: unknown; demote: "not-needed" | "done" | "failed"; closed: boolean; order: string[] }

/** The one exit path: revoke whatever pairing was started (outcome verified, never assumed),
 * demote the fixture Chief best-effort, then stop the owned server and remove its root. */
export async function finalizeLive(input: FinalizeInput): Promise<FinalizeOutcome> {
  const order: string[] = [];
  const needRevoke = input.pairingStarted && !input.revokeConfirmed, needDemote = Boolean(input.chiefId) && !input.chiefDemoted;
  const outcome: FinalizeOutcome = { revoke: needRevoke ? "failed" : "not-needed", demote: needDemote ? "failed" : "not-needed", closed: false, order };
  const record = (step: string, data: unknown) => { try { input.harness?.record(step, data); } catch { /* evidence is best-effort here */ } };
  if (input.harness && needRevoke) {
    order.push("revoke");
    try {
      const revoked = await input.harness.request("POST", input.revokePath, {});
      const after = await input.harness.request("GET", input.statusPath);
      outcome.revokeDetail = { http: revoked.status, pairedAfter: input.statePaired(after.body) };
      if (revoked.status === 200 && !input.statePaired(after.body)) outcome.revoke = "confirmed";
    } catch { outcome.revokeDetail = { error: "server unreachable; removing the fixture root deletes the local binding, the provider credential stays valid" }; }
    record("stop-revoke", { outcome: outcome.revoke, detail: outcome.revokeDetail });
  }
  if (input.harness && needDemote) {
    order.push("demote");
    try { if ((await input.harness.request("PATCH", `/api/bots/${input.chiefId}`, { chiefOfStaff: false })).status === 200) outcome.demote = "done"; } catch { /* recorded as failed */ }
    record("stop-demote", { outcome: outcome.demote });
  }
  if (input.harness) {
    order.push("close");
    try { await input.harness.close(); outcome.closed = true; } catch (error) { process.stderr.write(`cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  return outcome;
}

// ── Real-engine reply identity (exported for offline unit checks) ─────────

export interface LedgerRecord { id: string; state: string; runId?: string; response?: string }
const ledgerRecord = (r: any): LedgerRecord => ({ id: String(r.deliveryId), state: String(r.state), ...(r.runId ? { runId: String(r.runId) } : {}), ...(typeof r.response === "string" ? { response: r.response } : {}) });

/** Counts alone cannot distinguish a pairing acknowledgement from an early review reply. */
export function expectedReplyProblems(records: LedgerRecord[], expectedResponse: string): string[] {
  if (records.length !== 1) return [`expected one matching receipt, found ${records.length}`];
  return records[0].response === expectedResponse ? [] : ["receipt response does not match the requested step"];
}

/** Samples during operator prompts too; the owner must stop it before fixture cleanup. */
export function startReceiptCapture(sample: () => void, failed: (error: unknown) => void, signal: AbortSignal, intervalMs = 100) {
  const tick = () => { try { sample(); } catch (error) { failed(error); } };
  const timer = setInterval(tick, intervalMs);
  const stop = () => { clearInterval(timer); signal.removeEventListener("abort", stop); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop(); else tick();
  return stop;
}

export function receiptDiagnostics(records: LedgerRecord[]) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return records.map(record => ({ idSha256: hash(record.id), state: record.state,
    ...(record.runId ? { runIdSha256: hash(record.runId) } : {}),
    ...(record.response !== undefined ? { responseSha256: hash(record.response), responseLength: record.response.length } : {}) }));
}

export interface ReplyEvidence { runId: string; threadId?: string; replySha256: string; replyLength: number; excerpt: string }

/** A real-engine reply is exactly one completed Chief run whose own output was delivered once,
 * on a task pinned to the admitted engine and model with no Auto or remembered grants. */
export function realReplyProblems(input: { newRuns: any[]; newRecords: LedgerRecord[]; chiefId: string; chiefTasks: any[]; descriptor: B08EngineDescriptor }): { problems: string[]; evidence?: ReplyEvidence } {
  if (input.newRuns.length !== 1) return { problems: [`expected exactly one new run, found ${input.newRuns.length}`] };
  const problems: string[] = [];
  const run = input.newRuns[0];
  if (run.status !== "completed") problems.push(`run status is ${run.status}`);
  if (run.botId !== input.chiefId) problems.push("run belongs to a bot other than the fixture Chief");
  const records = input.newRecords.filter(record => record.runId === String(run.id));
  if (records.length !== 1 || input.newRecords.length !== 1) problems.push(`expected exactly one new delivery, for this run; found ${records.length} for the run of ${input.newRecords.length} new`);
  const record = records[0];
  if (record && record.state !== "sent") problems.push(`delivery state is ${record.state}`);
  const response = record?.response?.trim() ?? "", output = typeof run.output === "string" ? run.output.trim() : "";
  if (!output) problems.push("run has no model output");
  if (!response) problems.push("delivery has no reply text");
  else if (output && !output.startsWith(response)) problems.push("delivered reply is not the run's output");
  const tasks = input.chiefTasks.filter(task => !run.threadId || task.threadId === run.threadId);
  if (tasks.length !== 1) problems.push(`expected one Chief task for the run's thread, found ${tasks.length}`);
  else problems.push(...taskIdentityProblems(tasks[0], input.descriptor));
  const evidence = response ? { runId: String(run.id), ...(run.threadId ? { threadId: String(run.threadId) } : {}),
    replySha256: createHash("sha256").update(response).digest("hex"), replyLength: response.length, excerpt: response.slice(0, 60).replace(/\s+/g, " ") } : undefined;
  return { problems, ...(evidence ? { evidence } : {}) };
}

// ── Live run ────────────────────────────────────────────────────────────────

interface LiveAdapter {
  statusPath: string; pairPath: string; revokePath: string;
  pairBody(chiefId: string): unknown;
  saveBody(secrets: Record<string, string>): unknown;
  statePaired(status: any): boolean;
  stateActive(status: any): boolean;
  stateBlocked(status: any): boolean;
  identityMatches(data: string, pairResponse: any): { ok: boolean; detail: unknown };
  bindingMatches(data: string): { ok: boolean; detail: unknown };
  ledger(data: string): LedgerRecord[];
  runs(list: any[]): any[];
}

function liveAdapter(manifest: Manifest): LiveAdapter {
  if (manifest.platform === "telegram") {
    const t = manifest.telegram;
    return {
      statusPath: "/api/telegram/status", pairPath: "/api/telegram/pair", revokePath: "/api/telegram/revoke",
      pairBody: () => ({}), saveBody: secrets => ({ telegram: { botToken: secrets.MURAGE_TELEGRAM_BOT_TOKEN } }),
      statePaired: s => s?.paired === true, stateActive: s => s?.paired === true && s?.resumeState === "active", stateBlocked: s => s?.resumeState === "blocked",
      identityMatches: (data, pair) => {
        const connection = readJson(join(data, "telegram", "connection.json"));
        const detail = { connectionBot: connection?.botIdentityId, pairBot: pair?.botIdentityId, username: pair?.username };
        return { ok: connection?.botIdentityId === t.botId && pair?.botIdentityId === t.botId && (pair?.username === undefined || pair.username.toLowerCase() === t.botUsername.toLowerCase()), detail };
      },
      bindingMatches: data => {
        const binding = readJson(join(data, "telegram", `${t.botId}.json`))?.binding;
        return { ok: binding?.senderId === t.ownerUserId && binding?.chatId === t.ownerUserId, detail: { binding } };
      },
      ledger: data => (readJson(join(data, "telegram", `${t.botId}.json`))?.records ?? []).map(ledgerRecord),
      runs: list => list.filter(run => run.telegramConnectionId === t.botId),
    };
  }
  const platform = manifest.platform;
  const connectionOf = (data: string) => readJson(join(data, "channels", platform, "connection.json"));
  return {
    statusPath: `/api/${platform}/status`, pairPath: `/api/${platform}/pair`, revokePath: `/api/${platform}/revoke`,
    pairBody: chiefId => ({ targetBotId: chiefId }),
    saveBody: secrets => manifest.platform === "slack"
      ? { slack: { appToken: secrets.MURAGE_SLACK_APP_TOKEN, botToken: secrets.MURAGE_SLACK_BOT_TOKEN, teamId: manifest.slack.teamId, appId: manifest.slack.appId, ownerUserId: manifest.slack.ownerUserId } }
      : { discord: { botToken: secrets.MURAGE_DISCORD_BOT_TOKEN, applicationId: (manifest as any).discord.applicationId, ownerUserId: (manifest as any).discord.ownerUserId } },
    statePaired: s => s?.paired === true, stateActive: s => s?.paired === true && s?.enabled === true && s?.state === "connected", stateBlocked: s => s?.state === "blocked",
    identityMatches: data => {
      const identity = connectionOf(data)?.identity;
      const ok = manifest.platform === "slack"
        ? identity?.teamId === manifest.slack.teamId && identity?.userId === manifest.slack.botUserId && identity?.botId === manifest.slack.botId
        : identity?.applicationId === (manifest as any).discord.applicationId && identity?.botUserId === (manifest as any).discord.botUserId;
      return { ok, detail: { identity } };
    },
    bindingMatches: data => {
      const binding = connectionOf(data)?.binding;
      const ok = manifest.platform === "slack"
        ? binding?.ownerUserId === manifest.slack.ownerUserId && binding?.teamId === manifest.slack.teamId && binding?.appId === manifest.slack.appId && /^D[A-Z0-9]+$/.test(String(binding?.dmId))
        : binding?.ownerUserId === (manifest as any).discord.ownerUserId && binding?.applicationId === (manifest as any).discord.applicationId && /^[1-9][0-9]*$/.test(String(binding?.dmId));
      return { ok, detail: { binding } };
    },
    ledger: data => {
      const connectionId = connectionOf(data)?.binding?.connectionId;
      if (!connectionId) return [];
      return (readJson(join(data, "channels", platform, `${connectionId}.json`))?.records ?? []).map(ledgerRecord);
    },
    runs: list => list.filter(run => run.channelOrigin?.platform === platform),
  };
}

/** Longer than one Telegram receive cycle (1.5 s) and one durable-delivery drain, twice. */
const REPLY_SETTLE_MS = 6_000;

export const BUTTON_ENGINE = { instanceId: "channelButtonFixture", model: "claude-sonnet-5" };
export const BUTTON_BUDGET = { telegram: { operator: 6, outbound: 7 }, slack: { operator: 7, outbound: 8 }, discord: { operator: 7, outbound: 8 } };
export function buttonPilotProblems(platform: Platform, limits: Manifest["limits"], flag?: string): string[] {
  if (flag === undefined) return [];
  if (flag !== "yes") return ["--buttons must equal yes"];
  const budget = BUTTON_BUDGET[platform];
  return [...(limits.maxOperatorMessages < budget.operator ? ["button pilot operator budget is too small"] : []),
    ...(limits.maxOutboundMessages < budget.outbound ? ["button pilot outbound budget is too small"] : []),
    ...(limits.maxMinutes > 30 ? ["button pilot must be capped at 30 minutes"] : [])];
}
export function buttonDecisions(data: string): Array<{ id: string; phase: string; behavior?: string }> {
  const path = join(data, "channel-button-decisions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
/** Stops the only owned server before changing its isolated engine catalog. */
export async function prepareButtonPilot(harness: Harness, chiefId: string, enterFixture: () => void, channelThreadId?: string) {
  const exit = await harness.stop();
  if (exit.exitCode !== 0) throw new LiveStop("button engine transition requires a clean server stop");
  const path = join(harness.data, "config.json");
  const config = readJson(path);
  config.engineDiscovery = "explicit";
  config.instances = { [BUTTON_ENGINE.instanceId]: { driver: "claudeAgent", config: { cli: join(ROOT, "scripts/channel-button-permission-cli.mjs") } } };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  enterFixture();
  await harness.boot();
  const patched = await harness.request("PATCH", `/api/bots/${chiefId}`, { settingsScope: "defaults", modelSelection: BUTTON_ENGINE,
    autoReview: "off", autoApprove: false, alwaysAllow: [], computer: "off", browser: false, composio: false });
  if (patched.status !== 200) throw new LiveStop(`button Chief policy refused (${patched.status})`);
  const file = readJson(join(harness.data, "bots.json"));
  const bot = (Array.isArray(file) ? file : file?.bots ?? []).find((item: any) => item.id === chiefId);
  if (!bot || bot.autoReview !== "off" || bot.autoApprove === true || bot.alwaysAllow?.length
    || bot.modelSelection?.instanceId !== BUTTON_ENGINE.instanceId || bot.modelSelection?.model !== BUTTON_ENGINE.model)
    throw new LiveStop("button Chief policy was not retained");
  const channelTasks = (bot.tasks ?? []).filter((task: any) => channelThreadId ? task.threadId === channelThreadId : task.title === "Channel conversation");
  if (channelTasks.length > 1) throw new LiveStop("button transition has ambiguous channel tasks");
  if (channelTasks.length === 1) {
    const task = channelTasks[0];
    if (task.alwaysAllow?.length) throw new LiveStop("channel task has standing grants before the button pilot");
    const result = await harness.request("PATCH", `/api/bots/${chiefId}/tasks/${task.threadId}`, { modelSelection: BUTTON_ENGINE, autoApprove: false });
    if (result.status !== 200 || buttonTaskProblems(harness.data, chiefId, { threadId: task.threadId }).length)
      throw new LiveStop("existing channel task could not be pinned to the permission fixture");
  } else if (channelThreadId) throw new LiveStop("the previous channel thread was not found");
  harness.record("button-engine-transition", { instanceId: BUTTON_ENGINE.instanceId, model: BUTTON_ENGINE.model, realModel: false });
}
export function buttonTaskProblems(data: string, chiefId: string, run: any): string[] {
  const tasks = chiefTasks(data, chiefId).filter(task => task.threadId === run?.threadId);
  if (tasks.length !== 1) return ["permission run does not have one Chief task"];
  const task = tasks[0];
  return task.modelSelection?.instanceId !== BUTTON_ENGINE.instanceId || task.modelSelection?.model !== BUTTON_ENGINE.model
    || task.autoApprove === true || task.alwaysAllow?.length ? ["permission task has wrong engine or grants"] : [];
}

/** Qualification setup authority covers only the exact generated task folder, never a general permission. */
export function fixtureFolderTrustProblems(harness: Pick<Harness, "root" | "data">, chiefId: string, run: any, task: any, card: any): string[] {
  const reject = (reason: string) => [reason];
  if (!run?.threadId || run.botId !== chiefId || task?.threadId !== run.threadId) return reject("folder trust does not belong to the current Chief run task");
  if (!card?.folderTrust || card.answered || card.dismissed || card.expired || !card.requestId || card.tool
    || card.questions?.length !== 1 || card.questions[0].id !== "folderTrust"
    || card.questions[0].allowOther !== false || !card.questions[0].options?.some((option: any) => option.label === "Trust this folder"))
    return reject("unexpected approval; only a live host folderTrust question is fixture setup");
  const sources = card.folderTrust.sources;
  if (!Array.isArray(sources) || !sources.length || sources.length > 2 || new Set(sources).size !== sources.length
    || sources.some((source: unknown) => source !== ".agents/skills" && source !== ".claude/skills")) return reject("folder trust has unapproved sources");
  if (task.autoApprove === true || task.alwaysAllow?.length) return reject("fixture task has standing tool grants");
  try {
    const owned = realpathSync(harness.root), data = realpathSync(harness.data);
    const expected = join(data, "workspaces", chiefId, "threads", run.threadId);
    if (!data.startsWith(owned + sep) || realpathSync(expected) !== expected || realpathSync(card.folderTrust.folder) !== expected
      || realpathSync(card.folderTrust.key) !== expected || realpathSync(task.cwd) !== expected)
      return reject("folder trust path is not the canonical fixture task folder");
    const bundleId = task.procedurePin?.bundleId;
    if (!/^[a-f0-9]{64}$/.test(bundleId ?? "")) return reject("fixture task has no generated procedure pin");
    const bundle = join(expected, ".murage-procedures", bundleId);
    if (realpathSync(bundle) !== bundle || readFileSync(join(bundle, ".complete"), "utf8") !== bundleId)
      return reject("fixture procedure origin is not the completed task pin");
    for (const source of sources) {
      const directory = join(expected, source);
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) return reject("fixture skill source was replaced");
      for (const name of readdirSync(directory)) {
        const link = join(directory, name), target = join(bundle, "skills", name);
        if (!lstatSync(link).isSymbolicLink() || realpathSync(target) !== target || realpathSync(link) !== target)
          return reject("folder trust includes a skill outside the task procedure pin");
      }
    }
  } catch { return reject("fixture folder trust origin could not be verified"); }
  return [];
}

/** Called only while waiting for one ordinary real-engine channel reply. */
export interface ReplyOwnerAction { runId: string; threadId: string; messageId: string; settled: boolean }
export async function handleFixtureReplySetup(harness: Harness, platform: Platform, chiefId: string, beforeRuns: Set<string>, instanceId: string, handled: Set<string>, ownerActions = new Map<string, ReplyOwnerAction>(), notify = (text: string) => { process.stdout.write(text); }): Promise<boolean> {
  const response = await harness.request("GET", "/api/routines");
  if (response.status !== 200) throw new LiveStop("could not inspect the current channel run while awaiting its reply");
  const current = (response.body?.runs ?? []).filter((run: any) => run.channelOrigin?.platform === platform && !beforeRuns.has(String(run.id)));
  if (current.length > 1) throw new LiveStop("more than one channel run while awaiting its reply");
  if (!current.length) return false;
  const run = current[0];
  if (run.botId !== chiefId) throw new LiveStop("reply run belongs to another Chief");
  if (["failed", "cancelled", "interrupted"].includes(run.status)) throw new LiveStop(`channel reply run ended ${run.status}; review its recorded status`);
  if (!run.threadId) return false;
  if (run.status === "completed" && ![...ownerActions.values()].some(action => action.runId === run.id && !action.settled)) return false;
  const task = chiefTasks(harness.data, chiefId).find(item => item.threadId === run.threadId);
  if (!task || task.modelSelection?.instanceId !== instanceId) throw new LiveStop("channel reply task is not pinned to the admitted engine");
  const messages = await harness.request("GET", `/api/threads/${run.threadId}/messages?limit=200`);
  if (messages.status !== 200) throw new LiveStop("could not inspect channel reply prerequisites");
  // Only a card observed pending for this exact run can later count as its owner decision.
  for (const [requestId, action] of ownerActions) {
    if (action.runId !== run.id || action.settled) continue;
    const message = (messages.body?.messages ?? []).find((item: any) => item.id === action.messageId && item.card?.requestId === requestId);
    if (!message || action.threadId !== run.threadId) throw new LiveStop("observed owner action disappeared or changed identity");
    const card = message.card;
    if (card.expired || card.dismissed) throw new LiveStop("owner action expired or was dismissed without an owner decision");
    if (card.answered) {
      const decisions = card.tool ? ["allow", "deny"] : ["answer", "skipped"];
      if (!decisions.includes(card.answered)) throw new LiveStop("owner action has an unrecognized resolution");
      action.settled = true;
      harness.record("reply-owner-decision", { runId: run.id, threadId: run.threadId, requestId, messageId: message.id, behavior: card.answered });
    }
  }
  const pending = (messages.body?.messages ?? []).filter((message: any) => message.card?.requestId && !message.card.answered && !message.card.dismissed && !message.card.expired);
  let waitingForOwner = false;
  for (const message of pending) {
    if (!message.card.folderTrust) {
      const requestId = message.card.requestId;
      if (![run.id, run.threadId, message.id, requestId].every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)))
        throw new LiveStop("owner action has an invalid identity");
      const observed = ownerActions.get(requestId);
      if (observed && (observed.runId !== run.id || observed.threadId !== run.threadId || observed.messageId !== message.id || observed.settled))
        throw new LiveStop("owner action request identity was reused");
      if (!observed) {
        ownerActions.set(requestId, { runId: run.id, threadId: run.threadId, messageId: message.id, settled: false });
        const kind = message.card.tool ? "permission" : "question";
        // Tool inputs, titles, question text and answers can contain secrets. Show only routing identity.
        harness.record("reply-owner-action-pending", { runId: run.id, threadId: run.threadId, requestId, messageId: message.id, kind });
        notify(`\nOWNER ACTION REQUIRED (${kind}): review the actual card in the isolated Murage at ${harness.url}, thread ${run.threadId}, request ${requestId}, or its supported provider card. The runner will not approve it. The original reply/run deadline remains in force.\n`);
      }
      waitingForOwner = true;
      continue;
    }
    const problems = fixtureFolderTrustProblems(harness, chiefId, run, task, message.card);
    if (problems.length) {
      harness.record("fixture-setup-refused", { runId: run.id, threadId: run.threadId, requestId: message.card.requestId, reasons: problems });
      throw new LiveStop(problems.join("; "));
    }
    if (handled.has(message.card.requestId)) throw new LiveStop("fixture folder trust remains pending after its one setup response");
    handled.add(message.card.requestId);
    const answer = await harness.request("POST", `/api/bots/${chiefId}/respond`, { threadId: run.threadId, requestId: message.card.requestId,
      behavior: "answer", answers: [{ id: "folderTrust", selected: ["Trust this folder"] }] });
    harness.record("fixture-folder-trust", { runId: run.id, threadId: run.threadId, requestId: message.card.requestId,
      sources: message.card.folderTrust.sources, http: answer.status, outcome: answer.body?.outcome, authority: "isolated generated task-folder setup only" });
    if (answer.status !== 200 || answer.body?.outcome !== "answered") throw new LiveStop("fixture folder trust response was not accepted");
  }
  return waitingForOwner;
}

async function runLive(platform: Platform, flags: Record<string, string | undefined>): Promise<number> {
  if (flags["network-diagnostics"] !== undefined && (platform !== "telegram" || flags["network-diagnostics"] !== "yes")) {
    process.stderr.write("--network-diagnostics yes is limited to Telegram qualification\n"); return 2;
  }
  if (!flags.inputs) { process.stderr.write("run requires --inputs FILE and --authority TEXT\n"); return 2; }
  const context = { repoRoot: ROOT };
  let manifest: Manifest;
  try { manifest = loadManifestFile(flags.inputs, context).manifest; }
  catch (error) { process.stderr.write(`${error instanceof ManifestError ? error.message : "inputs could not be validated"}\n`); return 2; }
  if (manifest.platform !== platform) { process.stderr.write("--platform does not match the inputs file\n"); return 2; }
  if (flags.authority === undefined || flags.authority !== manifest.authorityReference) { process.stderr.write("--authority must exactly equal the manifest authorityReference; live run refused\n"); return 2; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write("the live run needs an interactive operator terminal; refused\n"); return 2; }
  let secrets: Record<string, string>;
  try { secrets = loadSecrets(manifest, context); }
  catch (error) { process.stderr.write(`${error instanceof ManifestError ? error.message : "credentials could not be loaded"}\n`); return 2; }
  let engine: AdmittedEngine | undefined;
  try { engine = loadEngine(manifest, context); }
  catch (error) { process.stderr.write(`${error instanceof ManifestError ? error.message : "the engine could not be admitted"}\n`); return 2; }
  const descriptor = engine?.descriptor;
  const buttonProblems = buttonPilotProblems(platform, manifest.limits, flags.buttons);
  if (buttonProblems.length) { process.stderr.write(buttonProblems.join("; ") + "\n"); return 2; }
  const buttons = flags.buttons === "yes";
  let buttonPhase = false, cardMessages = 0, cardEdits = 0, operatorTaps = 0;

  const started = Date.now(), deadline = started + manifest.limits.maxMinutes * 60_000;
  const evidenceDir = mkdtempSync(join(tmpdir(), `murage-channel-live-evidence-${platform}-live-`));
  process.stdout.write(`evidence ${evidenceDir}\n`);
  const adapter = liveAdapter(manifest);
  let harness: Harness | undefined;
  const checks = new Checks(() => harness);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = createRunAbort(rl, process);
  const outbound = new Map<string, string>();
  const capturedReceipts = new Map<string, LedgerRecord>();
  let replyBaseline = new Set<string>();
  const handledFixtureSetup = new Set<string>();
  const replyOwnerActions = new Map<string, ReplyOwnerAction>();
  let captureError: unknown;
  let stopCapture: (() => void) | undefined;
  const state = { pairingStarted: false, revokeConfirmed: false, chiefId: undefined as string | undefined, chiefDemoted: false };
  let operatorMessages = 0, delivered = false;

  const remaining = () => {
    if (abort.signal.aborted) throw abort.signal.reason;
    if (captureError) throw captureError;
    const left = deadline - Date.now();
    if (left <= 0) throw new LiveStop(`time limit of ${manifest.limits.maxMinutes} minutes reached`);
    return left;
  };
  const wait = <T>(label: string, probe: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs: number, intervalMs = 1_000) =>
    abortableWait(label, probe, accept, Math.min(timeoutMs, remaining()), intervalMs, abort.signal);
  const pause = (ms: number) => abortableSleep(Math.min(ms, remaining()), abort.signal);
  const status = async () => (await harness!.request("GET", adapter.statusPath)).body;
  const runs = async () => adapter.runs((await harness!.request("GET", "/api/routines")).body?.runs ?? []);
  const announce = () => process.stdout.write(`server pid ${harness!.child()?.pid} (own process group), fixture root ${harness!.root}\n`);
  // Keep every observed outbound record: each adapter may compact settled receipts on later intake.
  const observeLedger = () => {
    for (const record of adapter.ledger(harness!.data)) {
      capturedReceipts.set(record.id, record);
      if (outbound.has(record.id) || ["sending", "sent", "uncertain", "rejected"].includes(record.state)) outbound.set(record.id, record.state);
    }
    if (outbound.size + cardMessages > manifest.limits.maxOutboundMessages) throw new LiveStop(`outbound budget ${manifest.limits.maxOutboundMessages} exceeded`);
    return outbound.size;
  };
  /** Exact delivery: after settling, the total equals the expectation and every new record is "sent". */
  const expectReplies = async (id: string, criterion: string, expectedTotal: number, expectedResponse?: string, beforeRuns?: Set<string>) => {
    const before = replyBaseline;
    await wait(criterion, async () => {
      if (descriptor && !buttonPhase && beforeRuns && state.chiefId
        && await handleFixtureReplySetup(harness!, platform, state.chiefId, beforeRuns, descriptor.instanceId, handledFixtureSetup, replyOwnerActions)) {
        observeLedger();
        return -1; // A delivery count cannot bypass the still-pending owner card.
      }
      return observeLedger();
    }, size => size >= expectedTotal, 180_000, 500);
    await pause(REPLY_SETTLE_MS);
    observeLedger();
    const fresh = [...outbound].filter(([key]) => !before.has(key));
    const responseProblems = expectedResponse === undefined ? [] : expectedReplyProblems(
      [...capturedReceipts.values()].filter(record => !before.has(record.id)), expectedResponse);
    const ok = outbound.size === expectedTotal && fresh.length === expectedTotal - before.size && fresh.every(([, value]) => value === "sent") && responseProblems.length === 0;
    checks.expect(id, criterion, ok, { expectedTotal, observedTotal: outbound.size, newStates: fresh.map(([, value]) => value), responseProblems });
    if (!ok) throw new LiveStop(`${criterion}: not exactly as expected`);
  };
  const ownerSends = async (textToSend: string, purpose: string) => {
    remaining();
    observeLedger();
    replyBaseline = new Set(outbound.keys());
    if (operatorMessages + 1 > manifest.limits.maxOperatorMessages) throw new LiveStop(`operator message budget ${manifest.limits.maxOperatorMessages} reached`);
    operatorMessages += 1;
    process.stdout.write(`\nOPERATOR STEP ${operatorMessages}/${manifest.limits.maxOperatorMessages} (${purpose})\nFrom the dedicated owner account, send exactly this text to the test bot in a direct message:\n\n  ${textToSend}\n\n`);
    const answer = (await askOperator(rl, "Press Enter after sending it, or type STOP to abort: ", abort.signal, remaining())).trim();
    if (answer.toUpperCase() === "STOP") throw new LiveStop("operator stopped the run");
    harness!.record("operator-message", { step: operatorMessages, purpose });
  };
  const attest = async (question: string) => (await askOperator(rl, `${question} [y/N] `, abort.signal, remaining())).trim().toLowerCase() === "y";
  /** Real engine only: the server describes exactly the admitted, available, non-fake instance with its catalog model. */
  const verifyEngine = async (id: string, criterion: string) => {
    if (!descriptor) return;
    let problems: string[] = ["identity not checked"];
    try {
      await wait("admitted engine identity", async () => (problems = assertRealEngineIdentity(((await harness!.request("GET", "/api/instances")).body?.instances ?? []) as DescribedInstance[], descriptor, ROOT)),
        list => list.length === 0, 180_000, 2_000);
    } catch (error) { if (!(error instanceof LiveStop) || abort.signal.aborted) throw error; }
    checks.expect(id, criterion, problems.length === 0, { instanceId: descriptor.instanceId, driver: descriptor.driver, model: descriptor.model, problems });
    if (problems.length) throw new LiveStop("the running engine is not the admitted engine");
  };
  const snapshot = async () => ({ runs: new Set((await runs()).map((run: any) => String(run.id))), ledger: new Set(adapter.ledger(harness!.data).map(record => record.id)) });
  /** Real engine only: the reply is the admitted engine's one completed run for this request, delivered once. */
  const verifyModelReply = async (id: string, before: { runs: Set<string>; ledger: Set<string> }, chiefId: string) => {
    if (!descriptor) return undefined;
    const result = realReplyProblems({ newRuns: (await runs()).filter((run: any) => !before.runs.has(String(run.id))),
      newRecords: adapter.ledger(harness!.data).filter(record => !before.ledger.has(record.id)), chiefId, chiefTasks: chiefTasks(harness!.data, chiefId), descriptor });
    const { excerpt: _excerpt, ...recorded } = result.evidence ?? { excerpt: "" };
    checks.expect(id, "the reply is the admitted engine's one completed run for this request, delivered once", result.problems.length === 0, { problems: result.problems, ...recorded });
    if (result.problems.length) throw new LiveStop("the reply is not the admitted engine's run output");
    return result.evidence;
  };

  try {
    harness = await createHarness({ label: `${platform}-live`, evidenceDir, detached: true,
      ...(flags["network-diagnostics"] === "yes" ? { preload: join(ROOT, "scripts", "telegram-fetch-diagnostics.mjs") } : {}),
      ...(descriptor ? { engine: { instanceId: descriptor.instanceId, driver: descriptor.driver, displayName: descriptor.displayName, config: descriptor.config } } : {}),
      env: (): Record<string, string> => buttonPhase ? { MURAGE_CHANNEL_BUTTON_FIXTURE: "1" } : {},
      secretEnv: (): Record<string, string> => ({ ...(!buttonPhase ? engine?.env ?? {} : {}), ...(delivered ? secrets : {}) }) });
    await harness.boot();
    stopCapture = startReceiptCapture(observeLedger, error => { captureError = error; }, abort.signal);
    announce();
    remaining();
    await verifyEngine("A0.engine", "the server runs exactly the admitted real engine");
    const chief = descriptor
      ? await promoteFixtureChief(harness, "Qualification Chief", { instanceId: descriptor.instanceId, model: descriptor.model }, { browser: false, composio: false })
      : await promoteFixtureChief(harness, "Qualification Chief");
    state.chiefId = chief.id;
    const saved = await harness.request("PATCH", "/api/config?secretStorage=external", adapter.saveBody(secrets));
    delivered = true;
    const afterSave = await status();
    checks.expect("A1.save", "saving credentials does not pair or enable the channel", saved.status === 200 && !adapter.statePaired(afterSave) && afterSave.enabled !== true, pick(afterSave));
    if (saved.status !== 200) throw new LiveStop(`credential save refused (${saved.status})`);

    remaining();
    state.pairingStarted = true; // the receiver may be running even if this request fails or times out
    const pairing = await harness.request("POST", adapter.pairPath, adapter.pairBody(chief.id));
    if (pairing.status !== 200 || typeof pairing.body?.code !== "string") throw new LiveStop(`pairing refused (${pairing.status}: ${String(pairing.body?.error ?? "")})`);
    const identity = adapter.identityMatches(harness.data, pairing.body);
    checks.expect("A5.identity", "the provider identity behind the credentials is the dedicated test identity", identity.ok, identity.detail);
    if (!identity.ok) throw new LiveStop("provider identity does not match the manifest");

    await ownerSends(`${platform === "slack" ? "pair" : "/pair"} ${pairing.body.code}`, "pair the dedicated owner");
    await wait("owner pairing", status, adapter.statePaired, 300_000);
    const binding = adapter.bindingMatches(harness.data);
    checks.expect("A5.binding", "the binding is the dedicated owner's direct message", binding.ok, binding.detail);
    if (!binding.ok) throw new LiveStop("paired owner or DM does not match the manifest");
    await expectReplies("A6.ack-delivery", "exactly one pairing confirmation was delivered", 1,
      `${platform === "telegram" ? "Telegram" : platform === "discord" ? "Discord" : "Slack"} is paired with Murage. Before chatting, link this channel account in Murage Settings → Memory. Then send your message again.`);
    checks.expect("A1.healthy", "paired and receiving", adapter.stateActive(await status()), pick(await status()));
    checks.expect("A6.ack", "operator received exactly one pairing confirmation", await attest("Did the bot send exactly one pairing confirmation?"));

    let expectedOutbound = 1;
    if (platform !== "telegram") {
      await ownerSends("yes", "approval-shaped text must not approve");
      expectedOutbound += 1;
      await expectReplies("A6.review-delivery", "exactly one review reply was delivered", expectedOutbound,
        `Review approvals in Murage. ${platform === "discord" ? "Discord" : "Slack"} messages cannot approve actions.`);
      checks.expect("A6.review", "'yes' produced review guidance and no run", (await runs()).length === 0 && await attest("Did the bot reply once telling you to review approvals in Murage?"));
    }

    let link: { stateBefore: string; revision: number };
    try { link = await linkChannelOwner(harness, platform); }
    catch (error) { throw new LiveStop(`owner link failed: ${error instanceof Error ? error.message : String(error)}`); }
    checks.expect("A5.link", "the paired owner's account is linked to the workspace owner before any work", link.stateBefore === "link-required", link);

    const beforeOne = await snapshot();
    await ownerSends("Qualification request one: reply once.", "one request, one run, one reply");
    expectedOutbound += 1;
    await expectReplies("A6.one-delivery", "exactly one reply to request one was delivered", expectedOutbound, undefined, beforeOne.runs);
    const runsOne = (await runs()).length;
    const replyOne = await verifyModelReply("A6.one-identity", beforeOne, chief.id);
    checks.expect("A6.one", descriptor ? "one request created exactly one admitted-engine run and its reply" : "one request created exactly one run and the fixture reply",
      runsOne === 1 && await attest(replyOne ? `Did you receive exactly one reply, beginning: "${replyOne.excerpt}"?` : "Did you receive exactly one reply reading \"hello from fake claude\"?"),
      { runs: runsOne, outbound: Object.fromEntries(outbound) });

    const exit = await harness.restart();
    announce();
    const resumed = await wait("resume after restart", status, adapter.stateActive, 120_000);
    await verifyEngine("A0.engine-restart", "after the restart the server still runs exactly the admitted real engine");
    const identityAfter = adapter.identityMatches(harness.data, pairing.body), bindingAfter = adapter.bindingMatches(harness.data);
    checks.expect("A2.restart", "same-data restart resumed the binding without a new pairing code", exit.exitCode === 0 && identityAfter.ok && bindingAfter.ok,
      { exit, status: pick(resumed), identity: identityAfter.detail, binding: bindingAfter.detail });
    if (!identityAfter.ok || !bindingAfter.ok) throw new LiveStop("identity or binding changed across the restart");

    const beforeTwo = await snapshot();
    await ownerSends("Qualification request two after restart: reply once.", "post-restart request");
    expectedOutbound += 1;
    await expectReplies("A6.restart-delivery", "exactly one reply to request two was delivered", expectedOutbound, undefined, beforeTwo.runs);
    const runsTwo = (await runs()).length;
    if (runsTwo > LIVE_MODEL_RUNS) throw new LiveStop(`more than the ${LIVE_MODEL_RUNS} planned model runs started`);
    const replyTwo = await verifyModelReply("A6.restart-identity", beforeTwo, chief.id);
    checks.expect("A6.restart", "the post-restart request created exactly one more run and reply", runsTwo === 2
      && await attest(replyTwo ? `Did you receive exactly one new reply after the restart, beginning: "${replyTwo.excerpt}"?` : "Did you receive exactly one new reply after the restart?"), { runs: runsTwo });

    if (buttons) {
      await prepareButtonPilot(harness, chief.id, () => { buttonPhase = true; }, (await runs()).find((run: any) => !beforeTwo.runs.has(String(run.id)))?.threadId);
      announce();
      await wait("button-phase binding resume", status, adapter.stateActive, 120_000);
      if (!adapter.identityMatches(harness.data, pairing.body).ok || !adapter.bindingMatches(harness.data).ok)
        throw new LiveStop("button transition changed provider identity or binding");
      for (const behavior of ["allow", "deny"] as const) {
        const before = await snapshot();
        const decisionsBefore = buttonDecisions(harness.data).length;
        await ownerSends(`Qualification permission request: ${behavior === "allow" ? "approve once" : "deny"}.`, "scripted-engine permission, actual provider buttons");
        await wait("actual engine permission request", () => buttonDecisions(harness!.data).slice(decisionsBefore),
          records => records.some(record => record.phase === "requested"), 60_000, 250);
        const newRuns = (await runs()).filter((run: any) => !before.runs.has(String(run.id)));
        if (newRuns.length !== 1 || buttonTaskProblems(harness.data, chief.id, newRuns[0]).length)
          throw new LiveStop("permission request task is not the policy-pinned fixture task");
        const requested = buttonDecisions(harness.data).slice(decisionsBefore);
        if (requested.length !== 1 || requested[0].phase !== "requested") throw new LiveStop("permission resolved before the owner tap");
        if (!await attest("Did exactly one new Approve once / Deny card appear in the dedicated bot DM? Do not tap yet."))
          throw new LiveStop("operator did not confirm the exact permission card");
        cardMessages += 1;
        observeLedger();
        if (operatorTaps >= 2) throw new LiveStop("two-tap budget reached");
        operatorTaps += 1;
        process.stdout.write(`Tap ${behavior === "allow" ? "Approve once" : "Deny"} ONCE on that new card now. Do not type yes or repeat a tap.\n`);
        await wait("actual permission host decision", () => buttonDecisions(harness!.data).slice(decisionsBefore),
          records => records.some(record => record.phase === "resolved"), 600_000, 250);
        const decision = buttonDecisions(harness.data).slice(decisionsBefore);
        if (decision.length !== 2 || decision[1].id !== decision[0].id || decision[1].behavior !== behavior)
          throw new LiveStop("permission host did not receive exactly the requested decision");
        expectedOutbound += 1;
        await expectReplies(`buttons.${behavior}.reply`, "exactly one permission result reply was delivered", expectedOutbound,
          `Qualification permission ${behavior === "allow" ? "allowed once" : "denied"}; no tool was executed.`);
        if (!await attest("Did that same card update once with the decision and remove its buttons, with exactly one result reply?"))
          throw new LiveStop("operator did not confirm card settlement and result reply");
        cardEdits += 1;
        const afterRuns = (await runs()).filter((run: any) => !before.runs.has(String(run.id)));
        const safe = afterRuns.length === 1 && afterRuns[0].status === "completed" && buttonTaskProblems(harness.data, chief.id, afterRuns[0]).length === 0;
        checks.expect(`buttons.${behavior}`, "actual permission host received one provider decision without standing grants", safe,
          { decision: behavior, requestId: decision[0].id, runId: afterRuns[0]?.id, providerCards: "operator-attested", cardMessages, cardEdits, operatorTaps });
        if (!safe) throw new LiveStop("permission result or task policy differs");
      }
    }

    const demoted = await harness.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    state.chiefDemoted = demoted.status === 200;
    if (!state.chiefDemoted) throw new LiveStop(`Chief demotion refused (${demoted.status})`);
    await wait("Chief-change pause", status, adapter.stateBlocked, 60_000);
    const runsAtPause = (await runs()).length, outboundAtPause = observeLedger();
    await ownerSends("Qualification request after the Chief changed: expect no reply.", "Chief change fences intake");
    await pause(45_000);
    const replied = await attest("Did the bot reply to that last message?");
    checks.expect("A9.chief", "after the Chief change no run started and nothing was sent", (await runs()).length === runsAtPause && observeLedger() === outboundAtPause && !replied,
      { runs: (await runs()).length, runsAtPause, outbound: outbound.size, outboundAtPause, operatorSawReply: replied });

    const revoked = await harness.request("POST", adapter.revokePath, {});
    const afterRevoke = await status();
    state.revokeConfirmed = revoked.status === 200 && !adapter.statePaired(afterRevoke);
    checks.expect("A9.revoke", "revoke leaves this test installation unpaired", state.revokeConfirmed, { http: revoked.status, status: pick(afterRevoke) });
  } catch (error) {
    const reason = error instanceof LiveStop ? error.message : "unexpected runner failure";
    checks.expect("live.stopped", "the live run completed without a stop condition", false, reason);
    if (harness) {
      try { checks.observe("live.failure-receipts", "receipt identities and states retained before cleanup", {
        records: receiptDiagnostics(adapter.ledger(harness.data)),
        observed: receiptDiagnostics([...capturedReceipts.values()]),
      }); } catch { checks.observe("live.failure-receipts", "receipt identities and states retained before cleanup", "unavailable"); }
      try { checks.observe("live.failure-status", "channel status retained before cleanup", pick(await status())); }
      catch { checks.observe("live.failure-status", "channel status retained before cleanup", "unavailable"); }
    }
    if (!(error instanceof LiveStop)) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    stopCapture?.();
    const outcome = await finalizeLive({ harness, revokePath: adapter.revokePath, statusPath: adapter.statusPath, statePaired: adapter.statePaired, ...state });
    if (outcome.revoke !== "not-needed") checks.expect("stop.revoke", "cleanup revoked the pairing this run had started", outcome.revoke === "confirmed", outcome.revokeDetail);
    if (outcome.demote !== "not-needed") checks.observe("stop.demote", "best-effort fixture Chief demotion during cleanup", outcome.demote);
    checks.expect("stop.closed", "the owned server stopped and its fixture root was removed", outcome.closed, outcome.order);
    abort.dispose();
    rl.close();
  }
  checks.notRun("A3.live", "offline and startup recovery against the provider", "not safely inducible on a live connection; see rehearsal evidence");
  checks.notRun("A4.live", "receiver conflict or credential rejection", "would require a second receiver or a revoked credential");
  checks.notRun("A7.live", "provider redelivery of an accepted event", "providers control redelivery; covered by rehearsal only");
  checks.notRun("A8.live", "ambiguous outbound delivery", "cannot be forced without interfering with the provider");
  if (platform === "slack") checks.notRun("slack.ack", "Socket Mode ACK is transport receipt, not model completion", "limitation, not a check");
  if (platform === "discord") checks.notRun("discord.resume", "Gateway Resume is not durable offline history", "limitation, not a check");
  if (!descriptor) checks.notRun("model.live", "real model behaviour behind the replies", "fake Claude engine selected (no engine.descriptorFile): channel mechanics only");
  const leaked = scanForSecrets(evidenceDir, [...Object.values(secrets), ...Object.values(engine?.env ?? {})]);
  checks.expect("custody.evidence", "no credential bytes appear in evidence or server logs", leaked.length === 0, leaked.length);
  return finish(platform, "live", evidenceDir, checks.list, started, { provider: `live ${platform}`,
    engine: engine ? redactEngine(engine) : "fake Claude CLI (model behaviour not qualified)", operatorMessages, outbound: outbound.size, buttonPilot: buttons ? { tier: "scripted-engine/live-provider", cardMessages, cardEdits, operatorTaps, cardEvidence: "operator attestations" } : "not requested" });
}

// ── Entry ───────────────────────────────────────────────────────────────────

const USAGE = `usage:
  channel-live-providers.ts plan     --platform telegram|slack|discord --inputs FILE
  channel-live-providers.ts rehearse --platform slack|discord
  channel-live-providers.ts run      --platform telegram|slack|discord --inputs FILE --authority TEXT [--buttons yes]
`;

export async function qualifyProvider(command: "plan" | "rehearse" | "run", platform: Platform, flags: Record<string, string | undefined>): Promise<number> {
  if (command === "plan") {
    if (!flags.inputs) { process.stderr.write(USAGE); return 2; }
    try {
      const { plan, manifest } = loadManifestFile(flags.inputs, { repoRoot: ROOT });
      const problems = buttonPilotProblems(platform, manifest.limits, flags.buttons);
      if (problems.length) { process.stderr.write(problems.join("; ") + "\n"); return 2; }
      if (plan.platform !== platform) { process.stderr.write("--platform does not match the inputs file\n"); return 2; }
      process.stdout.write(JSON.stringify({ plan, steps: planSteps(platform, plan.engine, flags.buttons === "yes"), buttonBudget: flags.buttons === "yes" ? { ...BUTTON_BUDGET[platform], taps: 2, cardEdits: 2, maxMinutes: 30 } : undefined, notRunLive: ["offline/startup recovery", "receiver conflict/auth rejection", "provider redelivery", "ambiguous outbound delivery"] }, null, 2) + "\n");
      return 0;
    } catch (error) { process.stderr.write(`${error instanceof ManifestError ? error.message : "inputs could not be validated"}\n`); return 2; }
  }
  if (command === "rehearse") {
    if (platform === "telegram") { process.stderr.write("Telegram rehearsal: node --experimental-strip-types scripts/channel-live-qualify.ts rehearse --platform telegram\n"); return 2; }
    const spec = platform === "slack" ? slackSpec() : discordSpec();
    const evidenceDir = mkdtempSync(join(tmpdir(), `murage-channel-live-evidence-${platform}-rehearse-`));
    process.stdout.write(`evidence ${evidenceDir}\n`);
    const started = Date.now();
    const checks = await rehearseChannel(spec, evidenceDir);
    return finish(platform, "rehearsal", evidenceDir, checks, started, { provider: `scripted ${platform} SDK stand-in`, engine: "fake Claude CLI" });
  }
  if (command === "run") return runLive(platform, flags);
  process.stderr.write(USAGE); return 2;
}

function planSteps(platform: Platform, engine: RedactedEngine | "fake Claude CLI" = "fake Claude CLI", buttons = false) {
  const real = typeof engine !== "string";
  return [
    "check the credentials offline: file custody, token shape, token-derived identity equals the manifest, denylist",
    `launch an isolated source server in its own process group (temporary HOME/data, no preload, ${typeof engine === "string" ? "fake Claude engine" : `only the admitted engine ${engine.instanceId} (${engine.driver}, model ${engine.model})`})`,
    ...(real ? ["STOP unless /api/instances describes exactly the admitted, available, non-fake engine with its catalog model (checked again after restart)"] : []),
    "promote the fixture bot to workspace Chief",
    "save credentials through external secret storage; confirm saved is not paired",
    "request a pairing code; STOP unless the provider identity equals the manifest",
    `operator sends ${platform === "slack" ? "pair" : "/pair"} CODE from the dedicated owner; STOP unless the bound owner/DM equals the manifest`,
    "confirm exactly one delivered pairing acknowledgement",
    ...(platform === "telegram" ? [] : ["operator sends 'yes'; confirm exactly one review reply and no run"]),
    "link the paired owner's channel account to the workspace owner in the isolated data (no operator message); STOP unless exactly one active binding exists",
    real ? "operator sends request one; confirm exactly one completed admitted-engine run on a task pinned to that engine, and exactly one delivered reply equal to its output"
      : "operator sends request one; confirm exactly one run and one delivered reply",
    "same-data restart; STOP unless identity and binding are unchanged",
    real ? `operator sends request two; confirm exactly one more admitted-engine run and its delivered reply (at most ${LIVE_MODEL_RUNS} model runs in total)`
      : "operator sends request two; confirm exactly one more run and delivered reply",
    ...(buttons ? ["stop the server, replace only its isolated engine catalog with the permission fixture, restart the same binding; no more real model credentials or turns", "pin Chief defaults and each new permission task to the fixture with autoReview off, autoApprove false, no remembered grants", "operator sends two permission requests and taps Approve once then Deny once; verify actual host decisions and replies, attest exactly two cards and two edits separately"] : []),
    "demote the Chief; operator sends one more message; confirm no run and nothing sent",
    "revoke (verified); on any stop or signal: verified revoke, best-effort demotion, stop the server, remove the fixture root; scan evidence for credential bytes",
  ];
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const index = rest.indexOf(name); return index === -1 ? undefined : rest[index + 1]; };
  const platform = flag("--platform");
  if (!["plan", "rehearse", "run"].includes(String(command)) || !["telegram", "slack", "discord"].includes(String(platform))) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    process.exitCode = await qualifyProvider(command as "plan" | "rehearse" | "run", platform as Platform, { inputs: flag("--inputs"), authority: flag("--authority"), buttons: flag("--buttons") });
  }
}
