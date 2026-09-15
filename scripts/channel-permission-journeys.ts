#!/usr/bin/env -S node --experimental-strip-types
// Slack and Discord permission-button journeys on the current candidate: the
// channel person link step, then Approve once / Deny through the actual
// adapters with their fences (wrong user, DM or message, plain "yes", repeat
// taps, a card answered in the app, restart, Chief change, revoke).
//
//   node --experimental-strip-types scripts/channel-permission-journeys.ts [EVIDENCE_DIR]
//
// Offline: the real source server and permission broker, the existing SDK IPC
// stand-ins and a fake Claude engine. Not provider, model or installed-app proof.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarness, promoteFixtureChief, ROOT, sleep, waitFor, type Harness } from "./channel-live-harness.ts";
import { Checks, finishCleanup } from "./channel-live-qualify.ts";
import { discordPrompt } from "../server/channels/discord/event.ts";
import { slackPrompt } from "../server/channels/slack/event.ts";

type Provider = "discord" | "slack";
const ACTION = "fixture_exact_action_no_execution";
const LINK = "Link this channel account";
const SECRETS: Record<Provider, Record<string, string>> = {
  discord: { MURAGE_DISCORD_BOT_TOKEN: "discord-fixture-private-not-real" },
  slack: { MURAGE_SLACK_APP_TOKEN: "xapp-fixture-private-not-real", MURAGE_SLACK_BOT_TOKEN: "xoxb-fixture-private-not-real" },
};
const evidence = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "murage-channel-permission-journeys-evidence-"));
mkdirSync(evidence, { recursive: true, mode: 0o700 });
process.stdout.write(`evidence ${evidence}\n`);
const report: unknown[] = [];
const allChecks: unknown[] = [];

