// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-J (item 17): automations from chat. A webhook proposed in chat gets the
// same card and the same guard as a routine (J1), and an applied change can
// be undone from the receipt written before it was applied (J2). Each test
// names the failure it prevents (design page section 5). The service runs
// on real RoutineManager and WebhookManager files in a temp directory, so a
// "restart" is a fresh manager reading the same files.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RoutineRequestService,
  routineRequestFingerprint,
  webhookIdForRequest,
  type RoutineRequestMessage,
  type RoutineRequestOptionCard,
  type RoutineRequestStore,
} from "./routine-requests.ts";
import { RoutineManager } from "./routines.ts";
import { WebhookManager } from "./webhooks.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

class MemoryStore implements RoutineRequestStore {
  readonly threads = new Map<string, RoutineRequestMessage[]>();
  private sequence = 0;
  failNextPatch = false;

  messagesFor(threadId: string): RoutineRequestMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: RoutineRequestOptionCard }): RoutineRequestMessage {
    const stored = { id: `message-${++this.sequence}`, card: structuredClone(message.card) };
    this.threads.set(threadId, [...this.messagesFor(threadId), stored]);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: RoutineRequestOptionCard }): RoutineRequestMessage | null {
    // a crash after the change and before the card was settled
    if (this.failNextPatch) {
      this.failNextPatch = false;
      throw new Error("simulated crash before the card was settled");
    }
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = structuredClone(patch.card);
    return message;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

const BOT = "bot-a";
const THREAD = "thread-a";

function world(dir = mkdtempSync(join(tmpdir(), "murage-slj-")), store = new MemoryStore(), clock = { now: Date.parse("2026-10-20T10:00:00Z") }) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const routines = new RoutineManager({
    file: join(dir, "routines.json"),
    now: () => clock.now,
    botState: () => "busy",
    createTask: () => null,
    startTurn: async () => {},
  });
  const queued: string[] = [];
  const webhooks = new WebhookManager({
    file: join(dir, "webhooks.json"),
    now: () => clock.now,
    botState: (botId) => (botId === BOT ? "ready" : "missing"),
    enqueue: (input) => {
      queued.push(input.deliveryId);
      return { id: `run-${queued.length}` };
    },
  });
  const service = new RoutineRequestService({ store, routines, webhooks: () => webhooks, now: () => clock.now, timeZone: () => "UTC" });
  // "restart": fresh managers over the same files and the same transcript
  const restart = () => world(dir, store, clock);
  return { dir, store, clock, routines, webhooks, service, queued, restart };
}

type World = ReturnType<typeof world>;

const card = (w: World, requestId: string) => w.store.messagesFor(THREAD).find((message) => message.card?.requestId === requestId)!;
const confirm = (w: World, requestId: string) => w.service.resolve({ botId: BOT, threadId: THREAD, requestId, behavior: "allow" });
const undo = (w: World, requestId: string) => w.service.resolve({ botId: BOT, threadId: THREAD, requestId, behavior: "undo" });
const receiptsOnDisk = (w: World) => JSON.parse(readFileSync(join(w.dir, "routines.json"), "utf8")).routineRequestReceipts as Array<Record<string, unknown>>;

const proposeWebhook = (w: World, webhook: Record<string, unknown> = {}) => w.service.propose({
  botId: BOT, threadId: THREAD,
  proposal: { kind: "webhook", action: "create", webhook: { name: "Build alerts", instructions: "Summarize the failed build.", ...webhook } },
});
const proposeWebhookAction = (w: World, action: string, webhookId: string, changes?: Record<string, unknown>) => w.service.propose({
  botId: BOT, threadId: THREAD,
  proposal: { kind: "webhook", action, webhookId, ...(changes ? { changes } : {}) },
});
const proposeRoutine = (w: World, name = "Morning brief") => w.service.propose({
  botId: BOT, threadId: THREAD,
  proposal: { action: "create", routine: { name, instructions: `Summarize the queue for ${name}.`, schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } } },
});
const proposeRoutineAction = (w: World, action: string, routineId: string, changes?: Record<string, unknown>) => w.service.propose({
  botId: BOT, threadId: THREAD,
  proposal: { action, routineId, ...(changes ? { changes } : {}) },
});

