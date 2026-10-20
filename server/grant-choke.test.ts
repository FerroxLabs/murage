// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A13-FIX-DESIGN C1 amendment (Astra r3): a remembered approval is staged as
// a pending row, answered, and written only once the answer has landed. No
// reader reads the pending file, so whatever fails (the answer, the drop of
// the row, the active write), a grant that was never answered is never
// active. C1b: a bot-to-bot contact card is answered through the peer bus.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, RequestOutcome } from "./contracts.ts";
import { PendingGrants, rememberAndAnswer, type GrantChokeDeps, type GrantHolder, type RememberInput } from "./grant-choke.ts";
import { closeMessageDb } from "./message-db.ts";
import { peerAllowKey, peerApprovalHolder, requestPeerApproval, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { Store, type BotRecord } from "./store.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const BOB = "stop:message:bob@example.com";

/** A pending file whose writes can be made to fail on demand. */
function pendingFile(): { pending: PendingGrants; file: string; failNext: (times: number) => void; writes: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "murage-grant-choke-"));
  const file = join(dir, "pending-grants.json");
  let failures = 0;
  let writes = 0;
  const pending = new PendingGrants(file, (path, json) => {
    if (failures > 0) { failures -= 1; throw new Error("disk full"); }
    writes += 1;
    writeFileSync(path, json);
  });
  return { pending, file, failNext: (times) => { failures = times; }, writes: () => writes };
}

