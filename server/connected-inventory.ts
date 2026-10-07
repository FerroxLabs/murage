// The connected-accounts inventory cache: single-flight, stale-while-revalidate,
// persisted, one owner at a time.
//
// Why it exists: opening Connected apps took 20-40 s because the panel, the
// tray, the setup card, the What's New check and the bot-access review each
// made their own full round trip to the broker. Here they share one.
//
// Correctness rules, in order of importance:
//  1. An owner is a credential identity (a hash that already includes the
//     broker token or the project key). A list is only ever served to the
//     owner that fetched it, and only one owner is held at a time: asking as a
//     different owner drops every other owner's list, in memory and on disk.
//  2. Anything that could make a remembered "connected" untrue calls
//     `invalidate`. `drop` removes the list (a disconnect: never show it
//     again); without `drop` the list stays for display but is marked dirty
//     (a connect starting) and is refetched on the next read.
//  3. A refresh that began before an invalidation is never stored: each owner
//     carries a version, and a fetch only writes if the version it started
//     under is still current.
//  4. The file holds slugs, account ids, aliases and statuses. Never a token,
//     key, label or URL.
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export interface InventoryService {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: Array<{ id: string; alias?: string; status: string }>;
}
export type InventoryServices = Record<string, InventoryService>;

export const INVENTORY_FRESH_MS = 60_000;
export const INVENTORY_FILE = "connected-apps-inventory.json";

const fileSchema = z.object({
  v: z.literal(1),
  owner: z.string().min(8).max(128),
  at: z.number(),
  services: z.record(z.string(), z.object({
    connected: z.boolean(),
    pending: z.boolean(),
    status: z.string(),
    accounts: z.array(z.object({ id: z.string(), alias: z.string().optional(), status: z.string() })),
  })),
});

interface Entry {
  owner: string;
  snapshot?: { services: InventoryServices; at: number };
  dirty: boolean;
  version: number;
  inflight?: Promise<InventoryServices>;
  scheduled: boolean;
}

let entry: Entry | null = null;
let diskChecked = false;

function path(): string {
  return join(DATA_DIR, INVENTORY_FILE);
}

function persist(): void {
  try {
    if (!entry?.snapshot) {
      if (existsSync(path())) unlinkSync(path());
      return;
    }
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(path(), JSON.stringify({ v: 1, owner: entry.owner, at: entry.snapshot.at, services: entry.snapshot.services }), { mode: 0o600 });
  } catch {
    // The file is only a head start for the next launch.
  }
}

function loadFromDisk(owner: string): Entry | null {
  try {
    if (!existsSync(path())) return null;
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path(), "utf8")));
    if (!parsed.success || parsed.data.owner !== owner) return null;
    return {
      owner,
      snapshot: { services: parsed.data.services, at: parsed.data.at },
      // Remembered across a launch: usable, but always revalidated.
      dirty: true,
      version: 0,
      scheduled: false,
    };
  } catch {
    return null;
  }
}

/** The entry for this owner. A different owner replaces whatever was held,
 * including the file, so one account's list can never reach another. */
function entryFor(owner: string): Entry {
  if (entry && entry.owner === owner) return entry;
  if (entry && entry.owner !== owner) {
    entry = null;
    persistGone();
  }
  if (!entry && !diskChecked) {
    diskChecked = true;
    entry = loadFromDisk(owner);
    if (!entry) persistGone();
  }
  if (!entry) entry = { owner, dirty: false, version: 0, scheduled: false };
  return entry;
}

function persistGone(): void {
  try {
    if (existsSync(path())) unlinkSync(path());
  } catch {
    // best effort
  }
}

export interface InventoryRead {
  /** null: nothing is remembered and nothing arrived inside the wait. */
  services: InventoryServices | null;
  at: number | null;
  /** A refresh is running or due; ask again shortly. */
  revalidating: boolean;
}

export interface InventoryReadOptions {
  force?: boolean;
  /** Longest to wait when there is nothing remembered. */
  waitMs?: number;
  /** Await a fetch when the remembered list is stale or dirty. */
  fresh?: boolean;
}

function isFresh(e: Entry, now: number): boolean {
  return Boolean(e.snapshot) && !e.dirty && now - e.snapshot!.at < INVENTORY_FRESH_MS;
}

