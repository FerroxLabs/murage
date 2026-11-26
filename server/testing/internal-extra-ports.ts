// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety. Production service/policy owners: their modules
// and the real index callbacks resolved by InternalPortContext.production.
import ts from "typescript";
import { homeEventsDir } from "../home-events.ts";
import { createBackupRestartAdmission } from "../backup-restart-admission.ts";
import { ChiefProposalTurns } from "../project-proposal-engines.ts";
import { createCloudEmailAvailability } from "../cloud-home/email-signin-availability.ts";
import { FluxMemoryForget, type FluxForgetDeps } from "../flux-memory-forget.ts";
import { createOwnerZoneReconciler } from "../owner-zone-reconcile.ts";
import { createPushWarn } from "../mobile-push-hooks.ts";
import { createReplySpeakerTurns } from "../reply-speaker-guard.ts";
import { RestoreJobStore, type RestoreJobOptions } from "../email/restore-job.ts";
import { archiveIsLocal, captureEmailCarry, sqliteRestoreEffects } from "../email/restore-job-effects.ts";
import { createTaskAggregateCache } from "../task-window.ts";
import { TaskAllowances } from "../stop-line-state.ts";
import { TeamIncidentLedger } from "../team-incidents.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserCheckTurns, type BrowserCheckNotes } from "../browser-check-state.ts";
import { FluxMemoryCapture, type FluxCaptureDeps } from "../flux-memory-capture.ts";
import { backupGate, type BackupGateDeps } from "../limit-backup-gate.ts";
import { createTaskDelta, type TaskDeltaOptions } from "../task-delta.ts";
import { createOutputPublisher, type OutputPublicationDeps } from "../output-publication.ts";
import { createCloudEmailSaver } from "../cloud-home/email-keystore-server.ts";
import { BrowserCleanupCoordinator } from "../browser-lifecycle-cleanup.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { loadBundledSkills, shippedSkillCheck, type BundledSkill } from "../skill-library.ts";
import { createFreshStartOwner, type FreshStartOwnerDeps } from "../memory/gh18-fresh-start-owner.ts";
import { planFreshStart, applyFreshStartRows } from "../memory/gh18-fresh-start.ts";
import { createKeepAllRepairGate, keepAllUnwedged } from "../memory/keepall-unwedge.ts";
import { createSharedOwnerUsage } from "../shared-owner-usage.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { TelegramService } from "../telegram-service.ts";
import { TelegramTransport } from "../telegram-transport.ts";
import { loadConfig } from "../config.ts";
import { PushOutbox, type OutboxWorld, type PushSender } from "../mobile-push-outbox.ts";
import { PushStore } from "../mobile-push-store.ts";
import { createFluxSpendReader } from "../flux-limits.ts";
import { createAccountReader, createSpendGate, type SpendGateOptions } from "../spend-gate.ts";
import { RowSink } from "../bot-egress.ts";
import { createRoomDispatcher, type RoomDispatcherDeps } from "../room-dispatcher.ts";
import type { WorkAdmission } from "../work-admission.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import { extractFunction, type StatePort } from "./source-extract.ts";
import { registerPortConstructor } from "./port-integrity.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [ChiefProposalTurns, FluxMemoryForget, RestoreJobStore, TaskAllowances, TeamIncidentLedger, BrowserCheckTurns, FluxMemoryCapture, BrowserCleanupCoordinator, TelegramService, TelegramTransport, PushOutbox, PushStore, RowSink]) if (typeof Constructor === "function") registerPortConstructor(Constructor);

type Fn = (...args: any[]) => any;
type PushOptions = ConstructorParameters<typeof PushOutbox>[0];
type SpendReaderOptions = Parameters<typeof createFluxSpendReader>[0];
const cleanups: Array<() => unknown> = [];
const failClosedProviderFetch: typeof fetch = async () => {
  throw new Error("FIXTURE_IO_NOT_CONFIGURED spend provider network");
};
const failClosedPushDelivery: PushSender["publish"] = async () => {
  throw new Error("FIXTURE_IO_NOT_CONFIGURED push relay delivery");
};
function port<T>(name: string, create: () => T, close?: (value: T) => unknown): StatePort {
  const fresh = () => { const value = create(); if (close) cleanups.push(() => close(value)); return value; };
  return { name, fresh, reason: "Complete production service, real extracted callbacks, isolated storage, explicit external I/O boundary." };
}
/** Constructor-time state readers use their exact production AST. Their
 * only dependency is the same real isolated config object used by later calls. */
