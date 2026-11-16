// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety. Production service and policy owners: their modules
// and the extracted index.ts callbacks registered through InternalPortContext.
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { indexSourceData } from "./internal-source-data.ts";
import { ModelSignIns, type ModelSignInsOptions } from "../model-signin.ts";
import { ProviderConnectionsService } from "../provider-connections.ts";
import { ImageGenerationService, type ImageGenerationServiceOptions } from "../image-generation.ts";
import { PublishOperations } from "../publish/publish-ops.ts";
import { ImageOperations } from "../image-operations.ts";
import { EmailRuntime, type EmailRuntimeOptions } from "../email/runtime.ts";
import type { EmailCardHost } from "../email/cards.ts";
import { PhoneJobs } from "../phones/jobs.ts";
import { deviceJobPush, type DeviceJobPushDeps } from "../phones/job-push.ts";
import { RemoteSseSessions } from "../remote-mcp-sse-sessions.ts";
import { WebhookManager, type WebhookManagerOptions } from "../webhooks.ts";
import { RoutineRequestService, type RoutineRequestServiceOptions } from "../routine-requests.ts";
import { RoutineManager, type RoutineManagerOptions } from "../routines.ts";
import { AppTriggerStore } from "../app-trigger-store.ts";
import { HighLevelConnectionSource } from "../highlevel/connection-source.ts";
import { HighLevelTurnSignals } from "../highlevel/host.ts";
import { createHighLevelRuntime, type HighLevelRuntimeOptions } from "../highlevel/runtime.ts";
import { PrivateTokenLeaseSource, defaultHighLevelConnectionFile } from "../highlevel/private-token.ts";
import { database } from "../database.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import type { StatePort } from "./source-extract.ts";
import { registerPortConstructor } from "./port-integrity.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [ModelSignIns, ProviderConnectionsService, ImageGenerationService, PublishOperations, ImageOperations, EmailRuntime, PhoneJobs, RemoteSseSessions, WebhookManager, RoutineRequestService, RoutineManager, AppTriggerStore, HighLevelConnectionSource, HighLevelTurnSignals, PrivateTokenLeaseSource]) if (typeof Constructor === "function") registerPortConstructor(Constructor);

type Fn = (...args: any[]) => any;
type ProviderOptions = ConstructorParameters<typeof ProviderConnectionsService>[0];
type ImageOptions = ConstructorParameters<typeof ImageOperations>[0];
type PublishOptions = ConstructorParameters<typeof PublishOperations>[0];
const cleanups: Array<() => unknown> = [];
/** The only replacement below is the external provider network boundary. */
const unavailableProviderNetwork: typeof fetch = async () => {
  throw new Error("FIXTURE_IO_NOT_CONFIGURED provider network");
};
function port<T>(name: string, fresh: () => T, close?: (value: T) => unknown): StatePort {
  return { name, reason: "Complete production class; real extracted admission/policy callbacks and isolated fixture storage.", fresh: () => {
    const value = fresh();
    if (close) cleanups.push(() => close(value));
    return value;
  } };
}
function instance<T>(context: InternalPortContext, name: string, ctor: abstract new (...args: any[]) => T): T {
  const value = context.state.get(name);
  if (!(value instanceof ctor)) throw new Error(`FIXTURE_SCOPE_UNRESOLVED ${name}: complete production instance required`);
  return value;
}
export async function closeProviderFixturePorts(): Promise<void> {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "FIXTURE_PROVIDER_CLEANUP_FAILED");
}

/** These are explicit constructor recipes, never evaluated index initializers.
 * production() records every callback's real source for eager binder validation;
 * it does not supply an authority decision or a replacement policy. */