const onDisk = (file: string) => (existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8"))) : []);

/** A fake world: one open card held by the engine, an answer we script, and
 * the active grant list the write appends to. */
function world(options: { outcome?: RequestOutcome | Error; holder?: GrantHolder | undefined } = {}) {
  const { pending, file, failNext, writes } = pendingFile();
  const active: string[] = [];
  const inFlight = new Set<string>();
  const warned: unknown[] = [];
  const deps: GrantChokeDeps = {
    cardOpen: () => true,
    holder: () => ("holder" in options ? options.holder : { kind: "engine", instanceId: "claude" }),
    inFlight: (flight) => inFlight.has(flight),
    pending,
    attempt: () => {},
    answer: async (_holder, threadId, requestId) => {
      const flight = `${threadId}:${requestId}`;
      inFlight.add(flight);
      try {
        await Promise.resolve();
        const outcome = options.outcome ?? "allowed-once";
        if (outcome instanceof Error) throw outcome;
        return outcome;
      } finally { inFlight.delete(flight); }
    },
    warn: (error) => warned.push(error),
  };
  const input = (extra: Partial<RememberInput<string[]>> = {}): RememberInput<string[]> => ({
    res: {}, threadId: "t-1", requestId: "r-1", answer: true, onComputer: true, holderId: "bot-a",
    row: { kind: "bot", ownerId: "bot-a", taskThreadId: "t-1" },
    plan: () => [BOB],
    write: () => { active.push(BOB); return [...active]; },
    ...extra,
  });
  return { deps, input, active, pending, file, failNext, writes, warned, inFlight, options };
}

describe("C1 amendment: the write follows the answer, through a pending row", () => {
  it("stages, answers, writes, and drops the row; the write runs after the answer", async () => {
    const w = world();
    const order: string[] = [];
    const answer = w.deps.answer;
    w.deps.answer = async (...args) => { order.push("answer"); return answer(...args); };
    const decided = await rememberAndAnswer(w.deps, w.input({ write: () => { order.push("write"); w.active.push(BOB); return [BOB]; } }));
    expect(decided).toEqual({ ok: true, value: [BOB], outcome: "allowed-once" });
    expect(order).toEqual(["answer", "write"]);
    expect(w.active).toEqual([BOB]);
    expect(w.pending.ids()).toEqual([]);
    expect(onDisk(w.file)).toEqual([]);
    expect(w.writes()).toBe(2); // the row staged, the row dropped
  });

  it("fault injection: the answer fails, then the drop fails, and the grant is not active", async () => {
    const w = world({ outcome: new Error("engine went away") });
    const write = vi.fn(() => [BOB]);
    w.failNext(0);
    const run = rememberAndAnswer(w.deps, w.input({ write }));
    // the row is staged; now the drop that follows the failed answer fails too
    w.failNext(1);
    await expect(run).rejects.toThrow("engine went away");
    expect(write).not.toHaveBeenCalled();
    expect(w.active).toEqual([]);
    // the row stays pending, on disk and in memory, where no reader looks
    expect(w.pending.ids()).toEqual(["t-1:r-1"]);
    expect(onDisk(w.file)).toEqual(["t-1:r-1"]);
    expect(w.warned).toHaveLength(1);
    // the next call sweeps it (its flight is not live) and never promotes it:
    // only ITS own answer, once landed, writes its own keys
    w.options.outcome = "allowed-once";
    const later = await rememberAndAnswer(w.deps, w.input({ requestId: "r-2", write: () => { w.active.push("stop:message:eve@example.com"); return [...w.active]; } }));
    expect(later).toMatchObject({ ok: true, outcome: "allowed-once" });
    expect(w.pending.ids()).toEqual([]);
    expect(onDisk(w.file)).toEqual([]);
    expect(w.active).toEqual(["stop:message:eve@example.com"]);
  });

  it("a lost answer (Deny or another device won) writes nothing and reports what landed", async () => {
    for (const outcome of ["rejected", "unavailable", "answered"] as const) {
      const w = world({ outcome });
      const decided = await rememberAndAnswer(w.deps, w.input());
      expect(decided).toEqual({ ok: false, status: 409, error: "This request was answered elsewhere, so nothing was saved.", answered: outcome });
      expect(w.active).toEqual([]);
      expect(w.pending.ids()).toEqual([]);
    }
  });

  it("a write that fails after the answer landed says so, with the outcome, and leaves no grant", async () => {
    const w = world();
    const decided = await rememberAndAnswer(w.deps, w.input({ write: () => { throw new Error("disk full"); } }));
    expect(decided).toEqual({ ok: false, status: 500, error: "Allowed once. Always allow was not saved: disk full", answered: "allowed-once" });
    expect(w.active).toEqual([]);
    expect(w.pending.ids()).toEqual([]);
  });

  it("a stage that fails answers nothing: the card stays pending", async () => {
    const w = world();
    const answer = vi.fn(w.deps.answer);
    w.deps.answer = answer;
    w.failNext(1);
    const decided = await rememberAndAnswer(w.deps, w.input());
    expect(decided).toEqual({ ok: false, status: 500, error: "Nothing was saved: disk full" });
    expect(answer).not.toHaveBeenCalled();
    expect(w.active).toEqual([]);
    expect(w.pending.ids()).toEqual([]);
  });

  it("a plan that refuses (cap, bad key, no such bot) answers nothing and stages nothing", async () => {
    const w = world();
    const answer = vi.fn(w.deps.answer);
    w.deps.answer = answer;
    const decided = await rememberAndAnswer(w.deps, w.input({ plan: () => { throw Object.assign(new Error("This bot already remembers 200 approvals."), { status: 409 }); } }));
    expect(decided).toEqual({ ok: false, status: 409, error: "This bot already remembers 200 approvals." });
    expect(answer).not.toHaveBeenCalled();
    expect(w.writes()).toBe(0);
  });

  it("refuses without answer true, a closed card, another holder, a dead run and an in-flight answer, staging nothing", async () => {
    const w = world();
    expect((await rememberAndAnswer(w.deps, w.input({ answer: "true" }))).ok).toBe(false);
    w.deps.cardOpen = () => false;
    expect(await rememberAndAnswer(w.deps, w.input())).toMatchObject({ status: 409, error: "This request is no longer waiting." });
    w.deps.cardOpen = () => true;
    w.deps.holder = () => undefined;
    expect(await rememberAndAnswer(w.deps, w.input())).toMatchObject({ status: 409, error: "This request is no longer waiting." });
    w.deps.holder = () => ({ kind: "engine", instanceId: "claude" });
    expect(await rememberAndAnswer(w.deps, w.input({ live: () => false }))).toMatchObject({ status: 409 });
    w.inFlight.add("t-1:r-1");
    expect(await rememberAndAnswer(w.deps, w.input())).toMatchObject({ status: 409, error: "This request is being answered elsewhere, so nothing was saved." });
    expect(w.writes()).toBe(0);
    expect(w.active).toEqual([]);
  });

  it("the pending file: memory mirrors disk, a sweep keeps live flights, startup clears what was left", () => {
    const { pending, file, failNext } = pendingFile();
    const row = { threadId: "t", requestId: "r", kind: "bot" as const, ownerId: "b", keys: [BOB], at: 1 };
    pending.stage("t:r", row);
    pending.stage("t:s", { ...row, requestId: "s" });
    expect(onDisk(file)).toEqual(["t:r", "t:s"]);
    failNext(1);
    expect(() => pending.drop("t:r")).toThrow("disk full");
    expect(pending.ids().sort()).toEqual(["t:r", "t:s"]);
    expect(onDisk(file).sort()).toEqual(["t:r", "t:s"]);
    expect(pending.sweep((id) => id === "t:s")).toEqual(["t:r"]);
    expect(onDisk(file)).toEqual(["t:s"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restarted = new PendingGrants(file, (path, json) => writeFileSync(path, json));
    expect(restarted.ids()).toEqual([]);
    expect(onDisk(file)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 remembered choice never reached its answer"));
    warn.mockRestore();
  });
});

describe("C1b: a bot-to-bot contact card's Always allow saves through the choke point and approves the next contact", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
  let store: Store;
  let bus: ApprovalBus;
  let from: BotRecord;
  let target: BotRecord;

  beforeEach(() => {
    removeTempDirSync(DATA_DIR);
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Asker", approvePeerComms: true })!;
    target = store.patchBot(store.createBot().id, { name: "Helper" })!;
    bus = { store, broadcast: () => {} };
  });
  afterEach(async () => {
    closeMessageDb();
    await stopWalMaintenance();
    removeTempDirSync(DATA_DIR);
  });

  const openCard = () => store.openRequestCardRows(from.threadId).find((m) => m.card?.requestId && !m.card.answered && !m.card.dismissed);

  it("the peer bus is the holder, resolvePeerComms is the answer, and the grant lands after it", async () => {
    const first = requestPeerApproval(bus, from, target, "hello", "ask_bot");
    const card = openCard();
    expect(card?.card?.options).toEqual(["Allow", "Deny", "Always allow"]);
    const requestId = card!.card!.requestId!;
    const key = peerAllowKey("ask_bot", target.id);
    expect(card!.card!.allowKey).toBe(key);
    expect(peerApprovalHolder(requestId)).toEqual({ threadId: from.threadId, fromBotId: from.id, allowKey: key });
    // the wiring index.ts gives the choke point for a peer holder
    const { pending } = pendingFile();
    const inFlight = new Set<string>();
    const deps: GrantChokeDeps = {
      cardOpen: (threadId, id) => Boolean(store.openRequestCardRows(threadId).find((m) => m.card?.requestId === id && !m.card.answered && m.card.dismissed !== true)),
      holder: (threadId, id, holderId) => {
        const peer = peerApprovalHolder(id);
        return peer && peer.threadId === threadId && peer.fromBotId === holderId ? { kind: "peer" } : undefined;
      },
      inFlight: (flight) => inFlight.has(flight),
      pending,
      attempt: () => {},
      answer: async (holder, _threadId, id) => (holder.kind === "peer" && resolvePeerComms(bus, id, "allow") ? "allowed-once" : "unavailable"),
      warn: () => {},
    };
    const order: string[] = [];
    const answer = deps.answer;
    deps.answer = async (...args) => { order.push("answer"); return answer(...args); };
    // another bot cannot be granted the asker's card
    expect(await rememberAndAnswer(deps, { res: {}, threadId: from.threadId, requestId, answer: true, onComputer: true, holderId: target.id, row: { kind: "bot", ownerId: target.id }, plan: () => [key], write: () => store.rememberBotGrants(target.id, undefined, [key]) })).toMatchObject({ status: 409 });
    expect(store.bot(target.id)?.alwaysAllow ?? []).toEqual([]);
    const decided = await rememberAndAnswer(deps, {
      res: {}, threadId: from.threadId, requestId, answer: true, onComputer: true, holderId: from.id,
      row: { kind: "bot", ownerId: from.id, taskThreadId: from.threadId },
      plan: () => { order.push("plan"); const planned = store.planBotGrants(from.id, from.threadId, [key]).added; return [...new Set([...planned.bot, ...planned.task])]; },
      write: () => { order.push("write"); return store.rememberBotGrants(from.id, from.threadId, [key]); },
    });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    expect(order).toEqual(["plan", "answer", "write"]);
    await expect(first).resolves.toBe("allow");
    expect(store.messagesFor(from.threadId).find((m) => m.card?.requestId === requestId)?.card?.answered).toBe("allow");
    expect(store.bot(from.id)?.alwaysAllow).toEqual([key]);
    expect(new Store(selection).bot(from.id)?.alwaysAllow).toEqual([key]);
    expect(pending.ids()).toEqual([]);
    // the next contact is approved from the saved grant, with no card
    const second = requestPeerApproval(bus, store.bot(from.id)!, target, "again", "ask_bot");
    expect(openCard()).toBeUndefined();
    await expect(second).resolves.toBe("allow");
    // a second answer to the settled card finds no holder and saves nothing new
    expect(await rememberAndAnswer(deps, { res: {}, threadId: from.threadId, requestId, answer: true, onComputer: true, holderId: from.id, row: { kind: "bot", ownerId: from.id }, plan: () => [key], write: () => store.rememberBotGrants(from.id, undefined, [key]) })).toMatchObject({ status: 409 });
  });
});