function spendBootReader<T extends Fn>(context: InternalPortContext, name: "loadAccount" | "loadMembership" | "loadRefusals"): T {
  let cfg = context.state.get("cfg");
  if (cfg === undefined) { cfg = loadConfig(); context.state.set("cfg", cfg); }
  const extracted = extractFunction({ file: new URL("../index.ts", import.meta.url), select: source => {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "spendGate" || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
        const options = declaration.initializer.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) continue;
        for (const property of options.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === name) return property.initializer;
        }
      }
    }
    throw new Error(`FIXTURE_POLICY_DEPENDENCY_MISSING spendGate.${name}`);
  } }).preflightSync({}, {ports:[{name:"cfg",fresh:()=>cfg,reason:"Real isolated config loaded by loadConfig; no case config override."}]}).value;
  if (typeof extracted !== "function") throw new Error(`FIXTURE_POLICY_DEPENDENCY_MISSING spendGate.${name}`);
  return extracted as T;
}
export async function closeExtraFixturePorts(): Promise<void> {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "FIXTURE_EXTRA_CLEANUP_FAILED");
}

/** No source initializer executes. SpendGate's persisted-state readers execute
 * during construction, so those readers are independently source-extracted. */
export function extraFixturePorts(context: InternalPortContext): StatePort[] {
  const production = <T extends Fn>(name: string): T => context.production<T>(name);
  const required = <T>(name: string): T => {
    const value = context.state.get(name);
    if (value === undefined || value === null) throw new Error(`FIXTURE_SCOPE_UNRESOLVED ${name}: real production service required`);
    return value as T;
  };
  return [
    port("rows", () => new RowSink(context.store)),
    port("fluxMediaRequests", () => 0),
    port("providerConnectionsBusy", () => false),
    port("HOME_EVENTS_DIR", () => homeEventsDir(process.env)),
    port("backupRestartAdmission", () => createBackupRestartAdmission({
      isBusy: production<Parameters<typeof createBackupRestartAdmission>[0]["isBusy"]>("backupRestartAdmission.isBusy"),
      onRelease: production<Parameters<typeof createBackupRestartAdmission>[0]["onRelease"]>("backupRestartAdmission.onRelease"),
    })),
    port("chiefProposals", () => new ChiefProposalTurns()),
    port("cloudEmailAvailability", () => createCloudEmailAvailability(), value => value.dispose()),
    port("pushWarn", () => createPushWarn()),
    port("replySpeakerTurns", () => createReplySpeakerTurns()),
    port("taskAggregates", () => createTaskAggregateCache()),
    port("taskAllowances", () => new TaskAllowances()),
    port("teamIncidentLedger", () => new TeamIncidentLedger()),
    port("ownerZoneReconciler", () => createOwnerZoneReconciler(
      production<Parameters<typeof createOwnerZoneReconciler>[0]>("ownerZoneReconciler.$0"),
    )),
    port("restoreJobs", () => new RestoreJobStore({
      dir: context.dataDir,
      backupBusy: production<NonNullable<RestoreJobOptions["backupBusy"]>>("restoreJobs.backupBusy"),
      onAbort: production<NonNullable<RestoreJobOptions["onAbort"]>>("restoreJobs.onAbort"),
      onHoldExpired: production<NonNullable<RestoreJobOptions["onHoldExpired"]>>("restoreJobs.onHoldExpired"),
      isLocalArchive: id => archiveIsLocal(join(context.dataDir, "restore-archives"), id),
      captureCarry: () => captureEmailCarry(join(context.dataDir, "messages.db")),
      effects: sqliteRestoreEffects({ liveDb: join(context.dataDir, "messages.db"), archivesDir: join(context.dataDir, "restore-archives") }),
    })),
    port("fluxMemoryForget", () => new FluxMemoryForget({
      db: context.database,
      key: production<FluxForgetDeps["key"]>("fluxMemoryForget.key"),
      busy: production<FluxForgetDeps["busy"]>("fluxMemoryForget.busy"),
      dispatcher: production<NonNullable<FluxForgetDeps["dispatcher"]>>("fluxMemoryForget.dispatcher"),
      fetch: failClosedProviderFetch,
    }), value => value.stop()),

    port("browserCheckTurns", () => new BrowserCheckTurns({
      patch: production<BrowserCheckNotes["patch"]>("browserCheckTurns.patch"),
    })),
    port("proxyReleaseAuthority", () => createProxyReleaseAuthority(context.capabilities)),
    port("browserCleanup", () => new BrowserCleanupCoordinator({
      file: join(context.dataDir, "browser-cleanups.json"),
      send: production<ConstructorParameters<typeof BrowserCleanupCoordinator>[0]["send"]>("postDesktopPrivateMessage"),
    })),
    // A private utility port is absent in this desktop fixture. No post I/O
    // exists, so this complete service retains its documented no-port behavior.
    port("cloudEmailSaver", () => createCloudEmailSaver(0)),
    port("bundledSkills", () => loadBundledSkills(fileURLToPath(new URL("../../skills", import.meta.url)))),
    port("murageSkill", () => shippedSkillCheck(required<BundledSkill[]>("bundledSkills"))),
    port("keepAllRepair", () => createKeepAllRepairGate(keepAllUnwedged(context.database(), context.dataDir)), value => value.stop()),
    port("freshStartOwner", () => createFreshStartOwner({
      db: context.database,
      policy: { planFreshStart, applyFreshStartRows },
      bot: production<FreshStartOwnerDeps["bot"]>("freshStartOwner.bot"),
      schemaCompatible: production<FreshStartOwnerDeps["schemaCompatible"]>("freshStartOwner.schemaCompatible"),
      storeRevision: production<FreshStartOwnerDeps["storeRevision"]>("freshStartOwner.storeRevision"),
      liveThreads: production<FreshStartOwnerDeps["liveThreads"]>("freshStartOwner.liveThreads"),
      botBusy: production<FreshStartOwnerDeps["botBusy"]>("freshStartOwner.botBusy"),
      ownerDirectThread: production<FreshStartOwnerDeps["ownerDirectThread"]>("freshStartOwner.ownerDirectThread"),
      pendingDeletion: production<FreshStartOwnerDeps["pendingDeletion"]>("freshStartOwner.pendingDeletion"),
      clearCursors: production<FreshStartOwnerDeps["clearCursors"]>("freshStartOwner.clearCursors"),
      flush: production<FreshStartOwnerDeps["flush"]>("freshStartOwner.flush"),
    })),
    port("taskDelta", () => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      cleanups.push(() => { for (const timer of timers) clearTimeout(timer); timers.clear(); });
      return createTaskDelta({
        repair: production<NonNullable<TaskDeltaOptions["repair"]>>("taskDelta.repair"),
        setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); timers.add(timer); return timer; },
        clearTimer: handle => { for (const timer of timers) if (timer === handle) { clearTimeout(timer); timers.delete(timer); } },
      });
    }),
    port("outputPublisher", () => createOutputPublisher({
      store: context.store, database: context.database, dataDir: context.dataDir,
      artifactScopes: production<OutputPublicationDeps["artifactScopes"]>("artifactScopes"),
      turnOfRun: production<NonNullable<OutputPublicationDeps["turnOfRun"]>>("outputPublisher.turnOfRun"),
    })),
    port("backupVerdict", () => backupGate({
      hidden: production<BackupGateDeps["hidden"]>("backupVerdict.hidden"),
      registered: production<BackupGateDeps["registered"]>("backupVerdict.registered"),
      routes: production<BackupGateDeps["routes"]>("selectionRoutes"),
      billingAllowed: production<BackupGateDeps["billingAllowed"]>("backupVerdict.billingAllowed"),
      atLimit: production<BackupGateDeps["atLimit"]>("engineAtLimit"),
    })),
    port("sharedOwnerUsage", () => createSharedOwnerUsage<RuntimeEvent>(
      production<Parameters<typeof createSharedOwnerUsage<RuntimeEvent>>[0]>("sharedOwnerUsage.$0"),
    )),
    port("telegram", () => new TelegramService({
      dataDir: context.dataDir,
      isCurrentTarget: production<NonNullable<ConstructorParameters<typeof TelegramService>[0]["isCurrentTarget"]>>("telegram.isCurrentTarget"),
      approvals: production<NonNullable<ConstructorParameters<typeof TelegramService>[0]["approvals"]>>("telegram.approvals"),
      onVerifiedSender: production<NonNullable<ConstructorParameters<typeof TelegramService>[0]["onVerifiedSender"]>>("telegram.onVerifiedSender"),
      enqueue: production<ConstructorParameters<typeof TelegramService>[0]["enqueue"]>("telegram.enqueue"),
      runResult: production<ConstructorParameters<typeof TelegramService>[0]["runResult"]>("telegram.runResult"),
      voiceNotes: production<NonNullable<ConstructorParameters<typeof TelegramService>[0]["voiceNotes"]>>("channelVoiceNotes"),
      revokeRuns: production<ConstructorParameters<typeof TelegramService>[0]["revokeRuns"]>("telegram.revokeRuns"),
      transport: token => new TelegramTransport({ token, fetch: failClosedProviderFetch }),
    }), value => value.stop()),
    port("fluxMemoryCapture", () => new FluxMemoryCapture({
      key: production<FluxCaptureDeps["key"]>("fluxMemoryCapture.key"),
      threadCaptures: production<FluxCaptureDeps["threadCaptures"]>("fluxMemoryCapture.threadCaptures"),
      userText: production<FluxCaptureDeps["userText"]>("fluxMemoryCapture.userText"),
      asksFirst: production<FluxCaptureDeps["asksFirst"]>("fluxMemoryCapture.asksFirst"),
      botCaptures: production<NonNullable<FluxCaptureDeps["botCaptures"]>>("fluxMemoryCapture.botCaptures"),
      ledger: {
        noteUsed: production<FluxCaptureDeps["ledger"]["noteUsed"]>("fluxMemoryCapture.ledger.noteUsed"),
        keyOff: production<FluxCaptureDeps["ledger"]["keyOff"]>("fluxMemoryCapture.ledger.keyOff"),
        setKeyOff: production<FluxCaptureDeps["ledger"]["setKeyOff"]>("fluxMemoryCapture.ledger.setKeyOff"),
        accepted: production<FluxCaptureDeps["ledger"]["accepted"]>("fluxMemoryCapture.ledger.accepted"),
        routeProven: production<NonNullable<FluxCaptureDeps["ledger"]["routeProven"]>>("fluxMemoryCapture.ledger.routeProven"),
        threadForgotten: production<FluxCaptureDeps["ledger"]["threadForgotten"]>("fluxMemoryCapture.ledger.threadForgotten"),
        spaceGone: production<FluxCaptureDeps["ledger"]["spaceGone"]>("fluxMemoryCapture.ledger.spaceGone"),
        limit: production<FluxCaptureDeps["ledger"]["limit"]>("fluxMemoryCapture.ledger.limit"),
      },
      onReowe: production<NonNullable<FluxCaptureDeps["onReowe"]>>("fluxMemoryCapture.onReowe"),
      dispatcher: production<NonNullable<FluxCaptureDeps["dispatcher"]>>("fluxMemoryCapture.dispatcher"),
      fetch: failClosedProviderFetch,
    }), value => { for (const bot of context.store.bots) value.forgetBot(bot.id); }),

    port("pushOutbox", () => {
      const store = context.state.get("pushStore");
      if (!(store instanceof PushStore)) throw new Error("FIXTURE_SCOPE_UNRESOLVED pushStore: real instance required");
      const world: OutboxWorld = {
        visible: production<OutboxWorld["visible"]>("pushOutbox.world.visible"),
        present: production<OutboxWorld["present"]>("pushOutbox.world.present"),
        badge: production<OutboxWorld["badge"]>("pushBadge"),
        latestMessageId: production<OutboxWorld["latestMessageId"]>("pushOutbox.world.latestMessageId"),
        stillPending: production<OutboxWorld["stillPending"]>("pushOutbox.world.stillPending"),
        rate: production<NonNullable<OutboxWorld["rate"]>>("pushOutbox.world.rate"),
        risk: production<OutboxWorld["risk"]>("pushOutbox.world.risk"),
        timeSensitive: production<OutboxWorld["timeSensitive"]>("pushOutbox.world.timeSensitive"),
        actionable: production<OutboxWorld["actionable"]>("pushOutbox.world.actionable"),
        deviceJobCapable: production<NonNullable<OutboxWorld["deviceJobCapable"]>>("pushOutbox.world.deviceJobCapable"),
        phoneMarked: production<NonNullable<OutboxWorld["phoneMarked"]>>("pushOutbox.world.phoneMarked"),
        callRinging: production<NonNullable<OutboxWorld["callRinging"]>>("pushOutbox.world.callRinging"),
      };
      return new PushOutbox({ store, world, sender: { publish: failClosedPushDelivery },
        warn: production<NonNullable<PushOptions["warn"]>>("pushWarn"),
        onExhausted: production<NonNullable<PushOptions["onExhausted"]>>("pushOutbox.onExhausted"),
      });
    }),
    port("fluxSpend", () => createFluxSpendReader({
      key: production<SpendReaderOptions["key"]>("fluxSpend.key"),
      epoch: production<SpendReaderOptions["epoch"]>("fluxKeyEpoch"),
      fetchImpl: failClosedProviderFetch,
    })),
    port("spendGate", () => createSpendGate({
      credentials: production<SpendGateOptions["credentials"]>("spendGate.credentials"),
      epoch: production<NonNullable<SpendGateOptions["epoch"]>>("fluxKeyEpoch"),
      limitUsd: production<SpendGateOptions["limitUsd"]>("spendGate.limitUsd"),
      loadRefusals: spendBootReader<NonNullable<SpendGateOptions["loadRefusals"]>>(context, "loadRefusals"),
      loadAccount: spendBootReader<NonNullable<SpendGateOptions["loadAccount"]>>(context, "loadAccount"),
      loadMembership: spendBootReader<NonNullable<SpendGateOptions["loadMembership"]>>(context, "loadMembership"),
      saveMembership: production<NonNullable<SpendGateOptions["saveMembership"]>>("spendGate.saveMembership"),
      saveAccount: production<NonNullable<SpendGateOptions["saveAccount"]>>("spendGate.saveAccount"),
      saveRefusals: production<NonNullable<SpendGateOptions["saveRefusals"]>>("spendGate.saveRefusals"),
      wake: production<NonNullable<SpendGateOptions["wake"]>>("spendGate.wake"),
      read: createAccountReader(failClosedProviderFetch),
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms); timer.unref?.();
        cleanups.push(() => clearTimeout(timer));
        return timer;
      },
    })),
    port("roomDispatcher", () => createRoomDispatcher({
      db: context.database,
      admission: required<WorkAdmission>("workAdmission"),
      now: Date.now,
      ready: production<NonNullable<RoomDispatcherDeps["ready"]>>("roomDispatcher.ready"),
      authorize: production<NonNullable<RoomDispatcherDeps["authorize"]>>("roomDispatcher.authorize"),
      open: production<RoomDispatcherDeps["open"]>("roomDispatcher.open"),
      roomUsable: production<RoomDispatcherDeps["roomUsable"]>("roomDispatcher.roomUsable"),
      roomBusy: production<RoomDispatcherDeps["roomBusy"]>("roomDispatcher.roomBusy"),
      projectContext: production<RoomDispatcherDeps["projectContext"]>("roomDispatcher.projectContext"),
      memberIds: production<RoomDispatcherDeps["memberIds"]>("roomDispatcher.memberIds"),
      roomExists: production<NonNullable<RoomDispatcherDeps["roomExists"]>>("roomDispatcher.roomExists"),
      writerRoot: production<NonNullable<RoomDispatcherDeps["writerRoot"]>>("roomDispatcher.writerRoot"),
      audienceStillValid: production<RoomDispatcherDeps["audienceStillValid"]>("roomRequestStillOwnerAudience"),
      ownerOrigin: production<RoomDispatcherDeps["ownerOrigin"]>("roomDispatcher.ownerOrigin"),
      startOwnerSend: production<RoomDispatcherDeps["startOwnerSend"]>("roomDispatcher.startOwnerSend"),
      startMemberTurn: production<RoomDispatcherDeps["startMemberTurn"]>("startRoomRequestTurn"),
      onClosed: production<RoomDispatcherDeps["onClosed"]>("roomDispatcher.onClosed"),
      keepOwnerWords: production<NonNullable<RoomDispatcherDeps["keepOwnerWords"]>>("roomDispatcher.keepOwnerWords"),
      onStillWaiting: production<RoomDispatcherDeps["onStillWaiting"]>("roomDispatcher.onStillWaiting"),
      changed: production<RoomDispatcherDeps["changed"]>("roomRequestsChanged"),
      onRefused: production<NonNullable<RoomDispatcherDeps["onRefused"]>>("roomDispatcher.onRefused"),
      onGoalPaused: production<NonNullable<RoomDispatcherDeps["onGoalPaused"]>>("roomDispatcher.onGoalPaused"),
    })),
  ];
}