export function providerFixturePorts(context: InternalPortContext): StatePort[] {
  const production = <T extends Fn>(name: string): T => context.production<T>(name);
  return [
    port("modelSignIns", () => new ModelSignIns({
      env: {},
      requestRefresh: production<NonNullable<ModelSignInsOptions["requestRefresh"]>>("modelSignIns.requestRefresh"),
      onChange: production<NonNullable<ModelSignInsOptions["onChange"]>>("modelSignIns.onChange"),
    })),
    port("providerConnections", () => new ProviderConnectionsService({
      readBank: production<ProviderOptions["readBank"]>("providerConnections.readBank"),
      cacheDir: join(context.dataDir, "provider-catalogs"),
      signIns: instance(context, "modelSignIns", ModelSignIns),
      fetch: unavailableProviderNetwork,
      keyGate: production<NonNullable<ProviderOptions["keyGate"]>>("providerConnections.keyGate"),
      beginEvidence: production<NonNullable<ProviderOptions["beginEvidence"]>>("beginFluxKeyEvidence"),
      evidenceCurrent: production<NonNullable<ProviderOptions["evidenceCurrent"]>>("fluxKeyTicketCurrent"),
      onCatalogOutcome: production<NonNullable<ProviderOptions["onCatalogOutcome"]>>("providerConnections.onCatalogOutcome"),
      resolveAlias: production<NonNullable<ProviderOptions["resolveAlias"]>>("providerConnections.resolveAlias"),
      legacyConnections: production<NonNullable<ProviderOptions["legacyConnections"]>>("providerConnections.legacyConnections"),
    })),
    port("imageService", () => new ImageGenerationService({
      resolveConnection: production<ImageGenerationServiceOptions["resolveConnection"]>("imageConnection"),
      connectionIds: production<ImageGenerationServiceOptions["connectionIds"]>("imageConnectionIds"),
      fetch: unavailableProviderNetwork,
    })),
    port("publishOperations", () => new PublishOperations({
      store: context.store,
      token: production<PublishOptions["token"]>("publishOperations.token"),
      waiting: production<PublishOptions["waiting"]>("publishOperations.waiting"),
      workspaceFor: production<PublishOptions["workspaceFor"]>("publishOperations.workspaceFor"),
      fetchImpl: unavailableProviderNetwork,
    })),
    port("imageOperations", () => {
      // This class intentionally owns its production database accessor. Refuse
      // a different fixture DB instead of silently writing another installation.
      if (database() !== context.database()) throw new Error("FIXTURE_SCOPE_UNRESOLVED imageOperations database identity");
      return new ImageOperations({
        store: context.store,
        waiting: production<ImageOptions["waiting"]>("imageOperations.waiting"),
        speaker: production<NonNullable<ImageOptions["speaker"]>>("imageOperations.speaker"),
        holdProjectApproval: production<NonNullable<ImageOptions["holdProjectApproval"]>>("imageOperations.holdProjectApproval"),
        rendering: production<NonNullable<ImageOptions["rendering"]>>("imageOperations.rendering"),
        autoApproval: production<NonNullable<ImageOptions["autoApproval"]>>("imageAutoApproval"),
        autoApprovalLogged: production<NonNullable<ImageOptions["autoApprovalLogged"]>>("imageAutoApprovalLogged"),
        routineCard: {
          opened: production<NonNullable<ImageOptions["routineCard"]>["opened"]>("routineCardOpened"),
          closed: production<NonNullable<ImageOptions["routineCard"]>["closed"]>("routineCardClosed"),
        },
      });
    }),
    port("remoteSseSessions", () => new RemoteSseSessions({
      isLive: production<(generation: string) => boolean>("remoteSseSessions.isLive"),
    }), value => value.closeAll()),
    port("phoneJobs", () => new PhoneJobs({
      authorityFor: production<NonNullable<ConstructorParameters<typeof PhoneJobs>[0]["authorityFor"]>>("producerAuthorityFor"),
      now: Date.now,
      setTimer: (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); },
      push: deviceJobPush({
        bindingIdForDevice: production<DeviceJobPushDeps["bindingIdForDevice"]>("phoneJobs.push.bindingIdForDevice"),
        outbox: {
          enqueueDeviceJob: production<DeviceJobPushDeps["outbox"]["enqueueDeviceJob"]>("phoneJobs.push.outbox.enqueueDeviceJob"),
          resolve: production<DeviceJobPushDeps["outbox"]["resolve"]>("phoneJobs.push.outbox.resolve"),
        },
        warn: production<NonNullable<DeviceJobPushDeps["warn"]>>("phoneJobs.push.warn"),
      }),
      ids: randomUUID,
      leaseToken: () => randomBytes(32).toString("base64url"),
    }), value => value.shutdown()),
    port("appRunStore", () => new AppTriggerStore(context.database())),
    port("routines", () => new RoutineManager({
      appRunStore: instance(context, "appRunStore", AppTriggerStore),
      file: join(context.dataDir, "routines.json"),
      catchUpStaggerMs: indexSourceData("routines.catchUpStaggerMs"),
      dispatchStaggerMs: indexSourceData("routines.dispatchStaggerMs"),
      maxConcurrentAutomaticRuns: indexSourceData("routines.maxConcurrentAutomaticRuns"),
      automaticCapCeiling: indexSourceData("routines.automaticCapCeiling"),
      botMode: production<NonNullable<RoutineManagerOptions["botMode"]>>("routines.botMode"),
      validateInstructionPromotion: production<NonNullable<RoutineManagerOptions["validateInstructionPromotion"]>>("routines.validateInstructionPromotion"),
      validateInstructionEvidence: production<NonNullable<RoutineManagerOptions["validateInstructionEvidence"]>>("routines.validateInstructionEvidence"),
      readWatchSource: production<NonNullable<RoutineManagerOptions["readWatchSource"]>>("routines.readWatchSource"),
      dispatchOpen: production<NonNullable<RoutineManagerOptions["dispatchOpen"]>>("routines.dispatchOpen"),
      dispatchHeld: production<NonNullable<RoutineManagerOptions["dispatchHeld"]>>("routines.dispatchHeld"),
      automaticPaused: production<NonNullable<RoutineManagerOptions["automaticPaused"]>>("routines.automaticPaused"),
      startupReady: production<NonNullable<RoutineManagerOptions["startupReady"]>>("routines.startupReady"),
      admitAutomatic: production<NonNullable<RoutineManagerOptions["admitAutomatic"]>>("routines.admitAutomatic"),
      beginStart: production<NonNullable<RoutineManagerOptions["beginStart"]>>("routines.beginStart"),
      activeProjectRoutineRuns: production<NonNullable<RoutineManagerOptions["activeProjectRoutineRuns"]>>("routines.activeProjectRoutineRuns"),
      connectorsMissing: production<NonNullable<RoutineManagerOptions["connectorsMissing"]>>("routines.connectorsMissing"),
      isChannelCurrent: production<NonNullable<RoutineManagerOptions["isChannelCurrent"]>>("routines.isChannelCurrent"),
      emit: production<NonNullable<RoutineManagerOptions["emit"]>>("routines.emit"),
      channelMessagesOff: production<NonNullable<RoutineManagerOptions["channelMessagesOff"]>>("routines.channelMessagesOff"),
      channelThread: production<NonNullable<RoutineManagerOptions["channelThread"]>>("routines.channelThread"),
      botState: production<NonNullable<RoutineManagerOptions["botState"]>>("routines.botState"),
      channelMessagesEnabled: production<NonNullable<RoutineManagerOptions["channelMessagesEnabled"]>>("routines.channelMessagesEnabled"),
      threadBusy: production<NonNullable<RoutineManagerOptions["threadBusy"]>>("routines.threadBusy"),
      goalState: production<NonNullable<RoutineManagerOptions["goalState"]>>("routines.goalState"),
      createTask: production<NonNullable<RoutineManagerOptions["createTask"]>>("routines.createTask"),
      projectRoutine: production<NonNullable<RoutineManagerOptions["projectRoutine"]>>("routines.projectRoutine"),
      createGoalTask: production<NonNullable<RoutineManagerOptions["createGoalTask"]>>("routines.createGoalTask"),
      projectOpen: production<NonNullable<RoutineManagerOptions["projectOpen"]>>("routines.projectOpen"),
      boxEngine: production<NonNullable<RoutineManagerOptions["boxEngine"]>>("routines.boxEngine"),
      taskExists: production<NonNullable<RoutineManagerOptions["taskExists"]>>("routines.taskExists"),
      goalTaskExists: production<NonNullable<RoutineManagerOptions["goalTaskExists"]>>("routines.goalTaskExists"),
      onRunDispatch: production<NonNullable<RoutineManagerOptions["onRunDispatch"]>>("routines.onRunDispatch"),
      channelStartOwner: production<NonNullable<RoutineManagerOptions["channelStartOwner"]>>("routines.channelStartOwner"),
      memoryRebuildOwed: production<NonNullable<RoutineManagerOptions["memoryRebuildOwed"]>>("routines.memoryRebuildOwed"),
      startTurn: production<NonNullable<RoutineManagerOptions["startTurn"]>>("routines.startTurn"),
      startGoal: production<NonNullable<RoutineManagerOptions["startGoal"]>>("routines.startGoal"),
      interruptTurn: production<NonNullable<RoutineManagerOptions["interruptTurn"]>>("routines.interruptTurn"),
      onRunChanged: production<NonNullable<RoutineManagerOptions["onRunChanged"]>>("routines.onRunChanged"),
      onRunNeedsYou: production<NonNullable<RoutineManagerOptions["onRunNeedsYou"]>>("routines.onRunNeedsYou"),
      limitRefusal: production<NonNullable<RoutineManagerOptions["limitRefusal"]>>("routines.limitRefusal"),
      onRunFailed: production<NonNullable<RoutineManagerOptions["onRunFailed"]>>("routines.onRunFailed"),
      onRunRecovered: production<NonNullable<RoutineManagerOptions["onRunRecovered"]>>("routines.onRunRecovered"),
      validateWatchSource: production<NonNullable<RoutineManagerOptions["validateWatchSource"]>>("validateWatchSource"),
      priorReplyCarryable: production<NonNullable<RoutineManagerOptions["priorReplyCarryable"]>>("priorReplyCarryable"),
      priorReplyEmailDerived: production<NonNullable<RoutineManagerOptions["priorReplyEmailDerived"]>>("priorReplyEmailDerived"),
      interruptGoal: production<NonNullable<RoutineManagerOptions["interruptGoal"]>>("interruptRoutineGroupGoal"),
    }), value => value.stop()),
    port("webhooks", () => new WebhookManager({
      file: join(context.dataDir, "webhooks.json"),
      emit: production<NonNullable<WebhookManagerOptions["emit"]>>("broadcast"),
      botState: production<WebhookManagerOptions["botState"]>("webhooks.botState"),
      enqueue: production<WebhookManagerOptions["enqueue"]>("webhooks.enqueue"),
      cancelQueued: production<NonNullable<WebhookManagerOptions["cancelQueued"]>>("webhooks.cancelQueued"),
      pendingRuns: production<NonNullable<WebhookManagerOptions["pendingRuns"]>>("webhooks.pendingRuns"),
      findDelivery: production<NonNullable<WebhookManagerOptions["findDelivery"]>>("webhooks.findDelivery"),
    })),
    port("routineRequests", () => new RoutineRequestService({
      store: context.store,
      routines: instance(context, "routines", RoutineManager),
      resolveWatchSource: production<NonNullable<RoutineRequestServiceOptions["resolveWatchSource"]>>("resolveWatchSource"),
      cloudReady: production<NonNullable<RoutineRequestServiceOptions["cloudReady"]>>("cloudRoutineReadiness"),
      canPersist: production<NonNullable<RoutineRequestServiceOptions["canPersist"]>>("routineProposalPersistence"),
      holdTarget: production<NonNullable<RoutineRequestServiceOptions["holdTarget"]>>("routineRequests.holdTarget"),
      validateTarget: production<NonNullable<RoutineRequestServiceOptions["validateTarget"]>>("routineRequests.validateTarget"),
      webhooks: production<NonNullable<RoutineRequestServiceOptions["webhooks"]>>("routineRequests.webhooks"),
    })),
    port("emailRuntime", () => {
      const cardHost: EmailCardHost = {
        botName: production<EmailCardHost["botName"]>("emailRuntime.cardHost.botName"),
        threadExists: production<EmailCardHost["threadExists"]>("emailRuntime.cardHost.threadExists"),
        card: production<EmailCardHost["card"]>("emailRuntime.cardHost.card"),
        cardMessages: production<NonNullable<EmailCardHost["cardMessages"]>>("emailRuntime.cardHost.cardMessages"),
        appendCard: production<EmailCardHost["appendCard"]>("emailRuntime.cardHost.appendCard"),
        patchCard: production<EmailCardHost["patchCard"]>("emailRuntime.cardHost.patchCard"),
        outcome: production<EmailCardHost["outcome"]>("emailRuntime.cardHost.outcome"),
        activity: production<EmailCardHost["activity"]>("emailRuntime.cardHost.activity"),
        notify: production<EmailCardHost["notify"]>("emailRuntime.cardHost.notify"),
      };
      return new EmailRuntime({
        database: context.database,
        transaction: production<EmailRuntimeOptions["transaction"]>("emailRuntime.transaction"),
        accountKey: production<EmailRuntimeOptions["accountKey"]>("fluxKey"),
        authorityFor: production<NonNullable<EmailRuntimeOptions["authorityFor"]>>("emailRuntime.authorityFor"),
        restoreWindow: production<NonNullable<EmailRuntimeOptions["restoreWindow"]>>("emailRuntime.restoreWindow"),
        workspaceRoot: production<EmailRuntimeOptions["workspaceRoot"]>("emailRuntime.workspaceRoot"),
        bot: production<EmailRuntimeOptions["bot"]>("emailRuntime.bot"),
        persistSecrets: production<NonNullable<EmailRuntimeOptions["persistSecrets"]>>("emailRuntime.persistSecrets"),
        secretsDurable: production<NonNullable<EmailRuntimeOptions["secretsDurable"]>>("emailRuntime.secretsDurable"),
        deletionProof: production<NonNullable<EmailRuntimeOptions["deletionProof"]>>("emailRuntime.deletionProof"),
        offered: production<NonNullable<EmailRuntimeOptions["offered"]>>("emailRuntime.offered"),
        onStatus: production<NonNullable<EmailRuntimeOptions["onStatus"]>>("emailRuntime.onStatus"),
        onArrival: production<NonNullable<EmailRuntimeOptions["onArrival"]>>("emailRuntime.onArrival"),
        capsFile: join(context.dataDir, "email-capabilities.json"),
        fetch: unavailableProviderNetwork,
        cardHost,
      });
    }, value => value.stop()),
    port("highlevelTokenSource", () => new PrivateTokenLeaseSource({
      token: production<ConstructorParameters<typeof PrivateTokenLeaseSource>[0]["token"]>("highlevelTokenSource.token"),
      file: defaultHighLevelConnectionFile(context.dataDir),
      fetch: unavailableProviderNetwork,
    })),
    port("highlevelCredentialConnection", () => null),
    port("highlevelConnectionSource", () => new HighLevelConnectionSource(
      instance(context, "highlevelTokenSource", PrivateTokenLeaseSource), null,
    )),
    port("highlevel", () => createHighLevelRuntime({
      dataDir: context.dataDir,
      capabilities: context.capabilities,
      signals: instance(context, "highlevelCalls", HighLevelTurnSignals),
      leases: instance(context, "highlevelConnectionSource", HighLevelConnectionSource),
      userCreateOwner: production<NonNullable<HighLevelRuntimeOptions["userCreateOwner"]>>("highlevel.userCreateOwner"),
      threadMarkState: production<HighLevelRuntimeOptions["threadMarkState"]>("highlevel.threadMarkState"),
      bot: production<HighLevelRuntimeOptions["bot"]>("highlevel.bot"),
      operationScopes: production<NonNullable<HighLevelRuntimeOptions["operationScopes"]>>("highlevel.operationScopes"),
      onJournalHeld: production<NonNullable<HighLevelRuntimeOptions["onJournalHeld"]>>("highlevel.onJournalHeld"),
      fetch: unavailableProviderNetwork,
    }), value => value.close()),
  ];
}