for (const provider of ["discord", "slack"] as const) {
  const folder = join(evidence, provider);
  let harness: Harness | undefined;
  const checks = new Checks(() => harness);
  const expect = (id: string, criterion: string, ok: boolean, detail?: unknown) => checks.expect(`${provider}.${id}`, criterion, ok, detail);
  const traces: any[] = [];
  let delivered = false, sequence = 200;
  const ownerId = provider === "discord" ? "13" : "UOWNER", dmId = provider === "discord" ? "14" : "DOWNER";
  const otherUser = provider === "discord" ? "99" : "UOTHER", otherDm = provider === "discord" ? "15" : "DOTHER", otherMessage = provider === "discord" ? "999999" : "999.999";
  const textGuidance = (provider === "discord" ? discordPrompt("yes") : slackPrompt("yes")).response!;
  const decisionsFile = () => join(harness!.root, "decisions.jsonl");
  const decisions = () => existsSync(decisionsFile()) ? readFileSync(decisionsFile(), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const status = async () => (await harness!.request("GET", `/api/${provider}/status`)).body;
  const sends = (from = 0) => traces.slice(from).filter(trace => trace.op === "send");
  const acked = (eventId: string) => traces.some(trace => trace.op === "action-ack" && trace.eventId === eventId);
  const edited = (messageId: string, from = 0) => traces.slice(from).some(trace => trace.op === "edit" && trace.messageId === messageId);
  const sendMessage = (text: string) => {
    const id = String(sequence++);
    harness!.child()!.send(provider === "discord" ? { kind: "discord-fixture-event", body: {
      id, channelId: dmId, channel: { type: 1 }, author: { id: ownerId, bot: false }, guildId: null,
      webhookId: null, type: 0, content: text, createdTimestamp: Date.now(), attachments: { size: 0 }, components: [],
    } } : { kind: "slack-fixture-event", body: {
      type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: `Ev${id}`, event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: dmId, user: ownerId, text },
    } });
  };
  const click = (messageId: string, actionId: string, override: { user?: string; dm?: string } = {}) => {
    const eventId = `click${sequence++}`, user = override.user ?? ownerId, dm = override.dm ?? dmId;
    harness!.child()!.send(provider === "discord" ? { kind: "discord-fixture-action", eventId, body: {
      guildId: null, channel: { type: 1 }, applicationId: "11", message: { id: messageId, author: { id: "12" } },
      user: { id: user, bot: false }, channelId: dm, customId: actionId,
    } } : { kind: "slack-fixture-action", eventId, body: {
      type: "block_actions", api_app_id: "APP", team: { id: "TEAM" }, user: { id: user }, channel: { id: dm },
      message: { ts: messageId, user: "UBOT", bot_id: "BOT" }, container: { type: "message", channel_id: dm, message_ts: messageId },
      actions: [{ type: "button", action_id: actionId }],
    } });
    return eventId;
  };
  const controls = (send: any): Array<{ label: string; id: string }> => provider === "discord"
    ? send.components[0].components.map((control: any) => ({ label: control.label, id: control.custom_id }))
    : send.blocks.find((block: any) => block.type === "actions").elements.map((control: any) => ({ label: control.text.text, id: control.action_id }));
  const pendingCards = async (chiefId: string) => {
    const bot = (await harness!.request("GET", "/api/bots")).body.bots.find((item: any) => item.id === chiefId);
    const found: Array<{ threadId: string; message: any }> = [];
    for (const threadId of new Set<string>([bot.threadId, ...(bot.tasks ?? []).map((task: any) => task.threadId)])) {
      for (const item of (await harness!.request("GET", `/api/threads/${threadId}/messages`)).body?.messages ?? []) {
        if (item.card?.requestId && !item.card.answered && !item.card.dismissed) found.push({ threadId, message: item });
      }
    }
    return found;
  };
  const cardState = async (threadId: string, id: string) => ((await harness!.request("GET", `/api/threads/${threadId}/messages`)).body?.messages ?? []).find((item: any) => item.id === id)?.card ?? null;
  const requestApproval = async (label: string) => {
    const from = traces.length;
    sendMessage(`${label}: request the fictional action and ask for approval.`);
    const offer: any = await waitFor(`${label} permission buttons`, () => sends(from).find(trace => trace.components?.length || trace.blocks?.some((block: any) => block.type === "actions")), (value: any) => Boolean(value), 60_000);
    return { offer, buttons: controls(offer), from };
  };
  const linkOwner = async () => {
    const humans = await harness!.request("POST", "/api/memory/action", { action: "humans" });
    const binding = humans.body?.bindings?.find((item: any) => item.active && item.origin?.platform === provider && item.origin?.userId === ownerId);
    if (!binding) throw new Error(`no active ${provider} channel person: ${humans.status} ${JSON.stringify(humans.body)?.slice(0, 400)}`);
    const linked = await harness!.request("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
    if (linked.status !== 200 || linked.body?.personId !== "workspace-owner") throw new Error(`owner link refused ${linked.status} ${JSON.stringify(linked.body)}`);
    return binding.state as string;
  };
  try {
    harness = await createHarness({ label: `permission-journeys-${provider}`, evidenceDir: folder, ipc: true,
      preload: join(ROOT, "server", "testing", `${provider}-sdk-preload.mjs`),
      env: () => ({ FAKE_CLAUDE_MODE: "channel-permission", FAKE_PERMISSION_DECISIONS: decisionsFile() }),
      secretEnv: (): Record<string, string> => delivered ? SECRETS[provider] : {} });
    harness.onMessage(value => { if ((value as any)?.kind === `${provider}-fixture`) { traces.push(value); harness!.record("sdk", value); } });
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
    const chief = await promoteFixtureChief(harness, `Fictional ${provider} journey Chief`, undefined, { autoReview: "off", autoApprove: false, alwaysAllow: [] });
    const saved = await harness.request("PATCH", "/api/config?secretStorage=external", provider === "discord"
      ? { discord: { botToken: SECRETS.discord.MURAGE_DISCORD_BOT_TOKEN, applicationId: "11", ownerUserId: "13" } }
      : { slack: { appToken: SECRETS.slack.MURAGE_SLACK_APP_TOKEN, botToken: SECRETS.slack.MURAGE_SLACK_BOT_TOKEN, teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" } });
    if (saved.status !== 200) throw new Error(`config save refused ${saved.status} ${JSON.stringify(saved.body)}`);
    delivered = true;
    const pairing = await harness.request("POST", `/api/${provider}/pair`, { targetBotId: chief.id });
    if (pairing.status !== 200) throw new Error(`pairing refused ${pairing.status} ${JSON.stringify(pairing.body)}`);
    const pairFrom = traces.length;
    sendMessage("/pair " + pairing.body.code);
    await waitFor("paired", status, value => value.paired === true);
    await waitFor("pairing confirmation", () => sends(pairFrom), list => list.length >= 1, 30_000);

    const unlinkedFrom = traces.length;
    sendMessage("Message before this channel account is linked.");
    await waitFor("link guidance", () => sends(unlinkedFrom), list => list.length >= 1, 30_000);
    await sleep(3_000);
    expect("link.required", "a paired but unlinked channel account gets link guidance, no card and no engine decision",
      sends(unlinkedFrom).length === 1 && String(sends(unlinkedFrom)[0].text).includes(LINK) && decisions().length === 0 && (await pendingCards(chief.id)).length === 0,
      { replies: sends(unlinkedFrom).map(item => item.text) });
    const stateBeforeLink = await linkOwner();

    const allow = await requestApproval("Allow");
    const [approve, deny] = allow.buttons;
    const allowCards = await pendingCards(chief.id);
    expect("approval.offer", "one exact pending action is offered as Approve once / Deny with its full action details",
      stateBeforeLink === "link-required" && allow.buttons.map(button => button.label).join("|") === "Approve once|Deny" && String(allow.offer.text).includes(ACTION)
        && allowCards.length === 1 && decisions().length === 0,
      { buttons: allow.buttons.map(button => button.label), cards: allowCards.length, stateBeforeLink });
    const foreignFrom = traces.length;
    const foreign = [click(allow.offer.messageId, approve.id, { user: otherUser }), click(allow.offer.messageId, approve.id, { dm: otherDm }), click(otherMessage, approve.id)];
    await waitFor("foreign taps acknowledged", () => foreign.every(acked), Boolean, 20_000);
    await sleep(1_500);
    expect("approval.foreign", "taps from another user, another DM or on another message are acknowledged but never reach the engine, settle the card or clear its buttons",
      decisions().length === 0 && !edited(allow.offer.messageId, foreignFrom) && (await pendingCards(chief.id)).length === 1, { acknowledged: foreign.map(acked) });
    const yesFrom = traces.length;
    sendMessage("yes");
    await waitFor("text approval guidance", () => sends(yesFrom), list => list.length >= 1, 30_000);
    await sleep(2_000);
    expect("approval.text-yes", "a plain 'yes' gets in-app review guidance and never approves",
      decisions().length === 0 && sends(yesFrom).some(item => String(item.text).includes(textGuidance)) && (await pendingCards(chief.id)).length === 1,
      { replies: sends(yesFrom).map(item => item.text) });
    const allowFrom = traces.length;
    const allowTap = click(allow.offer.messageId, approve.id);
    await waitFor("allow acknowledged", () => acked(allowTap), Boolean, 20_000);
    const afterAllow = await waitFor("one allow decision", decisions, list => list.length >= 1, 30_000);
    await waitFor("allow buttons removed", () => edited(allow.offer.messageId, allowFrom), Boolean, 20_000);
    await waitFor("allow reply", () => sends(allowFrom).some(item => String(item.text).includes("Fixture decision: allow")), Boolean, 45_000);
    const allowCard = await cardState(allowCards[0].threadId, allowCards[0].message.id);
    expect("approval.allow-once", "Approve once reaches the engine exactly once as allow without a standing grant, removes the buttons, resolves the same card and delivers the reply",
      afterAllow.length === 1 && afterAllow[0].decision.behavior === "allow" && afterAllow[0].decision.updatedPermissions === undefined && Boolean(allowCard?.answered),
      { decision: afterAllow[0], answered: allowCard?.answered ?? null });
    const repeats = [click(allow.offer.messageId, approve.id), click(allow.offer.messageId, deny.id)];
    await waitFor("repeat taps acknowledged", () => repeats.every(acked), Boolean, 20_000);
    await sleep(1_500);
    expect("approval.duplicate", "repeating Approve or tapping Deny on the answered offer never reaches the engine again", decisions().length === 1, { decisions: decisions().length });

    const grant = await requestApproval("Grant consumed");
    const grantCards = await pendingCards(chief.id);
    expect("approval.grant-consumed", "after Approve once, the same action asks again with a new card and new buttons",
      grantCards.length === 1 && grantCards[0].message.id !== allowCards[0].message.id && grant.offer.messageId !== allow.offer.messageId && decisions().length === 1,
      { cards: grantCards.length, newMessage: grant.offer.messageId });
    const appFrom = traces.length;
    const answered = await harness.request("POST", `/api/threads/${grantCards[0].threadId}/respond`, { requestId: grantCards[0].message.card.requestId, behavior: "deny" });
    const afterApp = await waitFor("in-app deny decision", decisions, list => list.length >= 2, 30_000);
    await waitFor("offer settled after in-app answer", () => edited(grant.offer.messageId, appFrom), Boolean, 20_000);
    const lateTap = click(grant.offer.messageId, grant.buttons[0].id);
    await waitFor("late tap acknowledged", () => acked(lateTap), Boolean, 20_000);
    await sleep(1_500);
    expect("approval.answered-in-app", "a card answered in the app settles the channel buttons, and a later Approve tap never reaches the engine",
      answered.status === 200 && afterApp.length === 2 && afterApp[1].decision.behavior === "deny" && decisions().length === 2,
      { http: answered.status, decision: afterApp[1] ?? null });

    const denial = await requestApproval("Deny");
    const denyCards = await pendingCards(chief.id);
    const denyFrom = traces.length;
    const denyTap = click(denial.offer.messageId, denial.buttons[1].id);
    await waitFor("deny acknowledged", () => acked(denyTap), Boolean, 20_000);
    const afterDeny = await waitFor("one deny decision", decisions, list => list.length >= 3, 30_000);
    await waitFor("deny buttons removed", () => edited(denial.offer.messageId, denyFrom), Boolean, 20_000);
    const denyCard = denyCards.length === 1 ? await cardState(denyCards[0].threadId, denyCards[0].message.id) : null;
    expect("approval.deny", "Deny reaches the engine exactly once as deny, removes the buttons and resolves the card",
      denyCards.length === 1 && afterDeny.length === 3 && afterDeny[2].decision.behavior === "deny" && Boolean(denyCard?.answered), { decision: afterDeny[2] ?? null });

    const beforeRestart = await requestApproval("Restart");
    const decisionsBeforeRestart = decisions().length;
    await harness.restart();
    await waitFor("resumed after restart", status, value => value.paired === true && value.enabled === true, 30_000);
    const staleTap = click(beforeRestart.offer.messageId, beforeRestart.buttons[0].id);
    await waitFor("stale tap acknowledged", () => acked(staleTap), Boolean, 20_000);
    await sleep(2_000);
    expect("approval.restart-fence", "a button offered before a restart never reaches the engine afterwards", decisions().length === decisionsBeforeRestart,
      { decisions: decisions().length, pendingCards: (await pendingCards(chief.id)).length });

    const beforeChiefChange = await requestApproval("Chief change");
    const decisionsBeforeChief = decisions().length;
    const demoted = await harness.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    await waitFor("Chief-change pause", status, value => value.enabled === false, 20_000);
    const chiefTap = click(beforeChiefChange.offer.messageId, beforeChiefChange.buttons[0].id);
    await sleep(2_500);
    expect("approval.chief-change-fence", "after the Chief changes, an Approve tap is neither acknowledged nor sent to the engine",
      demoted.status === 200 && decisions().length === decisionsBeforeChief && !acked(chiefTap), { acknowledged: acked(chiefTap), status: await status() });
    const revoked = await harness.request("POST", `/api/${provider}/revoke`, {});
    const revokeTap = click(beforeChiefChange.offer.messageId, beforeChiefChange.buttons[0].id);
    await sleep(2_000);
    const afterRevoke = await status();
    expect("revoke.after-pause", "revoking the paused connection disables it and a later tap is not acknowledged or decided",
      revoked.status === 200 && afterRevoke.enabled === false && decisions().length === decisionsBeforeChief && !acked(revokeTap), { http: revoked.status, status: afterRevoke });

    if (existsSync(decisionsFile())) copyFileSync(decisionsFile(), join(folder, "engine-decisions.jsonl"));
    writeFileSync(join(folder, "sdk-traces.jsonl"), traces.map(trace => JSON.stringify(trace)).join("\n") + "\n");
  } catch (error) {
    expect("fixture.completed", "the journeys reached their final step", false, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await finishCleanup(harness, checks);
  }
  expect("cleanup.absent", "the owned fixture root is absent", Boolean(harness && !existsSync(harness.root)));
  const failed = checks.list.filter(check => check.outcome === "fail").map(check => check.id);
  report.push({ provider, realServer: true, fakeEngine: true, fakeProvider: true, passed: checks.list.filter(check => check.outcome === "pass").length, failed });
  allChecks.push(...checks.list);
}

const leaked: string[] = [];
const scan = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path);
    else { const bytes = readFileSync(path); for (const secret of [...Object.values(SECRETS.discord), ...Object.values(SECRETS.slack)]) if (bytes.includes(secret)) leaked.push(path); }
  }
};
scan(evidence);
const custody = { id: "custody.evidence", criterion: "no fixture token bytes appear in evidence or server logs", outcome: leaked.length === 0 ? "pass" : "fail", ...(leaked.length ? { detail: leaked } : {}) };
process.stdout.write(`${leaked.length === 0 ? "PASS" : "FAIL"} custody.evidence\n`);
allChecks.push(custody);
const failedIds = (allChecks as any[]).filter(check => check.outcome === "fail").map(check => check.id);
writeFileSync(join(evidence, "result.json"), JSON.stringify({ mode: "offline SDK stand-ins, real source server and permission broker, fake Claude", node: process.version, report, checks: allChecks, failed: failedIds }, null, 2) + "\n");
process.stdout.write(`result ${JSON.stringify({ report, failed: failedIds })}\n`);
process.exitCode = failedIds.length ? 1 : 0;
