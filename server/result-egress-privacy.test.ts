// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress, RowSink } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import { CoordinationBudget } from "./coordination-budget.ts";
import { closeDatabase, database } from "./database.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { askBotRoute, type AskBotRouteContext } from "./handoff-boundary.ts";
import { humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, shareHumanScope, threadHumanPrincipal } from "./human-principals.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { closeMessageDb } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { linkMemoryDisclosureOutput } from "./memory/disclosures.ts";
import { addTurnParents, closeTurnLineage, currentLsn, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import { memoryState } from "./memory/repository.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";
import { configureStatusRoster, outboundWords } from "./murage-status.ts";
import { turnAudienceIsOwner } from "./owner-audience.ts";
import { dispatchProjectUsageTurn } from "./project-usage-dispatch.ts";
import { configureResultEgress, releaseAskReply, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { insertRoomRequest } from "./room-requests.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const SECRET = "DELEGATED_RESULT_41";
beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => {
  configureResultEgress(undefined); configureBotEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks();
});

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const chief = store.createBot({ name: "Chief", section: "Ops" }, { seedMessages: false });
  const worker = store.createBot({ name: "Worker", section: "Ops" }, { seedMessages: false });
  store.setChiefOfStaff(chief.id, undefined, "workspace");
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
    // Isolate the write-time layer; the legacy checks cannot mask a missing mark here.
    messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => false,
    linesShown: writetimeLinesShown(database), withheldLine: "[withheld]",
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(bot => bot.name === name));
  return { store, chief, worker, deps };
}

it("the owner receives a Chief's delegated reply after moving a sub-bot to another team bumps policy between write and release", () => {
  const { store, chief, worker, deps } = world();
  const subBot = store.createBot({ name: "New sub-bot", section: "Ops" }, { seedMessages: false });
  const turn = openTurnLineage(database(), { threadId: worker.threadId, turnId: "delegated" });
  // An inherited receipt age, with no receipt revocation: only the policy watermark is under test.
  addTurnParents(turn, [{ kind: "receipt", bundleId: "inherited", lsn: currentLsn(database()), scopeIds: [] }]);
  const message = store.appendMessage(worker.threadId, { role: "bot", kind: "text", text: SECRET });
  closeTurnLineage(turn);
  const release = () => releaseAskReply({ requestId: "owner-ask", origin: { threadId: worker.threadId, messageIds: [message.id] } },
    worker.id, chief.threadId, { fromBotId: chief.id }, false, new WorkerText(SECRET), deps);
  expect(release()).toMatchObject({ ok: true, withheld: false });
  // an audience change moves the policy revision; adding a bot withdraws nothing and would not
  store.patchBot(subBot.id, { section: "Moved team" });
  const page = { threadId: worker.threadId, lines: [{ messageId: message.id, author: "generated" as const }] };
  expect(denyLookup(database(), page, { audience: { owner: true, scopeIds: [] } }).get(message.id))
    .toEqual({ state: "withheld", reason: "watermark" });
  const result = release();
  expect(result).toMatchObject({ ok: true, withheld: false });
  if (result.ok) expect(outboundWords(result.text)).toBe(SECRET);
});

it.each(["forget", "delete"] as const)("a %s of the delegated reply's source still withholds it from the owner", cause => {
  const { store, chief, worker, deps } = world();
  const source = store.appendMessage(chief.threadId, { role: "user", kind: "text", text: SECRET });
  const turn = openTurnLineage(database(), { threadId: worker.threadId, turnId: "delegated" });
  addTurnParents(turn, [{ kind: "line", threadId: chief.threadId, messageId: source.id }]);
  const message = store.appendMessage(worker.threadId, { role: "bot", kind: "text", text: SECRET });
  closeTurnLineage(turn);
  const release = () => releaseAskReply({ requestId: "owner-ask", origin: { threadId: worker.threadId, messageIds: [message.id] } },
    worker.id, chief.threadId, { fromBotId: chief.id }, false, new WorkerText(SECRET), deps);
  expect(release()).toMatchObject({ ok: true, withheld: false });
  commitRevoke(database(), { kind: "line", threadId: chief.threadId, messageIds: [source.id], cause });
  expect(drainRevokeMarker(database()).pending).toBe(false);
  const result = release();
  expect(result).toMatchObject({ ok: true, withheld: true });
  if (result.ok) expect(outboundWords(result.text)).toBe("[withheld]");
});

