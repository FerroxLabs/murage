// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// NOLIM-UI2-CLI2 (Rev 3.3 U4/V3, the key cross-check): ONE real Store, the server's real thread preview, and the client's
// own reading of the same thread (pendingApprovals + chatRequestKey + boundToThread). The ids are literal, so a key that
// drifts between the two halves (a message id for a request id, a bare request id for the thread key) fails here and
// nowhere else. HEADLESS: the data dir is the suite's throwaway.
import { database } from "../../server/database.ts";
import { randomUUID } from "node:crypto";
import { openFixtureApproval } from "../../server/testing/approval-card.ts";
import { updateRecord } from "../../server/decision/records.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { ApproveAllBatches } from "../../server/approve-all.ts";
import { buildThreadPreview, storeDeps } from "../../server/approve-all-thread.ts";
import { DATA_DIR } from "../../server/config.ts";
import type { ModelSelection } from "../../server/contracts.ts";
import { Store } from "../../server/store.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";
import { boundToThread, chatRequestKey, requestIdOfKey, threadPreviewBody } from "../../shared/approve-all-thread";
import { pendingApprovals } from "@/lib/pending-approval";
import type { Message } from "@/state/store";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const OWNER = { reason: "no-grant", unattended: false, automated: false, keys: [], origin: "owner", noLimits: { n2: false, initiator: "owner" } };
let store: Store;
let at = 1_700_000_000_000;

const card = (threadId: string, requestId: string, extra: Record<string, unknown> = {}) => store.appendMessage(threadId, openFixtureApproval(database(), threadId, {
  id: randomUUID(), role: "bot", kind: "options", text: "May I?", at: at++,
  card: { title: "Approval needed", subtitle: "ls -la", options: ["Allow", "Deny"], requestId, tool: "bash", cardClass: OWNER, ...extra },
}) as never);

beforeEach(() => { removeTempDirSync(DATA_DIR); store = new Store(selection); });

describe("thread Approve all: the client and the server read one thread the same way", () => {
  it("A and C are eligible, B is an orphan (own reason), D is answered and never asked; the ids and stored message ids are literal", () => {
    const T = store.createBot().threadId;
    const U = store.createBot().threadId;
    const a = card(T, "A");
    const b = card(T, "B", { orphaned: true });
    const c = card(T, "C");
    const d = card(T, "D");
    updateRecord(database(), (d.card as unknown as { approvalId: string }).approvalId, { state: "answered", answer: "allow" });
    store.patchMessage(T, d.id, { card: { ...(store.messageById(T, d.id)!.card as object), answered: "allow" } } as never);
    const otherA = card(U, "A"); // the same request id in ANOTHER thread is another card

    // the client side: what the chat shows and sends
    const shown = pendingApprovals(store.messagesFor(T) as unknown as Message[]);
    expect(shown.map((p) => p.requestId)).toEqual(["A", "B", "C"]);
    const keys = shown.map((p) => chatRequestKey(T, p));
    expect(keys).toEqual([`${T}\u0000A`, `${T}\u0000B`, `${T}\u0000C`]);
    expect(keys.map((k) => requestIdOfKey(T, k))).toEqual(["A", "B", "C"]);
    expect(requestIdOfKey(U, keys[0])).toBeNull();
    const body = JSON.parse(threadPreviewBody(T, shown.map((p) => p.requestId)));
    expect(body).toEqual({ thread: { threadId: T, requestIds: ["A", "B", "C"] } });

    // the server side: the real preview on the same store
    const out = buildThreadPreview(storeDeps(store), new ApproveAllBatches({ now: () => 1000 }), { key: "desktop", deviceId: null }, body.thread.threadId, body.thread.requestIds);
    expect(out.status).toBe(200);
    const preview = out.body as any;
    expect(preview.eligible.map((e: any) => e.requestId)).toEqual(["A", "C"]);
    expect(preview.eligible.map((e: any) => e.messageId)).toEqual([a.id, c.id]);
    expect(preview.eligible.every((e: any) => e.threadId === T)).toBe(true);
    expect(preview.excluded.map((e: any) => [e.requestId, e.messageId, e.reasonKey])).toEqual([["B", b.id, "orphaned"]]);
    expect(preview.closed).toEqual([]);
    expect(preview.later).toEqual([]);
    expect(preview.eligible.map((e: any) => e.messageId)).not.toContain(otherA.id);
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4);
    expect(["A", "B", "C"]).not.toContain(a.id); // a message id is never the request id

    // and the client's own check of that preview against what it asked
    const bound = boundToThread(preview, T, keys);
    expect(bound).toMatchObject({ at: "cards", excluded: 1, later: 0 });
    if (bound.at !== "cards") throw new Error("expected cards");
    expect(bound.cards.map((e: any) => e.requestId)).toEqual(["A", "C"]);
  });

  it("a thread with only an orphan and an answered card reads as each-own (excluded), never as nothing left", () => {
    const T = store.createBot().threadId;
    card(T, "B", { orphaned: true });
    const shown = pendingApprovals(store.messagesFor(T) as unknown as Message[]);
    const keys = shown.map((p) => chatRequestKey(T, p));
    const out = buildThreadPreview(storeDeps(store), new ApproveAllBatches({ now: () => 1000 }), { key: "desktop", deviceId: null }, T, shown.map((p) => p.requestId));
    const bound = boundToThread(out.body as any, T, keys);
    expect(bound).toEqual({ at: "empty", excluded: 1, closed: 0 });
  });
});
