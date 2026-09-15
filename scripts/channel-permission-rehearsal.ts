// Offline real-server journey: real permission broker and channel services,
// scripted Claude permission calls, and SDK IPC facades with no provider I/O.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHarness, promoteFixtureChief, ROOT, waitFor, sleep } from "./channel-live-harness.ts";

const evidence = resolve(process.argv[2] ?? "docs/verification/channel-permission-rehearsal");
mkdirSync(evidence, { recursive: true });
const report: unknown[] = [];
for (const provider of ["discord", "slack"] as const) {
  const folder = join(evidence, provider), decisionsFile = join(folder, "decisions.jsonl");
  const traces: any[] = [];
  const harness = await createHarness({ label: `permission-${provider}`, evidenceDir: folder, ipc: true,
    preload: join(ROOT, `server/testing/${provider}-sdk-preload.mjs`),
    env: () => ({ FAKE_CLAUDE_MODE: "channel-permission", FAKE_PERMISSION_DECISIONS: decisionsFile }),
  });
  harness.onMessage(value => {
    if ((value as any)?.kind === `${provider}-fixture`) {
      traces.push(value);
      harness.record("sdk", value);
    }
  });
  // Extend the established fake CLI in the task-owned temporary root only.
  // The original fake and real engines remain unchanged. Its MCP call helper
  // performs initialize/tools-call against the real permission-proxy process.
  const fixture = join(harness.root, "permission-claude.ts");
  const source = readFileSync(join(ROOT, "server/testing/fake-claude-cli.ts"), "utf8");
  const anchor = '  if (mode === "ask-user-question" || fixtureRequested(promptText(prompt), "__fixture_ask_user_question__")) {';
  assert.equal(source.split(anchor).length, 2, "fake CLI insertion anchor must be unique");
  writeFileSync(fixture, source.replace(anchor, `  if (mode === "channel-permission") {
    void (async () => {
      const input = { command: "fixture_exact_action_no_execution" };
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
  chmodSync(fixture, 0o700);
  const configPath = join(harness.data, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.fixtureClaude.config.cli = fixture;
  writeFileSync(configPath, JSON.stringify(config));
  let sequence = 200;
  const dmId = provider === "discord" ? "14" : "DOWNER";
  const sendMessage = (text: string) => {
    const id = String(sequence++);
    harness.child()!.send(provider === "discord" ? { kind: "discord-fixture-event", body: {
      id, channelId: dmId, channel: { type: 1 }, author: { id: "13", bot: false }, guildId: null,
      webhookId: null, type: 0, content: text, createdTimestamp: Date.now(), attachments: { size: 0 }, components: [],
    } } : { kind: "slack-fixture-event", body: {
      type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: `Ev${id}`, event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: dmId, user: "UOWNER", text },
    } });
  };
  const click = (button: any, actionId: string) => {
    const eventId = `click${sequence++}`;
    harness.child()!.send(provider === "discord" ? { kind: "discord-fixture-action", eventId, body: {
      guildId: null, channel: { type: 1 }, applicationId: "11", message: { id: button.messageId, author: { id: "12" } },
      user: { id: "13", bot: false }, channelId: dmId, customId: actionId,
    } } : { kind: "slack-fixture-action", eventId, body: {
      type: "block_actions", api_app_id: "APP", team: { id: "TEAM" }, user: { id: "UOWNER" }, channel: { id: dmId },
      message: { ts: button.messageId, user: "UBOT", bot_id: "BOT" }, container: { type: "message", channel_id: dmId, message_ts: button.messageId },
      actions: [{ type: "button", action_id: actionId }],
    } });
    return eventId;
  };
  const decisions = () => existsSync(decisionsFile) ? readFileSync(decisionsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    await harness.boot();
    const chief = await promoteFixtureChief(harness, `Fictional ${provider} permission Chief`, undefined, { autoReview: "off", autoApprove: false, alwaysAllow: [] });
    const originalThread = (await harness.request("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id).threadId;
    const saved = await harness.request("PATCH", "/api/config?secretStorage=external", provider === "discord"
      ? { discord: { botToken: "discord-fixture-not-real", applicationId: "11", ownerUserId: "13" } }
      : { slack: { appToken: "xapp-fixture-not-real", botToken: "xoxb-fixture-not-real", teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const pairing = await harness.request("POST", `/api/${provider}/pair`, { targetBotId: chief.id });
    assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
    sendMessage("/pair " + pairing.body.code);
    await waitFor("paired", () => harness.request("GET", `/api/${provider}/status`), result => result.body.paired === true);
    for (const [index, behavior] of ["allow", "deny"].entries()) {
      const before = traces.length;
      sendMessage(`Request fictional action ${index}; ask for approval.`);
      const button = await waitFor("native permission buttons", () => traces.slice(before).find(trace => trace.op === "send" && (trace.components?.length || trace.blocks?.some((block: any) => block.type === "actions"))), Boolean);
      const controls = provider === "discord" ? button.components[0].components : button.blocks.find((block: any) => block.type === "actions").elements;
      assert.deepEqual(controls.map((control: any) => provider === "discord" ? control.label : control.text.text), ["Approve once", "Deny"]);
      assert.ok(button.text.includes("fixture_exact_action_no_execution"));
      const bot = (await harness.request("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id);
      const tasks = bot.tasks ?? [];
      const pending: any[] = [];
      for (const task of tasks) {
        const response = await harness.request("GET", `/api/threads/${task.threadId}/messages`);
        for (const message of response.body.messages ?? []) if (message.card?.requestId && !message.card.answered) pending.push({ threadId: task.threadId, message });
      }
      assert.equal(pending.length, 1, "one real pending card");
      assert.equal(pending[0].threadId, originalThread, "channel ingress uses the Chief's current thread");
      const actionId = provider === "discord" ? controls[behavior === "allow" ? 0 : 1].custom_id : controls[behavior === "allow" ? 0 : 1].action_id;
      const ackId = click(button, actionId);
      await waitFor("interaction acknowledged", () => traces.some(trace => trace.op === "action-ack" && trace.eventId === ackId), Boolean);
      const observed = await waitFor("one engine decision", decisions, items => items.length === index + 1);
      assert.equal(observed[index].decision.behavior, behavior);
      assert.equal(observed[index].decision.updatedPermissions, undefined, "no standing grant");
      await waitFor("buttons removed", () => traces.find(trace => trace.op === "edit" && trace.messageId === button.messageId), Boolean);
      const resolved = await waitFor("same card resolved", () => harness.request("GET", `/api/threads/${pending[0].threadId}/messages`), response => response.body.messages?.some((message: any) => message.id === pending[0].message.id && message.card?.answered));
      assert.ok(resolved.body.messages.find((message: any) => message.id === pending[0].message.id).card.answered);
      const stale = click(button, actionId);
      await waitFor("stale click acknowledged", () => traces.some(trace => trace.op === "action-ack" && trace.eventId === stale), Boolean);
      await sleep(150);
      assert.equal(decisions().length, index + 1, "stale click never reaches engine twice");
      harness.record("scenario-passed", { behavior, requestId: pending[0].message.card.requestId, threadId: pending[0].threadId, messageId: button.messageId, nativeProvider: false });
      await waitFor("channel reply", () => traces.slice(before).some(trace => trace.op === "send" && trace.text?.includes("Fixture decision:")), Boolean);
    }
    const revoke = await harness.request("POST", `/api/${provider}/revoke`, {});
    assert.equal(revoke.status, 200);
    await waitFor("service stopped", () => traces.some(trace => trace.op === "stop"), Boolean);
    const status = await harness.request("GET", `/api/${provider}/status`);
    assert.equal(status.body.enabled, false);
    report.push({ provider, status: "passed", realServer: true, fakeEngine: true, fakeProvider: true, decisions: decisions().length });
  } catch (error) {
    harness.record("failed", { message: error instanceof Error ? error.message : String(error) });
    report.push({ provider, status: "failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    await harness.close();
  }
}
writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ evidence, report }, null, 2));
if (report.some((item: any) => item.status !== "passed")) process.exitCode = 1;
