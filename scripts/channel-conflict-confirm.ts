// Bounded offline confirmation of the approved conflict recovery extension.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, promoteFixtureChief, ROOT, sleep, waitFor, type Harness } from "./channel-live-harness.ts";
import { Checks, finishCleanup } from "./channel-live-qualify.ts";
const evidence = mkdtempSync(join(tmpdir(), "murage-channel-conflict-evidence-"));
process.stdout.write(`evidence ${evidence}\n`);
let harness: Harness | undefined;
const checks = new Checks(() => harness);
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const atomic = (file: string, value: unknown) => { writeFileSync(file + ".tmp", JSON.stringify(value)); renameSync(file + ".tmp", file); };
try {
  let api = "";
  harness = await createHarness({ label: "conflict-confirm", evidenceDir: evidence, preload: join(ROOT, "scripts/channel-live-telegram-fake-api.mjs"), env: () => ({ CHANNEL_LIVE_TELEGRAM_DIR: api }) });
  api = join(harness.root, "telegram-api"); mkdirSync(api);
  const stateFile = join(harness.data, "telegram", "123.json"), connectionFile = join(harness.data, "telegram", "connection.json");
  const status = async () => (await harness!.request("GET", "/api/telegram/status")).body;
  const sent = () => lines(join(api, "sent.jsonl"));
  const requests = () => lines(join(api, "requests.jsonl"));
  const runs = async () => ((await harness!.request("GET", "/api/routines")).body?.runs ?? []).filter((run: any) => run.telegramConnectionId === "123");
  const message = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1700000000 + id, from: { id: 777, is_bot: false }, chat: { id: 777, type: "private" }, text } });
  await harness.boot(); const chief = await promoteFixtureChief(harness, "Conflict Confirmation Chief");
  const save = await harness.request("PATCH", "/api/config", { telegram: { botToken: "123:rehearsal_token_not_real_abcdefghij" } });
  const pair = await harness.request("POST", "/api/telegram/pair", {});
  if (save.status !== 200 || pair.status !== 200) throw new Error("Fixture pairing precondition failed");
  atomic(join(api, "updates.json"), [message(1, `/pair ${pair.body.code}`)]);
  await waitFor("paired", status, value => value.paired); await waitFor("pair acknowledgement", sent, value => value.length === 1);
  const binding = JSON.stringify(json(stateFile).binding), connection = readFileSync(connectionFile, "utf8");
  atomic(join(api, "faults.json"), { getUpdates: "conflict" });
  const blocked = await waitFor("receiver conflict", status, value => value.resumeState === "blocked");
  const polls = requests().length;
  atomic(join(api, "faults.json"), {}); await sleep(1800);
  checks.expect("conflict.explicit", "fault clearing alone does not restart; typed Retry is available", blocked.error === "conflict" && blocked.canResume === true && requests().length === polls);
  const denied = await harness.request("POST", "/api/telegram/resume", {}, false);
  checks.expect("retry.owner", "non-owner cannot resume", denied.status === 404 && requests().length === polls, { http: denied.status });
  const identityChecks = requests().filter(entry => entry.method === "getMe").length;
  const retry = await harness.request("POST", "/api/telegram/resume", {});
  checks.expect("retry.binding", "owner Retry freshly verifies identity and restores the exact binding/Chief", retry.status === 200 && retry.body.paired && retry.body.resumeState === "active" && !retry.body.canResume
    && JSON.stringify(json(stateFile).binding) === binding && readFileSync(connectionFile, "utf8") === connection && json(connectionFile).targetBotId === chief.id
    && requests().filter(entry => entry.method === "getMe").length === identityChecks + 1);
  const duplicate = await harness.request("POST", "/api/telegram/resume", {});
  checks.expect("retry.duplicate", "duplicate Retry is refused without another identity check", duplicate.status === 409 && requests().filter(entry => entry.method === "getMe").length === identityChecks + 1);
  atomic(join(api, "updates.json"), [message(2, "Reply once after conflict recovery.")]);
  await waitFor("one reply", sent, value => value.length >= 2, 30000);
  atomic(join(api, "updates.json"), [{ ...message(2, "Reply once after conflict recovery."), redeliver: true }]); await sleep(3200);
  checks.expect("delivery.duplicate", "recovered receiver executes and replies once despite redelivery", sent().length === 2 && (await runs()).length === 1);
  await harness.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
  await waitFor("Chief pause", status, value => value.resumeState === "blocked");
  const beforeChiefRetry = requests().length;
  const chiefRetry = await harness.request("POST", "/api/telegram/resume", {});
  checks.expect("retry.chief", "Chief-change pause refuses Retry without provider access", chiefRetry.status === 409 && !(await status()).canResume && json(connectionFile).paused === true && requests().length === beforeChiefRetry);
  await harness.request("POST", "/api/telegram/revoke", {});
  const revokedRetry = await harness.request("POST", "/api/telegram/resume", {});
  checks.expect("retry.revoked", "revoked connection refuses Retry and remains disabled", revokedRetry.status === 409 && !json(connectionFile).enabled && !(await status()).canResume && requests().length === beforeChiefRetry);
  for (const name of ["requests.jsonl", "sent.jsonl"]) copyFileSync(join(api, name), join(evidence, name));
} catch (error) { checks.expect("fixture.completed", "confirmation completed", false, { error: String(error) }); }
finally { await finishCleanup(harness, checks); }
checks.expect("cleanup.absent", "owned fixture root is absent", Boolean(harness && !existsSync(harness.root)));
const result = { mode: "offline scripted Telegram, real source server, fake Claude", node: process.version, checks: checks.list, failed: checks.list.filter(check => check.outcome === "fail").map(check => check.id) };
writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
process.stdout.write(`result ${JSON.stringify({ passed: checks.list.filter(check => check.outcome === "pass").length, failed: result.failed })}\n`);
process.exitCode = result.failed.length ? 1 : 0;
