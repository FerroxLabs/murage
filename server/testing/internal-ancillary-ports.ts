// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety. Production service owners: imported service modules.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnWatchdog } from "../turn-watchdog.ts";
import { ReplyState, speechTransaction, type SpeechEvent } from "../tts/reply-state.ts";
import { EventBus } from "../harness/bus.ts";
import { PushStore } from "../mobile-push-store.ts";
import { Presence } from "../mobile-presence.ts";
import { AskerWakes } from "../asker-wake.ts";
import { PendingTurnCancellations, RetiredTurnRegistry } from "../turn-dispatch-guard.ts";
import { PendingTurnKeys } from "../fold-steps.ts";
import { TurnImages } from "../turn-images.ts";
import { loadShrink } from "../image-thumbnail.ts";
import { LimitTurns } from "../limit-continuation.ts";
import { MemoryRefusalCauses } from "../memory/dispatch.ts";
import { createTaskAggregateCache } from "../task-window.ts";
import { createBotDeletionLedger } from "../bot-deletion-ledger.ts";
import { RoomTurnStallRegistry } from "../room-turn-timeout.ts";
import { PooledSessionAudiences } from "../session-audience.ts";
import { LimitFailoverStore } from "../limit-failovers.ts";
import { EngineCommandCache } from "../engine-commands.ts";
import { LocalVmLeasePool } from "../local-vm-lease.ts";
import { FolderTrustStore } from "../folder-trust.ts";
import { LimitStateStore } from "../limit-state.ts";
import { UserChromeBinds } from "../user-chrome.ts";

import { indexSourceData } from "./internal-source-data.ts";
import { extractFunction, type StatePort } from "./source-extract.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import { registerPortConstructor } from "./port-integrity.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [TurnWatchdog, ReplyState, EventBus, PushStore, Presence, AskerWakes, PendingTurnCancellations, RetiredTurnRegistry, PendingTurnKeys, TurnImages, LimitTurns, MemoryRefusalCauses, RoomTurnStallRegistry, PooledSessionAudiences, LimitFailoverStore, EngineCommandCache, LocalVmLeasePool, FolderTrustStore, LimitStateStore, UserChromeBinds]) if (typeof Constructor === "function") registerPortConstructor(Constructor);

/** Named external effects only. None of these hooks can grant admission. */
export interface AncillaryFixtureIo {
  speechEvent?: (event: SpeechEvent) => void;
}
const directories = new Set<string>();
const paths = new WeakMap<InternalPortContext, string>();
const cleanups: Array<() => void> = [];
function dataDir(context: InternalPortContext): string {
  let path = paths.get(context);
  if (!path) {
    path = mkdtempSync(join(tmpdir(), "sc-safety-ancillary-"));
    paths.set(context, path); directories.add(path);
  }
  return path;
}
export function closeAncillaryFixturePorts(): void {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { close(); } catch (error) { failures.push(error); }
  }
  for (const path of directories) {
    try {
      if (!path || !path.startsWith(join(tmpdir(), "sc-safety-ancillary-"))) throw new Error("FIXTURE_CLEANUP_PATH");
      rmSync(path, { recursive: true, force: true }); directories.delete(path);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "FIXTURE_ANCILLARY_CLEANUP_FAILED");
}

/** Construct the real index-local class, including its actual overridden
 * methods. Defining the selected class never runs a module initializer. */
const indexClasses=extractFunction({file:new URL("../index.ts",import.meta.url),select:()=>"() => [GroupSpeakers,ProviderSelections]"});
await indexClasses.preload();
function indexInstance(name: "GroupSpeakers" | "ProviderSelections", context: InternalPortContext) {
  const ports=name === "ProviderSelections" ? [context.port("modelSignIns")] : [];
  if (name === "ProviderSelections" && !context.state.get("modelSignIns")) throw new Error("FIXTURE_SCOPE_UNRESOLVED modelSignIns (ancillary state dependency)");
  const value = extractFunction({ file: new URL("../index.ts", import.meta.url), select: () => `() => new ${name}()` }).preflightSync({}, {ports}).value();
  // This constructor was just generated from a private canonical declaration;
  // no caller could patch its prototype before construction. Its lifetime is
  // this binding, unlike public imported classes captured before case hooks.
  registerPortConstructor(value.constructor,"binding");
  return value;
}