describe("SL-J J1: a webhook from chat, same card, same guard", () => {
  it("Confirm makes a webhook nobody can call until the owner mints its link; no secret or endpoint in the tool result or card", async () => {
    const w = world();
    const proposed = await proposeWebhook(w, { eventTypes: ["build.failed"] });
    const shown = card(w, proposed.requestId).card!;
    expect(shown.tool).toBe("create_webhook");
    expect(shown.options).toEqual(["Confirm", "Cancel"]);
    expect(shown.routineRequest).toMatchObject({ kind: "webhook", operation: { action: "create", webhook: { id: webhookIdForRequest(proposed.requestId), eventTypes: ["build.failed"] } } });
    expect(w.webhooks.list()).toHaveLength(0);

    const applied = confirm(w, proposed.requestId);
    expect(applied).toMatchObject({ claimed: true, state: "applied", action: "create", resultId: webhookIdForRequest(proposed.requestId) });
    const made = w.webhooks.get(webhookIdForRequest(proposed.requestId))!;
    expect(made).toMatchObject({ botId: BOT, enabled: true, eventTypes: ["build.failed"], prompt: "Summarize the failed build." });
    expect(w.webhooks.authorize(made.endpointId, "")).toBe(false);
    expect(() => w.webhooks.receive(made.endpointId, "whsec_guess", { payload: {}, eventName: "build.failed" })).toThrow(/Invalid webhook URL or secret/);
    expect(w.queued).toHaveLength(0);
    // GATE: absent by construction
    const everything = JSON.stringify({ proposed, applied, transcript: w.store.messagesFor(THREAD) });
    expect(everything).not.toMatch(/whsec_/);
    expect(everything).not.toContain(made.endpointId);
    // Confirm pressed twice
    expect(confirm(w, proposed.requestId)).toMatchObject({ state: "already_settled", behavior: "allow" });
    expect(w.webhooks.list()).toHaveLength(1);
  });

  it("an owner edit after the card was shown holds the card with 409, even inside the same millisecond", async () => {
    const w = world();
    const created = w.webhooks.create({ name: "Inbound", prompt: "Handle it", botId: BOT });
    const proposed = await proposeWebhookAction(w, "update", created.webhook.id, { instructions: "Handle it carefully" });
    // the clock does not move: the owner's write still moves updatedAt
    w.webhooks.update(created.webhook.id, { name: "Owner renamed" });
    const answer = confirm(w, proposed.requestId);
    expect(answer).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(card(w, proposed.requestId).card!.held).toContain("changed after this confirmation card was prepared");
    expect(w.webhooks.get(created.webhook.id)).toMatchObject({ name: "Owner renamed", prompt: "Handle it" });
  });

  it("refuses rotate and run now from chat, and a webhook of another bot", async () => {
    const w = world();
    const created = w.webhooks.create({ name: "Inbound", prompt: "Handle it", botId: BOT });
    await expect(proposeWebhookAction(w, "run_now", created.webhook.id)).rejects.toThrow();
    await expect(proposeWebhookAction(w, "rotate", created.webhook.id)).rejects.toThrow();
    await expect(w.service.propose({ botId: "bot-b", threadId: "thread-b", proposal: { kind: "webhook", action: "pause", webhookId: created.webhook.id } }))
      .rejects.toThrow(/does not exist/);
  });
});

