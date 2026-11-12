// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, isOwnerOrigin, type Message } from "./store.ts";
import { boundaryComms, boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { delegateBotRoute, type DelegateBotRouteContext } from "./handoff-boundary.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { sendStore } from "./send-store.ts";
import { queueSteeredMessage, drainSteeredMessages, _resetQueuedStarts, queuedStartPending } from "./steer-queue.ts";
import { runQueuedStart } from "./ask-turn-device.ts";
import { threadHumanPrincipal, isWorkspaceOwner } from "./human-principals.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { configureHandoffDispatch, dispatchHandoff } from "./handoff-dispatch.ts";
import { fakeHost } from "./testing/handoff-turn.ts";
import { promptCarriesOutside } from "./email/external-marks.ts";
import { automationForTurn } from "./message-automation.ts";
import { answerDelegationPackRoute } from "./delegation-pack-routes.ts";
import { readDelegationPack } from "./thread-recall.ts";
import { botMessages } from "./bot-read.ts";
import { forgottenMessageSources } from "./memory/replay-lineage.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";

vi.mock("./host-words.ts", async original => ({ ...await original<typeof import("./host-words.ts")>(), authorizeStatus: () => ({ ok: true }) }));
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function find(predicate: (n: ts.Node) => boolean): ts.Node | undefined {
  let result: ts.Node | undefined; const visit = (n: ts.Node) => { if (!result && predicate(n)) result = n; if (!result) ts.forEachChild(n, visit); }; visit(ast); return result;
}
function evaluate(code: string, env: Record<string, unknown>) {
  return new Function(...Object.keys(env), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(env));
}
function fn(name: string, env: Record<string, unknown>) {
  const node = find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  expect(node, name).toBeDefined(); return evaluate(`${node!.getText(ast)}; return ${name};`, env);
}
beforeEach(() => { _resetQueuedStarts(); closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); });
afterEach(() => { configureBotEgress(undefined); closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });
useOutsideStoreFixture();

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot({ name: "Sable" }, { seedMessages: false }), target = store.createBot({ name: "Ember" }, { seedMessages: false });
  const caps = new InternalCapabilities(), owners = new Map<string, any>();
  const turnInputOf = fn("turnInputOf", { internalCapabilities: caps, internalTurnOwners: owners });
  Object.assign(caps, { turnInputOf });
  const bus = { store, broadcast: () => {} }, comms = boundaryComms(bus), queue = vi.spyOn(comms, "queueDelegation");
  const turns: Array<{ opts: any; message: Message; generation: string }> = [];
  const startTurn = async (_bot: string, text: string, opts: any) => {
    const generation = caps.begin(from.id, from.threadId);
    const message = opts.userMessage ?? store.appendMessage(from.threadId, { role: "user", kind: "text", text, origin: opts.origin });
    const predicate = find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "ownerPackAuthority") as ts.VariableDeclaration;
    expect(predicate, "server-owned pack provenance predicate").toBeDefined();
    const routine = find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "routineOrigin") as ts.VariableDeclaration;
    const routineOrigin = evaluate(`return (${routine.initializer!.getText(ast)});`, { opts });
    const ownerPackAuthority = evaluate(`return (${predicate.initializer!.getText(ast)});`, { opts, directOwnerAudience: true, routineOrigin, commsDepth: opts.commsDepth ?? 0, isOwnerOrigin });
    owners.set(from.threadId, { generation, botId: from.id, triggerMessageId: message.id, ownerPackAuthority });
    turns.push({ opts, message, generation }); return message;
  };
  const env: Record<string, any> = { store, sendStore, queueSteeredMessage, drainSteeredMessages, runQueuedStart, queuedStartPending,
    isOwnerOrigin, threadHumanPrincipal, isWorkspaceOwner, startTurn, cfg: {}, threadAdmission: { run: (_id: string, go: () => unknown) => go() },
    botForDirectThread: () => from, promptWithReply: (text: string) => text, replyForPrompt: () => undefined,
    activeGroupTurnForBot: () => undefined, directThreadBusy: () => false, turnImages: { promote: () => [] },
    PHONE_IDLE_ENTRY: Symbol(), PHONE_TICKET: Symbol(), HL_OWNER_TICKET: Symbol(), phonesOfferedNow: () => false, phoneMintEligible: () => false,
    RECENT_SEND_ROWS: 10, murageLine: (row: unknown) => row, sendNoticeError: (message: string) => new Error(message),
  };
  const drain = fn("drainQueuedSends", env); env.drainQueuedSends = drain;
  const admit = fn("admitDirectSend", env);
  const run = async () => {
    const latest = turns.at(-1)!;
    const token = caps.mint({ botId: from.id, threadId: from.threadId, generation: latest.generation, depth: 0, kind: "agents", skillAuthoring: false });
    configureBotEgress(() => {});
    await delegateBotRoute({ MAX_COMMS_DEPTH: 4, store: boundaryStore(store), comms,
      internalCapabilities: caps, internalClaim: caps.resolve(`Bearer ${token}`), internalOwner: owners.get(from.threadId),
      ownerSurfacesByThread: new Map(), isUnattended: () => !!latest.opts.unattended, connectorThread: () => true,
      coordinationBudget: { advance: () => undefined }, fullAccessSkipsPeerCard: () => false,
      roomAskDuplicate: () => null, roomAskParent: () => undefined, roomAskRefused: () => undefined,
      routinePeerSource: () => undefined, sourceExecutionAudience: () => undefined, beginRoomAsk: () => "fixture-request",
      resultEgressDeps: {}, taskResolutionDeps: {}, eventAction: async (_spec: unknown, go: (h: unknown) => unknown) => go({ charge: async () => {}, record: () => {}, unrun: () => {} }),
      readInternalBody: async () => ({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "the note" }), res: {},
    } as unknown as DelegateBotRouteContext);
    return queue.mock.calls.at(-1)?.[4];
  };
  const send = async (via?: "ask-intent" | "share", queued = false) => {
    const origin = via ? "unproven" : "desktop";
    const accepted = sendStore.accept({ kind: "bot", ownerId: from.id, threadId: from.threadId, fingerprint: String(turns.length), text: "Ask Ember", origin,
      ...(via ? { via, queueOnly: true } : {}) });
    if (accepted.kind !== "new") throw new Error("fixture admission");
    await admit({ bot: from, threadId: from.threadId, row: accepted.row, text: "Ask Ember", origin, unprovenSend: !!via, ownerActs: !via, queueOnly: !!via || queued });
    await vi.waitFor(() => expect(turns.length).toBeGreaterThan(0));
  };
  return { store, from, target, caps, owners, turns, send, run, startTurn, queue, bus };
}

