// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { findCliCandidates } from "../env-path.ts";
import { MODEL_CATALOG_REFRESH_MS } from "../model-catalog-refresh.ts";
import { filterFluxRows } from "../flux-surface.ts";
import { decorateMemoryInstance } from "./memory-adapter.ts";
import type {
  AnyProviderDriver,
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

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private driversByKind: Map<string, AnyProviderDriver>;

  private catalogRefreshes = new WeakMap<ProviderInstance, { attemptedAt: number; pending?: Promise<void> }>();

  private readonly now: () => number;
  constructor(drivers: readonly AnyProviderDriver[], now: () => number = Date.now) {
    this.now = now;
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  async load(configs: InstanceConfigMap) {
    for (const [instanceId, entry] of Object.entries(configs)) {
      const driver = this.driversByKind.get(entry.driver);
      // Disabled is an admission barrier, not merely metadata on an already
      // constructed adapter. Factory/catalog discovery can spawn native CLIs.
      if (entry.enabled === false) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId, driverKind: entry.driver, displayName: entry.displayName,
            cli: cliOfRaw(entry.config), shadow: true, disabled: true,
            reason: "This engine is disabled. Enable it before starting new work.",
          },
        });
        continue;
      }
      if (!driver) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName,
            cli: cliOfRaw(entry.config),
            shadow: true,
            reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
          },
        });
        continue;
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
        const decorated = decorateMemoryInstance(live);
        this.byId.set(instanceId, { instanceId, live: decorated });
        this.catalogRefreshes.set(decorated, { attemptedAt: this.now() });
      } catch (e) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName ?? driver.metadata.displayName,
            cli: cliOfRaw(entry.config),
            shadow: true,
            reason: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
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
      if (this.get(instance.instanceId) === instance) await instance.refreshModels!();
    }).finally(() => { state.pending = undefined; });
    this.catalogRefreshes.set(instance, state);
    return state.pending;
  }

  async refreshModelCatalogs(dueOnly = true): Promise<void> {
    await Promise.allSettled(this.instances().map(instance => this.refreshCatalog(instance, dueOnly)));
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
        return [instanceId, await entry.live.snapshot()];
      } catch (e) {
        return [instanceId, { state: "unavailable", reason: e instanceof Error ? e.message : String(e) }];
      }
    }));
    return new Map(rows.filter((row): row is [InstanceId, ProviderSnapshot] => row !== undefined));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe() {
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
    return Promise.all(
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
            install: driver?.install,
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
          await this.refreshCatalog(inst);
          snapshot = await inst.snapshot();
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
          install: driver?.install,
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          // every copy of the driver's default binary on the augmented PATH —
          // the dropdown's "detected" entries. Snapshotted per describe() so a
          // newly installed CLI shows up on the next refresh.
          cliCandidates: candidatesFor(driver),
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map(instance => this.catalogRefreshes.get(instance)?.pending));
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
  }
}
