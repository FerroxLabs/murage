#!/usr/bin/env -S node --experimental-strip-types
// B17 Telegram journeys the accepted rehearsal does not cover: the exact
// pairing confirmation, sends interrupted by quitting Murage, the channel
// person link step, and one-time permission buttons with their fences.
//
//   node --experimental-strip-types scripts/channel-telegram-journeys.ts [EVIDENCE_DIR]
//
// Offline: the real source server, the scripted Bot API stand-in and a fake
// Claude engine. Evidence of the server join only, never of Telegram, a real
// model or an installed app.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarness, promoteFixtureChief, ROOT, sleep, waitFor, type Harness } from "./channel-live-harness.ts";
import { Checks, finishCleanup } from "./channel-live-qualify.ts";

const BOT = "123", OWNER = 777, STRANGER = 888;
const TOKEN = "123:rehearsal_token_not_real_abcdefghij";
const OWNER_BINDING = JSON.stringify({ senderId: String(OWNER), chatId: String(OWNER) });
const ACK = "Telegram is paired with Murage. Before chatting, link this channel account in Murage Settings → Memory. Then send your message again.";
const REVIEW = "Review approvals in the Murage app. Telegram messages cannot approve actions.";
const REFUSED = "This approval is expired, changed, or already answered. Review it in Murage.";
const ACTION = "fixture_exact_action_no_execution";

const evidence = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "murage-telegram-journeys-evidence-"));
mkdirSync(evidence, { recursive: true, mode: 0o700 });
process.stdout.write(`evidence ${evidence}\n`);

let harness: Harness | undefined;
const checks = new Checks(() => harness);
let api = "", mode = "happy", secretDelivered = false, updateId = 0;
const updates: any[] = [];
const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const atomic = (file: string, value: unknown) => { writeFileSync(file + ".tmp", JSON.stringify(value)); renameSync(file + ".tmp", file); };
const arrive = (...values: any[]) => { updates.push(...values); atomic(join(api, "updates.json"), updates); };
const faults = (value: Record<string, string>) => atomic(join(api, "faults.json"), value);
const requests = () => lines(join(api, "requests.jsonl"));
const sent = () => lines(join(api, "sent.jsonl"));
const callbacks = () => lines(join(api, "callbacks.jsonl"));
const edits = () => lines(join(api, "edits.jsonl"));
const decisions = () => lines(join(harness!.root, "decisions.jsonl"));
const count = (method: string, fault?: string) => requests().filter(entry => entry.method === method && (fault === undefined || entry.fault === fault)).length;
const status = async () => (await harness!.request("GET", "/api/telegram/status")).body;
const channel = () => { const file = join(harness!.data, "telegram", `${BOT}.json`); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; };
const record = (id: number) => channel()?.records.find((item: any) => item.updateId === id);
const runs = async () => ((await harness!.request("GET", "/api/routines")).body?.runs ?? []).filter((run: any) => run.telegramConnectionId === BOT);
const settle = () => sleep(4_000); // more than two receive cycles at the service's 1.5 s cadence
const summary = (value: any) => value && { paired: value.paired, enabled: value.enabled, resumeState: value.resumeState, error: value.error, pending: value.pending,
  uncertain: value.uncertain, rejected: value.rejected, deliveryError: value.deliveryError, humanBindingState: value.humanBindingState };
const message = (from: number, text: string) => ({ update_id: ++updateId, message: { message_id: updateId, date: 1_700_000_000 + updateId, text,
  from: { id: from, is_bot: false }, chat: { id: from, type: "private" } } });
const tap = (from: number, messageId: number, data: string) => ({ update_id: ++updateId, callback_query: { id: `callback-${updateId}`, data,
  from: { id: from, is_bot: false }, message: { message_id: messageId, date: 1_700_000_000 + updateId, chat: { id: from, type: "private" } } } });
const consumed = (id: number) => waitFor(`update ${id} consumed`, requests, list => list.some(entry => entry.method === "getUpdates" && entry.offset > id && !entry.fault), 30_000);

