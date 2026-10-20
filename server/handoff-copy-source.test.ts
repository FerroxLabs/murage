// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 rule 6: a queued hand-off's source row is written at queue time, in the queue transaction, as the sender turn's engine row,
// and the room copy names it by `copyOf` (test 32: the legacy queue item yields the withheld line).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _resetPending, _simulateRestart, queueDelegation } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { _resetDrainDiagnostics } from "./shared-work.ts";
import { ownerWorld } from "./testing/handoff-worlds.ts";
import { isMurageVoice } from "./murage-voice.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); };
beforeEach(fresh);
afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

const itemOf = (id: string) => JSON.parse(String((database().prepare("SELECT item FROM pending_delegations WHERE id=?").get(id) as { item: string }).item)) as { sourceMessageId?: string; senderTurnId?: string | null };
const MESSAGE = "find the number the owner gave";

describe("rule 6: the source is persisted at queue time", () => {
  it("queueDelegation writes the sender's Messaged row as its turn's engine row and keeps its id on the queue item", () => {
    const w = ownerWorld();
    Object.assign(w.bus, { turnOf: (thread: string) => (thread === w.from.threadId ? "prov-sender" : undefined) });
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: MESSAGE, depth: 0 }, 2).id!;
    const item = itemOf(id);
    expect(item.sourceMessageId).toBeTruthy();
    const source = w.store.messagesFor(w.from.threadId).find(row => row.id === item.sourceMessageId) as Message;
    expect(source).toMatchObject({ role: "bot", kind: "activity", turnId: "prov-sender", from: { botId: w.from.id }, tool: { name: "Messaged @Helper" } });
    expect(isMurageVoice(source), "the source row is the sender's own, not a Murage line").toBe(false);
  });
  it("the room copy is the sender's bot row naming that row by copyOf; the source thread gets no second Messaged row", async () => {
    const w = ownerWorld();
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: MESSAGE, depth: 0 }, 2).id!;
    const sourceId = itemOf(id).sourceMessageId!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const copy = w.store.groups.flatMap(group => w.store.messagesFor(group.threadId)).find(row => row.text === MESSAGE);
    expect(copy).toMatchObject({ role: "bot", kind: "text", from: { botId: w.from.id }, copyOf: { threadId: w.from.threadId, messageIds: [sourceId] } });
    expect(isMurageVoice(copy as Message)).toBe(false);
    expect(copy?.turnId).toBeUndefined();
    expect(w.store.messagesFor(w.from.threadId).filter(row => row.tool?.name === "Messaged @Helper")).toHaveLength(1);
  });
  it("rule 7: the hand-off's turn starts with handoffOf naming that row; a legacy item starts without it", async () => {
    const w = ownerWorld();
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: MESSAGE, depth: 0 }, 2).id!;
    const sourceId = itemOf(id).sourceMessageId!;
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(w.turns.map(turn => turn.handoffOf)).toEqual([{ threadId: w.from.threadId, messageId: sourceId }]);
    const legacyWorld = ownerWorld();
    const legacyId = queueDelegation(legacyWorld.bus, legacyWorld.from, { toBotId: legacyWorld.target.id, message: MESSAGE, depth: 0 }, 2).id!;
    const legacy = itemOf(legacyId); delete legacy.sourceMessageId;
    database().prepare("UPDATE pending_delegations SET item=? WHERE id=?").run(JSON.stringify(legacy), legacyId);
    _simulateRestart();
    await dispatchHandoff(legacyId, { bus: legacyWorld.bus, approvalBus: legacyWorld.approvalBus });
    expect(legacyWorld.turns.map(turn => turn.handoffOf)).toEqual([undefined]);
  });
  it("a legacy queue item with no source row puts Murage's withheld line in the room, never the message", async () => {
    const w = ownerWorld();
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: MESSAGE, depth: 0 }, 2).id!;
    const legacy = itemOf(id); delete legacy.sourceMessageId; delete legacy.senderTurnId;
    database().prepare("UPDATE pending_delegations SET item=? WHERE id=?").run(JSON.stringify(legacy), id);
    _simulateRestart();
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const room = w.store.groups.flatMap(group => w.store.messagesFor(group.threadId));
    expect(room.some(row => row.text === MESSAGE)).toBe(false);
    expect(room.some(row => row.murage?.status?.key === "withheld")).toBe(true);
  });
});
