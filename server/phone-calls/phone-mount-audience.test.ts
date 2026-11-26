// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import {
  _resetAutomationAncestryForTest, automationAncestry, configureAutomationAncestryFile, phoneAncestry, recordAutomationAncestry, recordRequestAncestry,
  requestAutomationAncestry, threadAutomationAncestry,
} from "../automation-ancestry.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { source, wiring } from "../decision-wiring/fixture.ts";
import { _resetPending, parsePendingItem, queueDelegation } from "../delegations.ts";
import { PHONE_TOOLS_ENV, phoneToolsFor } from "../drivers/phone-tool-schemas.ts";
import { configureHandoffDispatch, dispatchHandoff } from "../handoff-dispatch.ts";
import { isAutomationThread, setAutomationProbe } from "../message-allow.ts";
import { turnAudienceIsOwner } from "../owner-audience.ts";
import * as routinePermissions from "../routine-permissions.ts";
import { RoutineManager } from "../routines.ts";
import { serviceNoLimits } from "../service-no-limits.ts";
import { fakeHost, writePrompt } from "../testing/handoff-turn.ts";
import { ownerWorld } from "../testing/handoff-worlds.ts";
import { unattendedMarkAction } from "../unattended-mark.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { forgetAllPhoneTurns, forgetPhoneThread, recordPhoneTurn } from "./phone-turns.ts";
import { phoneMount } from "./service.ts";

