// The approval card's LIFECYCLE, as opposed to its verdict. A card that is
// raised but never settled keeps matching the client's "unanswered" filter,
// and the composer stays disabled behind it — so a gate that works
// perfectly can still make a thread unusable. These tests pin the settle.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  cancelPeerApprovalsFor,
  cancelPeerApprovalsForThread,
  dismissStalePeerCards,
  peerAllowKey,
  peerApprovalFailure,
  requestPeerApproval,
  resolvePeerComms,
  type ApprovalBus,
} from "./peer-approval.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

function pendingCard(store: Store, bot: BotRecord) {
  return store
    .messagesFor(bot.threadId)
    .find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

describe("peer approval card lifecycle", () => {
  let store: Store;
  let bus: ApprovalBus;
  let from: BotRecord;
  let target: BotRecord;

  beforeEach(() => {
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Asker", approvePeerComms: true })!;
    target = store.patchBot(store.createBot().id, { name: "Helper" })!;
    bus = { store, broadcast: () => {} };
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("settles the card when the user allows, so the composer unblocks", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from);
    expect(card).toBeTruthy();

    expect(resolvePeerComms(bus, card!.card!.requestId!, "allow")).toBe(true);
    expect(await verdict).toBe("allow");

    // the card the client renders must now be answered — this is the bit
    // whose absence bricked the thread
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card!.id);
    expect(settled?.card?.answered).toBe("allow");
    expect(settled?.card?.dismissed).toBe(false);
    expect(pendingCard(store, from)).toBeUndefined();
  });

  it("emits exact pending identity and delivery failure cannot answer or fail the request", async () => {
    let observed: string[] = [];
    bus.onApproval = (...ids) => { observed = ids; throw new Error("notification unavailable"); };
    const verdict = requestPeerApproval(bus, from, target, "same prompt", "ask_bot");
    const card = pendingCard(store, from)!;
    expect(observed).toEqual([from.id, from.threadId, card.card!.requestId, card.id]);
    expect(card.card!.answered).toBeUndefined();
    resolvePeerComms(bus, card.card!.requestId!, "deny");
    expect(await verdict).toBe("deny");
  });

  it("settles the card on deny too", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "delegate_bot");
    const card = pendingCard(store, from)!;
    resolvePeerComms(bus, card.card!.requestId!, "deny");
    expect(await verdict).toBe("deny");
    expect(store.messagesFor(from.threadId).find((m) => m.id === card.id)?.card?.answered).toBe("deny");
  });

  it("reports an unanswered card as expired, not as the user's denial", async () => {
    vi.useFakeTimers();
    try {
      const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
      const card = pendingCard(store, from)!;
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
      expect(await verdict).toBe("expired");
      const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
      expect(settled?.card?.dismissed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names who decided in the failure the calling bot reads", () => {
    expect(peerApprovalFailure("deny")).toEqual({ error: "denied by user", approvalOutcome: "deny", approvalSource: "user" });
    expect(peerApprovalFailure("expired")).toEqual({ error: "the approval card expired without an answer", approvalOutcome: "expired", approvalSource: "system" });
    expect(peerApprovalFailure("cancelled")).toEqual({ error: "the approval was cancelled before a decision", approvalOutcome: "cancelled", approvalSource: "system" });
  });

  it("answers an unknown requestId as not-ours, so provider cards still route", () => {
    expect(resolvePeerComms(bus, "not-a-peer-request", "allow")).toBe(false);
  });

  it("keys persistent grants by target identity, not mutable or duplicate names", async () => {
    const originalName = target.name;
    store.patchBot(from.id, { alwaysAllow: [peerAllowKey("ask_bot", target.id)] });
    store.patchBot(target.id, { name: "Renamed helper" });

    await expect(requestPeerApproval(bus, from, target, "ping", "ask_bot")).resolves.toBe("allow");
    expect(pendingCard(store, from)).toBeUndefined();

    const impostor = store.patchBot(store.createBot().id, { name: originalName })!;
    const verdict = requestPeerApproval(bus, from, impostor, "ping", "ask_bot");
    const card = pendingCard(store, from);
    expect(card).toBeTruthy();
    cancelPeerApprovalsFor(impostor.id);
    await expect(verdict).resolves.toBe("cancelled");
  });

  it("cancels and settles when the bot on either side is deleted", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;

    cancelPeerApprovalsFor(target.id);

    // nobody said no: this is a cancellation, not the user's denial (upstream #1526)
    expect(await verdict).toBe("cancelled");
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true); // not the user's answer
  });

  it("cancels and settles approvals owned by an interrupted thread", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;

    cancelPeerApprovalsForThread(from.threadId);

    expect(await verdict).toBe("cancelled");
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true);
    expect(pendingCard(store, from)).toBeUndefined();
  });

  it("dismisses cards left by a previous run, which nothing can answer", () => {
    // a card on disk whose in-memory approval died with the process
    const orphan = store.appendMessage(from.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "from-a-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    const settled = store.messagesFor(from.threadId).find((m) => m.id === orphan.id);
    expect(settled?.card?.dismissed).toBe(true);
    // and it is idempotent — a second boot must not re-dismiss or double count
    expect(dismissStalePeerCards(bus)).toBe(0);
  });

  it("dismisses stale cards in non-active task threads", () => {
    const background = store.createTask(from.id, "Background", false)!;
    const orphan = store.appendMessage(background.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "background-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    expect(
      store.messagesFor(background.threadId).find((message) => message.id === orphan.id)?.card?.dismissed,
    ).toBe(true);
  });

  it("leaves a live card alone at boot", async () => {
    void requestPeerApproval(bus, from, target, "ping", "ask_bot");
    expect(pendingCard(store, from)).toBeTruthy();
    expect(dismissStalePeerCards(bus)).toBe(0);
    expect(pendingCard(store, from)).toBeTruthy();
    cancelPeerApprovalsFor(from.id); // don't leave a timer pending
  });

  it("dismisses a stale card left in a ROOM thread", () => {
    // A Chief's peer call is made FROM the room it is speaking in, so the
    // card lands on a GROUP thread. The boot sweep used to walk only each
    // bot's own threads, so this card could never be settled after a crash
    // and the room's composer stayed blocked forever.
    const room = store.createGroup("Exec", [from.id, target.id]);
    const orphan = store.appendMessage(room.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "room-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    expect(
      store.messagesFor(room.threadId).find((message) => message.id === orphan.id)?.card?.dismissed,
    ).toBe(true);
    expect(dismissStalePeerCards(bus)).toBe(0);
  });

  it("dismisses a stale card in a room's non-active task thread", () => {
    const room = store.createGroup("Exec", [from.id, target.id]);
    const task = store.createGroupTask(room.id, "Side quest")!;
    const orphan = store.appendMessage(task.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to delegate to @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "room-task-dead-process",
        tool: "delegate_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    expect(
      store.messagesFor(task.threadId).find((message) => message.id === orphan.id)?.card?.dismissed,
    ).toBe(true);
  });

  // A bot-to-bot card in a scheduled or manual routine run is held open like
  // a permission card: no 15-minute expiry, the run waits on the owner, and
  // an allow given after the run's turn ended covers the same contact once
  // when the run carries on.
  describe("in a routine run", () => {
    const opened: string[] = [];
    const closed: Array<[string, string]> = [];
    let turnEnded = false;
    beforeEach(() => {
      opened.length = 0; closed.length = 0; turnEnded = false;
      bus = { store, broadcast: () => {}, routineCard: {
        opened: (_threadId, requestId) => { opened.push(requestId); return true; },
        closed: (_threadId, requestId, answer) => { closed.push([requestId, answer]); return turnEnded; },
      } };
    });

    it("never expires, and tells the run when it opens and closes", async () => {
      vi.useFakeTimers();
      try {
        const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
        const card = pendingCard(store, from)!;
        expect(opened).toEqual([card.card!.requestId]);
        vi.advanceTimersByTime(60 * 60_000);
        expect(pendingCard(store, from)?.id).toBe(card.id);
        resolvePeerComms(bus, card.card!.requestId!, "allow");
        expect(await verdict).toBe("allow");
        expect(closed).toEqual([[card.card!.requestId, "allow"]]);
      } finally { vi.useRealTimers(); }
    });

    it("an allow after the turn ended covers the same contact once when the run carries on", async () => {
      void requestPeerApproval(bus, from, target, "ping", "ask_bot");
      const card = pendingCard(store, from)!;
      turnEnded = true;
      resolvePeerComms(bus, card.card!.requestId!, "allow");
      expect(await requestPeerApproval(bus, from, target, "ping again", "ask_bot")).toBe("allow");
      expect(pendingCard(store, from)).toBeUndefined();
      // once only
      void requestPeerApproval(bus, from, target, "and again", "ask_bot");
      expect(pendingCard(store, from)).toBeTruthy();
    });
  });
});