async function pair(label: string): Promise<string> {
  const response = await harness!.request("POST", "/api/telegram/pair", {});
  if (response.status !== 200 || typeof response.body?.code !== "string") throw new Error(`${label}: pairing refused ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.code;
}
async function linkOwner() {
  const humans = await harness!.request("POST", "/api/memory/action", { action: "humans" });
  const binding = humans.body?.bindings?.find((item: any) => item.active && item.origin?.platform === "telegram" && item.origin?.userId === String(OWNER));
  if (!binding) throw new Error(`no active Telegram channel person: ${humans.status} ${JSON.stringify(humans.body)?.slice(0, 400)}`);
  const linked = await harness!.request("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
  if (linked.status !== 200 || linked.body?.personId !== "workspace-owner") throw new Error(`owner link refused ${linked.status} ${JSON.stringify(linked.body)}`);
  return { stateBefore: binding.state as string, revision: linked.body.revision as number };
}
async function pendingCards(chiefId: string) {
  const bot = (await harness!.request("GET", "/api/bots")).body.bots.find((item: any) => item.id === chiefId);
  const found: Array<{ threadId: string; message: any }> = [];
  for (const threadId of new Set<string>([bot.threadId, ...(bot.tasks ?? []).map((task: any) => task.threadId)])) {
    for (const item of (await harness!.request("GET", `/api/threads/${threadId}/messages`)).body?.messages ?? []) {
      if (item.card?.requestId && !item.card.answered && !item.card.dismissed) found.push({ threadId, message: item });
    }
  }
  return found;
}
async function cardState(threadId: string, id: string) {
  return ((await harness!.request("GET", `/api/threads/${threadId}/messages`)).body?.messages ?? []).find((item: any) => item.id === id)?.card ?? null;
}
async function requestApproval(label: string) {
  const before = sent().length;
  const ask = message(OWNER, `${label}: request the fictional action and ask for approval.`);
  arrive(ask);
  const offer: any = await waitFor(`${label} permission buttons`, () => sent().slice(before).find(item => item.keyboard), (value: any) => Boolean(value), 60_000);
  const buttons: Array<{ text: string; callback_data: string }> = offer.keyboard.flat();
  return { ask, offer, buttons };
}
async function restartActive(label: string) {
  const exit = await harness!.restart();
  await waitFor(label, status, value => value.paired === true && value.resumeState === "active", 30_000);
  return exit;
}

try {
  harness = await createHarness({ label: "telegram-journeys", evidenceDir: evidence, preload: join(ROOT, "scripts", "channel-live-telegram-fake-api.mjs"),
    env: () => ({ CHANNEL_LIVE_TELEGRAM_DIR: api, FAKE_CLAUDE_MODE: mode, FAKE_PERMISSION_DECISIONS: join(harness!.root, "decisions.jsonl") }),
    secretEnv: (): Record<string, string> => secretDelivered ? { MURAGE_TELEGRAM_BOT_TOKEN: TOKEN } : {} });
  api = join(harness.root, "telegram-api");
  mkdirSync(api, { mode: 0o700 });
  // A permission-mode copy of the established fake CLI in the task-owned root,
  // exactly as scripts/channel-permission-rehearsal.ts extends it.
  const fixtureCli = join(harness.root, "permission-claude.ts");
  const source = readFileSync(join(ROOT, "server", "testing", "fake-claude-cli.ts"), "utf8");
  const anchor = '  if (mode === "ask-user-question" || fixtureRequested(promptText(prompt), "__fixture_ask_user_question__")) {';
  if (source.split(anchor).length !== 2) throw new Error("fake CLI insertion anchor must be unique");
  writeFileSync(fixtureCli, source.replace(anchor, `  if (mode === "channel-permission") {
    void (async () => {
      const input = { command: "${ACTION}" };
      const reply = await callPermissionPromptTool({ tool_name: "Bash", input, tool_use_id: "fixture-permission", permission_suggestions: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash" }] }] });
      if (!reply) throw new Error("Missing permission prompt tool");
      const decision = JSON.parse(reply);
      appendFileSync(process.env.FAKE_PERMISSION_DECISIONS!, JSON.stringify({ decision }) + "\\n");
      out({ type: "assistant", message: { content: [{ type: "text", text: "Fixture decision: " + decision.behavior + "; no action executed" }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 });
      turnRunning = false;
      finishIfDone();
    })();
    return;
  }
` + anchor));
  chmodSync(fixtureCli, 0o700);
  const configPath = join(harness.data, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.fixtureClaude.config.cli = fixtureCli;
  writeFileSync(configPath, JSON.stringify(config));

  await harness.boot();
  const chief = await promoteFixtureChief(harness, "Journey Chief", undefined, { autoReview: "off", autoApprove: false, alwaysAllow: [] });
  const saved = await harness.request("PATCH", "/api/config?secretStorage=external", { telegram: { botToken: TOKEN } });
  if (saved.status !== 200) throw new Error(`token save refused ${saved.status}`);
  secretDelivered = true;

  // Pairing confirmation: one definite 429, then delivered exactly once.
  let code = await pair("first pairing");
  faults({ sendMessage: "rate-limit" });
  const firstPair = message(OWNER, `/pair ${code}`);
  arrive(firstPair);
  await waitFor("rate-limited confirmation attempt", () => count("sendMessage", "rate-limit"), value => value >= 1, 30_000, 100);
  faults({});
  await waitFor("confirmation delivered", sent, list => list.length >= 1, 30_000);
  await settle();
  checks.expect("ack.exact-once", "after one definite 429 the pairing confirmation is retried and delivered exactly once, to the owner chat, with the exact text",
    sent().length === 1 && sent()[0].chatId === String(OWNER) && sent()[0].text === ACK && count("sendMessage") === 2 && count("sendMessage", "rate-limit") === 1
      && record(firstPair.update_id)?.state === "sent" && (await status()).uncertain === 0 && (await runs()).length === 0 && JSON.stringify(channel()?.binding) === OWNER_BINDING,
    { sent: sent(), attempts: count("sendMessage"), record: record(firstPair.update_id), status: summary(await status()) });
  arrive({ ...firstPair, redeliver: true });
  await settle();
  checks.expect("ack.duplicate-pair", "a redelivered pairing update sends no second confirmation, starts no run and keeps the binding",
    sent().length === 1 && count("sendMessage") === 2 && (await runs()).length === 0 && JSON.stringify(channel()?.binding) === OWNER_BINDING, { sent: sent().length, attempts: count("sendMessage") });
  updates.splice(updates.findIndex(update => update.redeliver === true), 1);
  atomic(join(api, "updates.json"), updates);

  // The channel person link step that now precedes any channel work.
  const unlinked = message(OWNER, "Message before this channel account is linked.");
  arrive(unlinked);
  await waitFor("link guidance", sent, list => list.length >= 2, 30_000);
  await settle();
  const unlinkedStatus = await status();
  checks.expect("link.required", "a paired but unlinked channel account gets link guidance once and no run starts",
    sent().length === 2 && String(sent()[1].text).startsWith("Link this channel account") && (await runs()).length === 0 && unlinkedStatus.humanBindingState === "link-required",
    { reply: sent()[1], status: summary(unlinkedStatus) });
  const firstLink = await linkOwner();
  const linkedAsk = message(OWNER, "First linked request: reply once.");
  arrive(linkedAsk);
  await waitFor("linked reply", sent, list => list.length >= 3, 45_000);
  await settle();
  checks.expect("link.owner", "after the owner links the account, one message creates one run and one reply",
    firstLink.stateBefore === "link-required" && (await runs()).length === 1 && sent().length === 3 && sent()[2].text === "hello from fake claude"
      && (await status()).humanBindingState === "linked", { link: firstLink, runs: (await runs()).length, reply: sent()[2] });

  // Quitting Murage while a reply is sending.
  faults({ sendMessage: "hang" });
  const interrupted = message(OWNER, "Request whose reply is interrupted by quitting Murage.");
  arrive(interrupted);
  await waitFor("reply sending", () => record(interrupted.update_id)?.state, state => state === "sending", 60_000, 100);
  const runsAtQuit = (await runs()).length, sendsAtQuit = count("sendMessage");
  const quitDuringReply = await harness.stop();
  faults({});
  await harness.boot();
  await waitFor("resumed after reply interruption", status, value => value.paired === true && value.resumeState === "active", 30_000);
  await settle();
  const afterReplyQuit = await status();
  checks.expect("reply.interrupted", "quitting Murage while a reply is sending leaves it uncertain: attempted once, never resent after restart, and the run is not repeated",
    quitDuringReply.exitCode === 0 && record(interrupted.update_id)?.state === "uncertain" && count("sendMessage") === sendsAtQuit && count("sendMessage", "hang") === 1
      && (await runs()).length === runsAtQuit && afterReplyQuit.uncertain === 1 && sent().length === 3,
    { exit: quitDuringReply, record: record(interrupted.update_id), attempts: count("sendMessage") - sendsAtQuit, runs: (await runs()).length, status: summary(afterReplyQuit) });
  const afterInterruption = message(OWNER, "Request after the interrupted reply.");
  arrive(afterInterruption);
  await waitFor("reply after interruption", sent, list => list.length >= 4, 45_000);
  await settle();
  checks.expect("reply.after-interruption", "the next owner message after the interrupted reply creates exactly one run and one reply",
    (await runs()).length === runsAtQuit + 1 && sent().length === 4 && record(afterInterruption.update_id)?.state === "sent", { runs: (await runs()).length, sent: sent().length });

  // Quitting Murage while the pairing confirmation is sending.
  const firstRevoke = await harness.request("POST", "/api/telegram/revoke", {});
  if (firstRevoke.status !== 200) throw new Error(`revoke refused ${firstRevoke.status}`);
  const uncertainBeforeAckQuit = channel()?.records.filter((item: any) => item.state === "uncertain").length ?? 0;
  code = await pair("second pairing");
  faults({ sendMessage: "hang" });
  const secondPair = message(OWNER, `/pair ${code}`);
  arrive(secondPair);
  await waitFor("confirmation sending", () => record(secondPair.update_id)?.state, state => state === "sending", 60_000, 100);
  const sendsAtAckQuit = count("sendMessage"), runsAtAckQuit = (await runs()).length;
  const quitDuringAck = await harness.stop();
  faults({});
  await harness.boot();
  const resumedAfterAck = await waitFor("resumed after confirmation interruption", status, value => value.paired === true && value.resumeState === "active", 30_000);
  await settle();
  checks.expect("ack.interrupted", "quitting Murage while the pairing confirmation is sending keeps the pairing, marks the confirmation uncertain and never resends it",
    quitDuringAck.exitCode === 0 && record(secondPair.update_id)?.state === "uncertain" && JSON.stringify(channel()?.binding) === OWNER_BINDING
      && count("sendMessage") === sendsAtAckQuit && sent().length === 4 && (await runs()).length === runsAtAckQuit
      && (channel()?.records.filter((item: any) => item.state === "uncertain").length ?? 0) === uncertainBeforeAckQuit + 1,
    { exit: quitDuringAck, record: record(secondPair.update_id), attempts: count("sendMessage") - sendsAtAckQuit, status: summary(resumedAfterAck) });

  // Inject a DNS-shaped error to study the retained live symptom; this does
  // not establish the live cause or exercise a real DNS lookup.
  await harness.request("POST", "/api/telegram/revoke", {});
  code = await pair("third pairing");
  faults({ sendMessage: "dns" });
  const thirdPair = message(OWNER, `/pair ${code}`);
  arrive(thirdPair);
  await waitFor("confirmation network failure", () => record(thirdPair.update_id)?.state, state => state !== undefined && !["accepted", "sending"].includes(state), 30_000, 100);
  const dnsAttempts = count("sendMessage", "dns"), sendsAtDnsRecovery = count("sendMessage"), acksAtDnsRecovery = sent().filter(item => item.text === ACK).length;
  faults({});
  await sleep(8_000);
  checks.observe("ack.network-failure", "pairing confirmation after an injected ENOTFOUND/getaddrinfo fetch error (no real DNS or Telegram request)", {
    record: record(thirdPair.update_id), attemptsDuringFailure: dnsAttempts, attemptsAfterRecovery: count("sendMessage") - sendsAtDnsRecovery,
    confirmationsDeliveredAfterRecovery: sent().filter(item => item.text === ACK).length - acksAtDnsRecovery, status: summary(await status()) });
  checks.observe("link.after-repair", "channel person link state after revoking and pairing the same owner again", { humanBindingState: (await status()).humanBindingState });

  // One-time permission buttons.
  await linkOwner();
  mode = "channel-permission";
  await restartActive("resumed in permission mode");
  const allow = await requestApproval("Allow");
  const [approveButton, denyButton] = allow.buttons;
  const allowCards = await pendingCards(chief.id);
  checks.expect("approval.offer", "one exact pending action is offered as Approve once / Deny with its full action details",
    allow.buttons.map(button => button.text).join("|") === "Approve once|Deny" && String(allow.offer.text).includes(ACTION) && String(allow.offer.text).includes("Approve once or deny this exact action")
      && allowCards.length === 1 && decisions().length === 0,
    { offer: { text: allow.offer.text, buttons: allow.buttons.map(button => button.text), messageId: allow.offer.messageId }, cards: allowCards.map(card => ({ threadId: card.threadId, id: card.message.id, tool: card.message.card.tool })) });
  const callbacksBeforeForeign = callbacks().length;
  const strangerTap = tap(STRANGER, allow.offer.messageId, approveButton.callback_data);
  const wrongMessageTap = tap(OWNER, allow.offer.messageId + 100, approveButton.callback_data);
  arrive(strangerTap, wrongMessageTap);
  await consumed(wrongMessageTap.update_id);
  await settle();
  const foreignAnswers = callbacks().slice(callbacksBeforeForeign);
  checks.expect("approval.foreign", "a stranger's tap is ignored and a tap on a different message is refused; neither reaches the engine and the card stays pending",
    decisions().length === 0 && foreignAnswers.length === 1 && foreignAnswers[0].callbackId === wrongMessageTap.callback_query.id && foreignAnswers[0].text === REFUSED
      && (await pendingCards(chief.id)).length === 1, { foreignAnswers });
  const sentBeforeYes = sent().length, runsBeforeYes = (await runs()).length;
  arrive(message(OWNER, "yes"));
  await waitFor("text approval guidance", sent, list => list.length > sentBeforeYes, 30_000);
  await settle();
  checks.expect("approval.text-yes", "a plain 'yes' gets in-app review guidance, starts no run and never approves",
    decisions().length === 0 && sent().slice(sentBeforeYes).some(item => item.text === REVIEW) && (await pendingCards(chief.id)).length === 1 && (await runs()).length === runsBeforeYes,
    { replies: sent().slice(sentBeforeYes).map(item => item.text) });
  const allowTap = tap(OWNER, allow.offer.messageId, approveButton.callback_data);
  arrive(allowTap);
  const afterAllow = await waitFor("one allow decision", decisions, list => list.length >= 1, 30_000);
  await waitFor("allow tap answered", callbacks, list => list.some(entry => entry.callbackId === allowTap.callback_query.id), 20_000);
  await waitFor("allow buttons cleared", edits, list => list.some(entry => entry.messageId === allow.offer.messageId && Array.isArray(entry.keyboard) && entry.keyboard.length === 0), 20_000);
  await waitFor("allow reply", sent, list => list.some(item => String(item.text).includes("Fixture decision: allow")), 45_000);
  const allowCard = await cardState(allowCards[0].threadId, allowCards[0].message.id);
  checks.expect("approval.allow-once", "Approve once reaches the engine exactly once as allow without a standing grant, answers the tap, clears the buttons, resolves the same card and delivers the reply",
    afterAllow.length === 1 && afterAllow[0].decision.behavior === "allow" && afterAllow[0].decision.updatedPermissions === undefined
      && callbacks().find(entry => entry.callbackId === allowTap.callback_query.id)?.text === "Allowed once." && Boolean(allowCard?.answered),
    { decision: afterAllow[0], answer: callbacks().find(entry => entry.callbackId === allowTap.callback_query.id), card: allowCard && { answered: allowCard.answered } });
  const repeatAllow = tap(OWNER, allow.offer.messageId, approveButton.callback_data), lateDeny = tap(OWNER, allow.offer.messageId, denyButton.callback_data);
  arrive(repeatAllow, lateDeny);
  await waitFor("repeated taps answered", callbacks, list => [repeatAllow, lateDeny].every(item => list.some(entry => entry.callbackId === item.callback_query.id)), 20_000);
  await settle();
  checks.expect("approval.allow-duplicate", "repeating Approve or tapping Deny after it reports the recorded outcome and never reaches the engine again",
    decisions().length === 1 && [repeatAllow, lateDeny].every(item => callbacks().find(entry => entry.callbackId === item.callback_query.id)?.text === "Allowed once."),
    { answers: callbacks().slice(-2) });

  const deny = await requestApproval("Deny");
  const denyCards = await pendingCards(chief.id);
  const denyTap = tap(OWNER, deny.offer.messageId, deny.buttons[1].callback_data);
  arrive(denyTap);
  const afterDeny = await waitFor("one deny decision", decisions, list => list.length >= 2, 30_000);
  await waitFor("deny reply", sent, list => list.some(item => String(item.text).includes("Fixture decision: deny")), 45_000);
  const repeatDeny = tap(OWNER, deny.offer.messageId, deny.buttons[1].callback_data);
  arrive(repeatDeny);
  await waitFor("repeated deny answered", callbacks, list => list.some(entry => entry.callbackId === repeatDeny.callback_query.id), 20_000);
  await settle();
  const denyCard = denyCards.length === 1 ? await cardState(denyCards[0].threadId, denyCards[0].message.id) : null;
  checks.expect("approval.deny", "Deny reaches the engine exactly once as deny, answers the tap, clears the buttons, resolves the card, and a repeat is not delivered",
    denyCards.length === 1 && afterDeny.length === 2 && afterDeny[1].decision.behavior === "deny" && decisions().length === 2
      && callbacks().find(entry => entry.callbackId === denyTap.callback_query.id)?.text === "Denied." && callbacks().find(entry => entry.callbackId === repeatDeny.callback_query.id)?.text === "Denied."
      && edits().some(entry => entry.messageId === deny.offer.messageId && Array.isArray(entry.keyboard) && entry.keyboard.length === 0) && Boolean(denyCard?.answered),
    { decision: afterDeny[1], cards: denyCards.length, card: denyCard && { answered: denyCard.answered } });

  const beforeRestart = await requestApproval("Restart");
  const decisionsBeforeRestart = decisions().length;
  await restartActive("resumed after offer restart");
  const staleTap = tap(OWNER, beforeRestart.offer.messageId, beforeRestart.buttons[0].callback_data);
  arrive(staleTap);
  await consumed(staleTap.update_id);
  await settle();
  checks.expect("approval.restart-fence", "a button offered before a restart is refused afterwards and never reaches the engine",
    decisions().length === decisionsBeforeRestart && callbacks().find(entry => entry.callbackId === staleTap.callback_query.id)?.text === REFUSED,
    { answer: callbacks().find(entry => entry.callbackId === staleTap.callback_query.id), pendingCards: (await pendingCards(chief.id)).length, status: summary(await status()) });

  const beforeChiefChange = await requestApproval("Chief change");
  const decisionsBeforeChief = decisions().length, callbacksBeforeChief = callbacks().length;
  const demoted = await harness.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
  await waitFor("Chief-change pause", status, value => value.resumeState === "blocked", 20_000);
  const chiefTap = tap(OWNER, beforeChiefChange.offer.messageId, beforeChiefChange.buttons[0].callback_data);
  arrive(chiefTap);
  await settle();
  checks.expect("approval.chief-change-fence", "after the Chief changes, a delivered Approve tap is not received, answered or sent to the engine",
    demoted.status === 200 && decisions().length === decisionsBeforeChief && callbacks().length === callbacksBeforeChief
      && !requests().some(entry => entry.method === "getUpdates" && entry.offset > chiefTap.update_id), { status: summary(await status()) });
  await harness.request("POST", "/api/telegram/revoke", {});

  for (const name of ["requests.jsonl", "sent.jsonl", "callbacks.jsonl", "edits.jsonl"]) if (existsSync(join(api, name))) copyFileSync(join(api, name), join(evidence, `telegram-${name}`));
  if (existsSync(join(harness.root, "decisions.jsonl"))) copyFileSync(join(harness.root, "decisions.jsonl"), join(evidence, "engine-decisions.jsonl"));
  const finalChannel = channel();
  if (finalChannel) writeFileSync(join(evidence, "telegram-channel-records.json"), JSON.stringify(finalChannel.records.map((item: any) => ({ updateId: item.updateId, state: item.state, sendAttempts: item.sendAttempts, deliveryError: item.deliveryError })), null, 2));
} catch (error) {
  checks.expect("fixture.completed", "the journeys reached their final step", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await finishCleanup(harness, checks);
}
checks.expect("cleanup.absent", "the owned fixture root is absent", Boolean(harness && !existsSync(harness.root)));
const leaked: string[] = [];
const scan = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path);
    else if (readFileSync(path).includes(TOKEN)) leaked.push(path);
  }
};
scan(evidence);
checks.expect("custody.evidence", "no token bytes appear in evidence or server logs", leaked.length === 0, leaked);
const result = { mode: "offline scripted Telegram Bot API, real source server, fake Claude", node: process.version, checks: checks.list,
  failed: checks.list.filter(check => check.outcome === "fail").map(check => check.id), observed: checks.list.filter(check => check.outcome === "observed").map(check => check.id) };
writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(`result ${JSON.stringify({ passed: checks.list.filter(check => check.outcome === "pass").length, failed: result.failed, observed: result.observed })}\n`);
process.exitCode = result.failed.length ? 1 : 0;