describe("SL-J J2: Undo as the receipt", () => {
  it("the receipt holds `before` before the change, then its result; Undo of a webhook create removes it, and twice is already_settled", async () => {
    const w = world();
    const proposed = await proposeWebhook(w);
    confirm(w, proposed.requestId);
    const receipt = receiptsOnDisk(w).find((row) => row.requestId === proposed.requestId)!;
    expect(receipt).toMatchObject({ kind: "webhook", before: { absent: true }, resultId: webhookIdForRequest(proposed.requestId) });
    expect(typeof receipt.appliedUpdatedAt).toBe("number");
    expect(undo(w, proposed.requestId)).toMatchObject({ claimed: true, state: "undone", action: "create" });
    expect(w.webhooks.list()).toHaveLength(0);
    expect(card(w, proposed.requestId).card!.undone).toBe(true);
    expect(undo(w, proposed.requestId)).toMatchObject({ claimed: true, state: "already_settled", behavior: "undo" });
  });

  it("Undo of an update that added eventTypes clears them with []", async () => {
    const w = world();
    const created = w.webhooks.create({ name: "Inbound", prompt: "Handle it", botId: BOT });
    const proposed = await proposeWebhookAction(w, "update", created.webhook.id, { eventTypes: ["push"], name: "Pushes" });
    confirm(w, proposed.requestId);
    expect(w.webhooks.get(created.webhook.id)).toMatchObject({ name: "Pushes", eventTypes: ["push"] });
    expect(undo(w, proposed.requestId)).toMatchObject({ state: "undone" });
    const restored = w.webhooks.get(created.webhook.id)!;
    expect(restored.name).toBe("Inbound");
    expect(restored.eventTypes).toBeUndefined();
  });

  it.each(["owner edit", "minted link", "delivery"])("Undo after a %s answers changed_since and changes nothing", async (move) => {
    const w = world();
    const proposed = await proposeWebhook(w);
    confirm(w, proposed.requestId);
    const id = webhookIdForRequest(proposed.requestId);
    if (move === "owner edit") w.webhooks.update(id, { name: "Owner edit" });
    if (move === "minted link" || move === "delivery") {
      const minted = w.webhooks.rotateSecret(id)!;
      if (move === "delivery") w.webhooks.receive(minted.webhook.endpointId, minted.secret, { payload: { ok: true } });
    }
    expect(undo(w, proposed.requestId)).toMatchObject({ claimed: true, state: "invalid", status: 409, code: "changed_since" });
    expect(w.webhooks.get(id)).not.toBeNull();
    expect(card(w, proposed.requestId).card!.undone).toBeUndefined();
  });

  it("Undo restores a routine's `before` exactly: create, update, and a pause of a routine that was already paused", async () => {
    const w = world();
    const created = await proposeRoutine(w);
    confirm(w, created.requestId);
    const routineId = w.routines.listRoutines()[0]!.id;

    const updated = await proposeRoutineAction(w, "update", routineId, { name: "Evening brief", schedule: { type: "interval", everyMinutes: 30 } });
    confirm(w, updated.requestId);
    expect(w.routines.listRoutines()[0]).toMatchObject({ name: "Evening brief", schedule: { type: "interval", everyMinutes: 30 } });
    expect(undo(w, updated.requestId)).toMatchObject({ state: "undone", action: "update" });
    expect(w.routines.listRoutines()[0]).toMatchObject({ name: "Morning brief", schedule: { type: "daily", time: "09:00", weekdays: [1] }, enabled: true });

    // the owner pauses it, then the bot pauses it again: Undo keeps it paused
    w.routines.update(routineId, { enabled: false });
    const paused = await proposeRoutineAction(w, "pause", routineId);
    confirm(w, paused.requestId);
    expect(undo(w, paused.requestId)).toMatchObject({ state: "undone", action: "pause" });
    expect(w.routines.listRoutines()[0]!.enabled).toBe(false);

    const resumed = await proposeRoutineAction(w, "resume", routineId);
    confirm(w, resumed.requestId);
    expect(w.routines.listRoutines()[0]!.enabled).toBe(true);
    expect(undo(w, resumed.requestId)).toMatchObject({ state: "undone", action: "resume" });
    expect(w.routines.listRoutines()[0]!.enabled).toBe(false);

    // the create's Undo: the routine moved since (later edits), so changed_since
    expect(undo(w, created.requestId)).toMatchObject({ state: "invalid", code: "changed_since" });
    expect(w.routines.listRoutines()).toHaveLength(1);
  });

  it("Undo of a fresh routine create removes it; delete and run now offer no Undo", async () => {
    const w = world();
    const created = await proposeRoutine(w);
    confirm(w, created.requestId);
    expect(undo(w, created.requestId)).toMatchObject({ state: "undone", action: "create" });
    expect(w.routines.listRoutines()).toHaveLength(0);

    const again = await proposeRoutine(w, "Second brief");
    confirm(w, again.requestId);
    const routineId = w.routines.listRoutines()[0]!.id;
    const ran = await proposeRoutineAction(w, "run_now", routineId);
    confirm(w, ran.requestId);
    expect(undo(w, ran.requestId)).toMatchObject({ state: "invalid", error: "Undo is not offered for delete or run now." });
    const removed = await proposeRoutineAction(w, "delete", routineId);
    confirm(w, removed.requestId);
    expect(undo(w, removed.requestId)).toMatchObject({ state: "invalid", error: "Undo is not offered for delete or run now." });
    // delete and run now never keep a receipt for Undo
    expect(receiptsOnDisk(w).some((row) => row.requestId === removed.requestId || row.requestId === ran.requestId)).toBe(false);
  });

  it("a receipt without `before` (one written by 1.0.3) refuses Undo with one line", async () => {
    const w = world();
    const created = await proposeRoutine(w);
    // the 1.0.3 order: apply and receipt together, no `before`, card not yet settled
    const message = card(w, created.requestId);
    const payload = message.card!.routineRequest!;
    if (payload.kind === "webhook" || payload.operation.action !== "create") throw new Error("expected a routine create");
    w.routines.create({ name: "Morning brief", prompt: "x", botId: BOT, schedule: { type: "daily", time: "09:00", weekdays: [1] } }, {
      requestId: payload.requestId, messageId: message.id, botId: BOT, threadId: THREAD, action: "create",
      fingerprintVersion: 1, fingerprint: routineRequestFingerprint(payload, message.id),
    });
    expect(confirm(w, created.requestId)).toMatchObject({ state: "applied" });
    expect(undo(w, created.requestId)).toMatchObject({ state: "invalid", error: "Undo is no longer available for this change. Change it on the Automations page instead." });
    expect(w.routines.listRoutines()).toHaveLength(1);
  });
});

