// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety fixture state. index.ts owns production writers and callbacks.
import { AsyncLocalStorage } from "node:async_hooks";
import { ShellSessionRegistry } from "../shell-session-state.ts";
import { SleepClock } from "../sleep-clock.ts";
import { OwnerFirstGate } from "../owner-first.ts";
import { RepeatDetector } from "../repeat-detector.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, loadConfig } from "../config.ts";
import { MAX_COORDINATION_DEPTH } from "../coordination-budget.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { afterEach } from "vitest";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { executionStore, setExecutionStore } from "../execution-audience.ts";
import { indexSourceData } from "./internal-source-data.ts";
import { mergeOutputRoots } from "../memory/replay-lineage.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import { isInternalPortContext } from "./internal-authority-fixture.ts";
import { type StatePort } from "./source-extract.ts";
import { registerPortConstructor } from "./port-integrity.ts";
import { offlineInternalServicePorts } from "./internal-offline-service-ports.ts";
import { compositeFixturePorts, closeCompositeFixturePorts } from "./internal-composite-ports.ts";
import { providerFixturePorts, closeProviderFixturePorts } from "./internal-provider-ports.ts";
import { dispatchStatePorts, closeDispatchStatePorts } from "./internal-dispatch-state-ports.ts";
import { extraFixturePorts, closeExtraFixturePorts } from "./internal-extra-ports.ts";
import { policyFixturePorts, closePolicyFixturePorts } from "./internal-policy-ports.ts";
import { ancillaryFixturePorts, closeAncillaryFixturePorts } from "./internal-ancillary-ports.ts";
import { runtimeFixturePorts, closeRuntimeFixturePorts } from "./internal-runtime-ports.ts";
import { database } from "../database.ts";
import { initializeInternalFixtureDatabase } from "./internal-database-fixture.ts";
export { initializeInternalFixtureDatabase } from "./internal-database-fixture.ts";

registerPortConstructor(ShellSessionRegistry);
registerPortConstructor(InternalCapabilities);
registerPortConstructor(AsyncLocalStorage);
registerPortConstructor(SleepClock);
registerPortConstructor(OwnerFirstGate);
registerPortConstructor(RepeatDetector);
registerPortConstructor(ProviderRegistry);
// Explicit pure schema constructor. Execute its current production AST, with
// the real zod import, instead of accepting a case's validator replacement.
const fixtureStores = new Set<Store>();
const indexStatePorts = new WeakSet<object>();
export const isIndexStatePort = (port: StatePort): boolean => indexStatePorts.has(port);
const fixtureRegistries = new Set<ProviderRegistry>();
afterEach(async () => {
  const failures: unknown[] = [];
  for (const store of fixtureStores) try { store.stopSeqStamps(); } catch (error) { failures.push(error); }
  fixtureStores.clear();
  for (const registry of fixtureRegistries) try { await registry.disposeAll(); } catch (error) { failures.push(error); }
  fixtureRegistries.clear();
  for (const close of [closeCompositeFixturePorts,closeDispatchStatePorts,closeExtraFixturePorts,closeProviderFixturePorts,closePolicyFixturePorts,closeAncillaryFixturePorts,closeRuntimeFixturePorts]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures,"FIXTURE_SERVICE_CLEANUP_FAILED");
});

export function realStore(): Store {
  const previous = executionStore();
  try { initializeInternalFixtureDatabase(database()); const store = new Store(undefined,undefined,true);store.bots=[];store.groups=[];fixtureStores.add(store);return store; }
  finally { setExecutionStore(previous); }
}

/** A real registry over one fixture driver: the real load builds and decorates the instance exactly as boot does. */
export async function fixtureProviderRegistry(driver: import("../contracts.ts").AnyProviderDriver, configs: import("../contracts.ts").InstanceConfigMap): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry([driver]); fixtureRegistries.add(registry);
  await registry.load(configs); return registry;
}

/** No configured provider means no child process; registry behavior stays real. */
export function realProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry([]); fixtureRegistries.add(registry); return registry;
}

/** Explicit fixture declarations, never evaluated index source initializers.
 * Empty authority registries are seeded only through real production writers.
 * Pure functions are source-extracted and never replaced by these state ports. */
