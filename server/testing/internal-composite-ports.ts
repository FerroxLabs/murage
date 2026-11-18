// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety. Callback/policy owners: the original index tables.
import { boundaryComms, boundaryStore, type BoundaryComms } from "../boundary-ports.ts";
import type { CommsBus } from "../comms-visibility.ts";
import type { ApprovalBus, RoutineCardHooks } from "../peer-approval.ts";
import type { AskerWakePort } from "../handoff-boundary.ts";
import type { StoredAnswerDeps } from "../handoff-replay.ts";
import type { TaskResolutionDeps } from "../task-resolution.ts";
import { SHARED_RESULT_DELIVERED } from "../task-resolution.ts";
import type { CompletionHooks } from "../room-requests.ts";
import type { HandoffAdmission } from "../handoff-admission.ts";
import type { BotRecord } from "../store.ts";
import type { ProjectTurnLeases } from "../project-turn-leases.ts";
import { MAX_CONCURRENT_BOT_THREADS } from "../independent-thread-runs.ts";
import { providerCloseDeadlineMs } from "../drivers/child-teardown.ts";
import { ownUnsharedWorkCheck } from "../handoff-binding.ts";
import { writetimeLinesShown } from "../result-egress.ts";
import { doorEgress } from "../bot-read.ts";
import { messageSourceForgotten, messageMadeWithMemory } from "../memory/replay-lineage.ts";
import { threadHumanPrincipal } from "../human-principals.ts";
import { ROOM_REPLY_WITHHELD } from "../room-context.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import type { StatePort } from "./source-extract.ts";
import { createProjectFrameEmitter } from "../project-frames.ts";
import type { BoxRelayDeps } from "../box-relay.ts";
import { BOX_API_BASE } from "../box.ts";
import type { RoutineDeliveryDeps } from "../routine-delivery.ts";

const cleanups: Array<() => void> = [];
export function closeCompositeFixturePorts(): void {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) { try { close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "FIXTURE_COMPOSITE_CLEANUP_FAILED");
}

const realCommsInstances = new WeakMap<InternalPortContext, CommsBus>();
const realBoundaryCommsInstances = new WeakMap<InternalPortContext, BoundaryComms>();

/** Rebuild complete collaborator tables, without copying their policy bodies.
 * Every callback is selected from the real source or its real imported export.
 * Register data dependencies now; their getters read the same fixture bindings
 * that source-extract validates before returning the unit. */
