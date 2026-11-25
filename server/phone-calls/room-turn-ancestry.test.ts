// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHONEAUD (phonefix-redesign G1): a room member turn answering a queued request keeps the mark that request took when it was queued.
// A routine's run clears the unattended mark (unattended-mark.ts), and a bot's request is not background (turnIsBackground), so neither
// carries the chain into the room; the request mark is the only durable carrier once the owner has spoken in the asking thread.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import {
  _resetAutomationAncestryForTest, automationAncestry, recordAutomationAncestry, recordRequestAncestry, threadAutomationAncestry,
} from "../automation-ancestry.ts";
import * as ancestry from "../automation-ancestry.ts";
import { source, wiring } from "../decision-wiring/fixture.ts";

afterEach(() => _resetAutomationAncestryForTest());

/** The production initializer of runGroupMemberTurnDispatch's roomTurnAncestry, evaluated as written with the turn's locals injected. */
function roomTurnAncestry(locals: Record<string, unknown>): boolean {
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dispatch = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runGroupMemberTurnDispatch");
  expect(dispatch, "runGroupMemberTurnDispatch").toBeTruthy();
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "roomTurnAncestry") initializer = node.initializer;
    if (!initializer) ts.forEachChild(node, visit);
  };
  visit(dispatch!);
  expect(initializer, "roomTurnAncestry").toBeTruthy();
  const js = ts.transpileModule(`globalThis.result = ${initializer!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext({ ...ancestry, automationAncestry, ...locals });
  vm.runInContext(js, context);
  return context.result as boolean;
}

/** askBotRoute's own stamp line (handoff-boundary.ts), run as written. */
function stampAsk(requestId: string, fromThreadId: string): void {
  const line = readFileSync(join(import.meta.dirname, "..", "handoff-boundary.ts"), "utf8").split("\n").find(text => text.includes("recordRequestAncestry(queued.request.id,"));
  expect(line, "askBotRoute stamp").toBeTruthy();
  vm.runInContext(line!, vm.createContext({ queued: { request: { id: requestId } }, fromThreadId, recordRequestAncestry, threadAutomationAncestry }));
}

const quietRoom = { orchestration: undefined, isUnattended: () => false, routines: { isActiveThread: () => false }, threadId: "room-thread", turnAutomation: undefined,
  inheritedPhoneAncestry: undefined, roomRequestOwnerProof: () => false };

it("a room turn answering a request queued from a routine-started turn has automation ancestry after the owner speaks in the asking thread", () => {
  // the routine handed off to bot B; B's turn (thread asker-thread) carries automation and asks a room bot
  recordAutomationAncestry("asker-thread", true, 1);
  stampAsk("ask-request", "asker-thread");
  // the owner then types in B's thread: its newest record is the owner's
  recordAutomationAncestry("asker-thread", false, 2);
  const row = { id: "ask-request", rootId: "ask-request", rootThreadId: "asker-thread", unattended: false };
  expect(roomTurnAncestry({ ...quietRoom, roomLineageId: "ask-request", roomLineageRow: row }), "room turn of the routine chain's ask").toBe(true);
  // a child request of that ask (rootId names the marked ask) keeps it too
  const child = { id: "child-request", rootId: "ask-request", rootThreadId: "asker-thread", unattended: false };
  expect(roomTurnAncestry({ ...quietRoom, roomLineageId: "child-request", roomLineageRow: child }), "child request of the marked ask").toBe(true);
  // an ask nested in a tree whose root is the owner's own room message (unmarked) keeps its own mark
  recordAutomationAncestry("asker-thread", true, 3);
  stampAsk("nested-ask", "asker-thread");
  recordAutomationAncestry("asker-thread", false, 4);
  const nested = { id: "nested-ask", rootId: "owner-room-root", rootThreadId: "asker-thread", unattended: false };
  expect(roomTurnAncestry({ ...quietRoom, roomLineageId: "nested-ask", roomLineageRow: nested }), "marked ask under an owner's room root").toBe(true);
});

it("owner-positive control: a room turn answering the owner's own ask keeps owner ancestry", () => {
  recordAutomationAncestry("owner-thread", false, 1);
  stampAsk("owner-ask", "owner-thread");
  const row = { id: "owner-ask", rootId: "owner-ask", rootThreadId: "owner-thread", unattended: false };
  expect(roomTurnAncestry({ ...quietRoom, roomLineageId: "owner-ask", roomLineageRow: row })).toBe(false);
  // and a room turn with no request (the owner typing in the room) is the owner's
  expect(roomTurnAncestry({ ...quietRoom, roomLineageId: undefined, roomLineageRow: null })).toBe(false);
});

// arbiter3 Astra 3 / G2: the production helpers, as written (a pre-fix pin has neither: the fallbacks give its pre-fix behaviour)
const messages = new Map<string, { role: string; origin?: string; automation?: unknown }>();
const helpers = source.includes("function roomRequestOwnerProof(")
  ? wiring(["roomRequestOwnerProof", "queuedRoomAncestry"], { store: { messageById: (_thread: string, id: string) => messages.get(id) }, isOwnerOrigin: (origin: unknown) => origin === "desktop" || origin === "companion" })
  : { roomRequestOwnerProof: () => false, queuedRoomAncestry: () => undefined };
const room = { ...quietRoom, inheritedPhoneAncestry: undefined, roomRequestOwnerProof: helpers.roomRequestOwnerProof };

it("an unknown room request does not borrow a newer owner root; the owner's own send, queued or not, keeps its proof", () => {
  recordAutomationAncestry("owner-root-thread", false, 1);
  // restored, legacy or evicted: no mark on the request, its root names the owner's thread
  const restored = { id: "restored", rootId: "restored", rootThreadId: "owner-root-thread", verb: "room_turn", fromKind: "bot", unattended: false };
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "restored", roomLineageRow: restored }), "unknown request under a newer owner root").toBe(true);
  // a root's false mark alone cannot clear an unmarked child; a true root still restricts
  recordRequestAncestry("owner-root", false);
  const child = { id: "unmarked-child", rootId: "owner-root", rootThreadId: "owner-root-thread", verb: "room_turn", fromKind: "bot", unattended: false };
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "unmarked-child", roomLineageRow: child }), "unmarked child of an owner root").toBe(true);
  recordRequestAncestry("routine-root", true);
  recordRequestAncestry("owner-child", false);
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "owner-child", roomLineageRow: { ...child, id: "owner-child", rootId: "routine-root" } }), "true root restricts").toBe(true);
  // known marks decide
  recordRequestAncestry("known-routine", true);
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "known-routine", roomLineageRow: { ...restored, id: "known-routine", rootId: "known-routine" } }), "known routine request").toBe(true);
  recordRequestAncestry("known-owner", false);
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "known-owner", roomLineageRow: { ...restored, id: "known-owner", rootId: "known-owner" } }), "known owner request").toBe(false);
  // positive: the owner's own room send (queueRoomMemberTurn / claimRoomTurnRequest: room_turn, fromKind owner) proved by its typed source line
  messages.set("owner-line", { role: "user", origin: "desktop" });
  const ownerSend = { id: "queued-owner", rootId: "queued-owner", verb: "room_turn", fromKind: "owner", sourceMessageId: "owner-line", unattended: false };
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "queued-owner", roomLineageRow: ownerSend }), "genuine queued owner send").toBe(false);
  // a request claiming the owner but quoting an automation line proves nothing
  messages.set("routine-line", { role: "user", origin: "desktop", automation: { kind: "routine" } });
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "queued-owner-2", roomLineageRow: { ...ownerSend, id: "queued-owner-2", rootId: "queued-owner-2", sourceMessageId: "routine-line" } }), "owner request quoting an automation line").toBe(true);
});

it("a retry and a summoned member keep the resolved phone ancestry, immediate or queued; an owner chain keeps the phone", () => {
  // the first answer (routine-marked ask) resolved true; its request is settled. The summoned member's own fresh request is unmarked.
  const fresh = { id: "summoned", rootId: "summoned", verb: "room_turn", fromKind: "bot", unattended: false };
  expect.soft(roomTurnAncestry({ ...room, inheritedPhoneAncestry: true, roomLineageId: "summoned", roomLineageRow: fresh }), "summoned member of a routine answer").toBe(true);
  // redispatch of the first answer: the same owner-proved request, but the turn it retries resolved automation
  messages.set("owner-line-2", { role: "user", origin: "desktop" });
  const proved = { id: "retried", rootId: "retried", verb: "room_turn", fromKind: "owner", sourceMessageId: "owner-line-2", unattended: false };
  expect.soft(roomTurnAncestry({ ...room, inheritedPhoneAncestry: true, roomLineageId: "retried", roomLineageRow: proved }), "redispatch of a routine-resolved turn").toBe(true);
  // queued variant: the stamp the busy member's request takes, then its later dispatch with no inherited value
  const stamp = helpers.queuedRoomAncestry(1, true, undefined);
  const stampLine = source.split("\n").find(line => line.includes("recordRequestAncestry(request.id, ancestry)"));
  if (stampLine) vm.runInContext(stampLine, vm.createContext({ ancestry: stamp, created: true, request: { id: "queued-member" }, recordRequestAncestry }));
  expect.soft(roomTurnAncestry({ ...room, roomLineageId: "queued-member", roomLineageRow: { ...fresh, id: "queued-member", rootId: "queued-member" } }), "queued summoned member").toBe(true);
  // owner-chain control: the owner's member summons another; resolved false travels, immediate and queued
  expect.soft(roomTurnAncestry({ ...room, inheritedPhoneAncestry: false, roomLineageId: "owner-summoned", roomLineageRow: { ...fresh, id: "owner-summoned", rootId: "owner-summoned" } }), "owner chain summoned member").toBe(false);
  expect.soft(helpers.queuedRoomAncestry(1, false, undefined), "owner chain queued stamp").toBe(false);
  expect.soft(helpers.queuedRoomAncestry(1, undefined, undefined), "unknown summoner queued stamp").toBe(true);
  expect.soft(helpers.queuedRoomAncestry(0, undefined, undefined), "owner's own queued send is left to its proof").toBeUndefined();
});

it("the room's retry and mention calls pass the resolved ancestry; the paired phone refuses a project role", () => {
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dispatch = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runGroupMemberTurnDispatch")!;
  const slot = dispatch.parameters.findIndex(parameter => parameter.name.getText(ast) === "inheritedPhoneAncestry");
  const calls: ts.CallExpression[] = [];
  let phoneGate: ts.IfStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "runGroupMemberTurn") calls.push(node);
    if (ts.isIfStatement(node) && !phoneGate && node.thenStatement.getText(ast).includes("integrations.phone = phoneIntegration()")) phoneGate = node;
    ts.forEachChild(node, visit);
  };
  visit(dispatch);
  expect.soft(slot, "inheritedPhoneAncestry parameter").toBeGreaterThan(-1);
  // the redispatch (same member, same request) and the mention chain (next member)
  expect.soft(calls.map(call => call.arguments[slot]?.getText(ast)), "retry and mention carriers").toEqual(["roomTurnAncestry", "roomTurnAncestry"]);
  expect(phoneGate, "room paired-phone gate").toBeTruthy();
  const gate = (role: string | undefined) => {
    const js = ts.transpileModule(`globalThis.result = Boolean(${phoneGate!.expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
    const context = vm.createContext({ roomTurnAncestry: false, roomProjectRole: () => role, group: {}, bot: { id: "member" }, roomOwnerAudience: true });
    vm.runInContext(js, context);
    return context.result;
  };
  expect.soft(gate("lead"), "owner-audience project room lead").toBe(false);
  expect.soft(gate("member"), "owner-audience project room member").toBe(false);
  expect.soft(gate(undefined), "ordinary room (control)").toBe(true);
});