function startFetch(e: Entry, load: () => Promise<InventoryServices>): Promise<InventoryServices> {
  if (e.inflight) return e.inflight;
  const startedAt = e.version;
  let promise!: Promise<InventoryServices>;
  promise = (async () => {
    try {
      const services = await load();
      if (entry === e && e.version === startedAt) {
        e.snapshot = { services, at: Date.now() };
        e.dirty = false;
        persist();
      }
      return services;
    } finally {
      if (e.inflight === promise) e.inflight = undefined;
    }
  })();
  e.inflight = promise;
  return promise;
}

/** Start a refresh after the caller has been answered, so a cached open makes
 * no broker call before its first paint. */
function scheduleRefresh(e: Entry, load: () => Promise<InventoryServices>): void {
  if (e.inflight || e.scheduled) return;
  e.scheduled = true;
  const timer = setTimeout(() => {
    e.scheduled = false;
    if (entry !== e) return;
    startFetch(e, load).catch(() => {});
  }, 0);
  timer.unref?.();
}

/** Read the inventory for `owner`, loading through `load` when needed. */
export async function readInventory(
  owner: string,
  load: () => Promise<InventoryServices>,
  options: InventoryReadOptions = {},
): Promise<InventoryRead> {
  const e = entryFor(owner);
  const now = Date.now();
  const mustRefresh = options.force === true || !isFresh(e, now);
  if (e.snapshot && !mustRefresh) return { services: e.snapshot.services, at: e.snapshot.at, revalidating: false };
  if (e.snapshot && !options.fresh && !options.force) {
    scheduleRefresh(e, load);
    return { services: e.snapshot.services, at: e.snapshot.at, revalidating: true };
  }
  if (e.snapshot && options.force) e.dirty = true;
  const startedUnder = e.version;
  const fetching = startFetch(e, load);
  // A fetch that began before an invalidation (a disconnect, a connect) may
  // describe a state that no longer holds. Its caller is never handed it as
  // settled: a caller that needs certainty reads again, the rest are told the
  // list is still being refreshed.
  const settle = async (services: InventoryServices): Promise<InventoryRead> => {
    if (e.version === startedUnder) return { services, at: Date.now(), revalidating: false };
    if (options.fresh) return { services: await startFetch(e, load), at: Date.now(), revalidating: false };
    return { services, at: Date.now(), revalidating: true };
  };
  if (e.snapshot && options.fresh) return settle(await fetching);
  if (options.waitMs === undefined) return settle(await fetching);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), options.waitMs); });
  try {
    const result = await Promise.race([fetching.then((services) => ({ services })), timedOut]);
    if (result === "timeout") {
      fetching.catch(() => {});
      // A forced read over a remembered list still answers with it.
      return e.snapshot
        ? { services: e.snapshot.services, at: e.snapshot.at, revalidating: true }
        : { services: null, at: null, revalidating: true };
    }
    return await settle(result.services);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether anything is remembered for this owner (memory, else the file). */
export function hasInventory(owner: string): boolean {
  return entryFor(owner).snapshot !== undefined;
}

/** What is remembered for this owner right now, without fetching. */
export function peekInventory(owner: string): InventoryServices | null {
  return entry && entry.owner === owner && entry.snapshot ? entry.snapshot.services : null;
}

/** Something happened that may have changed the list. */
export function invalidateInventory(owner: string | null, options: { drop?: boolean } = {}): void {
  if (!entry || (owner !== null && entry.owner !== owner)) return;
  entry.version += 1;
  entry.inflight = undefined;
  entry.scheduled = false;
  entry.dirty = true;
  if (options.drop) {
    entry.snapshot = undefined;
    persist();
  }
}

/** The owner's credential was replaced by the same install (a rejected token
 * re-minted): keep the remembered list under the new owner, marked stale, so
 * the panel still opens at once and refreshes behind it. */
export function rekeyInventory(newOwner: string | null): void {
  if (!entry) return;
  if (newOwner === null) { clearInventory(); return; }
  entry.owner = newOwner;
  entry.version += 1;
  entry.inflight = undefined;
  entry.scheduled = false;
  entry.dirty = true;
  persist();
}

/** The inventory version for `owner`; changes whenever the list may have. */
export function inventoryVersion(owner: string | null): number {
  return owner !== null && entry?.owner === owner ? entry.version : 0;
}

/** Forget everything, memory and file (a credential change, a reset). */
export function clearInventory(): void {
  entry = null;
  diskChecked = true;
  persistGone();
}

/** A restart, for tests: memory goes, the file stays. */
export function forgetInventoryMemory(): void {
  entry = null;
  diskChecked = false;
}
