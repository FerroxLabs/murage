// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13-boot2, Astra's review (astra-boot2/REPORT.md): each test reproduces a High finding on d6cee1176.
//  2a  the open-card walk after listen: a held lock in the middle of it leaves the walk's mark where it stood; the retry settles the card
//  2b  a boot recovery whose attempts are all spent on held locks runs again later in this process, not at the next launch
//  3   a kept receipt whose boot settle meets a held lock is settled by the stranded sweep in this process (it was skipped until restart)
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readySettle, startRecovery } from "./after-listen.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, DatabaseBusyError } from "./database.ts";
import * as delegations from "./delegations.ts";
import { _resetPending, findDelegationReceipt, onDelegationReceipt, queueDelegation, recordDelegationReceipt, reconcileStartedDelegations } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { staleHostConsentCardKind } from "./host-computer-consent.ts";
import { insertMessage, messagesHighWater, readMessage, updateMessage } from "./message-db.ts";
import { settleStaleCardsFromMark, stalePeerCardKind, type ApprovalBus, type StaleCardMark } from "./peer-approval.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { completeRequest, roomRequest } from "./room-requests.ts";
import type { Message } from "./store.ts";
import { ownerWorld } from "./testing/handoff-worlds.ts";
import { ensureOpenCardIndex } from "./transcript-backfill.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); };
const quietly = async <T>(run: () => T | Promise<T>): Promise<T> => {
  const error = console.error, warn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await run(); } finally { console.error = error; console.warn = warn; }
};
beforeEach(fresh);
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

