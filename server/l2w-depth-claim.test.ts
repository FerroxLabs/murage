// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2W 1.0.23 (designs/L2W-1023-WARM-MAP.md r3) L2W-1a, donor row #5768: the ask-bot and delegate-bot routes take the turn depth from the
// token record (internalClaim.depth), never from the request body. The agents proxy sends no depth field any more, so a route that still
// read `body.depth ?? 0` would let a teammate at the cap queue an unbounded bot-to-bot chain (Opus r1 H1).
// Real routes, real capability claim, real queue and database; only peer policy is bypassed (as delegation-pack-enqueue.test.ts does).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { boundaryComms, boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { askBotRoute, delegateBotRoute, type AskBotRouteContext, type DelegateBotRouteContext } from "./handoff-boundary.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { MurageStatus, status } from "./murage-status.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("./host-words.ts", async original => ({
  ...await original<typeof import("./host-words.ts")>(), authorizeStatus: () => ({ ok: true }),
}));
beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); });
afterEach(() => { configureBotEgress(undefined); closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });

const MAX = 4;
function world(depth: number) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot({ name: "Sable" }, { seedMessages: false });
  const target = store.createBot({ name: "Ember" }, { seedMessages: false });
  const comms = boundaryComms({ store, broadcast: () => {} });
  const queue = vi.spyOn(comms, "queueDelegation");
  const caps = new InternalCapabilities();
  const generation = caps.begin(from.id, from.threadId);
  const token = caps.mint({ botId: from.id, threadId: from.threadId, generation, depth, kind: "agents", skillAuthoring: false });
  const claim = caps.resolve(`Bearer ${token}`)!;
  const replies: Array<{ code: number; body: any }> = [];
  const context = {
    MAX_COMMS_DEPTH: MAX, store: boundaryStore(store), comms,
    internalCapabilities: Object.assign(caps, { turnInputOf: () => undefined }), internalClaim: claim,
    internalOwner: {}, ownerSurfacesByThread: new Map(), isUnattended: () => false,
    connectorThread: () => true, coordinationBudget: { advance: () => undefined },
    fullAccessSkipsPeerCard: () => false, roomAskDuplicate: () => null, roomAskParent: () => undefined,
    roomAskRefused: () => undefined, routinePeerSource: () => undefined, sourceExecutionAudience: () => undefined,
    beginRoomAsk: () => "fixture-request", resultEgressDeps: {}, taskResolutionDeps: {}, requireActiveInternal: () => {},
    eventAction: async (_spec: unknown, run: (handle: unknown) => unknown) => run({ charge: async () => {}, record: () => {}, unrun: () => {} }),
    // what the agents proxy sends after L2W: no depth field
    readInternalBody: async () => ({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "the note" }), res: {},
  };
  configureBotEgress((_res, code, body) => { replies.push({ code, body }); });
  const error = () => { const e = replies.at(-1)?.body?.error; return typeof e === "string" ? e : undefined; };
  const pending = () => Number(database().prepare("SELECT count(*) AS n FROM pending_delegations").get()?.n ?? 0);
  return { context, queue, replies, pending, error };
}

it("L2W-1a ask-bot: a token at MAX_COMMS_DEPTH with no body depth is refused depth_exhausted, nothing queued", async () => {
  const w = world(MAX);
  // past the cap the route would go on to the ask ports this harness does not wire; the refusal must come first
  const crashed = await askBotRoute(w.context as unknown as AskBotRouteContext).then(() => undefined, (error: unknown) => error);
  expect(w.error()).toBe(MurageStatus.words(status("depth_exhausted")));
  expect(crashed).toBeUndefined();
  expect(w.queue).not.toHaveBeenCalled();
});

it("L2W-1a delegate-bot: a token at MAX_COMMS_DEPTH with no body depth is refused depth_exhausted_delegate, nothing queued", async () => {
  const w = world(MAX);
  await delegateBotRoute(w.context as unknown as DelegateBotRouteContext);
  expect(w.error()).toBe(MurageStatus.words(status("depth_exhausted_delegate")));
  expect(w.pending()).toBe(0);
});

it("L2W-1a delegate-bot: a depth-1 token with no body depth queues the child at the claim's depth, not 0", async () => {
  const w = world(1);
  await delegateBotRoute(w.context as unknown as DelegateBotRouteContext);
  expect(w.queue).toHaveBeenCalled();
  expect((w.queue.mock.calls.at(-1)?.[1] as { depth?: number }).depth).toBe(1);
  expect(w.pending()).toBe(1);
});