it.each(["ask-intent", "share"] as const)("T-P1: real %s admission and drain queues a note without authority; desktop in the same thread lends", async via => {
  const w = world(); await w.send(via);
  expect(w.turns[0].opts).toMatchObject({ via, unattended: true, origin: "unproven", queuedDrain: true });
  expect(await w.run()).toBeUndefined(); expect(database().prepare("SELECT count(*) AS n FROM delegation_packs").get()!.n).toBe(0);
  await w.send(); expect(await w.run()).toBeDefined(); expect(database().prepare("SELECT count(*) AS n FROM delegation_packs").get()!.n).toBe(1);
});

it("T-P1: an owner queued drain and its rebuilt turn retain authority; routine/card classification removes it", async () => {
  const w = world(); await w.send(undefined, true); expect(w.turns[0].opts.queuedOwnerProof).toBe(true); expect(await w.run()).toBeDefined();
  const first = w.turns[0];
  await w.startTurn(w.from.id, "Ask Ember", { ...first.opts, userMessage: first.message, memoryRedispatch: 1, rebuildOf: first.generation });
  expect(await w.run()).toBeDefined();
  for (const guard of ["routineRunId", "cardContinuation"]) {
    await w.startTurn(w.from.id, "Ask Ember", { ...first.opts, userMessage: first.message, [guard]: true }); expect(await w.run()).toBeUndefined();
  }
  const latest = w.turns.at(-1)!; w.owners.get(w.from.threadId).ownerPackAuthority = true;
  expect((w.caps as any).turnInputOf(w.from.threadId, latest.generation)).toEqual({ messageId: latest.message.id });
  expect((w.caps as any).turnInputOf(w.from.threadId, first.generation)).toBeUndefined();
});