/** Full production constructors; registries begin empty. Persistent ancillary
 * state gets its own per-case directory, and no worker/watchdog is started. */
export function ancillaryFixturePorts(context: InternalPortContext, io: AncillaryFixtureIo = {}): StatePort[] {
  function port<T>(name: string, fresh: () => T, reason: string, close?: (value: T) => void): StatePort {
    return { name, reason, fresh: () => {
      if (context.state.has(name)) return context.state.get(name);
      const value = fresh(); context.state.set(name, value);
      if (close) cleanups.push(() => close(value));
      return value;
    } };
  }
  return [
    port("watchdog", () => new TurnWatchdog({ stallMs: indexSourceData("watchdog.stallMs"), setupStallMs: indexSourceData("watchdog.setupStallMs"),
      heartbeatOnlyMs: indexSourceData("watchdog.heartbeatOnlyMs"), checkMs: indexSourceData("watchdog.checkMs"), slept: context.production("watchdog.slept"), onStall: context.production("watchdog.onStall") }),
      "Real unstarted activity watchdog; stall effects require the named fixture I/O edge.", value => value.stop()),
    port("groupSpeakers", () => indexInstance("GroupSpeakers", context), "Actual index-local GroupSpeakers class with real shared-work release callbacks."),
    port("activeProviderSelections", () => indexInstance("ProviderSelections", context), "Actual index-local ProviderSelections class retaining gateway-key revocation through the real model sign-in service."),
    port("replyState", () => new ReplyState({ db: context.database, transaction: speechTransaction(context.database()), emit: io.speechEvent }),
      "Real transactional speech authority, using the fixture's complete SQLite database; no boot or session is fabricated."),
    port("bus", () => new EventBus(), "Real event bus; default persistence remains in the isolated test installation.", value => value.detachAll()),
    port("pushStore", () => new PushStore(context.database), "Real push metadata store over the fixture SQLite database."),
    port("presence", () => new Presence(), "Real empty per-case presence registry."),
    port("askerWakes", () => new AskerWakes((botId, threadId, snapshot) => context.store.setTaskAskerWakes(botId, threadId, snapshot)),
      "Real asker wake state with its actual Store persistence writer.", value => value.closing()),
    port("pendingCancelledProviderHandshakes", () => new PendingTurnCancellations(), "Real bounded pending-cancellation registry."),
    port("retiredProviderTurns", () => new RetiredTurnRegistry(), "Real bounded retired-turn registry."),
    port("releasedStoppedTurns", () => new PendingTurnKeys(), "Real bounded stopped-turn settlement registry."),
    port("turnImages", () => new TurnImages(context.store, dataDir(context), Date.now, loadShrink), "Real turn-image collector with real shrink loader and an isolated image directory."),
    port("limitTurns", () => new LimitTurns(), "Real per-thread prompt and limit admission state machine."),
    port("memoryRefusalCauses", () => new MemoryRefusalCauses(512), "Real bounded refusal-cause registry with production capacity."),
    port("groupTaskWindows", () => createTaskAggregateCache(), "Real bounded task-window aggregate cache."),
    port("roomRemovals", () => createBotDeletionLedger({ now: () => performance.now() }), "Real room deletion ledger with production monotonic-clock semantics."),
    port("roomStallCompletions", () => new RoomTurnStallRegistry(), "Real room-generation stall completion registry."),
    port("pooledSessionAudiences", () => new PooledSessionAudiences(), "Real pooled-session audience transition registry."),
    port("limitFailovers", () => new LimitFailoverStore(() => dataDir(context)), "Real failover store in a private per-case directory."),
    port("engineCommandCache", () => new EngineCommandCache(dataDir(context)), "Real engine-command cache in a private per-case directory."),
    port("localVmLeases", () => new LocalVmLeasePool(30 * 60_000), "Real per-target VM lease pool with production TTL and ownership checks."),
    port("folderTrust", () => new FolderTrustStore(join(dataDir(context), "folder-trust.json")), "Real folder-trust store; no trust record is fabricated."),
    port("limitState", () => new LimitStateStore(() => dataDir(context)), "Real durable limit state in a private per-case directory."),
    port("userChromeBinds", () => new UserChromeBinds(), "Real generation-aware Chrome binding registry; no browser is started."),
  ];
}