it.each([false, true])("a person's scope revocation withholds a nested request-bound ask and its pair-room mirror (marker drained: %s)", async drained => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { store, chief, worker, deps } = world();
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "TEAM", userId: "CONTACT" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(binding);
  const askerThread = humanTask(store, chief.id, person)!.threadId;
  const workerThread = humanTask(store, worker.id, person)!.threadId;
  const pair = getOrCreateChannel(store, chief, worker, askerThread);
  const f = new WritetimeFixture(database());
  shareHumanScope(ownerMemoryTicket(), { personId: person.personId, scopeId: "s-room", granted: true });
  const initiator = store.createBot({ name: "Initiator", section: "Ops" }, { seedMessages: false });
  const initiatorThread = humanTask(store, initiator.id, person)!.threadId;
  const rootPair = getOrCreateChannel(store, initiator, chief, initiatorThread);
  const parent = insertRoomRequest(database(), { groupId: rootPair.id, verb: "ask", fromKind: "bot", fromBotId: initiator.id,
    toBotId: chief.id, targetThreadId: askerThread, returnThreadId: rootPair.threadId, admissionKey: "outer", state: "running", now: 1,
    lineage: { rootThreadId: rootPair.threadId, origin: "desktop", audienceFingerprint: person.personId, notOwnerAudience: true, unattended: false },
  }).request;
  const request = insertRoomRequest(database(), { parentId: parent.id, groupId: pair.id, verb: "ask", fromKind: "bot", fromBotId: chief.id,
    toBotId: worker.id, targetThreadId: workerThread, returnThreadId: askerThread, admissionKey: "nested", state: "running", now: 1,
    lineage: { rootThreadId: pair.threadId, origin: "desktop", audienceFingerprint: person.personId, notOwnerAudience: true, unattended: false },
  }).request;
  const registry = new InternalCapabilities();
  const generation = registry.begin(chief.id, askerThread, "person-turn", threadHumanPrincipal(askerThread));
  const claim = registry.resolve(`Bearer ${registry.mint({ botId: chief.id, threadId: askerThread, generation,
    depth: 1, kind: "agents", skillAuthoring: false, humanPrincipal: person, notOwnerAudience: true })}`)!;
  const bindings = new Map<string, string>();
  const mirrored: string[] = [], sent: unknown[] = [];
  configureBotEgress((_res, code, body) => { expect(code).toBe(200); sent.push(body); });
  const coordinationBudget = new CoordinationBudget(`${DATA_DIR}/coordination-fixture.json`);
  const context = {
    store: boundaryStore(store), resultEgressDeps: deps, rows: new RowSink(store),
    internalCapabilities: registry, internalClaim: claim, internalOwner: { coordination: coordinationBudget.begin(chief.id) },
    MAX_COMMS_DEPTH: 2, ASK_BOT_TIMEOUT_MS: 1000, coordinationBudget, coordinationHasCapacity: () => true,
    readInternalBody: async () => ({ fromBotId: chief.id, fromThreadId: askerThread, toBotId: worker.id, message: "nested ask", depth: 1 }),
    requireActiveInternal: () => {}, res: {}, connectorThread: () => ({ bot: chief }),
    roomAskRefused: () => undefined, roomAskDuplicate: () => undefined, roomAskParent: () => {
      expect(bindings.get(generation)).toBe(parent.id); return parent;
    },
    roomAskKey: () => "nested", beginRoomAsk: () => request.id, settleRoomAsk: () => {},
    sourceExecutionAudience: () => null, ownerSurfacesByThread: new Map([[askerThread, false]]),
    delegationWatch: new Map(), syncAskRequests: new Map(), sharedApprovedRequests: new Set(),
    fullAccessSkipsPeerCard: () => false,
    eventAction: async (_spec: unknown, act: (handle: unknown) => Promise<unknown>) => act({ charge: async () => {}, record: () => {}, unrun: () => {} }),
    comms: { channel: () => pair, exchange: () => {}, audienceTask: () => ({ threadId: workerThread }),
      reply: (_bot: unknown, text: Parameters<typeof outboundWords>[0], _room: unknown, copyOf: unknown) => {
        mirrored.push(outboundWords(text)); expect(copyOf).toBeUndefined(); return "mirror";
      } },
    askBotAndWait: async (...args: unknown[]) => {
      expect(args[7]).toBe(true);
      const message = store.appendMessage(workerThread, { role: "bot", kind: "text", text: SECRET });
      f.receipt("person-receipt", workerThread, "fixture", "session", { policyRevision: memoryState().policyRevision, deletionEpoch: memoryState().deletionEpoch });
      f.source("shared-source", "s-room");
      database().prepare("UPDATE memory_disclosures SET source_versions=? WHERE bundle_id='person-receipt'").run(JSON.stringify([{ id: "shared-source", revision: 1 }]));
      linkMemoryDisclosureOutput("person-receipt", message.id);
      const page = { threadId: workerThread, lines: [{ messageId: message.id, author: "generated" as const }] };
      expect(denyLookup(database(), page, { audience: { owner: false, scopeIds: ["s-room"] } }).get(message.id)?.state).toBe("shown");
      shareHumanScope(ownerMemoryTicket(), { personId: person.personId, scopeId: "s-room", granted: false });
      expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id='person-receipt'").get()?.state).toBe("revoked");
      if (drained) expect(drainRevokeMarker(database()).pending).toBe(false);
      // No deleted content: the old null-audience exception still shows these exact words.
      expect(denyLookup(database(), page, { audience: null }).get(message.id)?.state).toBe("shown");
      expect(deps.linesShown!(workerThread, [message.id], false)).not.toBe("shown");
      return { status: "reply", hasText: true, text: new WorkerText(SECRET), copyOf: { threadId: workerThread, messageIds: [message.id] } };
    },
  } as unknown as AskBotRouteContext;
  await dispatchProjectUsageTurn({ threadId: askerThread, text: "pair-room request" },
    { request: parent, generation, botId: chief.id, engine: "fixture" }, {
      bindings, pending: new Map(), turns: new Map(), project: false, interrupt: () => {}, failure: () => {},
      send: async () => { await askBotRoute(context); return { turnId: "provider-turn" }; },
    });
  expect(mirrored).toEqual(["[withheld]"]);
  expect(sent).toEqual([expect.objectContaining({ text: "[withheld]" })]);
  expect(JSON.stringify(sent)).not.toContain(SECRET);
});