describe("2a. the open-card walk after listen", () => {
  it("a held lock while a page settles leaves the mark where the walk stood: the retry dismisses the dead card, and only then is the walk done", async () => {
    insertMessage("owned", { id: "dead", at: 1, role: "bot", kind: "options", text: "ask", parentId: null, card: { title: "c", options: [], requestId: "gone", tool: "ask_bot" } } as never);
    const db = database();
    db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'");
    ensureOpenCardIndex(db);
    let busy = true;
    const bus = { store: { bots: [], groups: [], patchMessagePoint: (thread: string, id: string, patch: Partial<Message>) => {
      if (busy) { busy = false; throw new DatabaseBusyError("card-settle", 50); }
      const current = readMessage(thread, id);
      if (!current) return null;
      const next = { ...current, ...patch } as Message;
      updateMessage(thread, next);
      return next;
    } } } as unknown as ApprovalBus;
    const kinds = [stalePeerCardKind(), staleHostConsentCardKind()], owned = new Set(["owned"]), high = messagesHighWater();
    const mark: StaleCardMark = { at: undefined };
    await expect(settleStaleCardsFromMark(bus, kinds, mark, high, owned, async () => {})).rejects.toBeInstanceOf(DatabaseBusyError);
    expect(mark.at).not.toBeNull();                                                   // on d6cee1176 the marker was null before the walk ran
    expect(readMessage("owned", "dead")?.card?.dismissed).toBeUndefined();
    expect(await settleStaleCardsFromMark(bus, kinds, mark, high, owned, async () => {})).toBe(1);
    expect(readMessage("owned", "dead")?.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(mark.at).toBeNull();
    expect(await settleStaleCardsFromMark(bus, kinds, mark, high, owned, async () => {})).toBe(0);
  });
  it("index.ts walks the list through the mark, and the walk after the list completes is a recovery of its own (source check)", async () => {
    const { readFileSync } = await import("node:fs");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("staleCardsResumeAt = null;");
    expect(index).toContain("settleStaleCardsFromMark(approvalBus, [stalePeerCardKind(), staleHostConsentCardKind()], staleCards, cardSweepHigh)");
    expect(index).toContain("const settleCardsFromList = readySettle({");
    expect(index).toContain("void startRecovery(settle,");
    expect(index).not.toContain("onThreadCardsReady(threadId => {\n      if (threadId !== null");   // the per-attempt listener of 89ebcf225
    expect(index).not.toContain("function startRecovery(");
  });
});

describe("2b. a boot recovery that keeps meeting a held lock", () => {
  it("after its attempts are spent it runs again periodically until it finishes; any other failure is reported once, never repeated", async () => {
    let calls = 0;
    const reported: unknown[] = [];
    const first = quietly(() => startRecovery(async () => { calls++; if (calls <= 3) throw new DatabaseBusyError("recovery", 50); }, (error) => reported.push(error), { attempts: 2, firstPauseMs: 1, periodicMs: 20, track: false }));
    await first;
    expect(calls).toBe(2);                                                              // the first cycle ended on a held lock
    await quietly(() => sleep(300));
    expect(calls).toBe(4);                                                              // on d6cee1176: 2, left until the next launch
    expect(reported).toEqual([]);
    await sleep(100);
    expect(calls).toBe(4);                                                              // finished: no more runs
    let failing = 0;
    await startRecovery(async () => { failing++; throw new Error("broken"); }, (error) => reported.push(error), { attempts: 2, firstPauseMs: 1, periodicMs: 20, track: false });
    await sleep(100);
    expect(failing).toBe(1);
    expect(reported).toHaveLength(1);
  });
});

describe("2c. the settle from the open-card list, asked for by every attempt of the sweep (astra-boot2-r2)", () => {
  it("repeated busy attempts before the list is ready leave ONE listener; the list completing starts exactly one recovery, and calls never overlap", async () => {
    let ready = false, listeners = 0, recoveries = 0, runs = 0, active = 0, overlap = 0;
    const signals = new Set<() => void>();
    const signal = () => { for (const listener of [...signals]) listener(); };
    let release!: () => void;
    const settle = readySettle({
      ready: () => ready,
      subscribe: (listener) => { listeners++; signals.add(listener); return () => { signals.delete(listener); }; },
      run: async () => { runs++; active++; overlap = Math.max(overlap, active); await new Promise<void>((resolve) => { release = resolve; }); active--; },
      recover: (run) => { recoveries++; void run(); },
    });
    // three attempts of the sweep, each ending on a held lock later in the sweep (89ebcf225 registered one listener per attempt)
    for (let attempt = 0; attempt < 3; attempt++) await settle();
    expect(listeners).toBe(1);
    expect(signals.size).toBe(1);
    ready = true;
    signal();
    signal();                                                                           // a second completion signal changes nothing
    expect(recoveries).toBe(1);
    expect(signals.size).toBe(0);
    await sleep(0);
    expect(runs).toBe(1);
    const joined = settle();                                                            // a later sweep attempt joins the settle in flight
    await sleep(0);
    expect(runs).toBe(1);
    release();
    await joined;
    expect(overlap).toBe(1);
    const again = settle();                                                             // once it has finished, a new ask runs it again (idempotent mark)
    await sleep(0);
    expect(runs).toBe(2);
    release();
    await again;
    expect(overlap).toBe(1);
  });
});

describe("3. a hand-off receipt whose boot settle meets a held lock", () => {
  it("is settled by the stranded sweep in this process (the boot cursor moved past it and drains skip started rows); the line and request end once", async () => {
    const w = ownerWorld("room");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it once", depth: 0 }, 2).id!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(roomRequest(database(), id)!.state).toBe("running");
    let busy = true, ended = 0;
    onDelegationReceipt((receipt) => {
      if (busy) throw new DatabaseBusyError("delegation-receipt-settle", 50);
      ended++;
      completeRequest(database(), receipt.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now() });
    });
    await quietly(() => recordDelegationReceipt({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" }));
    const row = () => database().prepare("SELECT phase FROM pending_delegations WHERE id=?").get(id) as { phase: string } | undefined;
    expect(row()?.phase).toBe("started");
    // a restart: the boot settling finds the kept receipt, meets the held lock again, and its cursor moves on
    delegations._simulateRestart();
    delegations._loadPending();
    expect(findDelegationReceipt(id)).toBeTruthy();
    await quietly(() => reconcileStartedDelegations());
    expect(row()?.phase).toBe("started");
    expect(roomRequest(database(), id)!.state).toBe("running");
    busy = false;
    expect(delegations.resettleStranded()).toBe(1);                                    // on d6cee1176: 0, the receipt waited for the next start
    expect(row()).toBeUndefined();
    expect(roomRequest(database(), id)!.state).toBe("done");
    expect(ended).toBe(1);
    expect(delegations.resettleStranded()).toBe(0);
    expect(w.turns.filter((turn) => turn.id === id)).toHaveLength(1);                   // never dispatched again
  });
});