it("T-MARK-DELEG: dispatch binds the pack and keeps the delegation outside mark; note-only dispatch has no pack ID", async () => {
  const w = world(); await w.send(); await w.run();
  const pack = database().prepare("SELECT * FROM delegation_packs").get()!;
  const options: any[] = [];
  const host = fakeHost(w.bus as any, () => {});
  configureHandoffDispatch({ ...host, startTurn: async (_bot, text, opts) => {
    options.push(opts);
    const append = find(n => ts.isCallExpression(n) && n.expression.getText(ast) === "store.appendMessage"
      && !!n.arguments[1]?.getText(ast).includes("opts?.handoffSourceThreadId")) as ts.CallExpression;
    const row = evaluate(`return (${append.arguments[1].getText(ast)});`, { opts, text, threadId: opts.threadId,
      dlg: opts.delegationRun, turnImages: { promote: () => [] }, routineRunPrompt: undefined, automation: automationForTurn(opts) });
    w.store.appendMessage(opts.threadId, row, opts.delegationRun.turnKey, opts.delegationRun.within(opts.threadId, () => {}));
  } }, { bus: w.bus as any, approvalBus: { store: w.store, broadcast: () => {} } as any });
  await dispatchHandoff(String(pack.delegation_id), { bus: w.bus as any, approvalBus: { store: w.store, broadcast: () => {} } as any });
  expect(options[0].packId).toBe(pack.id);
  expect(database().prepare("SELECT destination_thread_id FROM delegation_packs").get()!.destination_thread_id).toBe(options[0].threadId);
  expect(options[0].automation).toEqual({ kind: "delegation" });
  const row = w.store.messageById(options[0].threadId, options[0].delegationRun.turnKey)!;
  expect(row).toMatchObject({ packId: pack.id, automation: { kind: "delegation" } });
  expect(row.text).toContain("the note");
  expect(promptCarriesOutside({ threadId: w.target.threadId, botId: w.target.id, resumed: false, replayIds: [], promptIds: [row.id], branch: [row] })).toBe("another bot");
  w.owners.get(w.from.threadId).ownerPackAuthority = false;
  expect(await w.run()).toBeUndefined();
  const noteOnly = database().prepare("SELECT id FROM pending_delegations WHERE id<>?").get(pack.delegation_id)!;
  await dispatchHandoff(String(noteOnly.id), { bus: w.bus as any, approvalBus: { store: w.store, broadcast: () => {} } as any });
  expect(options[1].packId).toBeUndefined(); expect(options[1].automation).toEqual({ kind: "delegation" });
});

it("prepared route mount: only owner proof returns the prepared source rows", async () => {
  const w = world(); await w.send(); await w.run();
  const pack = database().prepare("SELECT * FROM delegation_packs").get()!;
  database().prepare("UPDATE delegation_packs SET prepared=refs").run();
  const mount = find(n => ts.isIfStatement(n) && n.expression.getText(ast) === 'path.startsWith("/api/delegation-packs/")')!;
  expect(mount).toBeDefined();
  for (const owner of [true, false]) {
    const response = evaluate(`${mount.getText(ast)}`, { path: `/api/delegation-packs/${pack.id}`, method: "GET", req: {}, url: {},
      answerDelegationPackRoute, readDelegationPack, forgottenMessageSources, botMessages, database, store: w.store,
      mayApprove: () => owner, res: { setHeader: vi.fn() }, json: (_res: unknown, status: number, body: unknown) => ({ status, body }) });
    expect(response.status).toBe(owner ? 200 : 404);
    if (owner) expect(response.body.rows).toEqual([{ id: w.turns[0].message.id, state: "text", author: "You", text: "Ask Ember" }]);
  }
});