// index.ts starts the server when imported. Execute its actual audience initializer against real linked principals,
// then mint the claim with that result. The API companion test also observes the complete dispatch when sockets are available.
it("the direct-turn initializer flags a linked person's nested turn and preserves desktop and companion owner turns", () => {
  const { store, chief, worker } = world();
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "TEAM", userId: "CONTACT" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const thread = humanTask(store, worker.id, resolveHumanBinding(binding))!.threadId;
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const expression = /const memoryNotOwner = ([^;]+);/.exec(source)?.[1];
  expect(expression).toBeTruthy();
  const decide = new Function("humanIsOwner", "surfacesForOwner", "opts", `return ${expression};`) as
    (human: boolean, surfaces: boolean, opts?: { notOwnerAudience?: boolean }) => boolean;
  for (const [threadId, origin, inherited, expected] of [
    [thread, "desktop", false, true], [thread, "companion", false, true],
    [chief.threadId, "desktop", false, false], [chief.threadId, "companion", false, false],
    [chief.threadId, "unproven", false, true], [chief.threadId, "desktop", true, true],
  ] as const) {
    const notOwner = decide(turnAudienceIsOwner(threadId), turnAudienceIsOwner(threadId, { origin }), { notOwnerAudience: inherited });
    expect(notOwner).toBe(expected);
    const registry = new InternalCapabilities(), principal = threadHumanPrincipal(threadId);
    const generation = registry.begin(worker.id, threadId, undefined, principal);
    const token = registry.mint({ botId: worker.id, threadId, generation, humanPrincipal: principal, depth: 1,
      kind: "agents", skillAuthoring: false, ...(notOwner ? { notOwnerAudience: true as const } : {}) });
    expect(registry.resolve(`Bearer ${token}`)?.notOwnerAudience === true).toBe(expected);
  }
  // F3 (6ef059ff6): the coordination argument is now the request tree's (requestCoordination falls back to opts?.coordination); the two audience arguments are unchanged
  expect(source).toContain("beginInternalTurn(bot.id, threadId, dispatchClaimId, commsDepth, skillAuthoring, eventId, requestCoordination, memoryNotOwner, directOwnerAudience)");
  expect(source).toContain("beginInternalTurn(bot.id, threadId, internalGeneration, hop, skillAuthoring, undefined, undefined, !roomOwnerAudience, roomOwnerAudience)");
});