function section(first: string, next: string, from = 0) {
  const start = source.indexOf(first, from);
  const end = source.indexOf(next, start + first.length);
  expect(start, first).toBeGreaterThanOrEqual(from);
  expect(end, next).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every phone tool an owner turn gets: the call tools and the paired phone (phoneMcp). The phone-jobs mount also needs a live phone
 *  authority for the generation (phoneJobsIntegration), minted for a phone-ticket send or the owner's No-limits turn. */
const OWNER_TOOLS = ["phone_call_place", "phone_call_result", "paired_phone"];
const WITH_AUTHORITY = [...OWNER_TOOLS, "phone_jobs", "phone_authority"];

afterEach(() => {
  setAutomationProbe(() => false);
  _resetAutomationAncestryForTest();
  _resetPhoneSecretsForTest();
  forgetAllPhoneTurns();
  _resetPending();
  closeDatabase();
});

it("mounts phone tools only on the owner turn, including on every hop a routine starts", async () => {
  const { store, from, target, bus, approvalBus } = ownerWorld();
  // the ledger is kept on disk, as the server does at boot (index.ts configureAutomationAncestryFile)
  const ledger = join(DATA_DIR, "automation-ancestry.json");
  configureAutomationAncestryFile(ledger);
  let noLimitsOn = false;
  const tick = () => new Promise(resolve => setTimeout(resolve, 3));
  expect(setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN })).toBe(true);
  const ownerSurfacesByThread = new Map<string, boolean>();
  const unattended = new Set<string>();
  const isUnattended = (thread: string) => unattended.has(thread);
  let now = Date.now();
  const startTurn = vi.fn<(botId: string, text: string, opts: { threadId: string; routineRunId?: string }) => Promise<void>>(async () => {});
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"), now: () => now, botState: () => "ready",
    createTask: () => store.createTask(from.id, "Routine conversation", false)!,
    startTurn: (...args) => startRoutineTurn(...args),
  });
  const { agentsIntegration } = wiring(["agentsIntegration"], {
    readTurnPolicy: () => undefined, process, agentsProxyPath: "fixture", AGENTS_NODE_FLAG: {}, PORT: 0,
    internalToken: () => "fixture", imageLibraryOwnerAudience: () => true, needsOwnerNowOffered: () => false, PHONE_TOOLS_ENV,
  });
  // Run the launcher's audience, scheduling and mount wiring without booting the server.
  const directStart = source.indexOf("async function startTurnAdmitting(");
  const js = ts.transpileModule(`
    ${section("setAutomationProbe((botId, threadId)", "\n")}
    globalThis.startRoutineTurn = ${section("startTurn: (botId, threadId, prompt, runOn, triggerSource,", ",\n  startGoal:").slice("startTurn: ".length)};
    globalThis.list = (bot, opts) => {
      const threadId = opts.threadId;
      ${section("const humanIsOwner=", "const memoryLastResort =", directStart)}
      ${section("ownerSurfacesByThread.set(threadId,surfacesForOwner);", "\n  // A scheduled or manual routine run", directStart)}
      // the admitted start's record (published after directRuns.admit, arbiter3 Astra 1), as written
      ${source.includes("  recordAutomationAncestry(threadId, turnPhoneAncestry);") ? section("  recordAutomationAncestry(threadId, turnPhoneAncestry);", "\n", directStart) : ""}
      const dispatchClaimId = threadId, commsDepth = opts.commsDepth ?? 0, skillAuthoring = false;
      const memoryLastResort = false, integrations = {};
      let phonePrimerLine;
      ${section("  const noLimitsPhone =", "\n", directStart)}
      const phoneAuthority = globalThis.liveAuthority = ${section("  if (noLimitsPhone || ", ") {\n    phoneAuthorities.mint(", directStart).slice("  if (".length)});
      const selectedSkills = [{ manifest: { requiredCapabilities: ["phoneMcp"] } }];
      ${section("...attachedSkillsFor(bot, pinnedProcedures.catalogue)];", "      // the user's connected apps", directStart).slice("...attachedSkillsFor(bot, pinnedProcedures.catalogue)];".length)}
      ${section("// Bot phone calls (3b):", "// @mentions in the user's message", directStart)}
      return [...phoneToolsFor(integrations.agents?.env[PHONE_TOOLS_ENV]).map(tool => tool.name), ...(integrations.phone ? ["paired_phone"] : []),
        ...(integrations.phoneJobs ? ["phone_jobs"] : []), ...(phoneAuthority ? ["phone_authority"] : [])];
    };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const context: Record<string, unknown> = vm.createContext({
    routines, startTurn, setAutomationProbe, isAutomationThread, turnAudienceIsOwner, ownerSurfacesByThread,
    isUnattended, unattendedMarkAction, markUnattended: (thread: string) => unattended.add(thread),
    clearUnattended: (thread: string) => unattended.delete(thread), phoneMount,
    serviceNoLimits: (...args: Parameters<typeof serviceNoLimits>) => noLimitsOn || serviceNoLimits(...args),
    phonesOfferedNow: () => true, PHONE_TICKET: "fixture-ticket", phoneIntegration: () => ({}),
    // as production: mounted only while this generation holds a live phone authority
    phoneJobsIntegration: () => (context.liveAuthority ? {} : undefined),
    driverMountsPhoneJobs: () => true, pairedVenueReadMounts: () => null, pairedChannelRun: () => undefined,
    instance: { driverKind: "codex", adapter: { capabilities: { agentsMcp: true } } }, recordPhoneTurn, forgetPhoneThread,
    pairedVenue: null, venueReadMounts: () => false, venuePostMounts: () => null, emailVerdict: { mounted: false },
    database: () => undefined, store, shareMounts: () => null, agentsIntegration, trace: { mark: () => {} },
    userMessage: {}, phoneToolsFor, PHONE_TOOLS_ENV, automationAncestry, phoneAncestry, recordAutomationAncestry,
  });
  vm.runInContext(js, context);
  const { startRoutineTurn, list } = context as unknown as {
    startRoutineTurn: ConstructorParameters<typeof RoutineManager>[0]["startTurn"];
    list: (bot: typeof from, opts: Record<string, unknown> & { threadId: string }) => string[];
  };

  const ownerTools = list(from, { threadId: from.threadId, origin: "desktop" });
  // Control: the same hop rooted at the owner's own turn keeps the tools.
  const ownerTask = store.createTask(target.id, "Owner ask", false)!;
  expect.soft(list(target, { threadId: ownerTask.threadId, chainRootThreadId: from.threadId, commsDepth: 1 }), "owner-rooted hop").toEqual(OWNER_TOOLS);
  routines.create({ botId: from.id, name: "Routine", prompt: "Run routine", permissionMode: "ask", schedule: { type: "once", at: now + 60_000 } });
  now += 120_000;
  await routines.tick();
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
  const [, , routineTurn] = startTurn.mock.calls[0];
  expect(routines.activeBotRunForThread(from.id, routineTurn.threadId)).toMatchObject({ id: routineTurn.routineRunId, triggerSource: "schedule" });
  const routineTools = list(from, routineTurn);

  const { routinePeerSource, peerRoutineTurnOptions } = wiring(["routinePeerSource", "peerRoutineTurnOptions"], {
    ...routinePermissions, routines, isUnattended, routineRunLevel: () => ({ mode: "ask" }),
    admittedRoutineCeilings: new Map(), routinePeerSources: new Map(), conversationCeilings: new Map(),
    routineWakeCeiling: () => undefined, turnGenerationFor: () => undefined,
  });
  const routineAuthority = routinePeerSource(routineTurn.threadId, from.id);
  expect(routineAuthority).toMatchObject({ permissionMode: "ask", triggerSource: "schedule" });
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "Hand off work", depth: 0, routineAuthority }, 2, routineTurn.threadId);
  expect(queued.result).toBe("ok");
  let handoffTools: string[] | undefined;
  let handoffThread: string | undefined;
  configureHandoffDispatch({
    ...fakeHost(bus, () => {}), isUnattended, peerOptions: peerRoutineTurnOptions,
    startTurn: async (botId, text, turn) => {
      expect(botId).toBe(target.id);
      expect(turn.chainRootThreadId).toBe(routineTurn.threadId);
      expect(turn.routineAuthority).toMatchObject(routineAuthority);
      handoffTools = list(target, turn);
      handoffThread = turn.threadId;
      writePrompt(bus, turn.delegationRun, turn.threadId, text);
    },
  }, { bus, approvalBus });
  expect(await dispatchHandoff(queued.id!, { bus, approvalBus })).toBe("started");

  expect.soft(ownerTools, "owner turn").toEqual(OWNER_TOOLS);
  expect.soft(routineTools, "scheduled routine turn").toEqual([]);
  expect.soft(handoffTools, "routine-started hand-off turn").toEqual([]);

  // The routine-started turn posts a card in its thread (a browser setup or approval) before the owner talks there.
  await tick();
  const card = store.appendMessage(handoffThread!, { role: "bot", kind: "text", text: "Connect a browser?", from: { botId: target.id, name: target.name, color: target.color } } as unknown as Parameters<typeof store.appendMessage>[1]) as unknown as { id: string };
  await tick();
  // Hop 2: the recipient hands off again. Its queue row keeps the chain's ancestry even after the owner talks in the recipient's thread
  // before the second hand-off starts (the thread's own record then reads owner).
  const second = queueDelegation(bus, target, { toBotId: from.id, message: "Pass it on", depth: 1 }, 3, handoffThread);
  expect(second.result).toBe("ok");
  const secondRow = database().prepare("SELECT item FROM pending_delegations WHERE id = ?").get(second.id!) as { item: string };
  expect.soft(list(target, { threadId: handoffThread!, origin: "desktop" }), "owner turn in the recipient's thread").toEqual(OWNER_TOOLS);
  let secondTools: string[] | undefined;
  configureHandoffDispatch({
    ...fakeHost(bus, () => {}), isUnattended, peerOptions: peerRoutineTurnOptions,
    startTurn: async (botId, text, turn) => {
      expect(botId).toBe(from.id);
      expect(turn.chainRootThreadId).toBe(handoffThread);
      expect(turn.routineAuthority).toBeUndefined();
      secondTools = list(from, turn);
      writePrompt(bus, turn.delegationRun, turn.threadId, text);
    },
  }, { bus, approvalBus });
  expect(await dispatchHandoff(second.id!, { bus, approvalBus })).toBe("started");
  expect.soft(secondTools, "second hand-off from a routine-started chain").toEqual([]);

  // Room and ask hops carry only their chain root (sharedTurnOptions: rootThreadId, no ceiling for a routine the ask did not capture).
  const roomTask = store.createTask(target.id, "Room ask", false)!;
  expect.soft(list(target, { threadId: roomTask.threadId, chainRootThreadId: routineTurn.threadId, commsDepth: 1 }), "room/ask hop rooted at the routine").toEqual([]);
  // Retry hop: a re-dispatch of that turn (memory redispatch) with none of its chain options still reads as the same chain.
  expect.soft(list(target, { threadId: roomTask.threadId, memoryRedispatch: 1 }), "retry of the routine-rooted hop").toEqual([]);

  // Fable M3 / Astra 2: the card's continuation (startCardContinuation's exact options) is judged by the turn that posted the card, even
  // though the owner has spoken in that thread since.
  const continuation = { threadId: handoffThread!, cardContinuation: true, heldContinuationId: undefined, continuationCardId: card.id };
  expect.soft(list(target, continuation), "card continuation of the routine-started turn").toEqual([]);

  // Fable H2 / Astra 2: after a restart the ledger is read back from disk; the continuation still mounts nothing. (The owner speaks in their
  // own thread first: the second hand-off ran there, so its newest record was that hop's.)
  await tick();
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop" }), "owner turn before the restart").toEqual(OWNER_TOOLS);
  _resetAutomationAncestryForTest();
  configureAutomationAncestryFile(ledger);
  expect.soft(list(target, continuation), "card continuation after a restart").toEqual([]);
  // owner-positive control after the restart: a hop rooted at the owner's own turn keeps every phone tool
  expect.soft(list(target, { threadId: ownerTask.threadId, chainRootThreadId: from.threadId, commsDepth: 1 }), "owner-rooted hop after a restart").toEqual(OWNER_TOOLS);
  // and a restart that lost the ledger: no record fails closed
  _resetAutomationAncestryForTest();
  expect.soft(list(target, continuation), "card continuation with no record").toEqual([]);
  configureAutomationAncestryFile(ledger);

  // Astra 3: a held hand-off sent again (resendHeldDelegation passes its stored payload through queueDelegation) keeps its mark, though the
  // source thread's newest turn is now the owner's; a row written before the field existed loads as automation.
  await tick();
  expect.soft(list(target, { threadId: handoffThread!, origin: "desktop" }), "owner turn in the source thread").toEqual(OWNER_TOOLS);
  // (soft, arbiter3 Astra 6: each is independent of the resend and ask rows below, which must still run on a pre-fix pin)
  expect.soft(threadAutomationAncestry(handoffThread!)).toBe(false);
  const stored = parsePendingItem({ toBotId: from.id, message: "Pass it on", depth: 1, ...JSON.parse(secondRow.item), id: "stored", fromBotId: target.id })!;
  // the row as stored carries the mark explicitly
  expect.soft(JSON.parse(secondRow.item).automationAncestry).toBe(true);
  expect.soft(stored.automationAncestry).toBe(true);
  const { automationAncestry: _dropped, ...legacy } = stored;
  expect.soft(parsePendingItem(legacy)?.automationAncestry, "row written before the field").toBe(true);
  expect.soft(parsePendingItem({ ...legacy, automationAncestry: false })?.automationAncestry).toBe(false);
  const resent = queueDelegation(bus, target, { toBotId: from.id, message: "Send again", depth: 1, automationAncestry: stored.automationAncestry }, 3, handoffThread);
  expect(resent.result).toBe("ok");
  // a caller cannot clear the mark either: an owner source with a false mark stays an owner chain, a routine source stays automation
  expect(queueDelegation(bus, target, { toBotId: from.id, message: "Owner hand-off", depth: 1, automationAncestry: false }, 3, handoffThread).result).toBe("ok");
  let resentTools: string[] | undefined;
  configureHandoffDispatch({
    ...fakeHost(bus, () => {}), isUnattended, peerOptions: peerRoutineTurnOptions,
    startTurn: async (_botId, text, turn) => { resentTools = list(from, turn); writePrompt(bus, turn.delegationRun, turn.threadId, text); },
  }, { bus, approvalBus });
  expect(await dispatchHandoff(resent.id!, { bus, approvalBus })).toBe("started");
  expect.soft(resentTools, "held hand-off sent again").toEqual([]);

  // Astra 4 / Fable M1: an ask queued by a routine-started turn keeps its mark on the request (the boundary's own line, run as written), so
  // the worker's turn (sharedTurnOptions, as production builds it) mounts nothing after the owner talks in the asking thread.
  recordAutomationAncestry(handoffThread!, true);
  const askRequest = { id: "ask-from-routine-chain", rootThreadId: handoffThread!, notOwnerAudience: false, unattended: false, verb: "ask", toBotId: from.id, fromBotId: target.id };
  const stampLine = readFileSync(join(import.meta.dirname, "..", "handoff-boundary.ts"), "utf8").split("\n").find(line => line.includes("recordRequestAncestry(queued.request.id,"))!;
  expect.soft(stampLine).toBeTruthy();
  vm.runInContext(stampLine, vm.createContext({ queued: { request: askRequest }, fromThreadId: handoffThread, recordRequestAncestry, threadAutomationAncestry }));
  await tick();
  expect.soft(list(target, { threadId: handoffThread!, origin: "desktop" }), "owner turn in the asking thread").toEqual(OWNER_TOOLS);
  const { sharedTurnOptions } = wiring(["sharedTurnOptions"], {
    store, requestSourceThread: () => handoffThread, sharedQueuedCeiling: () => undefined, governingSharedSource: () => undefined,
    peerRoutineTurnOptions, sharedRequestEventId: () => undefined, requestRunCoordination: () => undefined, requestAutomationAncestry,
  });
  const workerTask = store.createTask(from.id, "Shared ask", false)!;
  expect.soft(list(from, { threadId: workerTask.threadId, commsDepth: 1, ...sharedTurnOptions(askRequest) }), "ask worker from a routine-started chain").toEqual([]);
  // owner-positive control: an ask the owner's own turn queued keeps every phone tool
  await tick();
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop", phoneTicket: "fixture-ticket" }), "owner phone-ticket send").toEqual(WITH_AUTHORITY);
  const ownerAsk = { ...askRequest, id: "ask-from-owner", rootThreadId: from.threadId };
  recordRequestAncestry(ownerAsk.id, false);
  expect.soft(list(target, { threadId: store.createTask(target.id, "Owner ask 2", false)!.threadId, commsDepth: 1, ...sharedTurnOptions(ownerAsk) }), "ask worker from the owner").toEqual(OWNER_TOOLS);
  // arbiter3 Astra 3: a shared request with no mark (restored, legacy, evicted) does not borrow its owner root's newest record
  const unmarkedAsk = { ...askRequest, id: "ask-unmarked", rootThreadId: from.threadId };
  expect.soft(requestAutomationAncestry(unmarkedAsk.id)).toBeUndefined();
  expect.soft(list(target, { threadId: store.createTask(target.id, "Unmarked ask", false)!.threadId, commsDepth: 1, ...sharedTurnOptions(unmarkedAsk) }), "unmarked ask under a newer owner root").toEqual([]);

  // arbiter3 Astra 2: a cardless continuation (the browser Continue after Your turn: startCardContinuation with no card id) has no proof
  // tied to its original work; the thread's newest record is a newer owner turn's, so it gets no phone, before and after eviction or restart
  await tick();
  expect.soft(list(target, { threadId: handoffThread!, origin: "desktop" }), "newer owner turn in the paused thread").toEqual(OWNER_TOOLS);
  // r4 (Astra 6): the browser's Continue after Your turn runs through its production callback (handoffContinue) and startCardContinuation;
  // the options they start the turn with are the ones listed, never options built here
  const started: Array<Record<string, unknown> & { threadId: string }> = [];
  const connectorThread = (botId: string) => botId === target.id ? { bot: { ...target, busy: false }, group: undefined } : undefined;
  const { startCardContinuation } = wiring(["startCardContinuation"], {
    connectorThread, store, startTurn: async (_botId: string, _text: string, opts: Record<string, unknown> & { threadId: string }) => { started.push(opts); },
  });
  const callback = section("    handoffContinue: info => {", "\n    stopped:").trim().slice("handoffContinue: ".length).replace(/,$/, "");
  const handoffContinue = vm.runInContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText,
    vm.createContext({ connectorThread, startCardContinuation })) as (info: unknown) => boolean;
  const continued = async (start: () => unknown) => {
    started.length = 0;
    start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    return list(target, started[0]);
  };
  const browserContinue = () => continued(() => expect(handoffContinue({ bot: target, context: { threadId: handoffThread! }, text: "Continue" })).toBe(true));
  expect.soft(await browserContinue(), "cardless continuation after a newer owner send").toEqual([]);
  for (let index = 0; index < 8; index++) { await tick(); recordAutomationAncestry(handoffThread!, false); }
  expect.soft(await browserContinue(), "cardless continuation after its entry is evicted").toEqual([]);
  _resetAutomationAncestryForTest();
  configureAutomationAncestryFile(ledger);
  expect.soft(await browserContinue(), "cardless continuation after a restart").toEqual([]);
  // positive controls: the owner's fresh send keeps the phone, and so does a continuation of a card the owner's own turn posted (a setup
  // card answered: startCardContinuation with its card)
  await tick();
  expect.soft(list(target, { threadId: handoffThread!, origin: "desktop" }), "fresh owner send keeps the phone").toEqual(OWNER_TOOLS);
  const ownerCard = store.appendMessage(handoffThread!, { role: "bot", kind: "text", text: "Connect a browser?", from: { botId: target.id, name: target.name, color: target.color } } as unknown as Parameters<typeof store.appendMessage>[1]) as unknown as { id: string };
  await tick();
  expect.soft(await continued(() => startCardContinuation(target.id, handoffThread!, "Continue", undefined, ownerCard.id)), "card continuation of the owner's own turn").toEqual(OWNER_TOOLS);

  // Astra 5 / MAIN Q-P6: No limits is an approval level, not an audience. It admits no routine-started hop, no not-owner and no project-role
  // turn, and mints no phone authority for them; the owner's own turn under No limits keeps every phone tool and its authority.
  noLimitsOn = true;
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop" }), "owner turn under No limits").toEqual(WITH_AUTHORITY);
  expect.soft(list(target, { threadId: roomTask.threadId, chainRootThreadId: routineTurn.threadId, commsDepth: 1 }), "routine-rooted hop under No limits").toEqual([]);
  expect.soft(list(target, { threadId: roomTask.threadId, chainRootThreadId: routineTurn.threadId, commsDepth: 1, phoneTicket: "fixture-ticket", origin: "desktop" }), "routine-rooted hop with a phone ticket").toEqual([]);
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop", notOwnerAudience: true }).filter(tool => tool.startsWith("phone_")), "not-owner turn under No limits").toEqual([]);
  // arbiter3 Astra 4: the whole capability list (no filter) and the live authority, with owner ancestry so only the role guard can refuse
  expect.soft(threadAutomationAncestry(from.threadId)).toBe(false);
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop", projectCardRun: { cardId: "c" } }), "project-role turn under No limits").toEqual([]);
  expect.soft(context.liveAuthority, "project-role turn holds no phone authority").toBeFalsy();
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop", projectCardRun: { cardId: "c" }, phoneTicket: "fixture-ticket" }), "project-role turn with a phone ticket").toEqual([]);
  expect.soft(list(from, { threadId: from.threadId, origin: "desktop" }), "owner turn under No limits after the project card").toEqual(WITH_AUTHORITY);
  noLimitsOn = false;
});
