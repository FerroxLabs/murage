// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-approvefix (both sides: the Needs you row in src/components/InboxRequest.tsx and the respond route in
// server/index.ts respondToCard). 1.0.22 MUST-FIX: an approval card raised by an UNATTENDED turn could not be answered
// from Needs you: every Approve returned 503 delivery_retry, while the same card's Run in the chat went through.
// The Needs you row is rendered for real (InboxQuickAnswer, reading its card with readRequestCard) against a booted
// server and a fake ACP engine; only the transport is bridged (jsdom has no loopback origin) and the surface is the
// desktop app's (useDesktopSurface). The engine's own dump says whether the tool was released. The chat side is the real
// chat card (PendingApprovalActions, ApprovalCard) whose dispatch runs the store's own decideRequest post
// (postPermissionDecision); a question's one tap on the Needs you row is held to the chat card's display action.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

const bridge = vi.hoisted(() => ({ base: "", headers: {} as Record<string, string>, responds: [] as Array<{ status: number; body: Record<string, unknown>; sent: Record<string, unknown> }>, api: null as null | ((path: string, init?: RequestInit) => Promise<any>) }));
vi.mock("@/lib/use-surface", async (original) => ({ ...(await original<Record<string, unknown>>()), useDesktopSurface: () => true, useSurfaceState: () => ({ desktop: true, confirmed: true }) }));
vi.mock("@/lib/native-shell", async (original) => ({ ...(await original<Record<string, unknown>>()), inNativeShell: () => false }));
vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  // The real api() contract over a real socket: JSON in and out, the audience wire normalized, a refusal thrown with its body.
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(bridge.base + path, { ...init, headers: { ...bridge.headers, ...(init?.headers as Record<string, string> | undefined) } });
    const body = real.normalizeAudienceWire(await res.json().catch(() => ({})));
    if (path.endsWith("/respond")) bridge.responds.push({ status: res.status, body, sent: JSON.parse(String(init?.body ?? "{}")) });
    if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status, body });
    return body;
  };
  bridge.api = api;
  // The chat card's dispatch: the store's own decideRequest post (postPermissionDecision), over the same bridged transport.
  const dispatch = (action: { type: string }) => {
    if (action.type === "decideRequest") void real.postPermissionDecision(action as Parameters<typeof real.postPermissionDecision>[0], () => {}, api);
  };
  return { ...real, api, useStore: () => ({ dispatch }), useStoreIfAny: () => undefined };
});
import { InboxQuickAnswer, readRequestCard } from "./InboxRequest";
import { Inbox } from "./Inbox";
import { PendingApprovalActions, pendingOf } from "./PendingApproval";
import { ApprovalCard } from "./ApprovalCard";
import { questionDisplayAction } from "./QuestionCard";
import { loadPlainApproval } from "@/lib/plain-approval";
import { pendingApprovals } from "@/lib/pending-approval";
import type { Message } from "@/state/store";
const real = await vi.importActual<typeof import("@/state/store")>("@/state/store");

// jsdom gives import.meta.url no file scheme: paths are from the repository root vitest runs in.
const FAKE_CLI = join(process.cwd(), "server/testing/fake-acp-cli.ts");
const EDIT = { FAKE_ACP_MODE: "permission-edit-file" };
// One question with two plain options (the shape a Needs you row answers in one tap), on Fuigo's own ask method.
const ASK = { FAKE_ACP_MODE: "vendor-question", FAKE_ACP_ASK_METHOD: "_fuigo/ask_user_question", FAKE_ACP_ASK_PARAMS: JSON.stringify({ sessionId: "", toolCallId: "tc-1", mode: "default",
  questions: [{ question: "Which branch should I use?", options: [{ label: "main", description: "" }, { label: "develop", description: "" }] }] }) };