describe("SL-J section 4: crash recovery", () => {
  it("crash before apply: the receipt has no result, the next Confirm applies once", async () => {
    const w = world();
    const proposed = await proposeRoutine(w);
    const message = card(w, proposed.requestId);
    const payload = message.card!.routineRequest!;
    w.routines.beginRoutineRequest({
      requestId: payload.requestId, messageId: message.id, botId: BOT, threadId: THREAD, action: "create",
      fingerprintVersion: 1, fingerprint: routineRequestFingerprint(payload, message.id),
    }, { before: { absent: true } });
    const after = w.restart();
    expect(after.routines.routineRequestReceipt(proposed.requestId)).toMatchObject({ before: { absent: true } });
    expect(after.routines.routineRequestReceipt(proposed.requestId)?.resultId).toBeUndefined();
    expect(confirm(after, proposed.requestId)).toMatchObject({ state: "applied", action: "create" });
    expect(after.routines.listRoutines()).toHaveLength(1);
    expect(after.restart().routines.listRoutines()).toHaveLength(1);
  });

  it("crash after apply, before settle: the next Confirm settles from the receipt and Undo reads `before` from it", async () => {
    const w = world();
    const created = w.webhooks.create({ name: "Inbound", prompt: "Handle it", botId: BOT, eventTypes: ["push"] });
    const proposed = await proposeWebhookAction(w, "pause", created.webhook.id);
    w.store.failNextPatch = true;
    expect(confirm(w, proposed.requestId)).toMatchObject({ state: "invalid" });
    expect(w.webhooks.get(created.webhook.id)!.enabled).toBe(false);
    const after = w.restart();
    expect(confirm(after, proposed.requestId)).toMatchObject({ state: "applied", action: "pause" });
    expect(card(after, proposed.requestId).card!.answered).toBe("allow");
    expect(undo(after, proposed.requestId)).toMatchObject({ state: "undone" });
    expect(after.webhooks.get(created.webhook.id)).toMatchObject({ enabled: true, eventTypes: ["push"] });
  });

  it("section 8 item 1: a crash between the webhook save and the receipt save never makes a second webhook", async () => {
    const w = world();
    const proposed = await proposeWebhook(w);
    const complete = w.routines.completeRoutineRequest.bind(w.routines);
    let crashed = false;
    w.routines.completeRoutineRequest = (...args) => {
      if (!crashed) {
        crashed = true;
        throw new Error("simulated crash after webhooks.json was saved");
      }
      return complete(...args);
    };
    expect(confirm(w, proposed.requestId)).toMatchObject({ state: "invalid" });
    expect(w.webhooks.list()).toHaveLength(1);
    expect(w.routines.routineRequestReceipt(proposed.requestId)?.resultId).toBeUndefined();
    const after = w.restart();
    expect(confirm(after, proposed.requestId)).toMatchObject({ state: "applied", resultId: webhookIdForRequest(proposed.requestId) });
    expect(after.webhooks.list()).toHaveLength(1);
    // Undo still works: the record has not moved since it was made
    expect(undo(after, proposed.requestId)).toMatchObject({ state: "undone" });
    expect(after.webhooks.list()).toHaveLength(0);
  });

  it("section 8 item 2: the receipt survives settlement and a restart, so Confirm, restart, Undo works", async () => {
    const w = world();
    const proposed = await proposeWebhook(w);
    confirm(w, proposed.requestId);
    const after = w.restart();
    expect(after.routines.routineRequestReceipt(proposed.requestId)).toMatchObject({ before: { absent: true } });
    expect(undo(after, proposed.requestId)).toMatchObject({ state: "undone" });
    expect(after.webhooks.list()).toHaveLength(0);
    // Undo done: the receipt is no longer kept
    expect(after.routines.routineRequestReceipt(proposed.requestId)).toBeNull();
  });

  it("Undo is offered for 7 days after the change, then refuses", async () => {
    const w = world();
    const proposed = await proposeWebhook(w);
    confirm(w, proposed.requestId);
    w.clock.now += 7 * 24 * 60 * 60_000 + 1;
    expect(undo(w, proposed.requestId)).toMatchObject({ state: "invalid", error: "Undo is available for 7 days after a change. Change it on the Automations page instead." });
    expect(w.webhooks.list()).toHaveLength(1);
  });
});