export function freshIndexPorts(context?: InternalPortContext): StatePort[] {
  if(context && !isInternalPortContext(context)) throw new Error("FIXTURE_CONTEXT_REFUSED");
  const maps = [
    "roomStopRequests", "turnStartedAtMs", "toolRowByItem", "lastReply", "memoryEchoReplies", "toolMessageByItem", "turnServedModelByThread", "heldWriteWaits", "fullAccessStepLine",
    "answersInFlight", "liveSubtasks", "routinePublicationWaiters", "stopHitByRequest", "terminalPublications",
    "internalTurnOwners", "internalResponseBindings", "decisionAuthorities", "decisionProvenance",
    "decisionBotLevels", "decisionRequestTargets", "decisionRecoveryContexts", "turnRequestByGeneration",
    "turnEngineByThread", "routineWakeByTurn", "routinePeerSources", "roomTurnRequests",
    "refusedLeases", "admittedLedgerLeases", "memoryDispatches", "botTurnOrigins",
    "ownerSurfacesByThread", "decisionLevelWork", "decisionSharedSaves", "decisionWakeSaves",
    "decisionQueuePorts", "decisionQueueSyncRemovers", "directTurnDispatchClaims", "directTurnCancellationProofs", "coordinationSlots", "guestBrowserBindings",
    "userChromeProxies", "userChromeForgetting", "userChromeClosing", "browserCapabilitiesByThread",
    "closingHeadlessBrowsers", "lateMemoryRedispatches", "refusedBeforeHandback", "routineRunByTurn",
    "ownerStartedRuns", "seatWaitRunByTurn", "callRunByTurn", "syncAskRequests",
    "limitSuccessors", "limitActiveDispatches", "limitDispatches",
    "sessionAudienceByThread", "legacyToolNamesByThread", "generatedImagesByTurn", "computerControlRevision",
    "boxBindings", "turnOutputRoots", "roomSeqs", "groupTurnOperations",
    "groupGoalCoordinatorTurns", "askMessageByRequest", "pendingRoomStops", "unattendedBots",
    "conversationCeilings", "admittedRoutineCeilings", "turnCwdByThread", "turnDriverByThread",
    "localVmThreadTargets", "localVmActiveThreads", "activeVpsThreads", "localVmIdles",
    "roomLiveTurns", "settledScreenHashes", "groupQueues", "roomRounds",
    "roomTurnClaims", "deferredRoomClaims", "roomRoots", "roomRequestFrames",
    "projectUsagePending", "projectUsageTurns", "mcpRejectedBearer", "pendingSecretResumes",
    "delegationWatch", "screenPollers", "pendingConnectorResumes", "pendingBrowserCapabilityRevocations",
    "roomRetainedMemory", "taskAllowanceSuggestions", "phoneDispatchFacts", "hostComputerThreads",
    "unifiedBrowserThreads", "extensionBrowserThreads", "headlessBrowsersByThread", "turnBrowsers",
    "directAttemptBatches", "highlevelOwnerStartedAt", "turnUsage", "vpsRelayBindings",
    "turnRefusalNotes", "awaitingHandback", "pendingRoomTurnRequests", "unifiedBrowserBindings",
    "pendingUnifiedBrowserBindings",
    // NC+MA refusal/Stop state (LLS S1, Q2, D7)
    "stopInterrupts", "deferredRefusalNotes", "roomLedgerRefusalNotes", "refusedLeaseTerminals",
  ];
  const sets = [
    "successfulDecisionGenerations", "fencedMessages", "autoAnsweredAsks",
    "outsideFlights", "owedRoutineDeliveries", "queuedRoutineDeliveries", "toolStartedTurns",
    "cappedRoomRoots", "reportedUnconfirmedDirectStops", "desktopActionCalls", "desktopActionWithdrawn", "userChromeConnected", "rebindAfterHold", "lastResortMessages",
    "highlevelProvenRuns", "highlevelDesktopRuns", "stillWaitingNoted", "sseClients",
    "imagesNotSentNoted", "routineOriginThreads", "localVmLifecycleBusy", "checkpointRestoreLeases",
    "heldDispatches", "heldScans", "askerWakeRetry", "delegationRetryBots",
    "finalizingDelegations", "deferredDelegationRetries", "leadAtDispatch", "sharedApprovedRequests", "heldScanAgain",
    "ledgerRefusalAwaitingHandback", "refusedTerminalDecisions",
  ];
  const weakmaps = [
    // The real ledger-admission writer owns every completion source entry.
    "ledgerCompletionSources", "terminalPreparations", "sessionStarts",
    "shellPrepared", "shellPreparedRecord", "internalCallers", "remoteResponses", "routeNames", "decisionHttpProofs",
    "directConversationGenerations", "freshReplayConfirmations",
  ];
  const weaksets = [
    "shellPreparing", "foreignResponses", "settledRefusedLeases",
  ];
  const ports: StatePort[] = [
    ...["TOOL_STARTED_TURNS_MAX", "MEMORY_ECHO_NOTICE"].map(name => ({ name, fresh: () => indexSourceData(name as Parameters<typeof indexSourceData>[0]), reason: "Exact production literal for the event fold." })),
    {name:"cfg",fresh:loadConfig,reason:"Actual isolated configuration I/O; available before any optional service is constructed."},
    {name:"routineRequestSourceSchema",fresh:()=>indexSourceData("routineRequestSourceSchema"),reason:"Real zod schema constructed from the current selected production initializer; no case validator is accepted."},
    ...offlineInternalServicePorts(context),
    ...runtimeFixturePorts(),
    {name:"bindDecisionQueueSync",fresh:()=>undefined,reason:"Production starts without the optional background queue synchronizer."},
    { name: "dataWritersStopped", fresh: () => false, reason: "Production's initial writer state in a private running installation." },
    { name: "inboxChangedTimer", fresh: () => null, reason: "No inbox flush timer has been scheduled in this case." },
    { name: "lastPushBadge", fresh: () => 0, reason: "Production's initial push badge counter." },
    { name: "routineDispatchOpen", fresh: () => false, reason: "Routine dispatch remains closed until the real lifecycle opens it." },
    { name: "ROUTINE_RESULT_PUBLICATION_WAIT_MS", fresh: () => indexSourceData("ROUTINE_RESULT_PUBLICATION_WAIT_MS"), reason: "Production's exact bounded result-publication wait." },
    { name: "threadDepsCache", fresh: () => undefined, reason: "Production's initially uninitialized dependency cache." },
    { name: "unresolvedFrameDrops", fresh: () => 0, reason: "Production-default scoped stream diagnostic counter." },
    { name: "ROUTINE_WEEKDAY_NAMES", fresh: () => indexSourceData("ROUTINE_WEEKDAY_NAMES"), reason: "Production's literal weekday names." },
    { name: "mergeRoots", fresh: () => mergeOutputRoots, reason: "Identity-equal real imported lineage merge alias, without substituting its implementation." },
    { name: "browserSitesStore", fresh: () => undefined, reason: "Production's initially absent lazy browser-sites store; the real extracted browserSites function creates its complete class when used." },
    { name: "browserSitesFile", fresh: () => join(DATA_DIR, "browser-extension", "sites.json"), reason: "Real browser-sites state path in the isolated Vitest installation." },
    { name: "MAX_COMMS_DEPTH", fresh: () => MAX_COORDINATION_DEPTH, reason: "Real production coordination limit alias." },
    { name: "GROUP_GOAL_WAIT_MAX_MS", fresh: () => indexSourceData("GROUP_GOAL_WAIT_MAX_MS"), reason: "Real default goal wait limit for fixture without environment overrides." },
    { name: "agentsProxyPath", fresh: () => SPAWNED_PROXIES.agents, reason: "Real resolved production proxy path; fixture never starts a proxy." },
    { name: "phoneProxyPath", fresh: () => SPAWNED_PROXIES.phone, reason: "Real resolved production proxy path; fixture never starts a proxy." },
    { name: "CONNECTOR_TOOLS_CACHE_DIR", fresh: () => join(DATA_DIR, "connector-tools-cache"), reason: "Cache path in the isolated Vitest installation." },
    { name: "fenceNoticeDirectory", fresh: () => join(DATA_DIR, "fence-notices"), reason: "Notice path in the isolated Vitest installation." },
    ...maps.map(name => ({ name, fresh: () => new Map(), reason: "Fresh per-case Map; real production writers own all entries." })),
    ...sets.map(name => ({ name, fresh: () => new Set(), reason: "Fresh per-case Set; real production writers own all entries." })),
    ...weakmaps.map(name => ({ name, fresh: () => new WeakMap(), reason: "Fresh per-case WeakMap; real production writers own all entries." })),
    ...weaksets.map(name => ({ name, fresh: () => new WeakSet(), reason: "Fresh per-case WeakSet; real production writers own all entries." })),
    { name: "store", fresh: context ? () => context.store : realStore, reason: "The binding's complete real Store; never reconcile an unrelated empty roster over its retained ledger." },
    { name: "shellSessions", fresh: () => new ShellSessionRegistry(), reason: "Fresh real shell session registry; production launch and event writers own its records." },
    { name: "registry", fresh: realProviderRegistry, reason: "Full real provider registry without configured providers or spawned engines." },
    { name: "internalCapabilities", fresh: () => new InternalCapabilities(), reason: "Real capability registry; real begin/mint operations only." },
    { name: "repeats", fresh: () => new RepeatDetector({thresholds:indexSourceData("repeats.thresholds"),maxKeysPerThread:indexSourceData("repeats.maxKeysPerThread")}), reason: "Real repeat detector with actual production configuration." },
    { name: "decisionServiceContext", fresh: () => new AsyncLocalStorage(), reason: "Fresh decision request context, no top-level I/O." },
    { name: "decisionServiceAuthorities", fresh: () => new AsyncLocalStorage(), reason: "Fresh real service-authority context matching the current production producer; no preseeded authority." },
    { name: "providerConfigBusy", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "routines", fresh: () => null, reason: "Fresh per-case primitive state with the production default." },
    { name: "hostControlRevision", fresh: () => 0, reason: "Fresh per-case primitive state with the production default." },
    { name: "AUTOMATION_PROPOSAL_REFUSED", fresh: () => indexSourceData("AUTOMATION_PROPOSAL_REFUSED"), reason: "Fresh per-case primitive state with the production default." },
    { name: "MAX_WORKSPACE_BOTS", fresh: () => indexSourceData("MAX_WORKSPACE_BOTS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "mcpConfigBusy", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "ASK_USER_REFUSED", fresh: () => indexSourceData("ASK_USER_REFUSED"), reason: "Fresh per-case primitive state with the production default." },
    { name: "ASK_USER_SHOWN", fresh: () => indexSourceData("ASK_USER_SHOWN"), reason: "Fresh per-case primitive state with the production default." },
    { name: "cloudHome", fresh: () => false, reason: "Explicit closed-installation I/O configuration; no live service or listener." },
    { name: "providerFleetReady", fresh: () => true, reason: "Fresh per-case primitive state with the production default." },
    { name: "cloudEmailSaveMeta", fresh: () => undefined, reason: "The desktop fixture has no Cloud email save acknowledgement; production initializes this optional state absent." },
    { name: "cloudEmailStore", fresh: () => false, reason: "Explicit closed-installation I/O configuration; no live service or listener." },
    { name: "lastSeq", fresh: () => 0, reason: "Fresh per-case primitive state with the production default." },
    { name: "turnDispatchClosed", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "REQUEST_ENDED_LINE", fresh: () => indexSourceData("REQUEST_ENDED_LINE"), reason: "Fresh per-case primitive state with the production default." },
    { name: "coordinationDrainScheduled", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "coordinationDrainCursor", fresh: () => "", reason: "Fresh per-case primitive state with the production default." },
    { name: "localVmImageBusy", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "localVmModeChangeBusy", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    ...["TURN_STALL_MS", "TURN_HEARTBEAT_ONLY_MS"].map(name => ({name,fresh:()=>indexSourceData(name as "TURN_STALL_MS" | "TURN_HEARTBEAT_ONLY_MS"),reason:"Actual production watchdog bounds."})),
    { name: "TURN_REFUSAL_NOTES_MAX", fresh: () => indexSourceData("TURN_REFUSAL_NOTES_MAX"), reason: "Fresh per-case primitive state with the production default." },
    { name: "ROOM_LEDGER_REFUSAL_NOTES_MAX", fresh: () => indexSourceData("ROOM_LEDGER_REFUSAL_NOTES_MAX"), reason: "Fresh per-case primitive state with the production default." },
    { name: "ROUTINE_REBUILD_STOPPED", fresh: () => indexSourceData("ROUTINE_REBUILD_STOPPED"), reason: "Fresh per-case primitive state with the production default." },
    { name: "slackRequiresRevoke", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "slackOperationBusy", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "discordRequiresRevoke", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "discordOperationBusy", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "roomClock", fresh: () => 0, reason: "Fresh per-case primitive state with the production default." },
    { name: "ROOM_TURN_REVOKED_BEFORE_DISPATCH", fresh: () => indexSourceData("ROOM_TURN_REVOKED_BEFORE_DISPATCH"), reason: "Fresh per-case primitive state with the production default." },
    { name: "MAX_GROUP_HOPS", fresh: () => indexSourceData("MAX_GROUP_HOPS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "SCREEN_MIN_GAP_MS", fresh: () => indexSourceData("SCREEN_MIN_GAP_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "SCREEN_POLL_MS", fresh: () => indexSourceData("SCREEN_POLL_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "checkingCardsOwed", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "GROUP_GOAL_MAX_WAIT_EXHAUSTIONS", fresh: () => indexSourceData("GROUP_GOAL_MAX_WAIT_EXHAUSTIONS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "telegramHumanBindingId", fresh: () => undefined, reason: "Fresh per-case primitive state with the production default." },
    { name: "slackHumanBindingId", fresh: () => undefined, reason: "Fresh per-case primitive state with the production default." },
    { name: "discordHumanBindingId", fresh: () => undefined, reason: "Fresh per-case primitive state with the production default." },
    { name: "PORT", fresh: () => 0, reason: "Explicit closed-installation I/O configuration; no live service or listener." },
    { name: "HOST_CONSENT_WAIT_MS", fresh: () => indexSourceData("HOST_CONSENT_WAIT_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "ASK_BOT_TIMEOUT_MS", fresh: () => indexSourceData("ASK_BOT_TIMEOUT_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "ASK_ORIGIN_GRACE_MS", fresh: () => indexSourceData("ASK_ORIGIN_GRACE_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "UNATTENDED_TTL_MS", fresh: () => indexSourceData("UNATTENDED_TTL_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "GROUP_GOAL_COORDINATOR_GUARD_MS", fresh: () => indexSourceData("GROUP_GOAL_COORDINATOR_GUARD_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "IMAGES_NOT_SENT_RECORD_WAIT_MS", fresh: () => indexSourceData("IMAGES_NOT_SENT_RECORD_WAIT_MS"), reason: "Fresh per-case primitive state with the production default." },
    { name: "decisionRecoveryOpen", fresh: () => false, reason: "Fresh per-case primitive state with the production default." },
    { name: "roomEngine", fresh: () => ({}), reason: "Production's empty dispatcher state before room engine initialization." },
    { name: "waitingTeamIncidents", fresh: () => [], reason: "Fresh empty incident queue." },
    { name: "BROWSER_REVOCATION_RETRY_MS", fresh: () => indexSourceData("BROWSER_REVOCATION_RETRY_MS"), reason: "Production retry schedule, fresh per case." },
    { name: "IMAGE_PRESETS", fresh: () => indexSourceData("IMAGE_PRESETS"), reason: "Production's literal preset list." },
    { name: "LEGACY_IMAGE_IDS", fresh: () => indexSourceData("LEGACY_IMAGE_IDS"), reason: "Production's literal legacy identifiers." },
    { name: "AGENTS_NODE_FLAG", fresh: () => indexSourceData("AGENTS_NODE_FLAG"), reason: "Production's literal child environment flag." },
    { name: "HL_OWNER_TICKET", fresh: () => Symbol("highlevel owner ticket"), reason: "Fresh unforgeable per-case ticket, minted only by real production writers." },
    { name: "PHONE_TICKET", fresh: () => Symbol("phone ticket"), reason: "Fresh unforgeable per-case ticket, minted only by real production writers." },
    { name: "STREAM_ID", fresh: () => randomUUID().slice(0, 8), reason: "Fresh random stream identifier with production's shape." },
    ...(context ? dispatchStatePorts(context) : []),
    ...(context ? providerFixturePorts(context) : []),
    ...(context ? ancillaryFixturePorts(context) : []),
    ...(context ? policyFixturePorts(context) : []),
    ...(context ? extraFixturePorts(context) : []),
    ...(context ? compositeFixturePorts(context) : []),
    { name: "sseMetrics", fresh: () => ({ peakPendingBytes: 0, peakClientPendingBytes: 0, backpressureDisconnects: 0, oversizedDisconnects: 0, oversizedScreens: 0, replayFallbacks: 0, rejectedClients: 0 }), reason: "Fresh production-default stream counters." },
  ];
  for (const port of ports) { Object.freeze(port); indexStatePorts.add(port); }
  return ports;
}