const INSTANCES = { attended: EDIT, unattended: EDIT, chat: EDIT, ended: EDIT, deny: EDIT, question: ASK, stopped: EDIT, lookalike: { ...ASK, FAKE_ACP_ASK_PARAMS: ASK.FAKE_ACP_ASK_PARAMS.replace('"label":"main"', '"label":"o.0.1"') } } as const; // lookalike: a label reading like the other option's handle
let fixture: VerificationServer;
let root: Root;
let chatRoot: Root | undefined;
const chatHost = document.createElement("div");
const post = (path: string, body: unknown) => fetch(bridge.base + path, { method: "POST", headers: bridge.headers, body: JSON.stringify(body) });
const get = async (path: string) => (await fetch(bridge.base + path, { headers: bridge.headers })).json() as Promise<any>;
const wait = async <T,>(what: string, probe: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; server log tail:\n${readFileSync(fixture.info.logPath, "utf8").slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};
const decision = (instance: string) => {
  const file = join(fixture.info.dataDir, `dump-${instance}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { decision?: { outcome?: { outcome?: string; optionId?: string } } }).decision : undefined;
};
async function makeBot(instance: string): Promise<{ id: string; threadId: string }> {
  const created = await post("/api/bots", { name: `Needs you ${instance}`, modelSelection: { instanceId: instance, model: "fixture" } });
  expect(created.status, "bot created").toBe(201);
  const { bot } = await created.json() as { bot: { id: string; threadId: string } };
  const patched = await fetch(bridge.base + `/api/bots/${bot.id}`, { method: "PATCH", headers: bridge.headers, body: JSON.stringify({ autoApprove: false, autoReview: "off", computer: "off" }) });
  expect(patched.ok, "bot set to Ask").toBe(true);
  return bot;
}
/** The card the turn raised, as the transcript holds it (the chat surface's own read). */
const cardMessage = (threadId: string) => wait("the approval card", async () =>
  ((await get(`/api/threads/${threadId}/messages`)).messages as any[]).find(message => message.card?.requestHandle && message.card?.tool));
/** An unattended turn: a webhook delivery, nobody watching (origin=other unattended=1 in the approvals log). */
async function webhookTurn(botId: string): Promise<string> {
  const hook = await post("/api/webhooks", { name: "Incidents", prompt: "Check the incident queue", botId, runOn: "ember" });
  expect(hook.status, "webhook created").toBe(201);
  const { credential } = await hook.json() as { credential: { url: string } };
  const delivered = await fetch(credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "incident" }) });
  expect(delivered.status, "webhook delivered").toBe(202);
  const { runId } = await delivered.json() as { runId: string };
  return wait("the webhook run's thread", async () => ((await get("/api/routines")).runs as any[] ?? []).find(run => run.id === runId)?.threadId as string | undefined);
}
/** Mount the Needs you row for this card exactly as Inbox.tsx does (card from readRequestCard). */
async function needsYouRow(threadId: string, messageId: string) {
  const card = await readRequestCard({ threadId, messageId });
  await act(async () => root.unmount());
  document.body.replaceChildren();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  if (card) await act(async () => root.render(createElement(InboxQuickAnswer, { threadId, card, botName: "Bot", labelledBy: "row", onSettled: () => {} })));
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button[data-needs-quick]")].find(entry => entry.textContent?.includes(label));
  return { card, approve: () => button("Approve"), deny: () => button("Deny") };
}
/** The conversation's own surface for this card, drawn on screen: the transcript's ApprovalCard and, while the card is
 *  pending, the composer's PendingApprovalActions (ChatView / PendingApprovalQueue), from the chat's own read. */
async function chatCard(bot: { id: string; threadId: string }, messageId: string) {
  const messages = real.normalizeAudienceWire(await get(`/api/threads/${bot.threadId}/messages`)).messages as Message[];
  const message = messages.find(entry => entry.id === messageId)!;
  const pending = pendingApprovals(messages).find(entry => entry.message.id === messageId);
  const who = { id: bot.id, name: "Bot", autoApprove: false, threadId: bot.threadId } as never;
  await act(async () => chatRoot?.unmount());
  chatHost.replaceChildren();
  chatRoot = createRoot(chatHost);
  await act(async () => chatRoot!.render(createElement("div", null,
    createElement(ApprovalCard, { bot: who, message }),
    pending ? createElement(PendingApprovalActions, { pending: pendingOf(message), threadId: bot.threadId, bot: who, onCancelTurn: () => {} }) : null)));
  const buttons = () => [...chatHost.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Approval"] button')];
  return { message, pending, buttons, allow: () => buttons().find(entry => /^(Allow|Run|Approve)/.test(entry.textContent?.trim() ?? "")) };
}
async function pressApprove(button: HTMLButtonElement) {
  const before = bridge.responds.length;
  await act(async () => { button.click(); });
  await wait("the Needs you answer", async () => bridge.responds.length > before);
  return bridge.responds[bridge.responds.length - 1]!;
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const instrumentationSource = `
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const { createAcpDriver } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/acp/core.ts")).href)});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
    BUILT_IN_DRIVERS.push(createAcpDriver({
      driverKind: 'needsYou1022', displayName: 'Needs you fixture', defaultCli: process.execPath,
      models: { default: 'fixture', options: [{ id: 'fixture', label: 'Fixture' }] },
      nativeSource: 'needs-you-fixture.acp', loginNote: 'Fixture only',
      spawnArgs: () => ['--experimental-strip-types', ${JSON.stringify(FAKE_CLI)}],
      pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
      fluxReach: () => 'elsewhere'
    }));
    const fs = await import('node:fs');
    const path = await import('node:path');
    const instances = {};
    for (const [name, env] of Object.entries(${JSON.stringify(INSTANCES)})) instances[name] = { driver: 'needsYou1022', environment: { ...env, FAKE_ACP_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'dump-' + name + '.json') }, config: { cli: process.execPath, fullAuto: false } };
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'config.json'), JSON.stringify({ instances }));
  `;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  bridge.base = fixture.info.url;
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  bridge.headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  root = createRoot(document.createElement("div"));
  await loadPlainApproval();
}, 120_000);
afterAll(async () => {
  await act(async () => root?.unmount());
  await act(async () => chatRoot?.unmount());
  await fixture?.close();
});

describe("q1022-approvefix: Needs you answers through the chat card's one path", () => {
  it.each([
    // Unattended first: on the base an attended card left waiting would hold the webhook run behind it.
    ["unattended", "an unattended webhook (team incident) turn"],
    ["attended", "an owner's chat turn"],
  ] as Array<[string, string]>)("W1 %s: Approve on the Needs you row -> 200 and the engine releases the tool (%s)", async (instance) => {
    const bot = await makeBot(instance);
    const threadId = instance === "unattended" ? await webhookTurn(bot.id) : bot.threadId;
    if (instance === "attended") expect((await post(`/api/bots/${bot.id}/messages`, { text: "Edit the file", threadId })).ok).toBe(true);
    const message = await cardMessage(threadId);
    // The ask is the reported one: the approvals log says this bot's Bash-or-edit ask came from an unattended turn.
    if (instance === "unattended") expect(readFileSync(fixture.info.logPath, "utf8"), "the ask is an unattended turn's").toMatch(new RegExp(`approvals: asked bot=${bot.id} [^\\n]*unattended=1`));
    const row = await needsYouRow(threadId, message.id);
    const approve = row.approve();
    expect(approve, "the Needs you row offers Approve").toBeDefined();
    const answered = await pressApprove(approve!);
    expect({ status: answered.status, code: answered.body.code }, "Needs you Approve is taken, never 503 delivery_retry").toEqual({ status: 200, code: undefined });
    expect(answered.body.outcome).toBe("allowed-once");
    // The chat card's own body: the display handle as a display action, never the handle as a raw requestId.
    expect(answered.sent).toEqual({ requestHandle: message.card.requestHandle, action: "allow" });
    // The engine got Allow once: the tool runs.
    const released = await wait("the engine's decision", async () => decision(instance));
    expect(released?.outcome?.outcome).toBe("selected");
    expect(released?.outcome?.optionId).toMatch(/allow/);
  }, 90_000);

  it("W1 deny: Deny on the Needs you row -> 200 rejected, the engine is told no", async () => {
    const bot = await makeBot("deny");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Edit the file", threadId: bot.threadId })).ok).toBe(true);
    const message = await cardMessage(bot.threadId);
    const deny = (await needsYouRow(bot.threadId, message.id)).deny();
    expect(deny, "the Needs you row offers Deny").toBeDefined();
    const answered = await pressApprove(deny!);
    expect({ status: answered.status, outcome: answered.body.outcome }, "Needs you Deny is taken").toEqual({ status: 200, outcome: "rejected" });
    expect(answered.sent).toEqual({ requestHandle: message.card.requestHandle, action: "deny" });
    const told = await wait("the engine's decision", async () => decision("deny"));
    // ACP says no as a selected reject option: the tool is not run.
    expect(told?.outcome?.optionId).toMatch(/reject/);
  }, 90_000);

  it("W2 chat: the chat card's own Allow (PendingApprovalActions -> store decideRequest) answers the same card -> 200 and the tool runs", async () => {
    const bot = await makeBot("chat");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Edit the file", threadId: bot.threadId })).ok).toBe(true);
    const message = await cardMessage(bot.threadId);
    const chat = await chatCard(bot, message.id);
    const allow = chat.allow();
    expect(allow, `the chat card offers Allow: ${JSON.stringify(chat.buttons().map(entry => entry.textContent))}`).toBeDefined();
    const answered = await pressApprove(allow!);
    expect({ status: answered.status, outcome: answered.body.outcome }, "the chat card's Allow is taken").toEqual({ status: 200, outcome: "allowed-once" });
    expect(answered.sent).toEqual({ requestHandle: message.card.requestHandle, action: "allow" });
    expect((await wait("the engine's decision", async () => decision("chat")))?.outcome?.outcome).toBe("selected");
  }, 90_000);

  it("W3 ended: a request whose turn ended shows ended with no buttons on both surfaces, never an endless Try again", async () => {
    const bot = await makeBot("ended");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Edit the file", threadId: bot.threadId })).ok).toBe(true);
    const message = await cardMessage(bot.threadId);
    const live = await needsYouRow(bot.threadId, message.id);
    expect(live.approve(), "the live card offers Approve on Needs you").toBeDefined();
    const liveChat = await chatCard(bot, message.id);
    expect(liveChat.allow(), "the live chat card offers Allow").toBeDefined();
    expect((await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).ok).toBe(true);
    // Needs you, pressed on the row still on screen after the turn ended: the request is said to be gone, never a retry.
    const late = await pressApprove(live.approve()!);
    expect({ status: late.status, error: late.body.error, code: late.body.code }, "an ended request is never delivery_retry")
      .toEqual({ status: 409, error: "request_unavailable", code: undefined });
    // The stale row once its answer has settled (its buttons no longer held): no line asking to try again.
    await wait("the stale row to settle", async () => document.querySelector('[role="group"][aria-busy="false"]'));
    expect(document.querySelector('[role="alert"]')?.textContent ?? "", "the stale row never asks to try again").not.toMatch(/try again/i);
    // Chat surface, drawn from the conversation's own read: the transcript card says the bot stopped, and no answer buttons.
    const ended = await wait("the chat card to close", async () => {
      const drawn = await chatCard(bot, message.id);
      return drawn.pending ? undefined : drawn;
    });
    const outcome = chatHost.querySelector("[data-card-outcome]");
    expect(ended.message.card?.dismissed, "the Stop closed the chat card").toBe(true);
    expect(chatHost.querySelector("[data-approval-waiting]"), "the chat no longer shows it waiting").toBeNull();
    expect(outcome?.textContent?.trim() ?? "", "the chat card says the bot stopped waiting, never that the owner denied it").toBe("Bot stopped waiting for this. Ask it again.");
    expect(chatHost.querySelectorAll("button").length, "no answer buttons on the ended chat card").toBe(0);
    // Needs you after the Inbox reloads: the request is no longer waiting there, and its row re-read has no buttons.
    const inbox = await get("/api/inbox?view=decisions");
    expect(((inbox.items ?? []) as Array<{ status?: string; link?: { messageId?: string } }>).filter(item => item.link?.messageId === message.id && item.status === "pending"), "Needs you no longer lists it as waiting").toEqual([]);
    const after = await needsYouRow(bot.threadId, message.id);
    expect(after.card?.answered === "unavailable" || after.card?.dismissed === true, "the re-read row is ended").toBe(true);
    expect(after.approve(), "no Approve on the ended row").toBeUndefined();
    expect(document.querySelectorAll("button").length, "no buttons on the ended row").toBe(0);
    // The real Inbox, reloaded: Needs you (the door) no longer has the row, and the All list shows it with its ended
    // status on screen and no answer buttons.
    const item = ((await get("/api/inbox?view=all&includeSnoozed=true")).items as Array<{ id: string; status: string; link?: { messageId?: string } }>).find(entry => entry.link?.messageId === message.id);
    expect(item?.status, `the request's Inbox item is ended: ${JSON.stringify(item)}`).toMatch(/^(expired|cancelled|closed|resolved|unavailable|answered|stopped)$/);
    await act(async () => root.unmount());
    document.body.replaceChildren();
    const inboxHost = document.createElement("div"); document.body.append(inboxHost); root = createRoot(inboxHost);
    await act(async () => root.render(createElement(Inbox, { onOpen: () => {}, door: true, initialView: "decisions" })));
    await wait("Needs you to load", async () => !inboxHost.querySelector('[aria-busy="true"]') && inboxHost.textContent);
    expect(document.getElementById(`needs-row-line-${item!.id}`), "Needs you no longer shows the ended request").toBeNull();
    await act(async () => root.unmount());
    inboxHost.replaceChildren(); root = createRoot(inboxHost);
    await act(async () => root.render(createElement(Inbox, { onOpen: () => {}, initialView: "all" })));
    const shown = await wait("the ended row in the Inbox", async () => inboxHost.querySelector<HTMLElement>(`[data-inbox-id="${item!.id}"]`));
    expect(shown.textContent ?? "", "the reloaded row says it ended").toContain(item!.status.replaceAll("-", " ").replace(/^./, first => first.toUpperCase()));
    expect([...shown.querySelectorAll("button")].map(entry => entry.textContent?.trim()).filter(label => /^(Approve|Allow|Deny|Allow once)/.test(label ?? "")), "no answer buttons on the ended row").toEqual([]);
    expect(decision("ended")?.outcome?.outcome, "nothing was released").not.toBe("selected");
  }, 90_000);

  it("W4 question: a one-tap answer on the Needs you row posts the chat card's display action -> 200 and the engine gets the pick", async () => {
    const bot = await makeBot("question");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Pick a branch", threadId: bot.threadId })).ok).toBe(true);
    const message = await wait("the question card", async () =>
      ((await get(`/api/threads/${bot.threadId}/messages`)).messages as any[]).find(entry => entry.card?.requestHandle));
    const row = await needsYouRow(bot.threadId, message.id);
    const pick = [...document.querySelectorAll<HTMLButtonElement>("button[data-needs-quick]")].find(entry => entry.textContent?.trim() === "develop");
    expect(pick, `the Needs you row offers the one-tap pick: ${JSON.stringify([...document.querySelectorAll("button")].map(entry => entry.textContent))}`).toBeDefined();
    const answered = await pressApprove(pick!);
    expect({ status: answered.status, code: answered.body.code, error: answered.body.error }, "the one-tap answer is taken, never delivery_retry")
      .toEqual({ status: 200, code: undefined, error: undefined });
    // The chat card's QuestionCard posts questionDisplayAction for the same pick: the identical body.
    const develop = row.card!;
    expect(answered.sent).toEqual(questionDisplayAction(develop, message.id, [{ id: (develop.questions?.[0] as { id: string }).id, selected: [String((develop.questions?.[0]?.options[1] as { handle?: string; label: string }).handle ?? "develop")] }]));
    const told = await wait("the engine's decision", async () => decision("question"));
    expect(JSON.stringify(told), "the engine got the pick").toMatch(/develop/);
  }, 90_000);

  it("W4 lookalike: a one-tap label that reads like the other option's handle answers the option it names", async () => {
    const bot = await makeBot("lookalike");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Pick a branch", threadId: bot.threadId })).ok).toBe(true);
    const message = await wait("the question card", async () =>
      ((await get(`/api/threads/${bot.threadId}/messages`)).messages as any[]).find(entry => entry.card?.requestHandle));
    await needsYouRow(bot.threadId, message.id);
    const pick = [...document.querySelectorAll<HTMLButtonElement>("button[data-needs-quick]")].find(entry => entry.textContent?.trim() === "o.0.1");
    expect(pick, "the Needs you row offers the one-tap pick").toBeDefined();
    const answered = await pressApprove(pick!);
    expect(answered.status, "the one-tap answer is taken").toBe(200);
    // The pick reaches the engine as the option the owner tapped, never the other one.
    const told = JSON.stringify(await wait("the engine's decision", async () => decision("lookalike")));
    expect({ tapped: told.includes("o.0.1"), other: told.includes("develop") }, `the engine got the tapped option: ${told}`).toEqual({ tapped: true, other: false });
  }, 90_000);

  it("W3 chat stopped: a card the owner's Stop closed is drawn as stopped waiting, never Denied, with no buttons", async () => {
    const bot = await makeBot("stopped");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Edit the file", threadId: bot.threadId })).ok).toBe(true);
    const message = await cardMessage(bot.threadId);
    expect((await chatCard(bot, message.id)).allow(), "the live chat card offers Allow").toBeDefined();
    expect((await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).ok).toBe(true);
    await wait("the chat card to close", async () => { const drawn = await chatCard(bot, message.id); return drawn.pending ? undefined : drawn; });
    expect(chatHost.querySelector("[data-card-outcome]")?.textContent?.trim(), "the Stop-closed chat card says the bot stopped waiting").toBe("Bot stopped waiting for this. Ask it again.");
    expect(chatHost.querySelectorAll("button").length, "no answer buttons on the stopped chat card").toBe(0);
  }, 90_000);
});
