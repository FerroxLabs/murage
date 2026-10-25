// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { forgetAllInstanceMarks, forgetInstanceMark, withInstanceMark } from "../key-rejections.ts";
import { findCliCandidates } from "../env-path.ts";
import { MODEL_CATALOG_REFRESH_MS } from "../model-catalog-refresh.ts";
import { filterFluxRows } from "../flux-surface.ts";
import { runInLocalProbeScope } from "../drivers/local-inject.ts";
import { decorateMemoryInstance } from "./memory-adapter.ts";
import { decorateHoldInstance, InstanceHolds, type HoldResult } from "./instance-holds.ts";
import type {
  AnyProviderDriver,
  EngineInstall,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
  disabled?: boolean;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

const SERVER_PLATFORMS = new Set(["darwin", "win32", "linux"]);
/** The install descriptor with the server's own OS on it. */
export function withServerPlatform(install: EngineInstall | undefined, platform: string = process.platform): EngineInstall | undefined {
  if (!install) return undefined;
  return SERVER_PLATFORMS.has(platform) ? { ...install, platform: platform as "darwin" | "win32" | "linux" } : install;
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private driversByKind: Map<string, AnyProviderDriver>;

  /** Bumped whenever the set of engines changes, so a scan that began before a change is never shared with a caller that came after it. */
  private epoch = 0;
  private catalogRefreshes = new WeakMap<ProviderInstance, { attemptedAt: number; pending?: Promise<void> }>();

  private readonly now: () => number;
  /** Murage's own sessions wait on an instance while a deleted conversation is removed from its engine's files. */
  readonly holds = new InstanceHolds();
  constructor(drivers: readonly AnyProviderDriver[], now: () => number = Date.now) {
    this.now = now;
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  /** ONE ENGINE AT A TIME WAS COSTING THE WHOLE BOOT.
   *
   * `driver.create` can spawn a native CLI and wait for it to enumerate its
   * models — the comment below has always said so. This was a serial loop, so
   * boot paid the SUM of every configured engine's discovery before the HTTP
   * server would accept its first connection. Measured on the owner's install:
   * `fuigo models` 9s, `hermes` 5s, `opencode models` 2s, plus the rest, and
   * the window did not open until the last of them answered.
   *
   * The instances are independent — each one only writes its own key — so they
   * are discovered CONCURRENTLY and then recorded in the original config
   * order. Insertion order into `byId` is deliberately unchanged, because
   * callers read `entries()` and `instances()` in order and the first entry is
   * load-bearing for selection. Boot now costs the SLOWEST engine, not the
   * sum. Measured 2026-09-22. */
  async load(configs: InstanceConfigMap) {
    // A fleet built from the saved settings starts with no engine marked signed out.
    forgetAllInstanceMarks();
    // Discovered together, recorded in configuration order.
    // Same rule as the background refresh: one shared probe per localhost
    // address across every driver's create(), and user-added hosts are never
    // called before the server listens.
    const entries = await runInLocalProbeScope(false, () => Promise.all(Object.entries(configs).map(entry => this.resolveEntry(entry))));
    for (const [instanceId, resolved] of entries) {
      this.epoch++;
      this.byId.set(instanceId, resolved);
    }
  }

  /** Rebuild only these instances, leaving every other engine (and the turns
   * running on it) untouched. Turning off an engine nobody is using must not
   * kill a turn on another engine that is waiting for the person (D3): the
   * whole-fleet rebuild in disposeAll + load did exactly that.
   *
   * Each named instance is disposed, then re-created from `configs`; one that
   * is no longer configured is dropped. A kept id keeps its position in the
   * map, because the first entry is load-bearing for selection. */
  async reload(instanceIds: ReadonlySet<InstanceId>, configs: InstanceConfigMap) {
    const retiring = [...instanceIds].flatMap(id => {
      const live = this.byId.get(id)?.live;
      return live ? [live] : [];
    });
    await Promise.allSettled(retiring.map(instance => this.catalogRefreshes.get(instance)?.pending));
    const disposed = await Promise.allSettled(retiring.map(instance => instance.dispose()));
    for (const id of instanceIds) { this.cliByInstance.delete(id); forgetInstanceMark(id); }
    const wanted = Object.entries(configs).filter(([id]) => instanceIds.has(id));
    const resolved = new Map(await runInLocalProbeScope(false, () => Promise.all(wanted.map(entry => this.resolveEntry(entry)))));
    for (const id of instanceIds) {
      const next = resolved.get(id);
      this.epoch++;
      if (next) this.byId.set(id, next);
      else this.byId.delete(id);
    }
    // A disposal that could not be confirmed (a Claude process not yet seen
    // gone when the machine is loaded: CLAUDE_SESSION_NOT_STOPPED) does not
    // undo or fail the change: the new entry is already in place above, and the
    // driver keeps killing and watching that process until it is gone. The
    // whole-fleet rebuild (disposeAll) has always settled it the same way. It
    // used to reject here, so the settings request answered 500 for a change it
    // had saved and applied.
    for (const result of disposed) {
      if (result.status === "rejected") console.warn("engine reload: an engine's earlier process could not be confirmed stopped yet", result.reason);
    }
  }

  private async resolveEntry([instanceId, entry]: [string, InstanceConfigMap[string]]): Promise<[string, RegistryEntry]> {
    const driver = this.driversByKind.get(entry.driver);
    // Disabled is an admission barrier, not merely metadata on an already
    // constructed adapter. Factory/catalog discovery can spawn native CLIs.
    if (entry.enabled === false) {
      return [instanceId, {
        instanceId,
        shadow: {
          instanceId, driverKind: entry.driver, displayName: entry.displayName,
          cli: cliOfRaw(entry.config), shadow: true, disabled: true,
          reason: "This engine is disabled. Enable it before starting new work.",
        },
      }];
    }
    if (!driver) {
      return [instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: `unknown driver "${entry.driver}": kept as configured, unavailable here`,
        },
      }];
    }
    try {
      const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
      // Override detection is on the RAW config, never the decoded one:
      // decodeConfig fills in the driver default ("claude", "codex", …),
      // so reading `cli` there would flag every instance as overridden.
      const rawCli = cliOfRaw(entry.config);
      if (rawCli) this.cliByInstance.set(instanceId, rawCli);
      const live = await driver.create({
        instanceId,
        displayName: entry.displayName ?? driver.metadata.displayName,
        environment: entry.environment ?? {},
        enabled: entry.enabled ?? true,
        config,
      });
      const decorated = decorateHoldInstance(decorateMemoryInstance(live), this.holds);
      this.catalogRefreshes.set(decorated, { attemptedAt: this.now() });
      return [instanceId, { instanceId, live: decorated }];
    } catch (e) {
      return [instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName ?? driver.metadata.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: e instanceof Error ? e.message : String(e),
        },
      }];
    }
  }

  /** Holds these instances (see instance-holds.ts): new turns wait, running turns get `waitMs` to finish, idle engines close. The
   * instances whose running turns outlast the wait are not held and are reported in `busy`. */
  holdInstances(instanceIds: readonly InstanceId[], waitMs: number): Promise<HoldResult> {
    return this.holds.hold(instanceIds, waitMs, async (id) => this.get(id)?.adapter.holdIdle?.());
  }

  /** Calls `wake` once, when none of these instances has a running turn and one of them saw a turn end at or after `since`
   * (instance-holds.ts `whenFree`). Returns how to stop waiting. */
  whenInstancesFree(instanceIds: readonly InstanceId[], since: number, wake: () => void): () => void {
    return this.holds.whenFree(instanceIds, since, wake);
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  private refreshCatalog(instance: ProviderInstance, dueOnly = false): Promise<void> {
    if (!instance.refreshModels || instance.enabled === false) return Promise.resolve();
    const state = this.catalogRefreshes.get(instance) ?? { attemptedAt: -Infinity };
    if (state.pending) return state.pending;
    if (dueOnly && this.now() - state.attemptedAt < MODEL_CATALOG_REFRESH_MS) return Promise.resolve();
    state.attemptedAt = this.now();
    state.pending = Promise.resolve().then(async () => {
      if (this.get(instance.instanceId) === instance) await instance.refreshModels!({ manual: !dueOnly });
    }).finally(() => { state.pending = undefined; });
    this.catalogRefreshes.set(instance, state);
    return state.pending;
  }

  async refreshModelCatalogs(dueOnly = true): Promise<void> {
    // One probe per local host per refresh: every engine's catalog shares this
    // scope, and a background (dueOnly) refresh leaves user-added hosts alone.
    await runInLocalProbeScope(!dueOnly, () => Promise.allSettled(this.instances().map(instance => this.refreshCatalog(instance, dueOnly))));
  }

  /** Health of only these instances, for callers that need no model catalog:
   * no catalog refresh runs and no other engine is probed. describe() probes
   * the whole fleet, which held the Claude accounts section disabled for
   * seconds after every change (CLAC2). An id the registry lacks is omitted. */
  async snapshots(instanceIds: Iterable<InstanceId>): Promise<Map<InstanceId, ProviderSnapshot>> {
    const rows = await Promise.all([...new Set(instanceIds)].map(async (instanceId): Promise<[InstanceId, ProviderSnapshot] | undefined> => {
      const entry = this.byId.get(instanceId);
      if (!entry) return undefined;
      if (entry.shadow) return [instanceId, { state: "unavailable", reason: entry.shadow.reason }];
      try {
        return [instanceId, withInstanceMark(instanceId, await entry.live.snapshot())];
      } catch (e) {
        return [instanceId, { state: "unavailable", reason: e instanceof Error ? e.message : String(e) }];
      }
    }));
    return new Map(rows.filter((row): row is [InstanceId, ProviderSnapshot] => row !== undefined));
  }

  /** One engine's id, driver and health, with no catalog refresh and no other engine probed: what the
   * per-engine management card needs. Undefined when the registry lacks the id. */
  async describeOne(instanceId: InstanceId): Promise<{ instanceId: InstanceId; driverKind: string; snapshot: ProviderSnapshot } | undefined> {
    const entry = this.byId.get(instanceId);
    if (!entry) return undefined;
    const snapshot = (await this.snapshots([instanceId])).get(instanceId);
    if (!snapshot) return undefined;
    return { instanceId, driverKind: entry.shadow?.driverKind ?? entry.live!.driverKind, snapshot };
  }

  /** instance snapshots for the model picker: id, driver, models, health.
   *
   * `catalogs: "fresh"` (the default) refreshes every catalog first, for a
   * person asking right now (the picker, Check again). Background readers
   * (the tray's minute-by-minute setup view, the setup poll) pass `"due"`:
   * their forced refresh spawned `fuigo models` every minute, which is a
   * GET /v1/models at Flux every 60 to 65 s, refused or not (2026-10-01). */
  private describing: Record<"due" | "fresh", { epoch: number; run: Promise<Awaited<ReturnType<ProviderRegistry["scan"]>>> } | null> = { due: null, fresh: null };

  /** One scan at a time per mode: boot asks for the engine list and the setup view together, and every
   * engine card used to start its own. A caller that arrives mid-scan waits for it. A "fresh" scan also
   * answers a "due" caller (it refreshed at least as much); a "due" scan never answers a "fresh" one. */
  describe(options: { catalogs?: "fresh" | "due" } = {}) {
    const mode = options.catalogs === "due" ? "due" : "fresh";
    const usable = (flight: { epoch: number } | null) => flight !== null && flight.epoch === this.epoch;
    const shared = usable(this.describing.fresh) ? this.describing.fresh : mode === "due" && usable(this.describing.due) ? this.describing.due : null;
    if (shared) return shared.run;
    const flight = { epoch: this.epoch, run: this.scan(mode === "due") };
    this.describing[mode] = flight;
    const clear = () => { if (this.describing[mode] === flight) this.describing[mode] = null; };
    flight.run.then(clear, clear);
    return flight.run;
  }

  private async scan(dueOnly: boolean) {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    const candidatesFor = (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    // One probe per local host per scan; a due (background) scan leaves user-added hosts alone.
    return runInLocalProbeScope(!dueOnly, () => Promise.all(
      this.entries().map(async (entry) => {
        const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            enabled: entry.shadow.disabled !== true,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
            // an unknown driver has no driver record, hence no install path
            access: driver?.metadata.access ?? "subscription",
            install: withServerPlatform(driver?.install),
            cli: entry.shadow.cli,
            cliDefault: entry.shadow.disabled ? undefined : cliDefaultOf(driver),
            // a shadow is exactly the "your CLI is broken, pick another"
            // case where the detected-path dropdown matters most
            cliCandidates: entry.shadow.disabled ? [] : candidatesFor(driver),
          };
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          await this.refreshCatalog(inst, dueOnly);
          snapshot = withInstanceMark(inst.instanceId, await inst.snapshot());
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          enabled: inst.enabled,
          snapshot,
          // Backstop for the per-engine Flux gate: describe() is the one choke
          // point every catalog crosses on its way to the UI, so a driver that
          // forgets mergeFluxCatalog still cannot offer a Flux row on an engine
          // with no Flux surface (or with no key configured).
          models: filterFluxRows(inst.models, inst.driverKind),
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            phoneMcp: inst.adapter.capabilities.phoneMcp === true,
            browserMcp: inst.adapter.capabilities.browserMcp === true,
            images: inst.adapter.capabilities.images === true,
            effortLevels: inst.adapter.capabilities.effortLevels,
            queueing: inst.adapter.capabilities.queueing === true,
            localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
            approvalReview: inst.reviewPermission !== undefined,
            memoryDelivery: inst.adapter.capabilities.memoryDelivery ?? "unavailable",
            memoryMcp: inst.adapter.capabilities.memoryMcp === true,
          },
          access: driver?.metadata.access ?? "subscription",
          install: withServerPlatform(driver?.install),
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          // every copy of the driver's default binary on the augmented PATH —
          // the dropdown's "detected" entries. Snapshotted per describe() so a
          // newly installed CLI shows up on the next refresh.
          cliCandidates: candidatesFor(driver),
        };
      }),
    ));
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map(instance => this.catalogRefreshes.get(instance)?.pending));
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.epoch++;
    this.byId.clear();
    this.cliByInstance.clear();
  }
}