export function compositeFixturePorts(context: InternalPortContext): StatePort[] {
  const routineCard = context.value<RoutineCardHooks>("routineCardHooks");
  const leases = context.value<ProjectTurnLeases>("projectTurnLeases");
  const production = <T extends (...args: any[]) => any>(name: string): T => context.production<T>(name);
  function port<T>(name: string, fresh: () => T): StatePort {
    return { name, reason: "Complete production collaborator table with real source callbacks and fixture-owned data bindings.", fresh: () => {
      if (context.state.has(name)) return context.state.get(name);
      const value = fresh(); context.state.set(name, value); return value;
    } };
  }
  return [
    port("projectFrames", () => {
      const frames = createProjectFrameEmitter(production("broadcast"));
      cleanups.push(() => frames.flush()); return frames;
    }),
    port("boxRelayDeps", () => ({
      resolveClaim: production("boxRelayDeps.resolveClaim"),
      isActive: production("boxRelayDeps.isActive"),
      boundBoxId: production("boxRelayDeps.boundBoxId"),
      accountToken: production("boxRelayDeps.accountToken"),
      enabled: production("boxRelayDeps.enabled"),
      upstreamBase: BOX_API_BASE,
      ...(context.boxFetch?{fetch:context.boxFetch}:{}),
      log: production("boxRelayDeps.log"),
    } satisfies BoxRelayDeps)),
    port("routineDeliveryDeps", () => ({
      owner: production("routineDeliveryDeps.owner"),
      mainChat: production("routineDeliveryDeps.mainChat"),
      isMainChat: production("routineDeliveryDeps.isMainChat"),
      threadExists: production("routineDeliveryDeps.threadExists"),
      messageById: production("routineDeliveryDeps.messageById"),
      appendMessage: production("routineDeliveryDeps.appendMessage"),
      patchMessage: production("routineDeliveryDeps.patchMessage"),
      markUnread: production("routineDeliveryDeps.markUnread"),
      runFiles: production("routineDeliveryDeps.runFiles"),
      recordDelivery: production("routineDeliveryDeps.recordDelivery"),
    } satisfies RoutineDeliveryDeps)),
    port("routineCardHooks", () => ({ opened: production("routineCardOpened"), closed: production("routineCardClosed") } satisfies RoutineCardHooks)),
    port("handoffAdmission", () => ({
      bot: production("handoffAdmission.bot"),
      handoffThread: production("handoffAdmission.handoffThread"),
      threadBusy: production("handoffAdmission.threadBusy"),
      groupTurnActive: production("handoffAdmission.groupTurnActive"),
      runningThreads: production("handoffAdmission.runningThreads"),
      maxThreads: MAX_CONCURRENT_BOT_THREADS,
    } satisfies HandoffAdmission)),
    port("commsBus", () => {
      const bus = {
        store: context.store,
        broadcast: production("broadcast"),
        turnOf: production("runningProviderTurnOf"),
        canDispatch: production("coordinationHasCapacity"),
        canStartHandoff: production("commsBus.canStartHandoff"),
        handoffRunning: production("commsBus.handoffRunning"),
        prepareDelegation: production("commsBus.prepareDelegation"),
      } satisfies CommsBus;
      realCommsInstances.set(context, bus); return bus;
    }),
    port("approvalBus", () => ({
      authorityFor: production("approvalBus.authorityFor"),
      store: context.store,
      broadcast: production("broadcast"),
      turnOf: production("runningProviderTurnOf"),
      onApproval: production("notifyApproval"),
      onBrowserOwnerWait: production("approvalBus.onBrowserOwnerWait"),
      get routineCard() { return routineCard(); },
      holdProjectApproval: production("approvalBus.holdProjectApproval"),
      unattended: production("peerContactUnattended"),
      fullAccessStanding: production("approvalBus.fullAccessStanding"),
    } satisfies ApprovalBus)),
    port("featureRouteDeps", () => ({
      dataDir: context.dataDir, database: context.database, store: context.store,
      artifactScopes: production("artifactScopes"),
      get projectFolders() { return leases().folders; },
      get projectTurns() { return leases(); },
      stoppedTurnCloseMs: providerCloseDeadlineMs,
    })),
    port("emailCallLive", () => ({
      bot: production("emailCallLive.bot"),
      ownerSurface: production("emailCallLive.ownerSurface"),
      notOwnerAudience: production("emailCallLive.notOwnerAudience"),
      ownerThread: production("emailCallLive.ownerThread"),
      boundRequest: production("emailCallLive.boundRequest"),
    })),
    port("askerWakePort", () => ({
      register: production("askerWakePort.register"),
      consume: production("askerWakePort.consume"),
      returned: production("askerWakePort.returned"),
    } satisfies AskerWakePort)),
    port("unstartedRoomTurnReleaseDeps", () => ({
      roomBusyBotId: production("unstartedRoomTurnReleaseDeps.roomBusyBotId"),
      botBusy: production("unstartedRoomTurnReleaseDeps.botBusy"),
      clearRoomClaim: production("unstartedRoomTurnReleaseDeps.clearRoomClaim"),
      idleBot: production("unstartedRoomTurnReleaseDeps.idleBot"),
      releaseBrowser: production("unstartedRoomTurnReleaseDeps.releaseBrowser"),
      drainQueues: production("unstartedRoomTurnReleaseDeps.drainQueues"),
    })),
    port("taskResolutionDeps", () => ({
      receipt: production("findDelegationReceipt"),
      pending: production("pendingDelegationInfo"),
      watches: production("taskResolutionDeps.watches"),
      started: production("startedTicket"),
      request: production("taskResolutionDeps.request"),
      requestSourceThread: production("taskResolutionDeps.requestSourceThread"),
      delivered: SHARED_RESULT_DELIVERED,
    } satisfies TaskResolutionDeps)),
    port("roomCompletionHooks", () => ({
      ownerWords: production("roomCompletionHooks.ownerWords"),
      restartCards: production("roomCompletionHooks.restartCards"),
      settleUsage: production("roomCompletionHooks.settleUsage"),
      cardGenerationCurrent: production("cardGenerationCurrent"),
      cardEffect: production("roomCompletionHooks.cardEffect"),
      returnThread: production("roomCompletionHooks.returnThread"),
      reviewWake: production("roomCompletionHooks.reviewWake"),
    } satisfies CompletionHooks)),
    port("resultEgressDeps", () => ({
      message: production("resultEgressDeps.message"),
      request: production("resultEgressDeps.request"),
      requestSourceThread: production("resultEgressDeps.requestSourceThread"),
      authorize: production("resultEgressDeps.authorize"),
      copyOriginWithheld: production("resultEgressDeps.copyOriginWithheld"),
      capturedMessageWithheld: production("resultEgressDeps.capturedMessageWithheld"),
      messageSourceForgotten, messageMadeWithMemory,
      partitionAllowed: production("resultEgressDeps.partitionAllowed"),
      ownUnsharedWork: ownUnsharedWorkCheck<BotRecord>({
        bot: production("resultEgressDeps.ownUnsharedWork.bot"),
        isOwnUnsharedThread: production("isOwnUnsharedThread"),
        isOwnerNoLimitsSource: production("resultEgressDeps.ownUnsharedWork.isOwnerNoLimitsSource"),
        isSamePersonUnsharedPair: production("isSamePersonUnsharedPair"),
        principal: threadHumanPrincipal,
        message: production("resultEgressDeps.ownUnsharedWork.message"),
      }),
      personScopes: production("resultEgressDeps.personScopes"),
      withheldLine: `[${ROOM_REPLY_WITHHELD}]`,
      linesShown: writetimeLinesShown(context.database, production("ownerOwnConversation")),
      doorShown: doorEgress(context.database, production("ownerOwnConversation")),
    } satisfies StoredAnswerDeps)),
    port("personCopyReaders", () => ({ linesShown: writetimeLinesShown(context.database), doorShown: doorEgress(context.database) })),
    port("boundaryStoreView", () => boundaryStore(context.store)),
    port("boundaryCommsBase", () => {
      const bus = context.state.get("commsBus") as CommsBus;
      if (!bus || realCommsInstances.get(context) !== bus) throw new Error("FIXTURE_SCOPE_UNRESOLVED commsBus: real composite constructor identity required");
      const base = boundaryComms(bus); realBoundaryCommsInstances.set(context, base); return base;
    }),
    port("boundaryCommsPort", () => {
      const base = context.state.get("boundaryCommsBase") as BoundaryComms;
      if (!base || realBoundaryCommsInstances.get(context) !== base) throw new Error("FIXTURE_SCOPE_UNRESOLVED boundaryCommsBase: real boundary factory identity required");
      return { ...base, enqueueShared: production("boundaryCommsPort.enqueueShared") } satisfies BoundaryComms;
    }),
    port("projectHooks", () => ({
      applyGoalEnvelope: production("projectHooks.applyGoalEnvelope"),
      pauseGoal: production("projectHooks.pauseGoal"),
      resumeGoal: production("projectHooks.resumeGoal"),
      setRunState: production("projectHooks.setRunState"),
    })),
  ];
}
