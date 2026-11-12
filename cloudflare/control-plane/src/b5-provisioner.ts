// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 provisioner: one HostingAdapter interface, a real build host adapter and a Vultr adapter,
// the plan ladder with live stock checks, and the ProviderAdapter the frozen B3 lifecycle drives in live mode.
import { claimFleetLabels, claimLabelsOk } from "./fleet-labels";
import { persistAlert } from "./ops-monitor";
import { recordOwnProviderAction } from "./access-events";
import { ladderFor, provisionerConfig, type LadderRung, type ProvisionerConfig } from "./b5-config";
import type { CreateHomeInput, CreateVolumeInput, PowerStatus, ProviderAdapter, ProviderResource, ProvisionFence, ResourceRole, VolumeDescriptor } from "./b3-provider";
import { DB_NOW } from "./billing-lease";
import { validateVolume } from "./b3-provider";
import { BOX_SOFT_LIMIT, hetznerStorageBox, pickBox, prepareBackup, purgeBackup, type BackupDeps, type BoxSlot, type StorageBoxAdapter } from "./b5-backup";
import { assertHetznerImagesApproved } from "./env-isolation";
import { isAnswered, markAnswered, markNotSent, refusalStatus } from "./dispatch-ledger";
import { claimPoolServer, fencePoolRow, relabelPhase, sealPayload, type PoolRow } from "./warm-pool-claim";
import { keyWrapperFor, type KeyWrapper } from "./key-wrapper";
import { sha256 } from "./installations";
import { isUnenrolledPoolServer } from "./pool-handoff";
import { assertNoProdSshKeys, assertVerifiedImage, authorizeDispatch, settleDispatch, ImageRefused, verifyImageForUse, type VerifiedImage, type VerifyDeps } from "./image-signature";

export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>;
/** Astra round 2 #1: the attempt no longer holds the provisioning lease (another attempt took it). Aborts the pool path without fencing anything. */
export class PoolLeaseLost extends Error { constructor() { super("pool_lease_lost"); } }
/** How far a renewed lease reaches (B3's PROVISION_LEASE_MS). */
const POOL_LEASE_RENEW_MS = 2 * 60_000;
/** Worker and build host clocks differ: an action counts as started after the intent within this margin. */
const ACTION_CLOCK_SKEW_MS = 2 * 60_000;
/** A refusal that means the provider has no stock of that server type at that place (a different type or place may have). */
export const stockRefusal = (e: unknown) => e instanceof HostError && ["resource_unavailable", "placement_error"].includes(e.code);
/** build host's 422 service_error when the image's disk is larger than the server type's disk. The rung can never take this image, so it is
 *  closed like a stock refusal and the next rung is tried; retrying the same rung can only fail the same way. */
export const IMAGE_TOO_BIG_MESSAGE = /image disk is bigger than server type disk/i;
export const imageTooBigRefusal = (e: unknown) => e instanceof HostError && e.status === 422 && IMAGE_TOO_BIG_MESSAGE.test(e.providerMessage ?? "");
/** The one platform alert for a ladder that met an image no rung could hold. Deduplicated by the open-alert index (kind, home). */
export const IMAGE_TOO_BIG_ALERT = "image.too_big_for_server_type";
/** True unless BOTH sizes are known and the image is larger than the server type's disk. An unknown size never blocks a rung: build host's own
 *  422 (imageTooBigRefusal) still catches it at create time. */
export const diskFits = (imageGb: number | null | undefined, typeGb: number | null | undefined): boolean =>
  !(typeof imageGb === "number" && typeof typeGb === "number" && imageGb > typeGb);
/** Reads both disk sizes through the adapter. A lookup that fails counts as unknown (fits). */
export async function rungFits(adapter: Pick<HostingAdapter, "imageDiskGb" | "serverTypeDiskGb">, image: string, serverType: string): Promise<boolean> {
  if (!adapter.imageDiskGb || !adapter.serverTypeDiskGb) return true;
  try {
    const imageGb = await adapter.imageDiskGb(image);
    if (imageGb === null) return true;
    return diskFits(imageGb, await adapter.serverTypeDiskGb(serverType));
  } catch { return true; }
}
/** Each skipped server type is named with its own arch's image, so a mixed x86/arm ladder reports both images. */
export async function raiseImageTooBig(env: Env, misses: { image: string; serverType: string }[], now: number): Promise<void> {
  const named = [...new Set(misses.map((m) => `${m.serverType} (image ${m.image})`))].join(", ");
  await persistAlert(env, { homeId: "platform", kind: IMAGE_TOO_BIG_ALERT, severity: "high",
    detail: `image is bigger than the disk of server type ${named}; use a smaller image or drop the rung`.slice(0, 300) }, now).catch(() => false);
}
export class HostError extends Error {
  /** `providerMessage` is the provider's own words (build host body.error.message), raw: operator-only, store it through
   *  sanitizeProviderMessage, never show it to a customer. */
  constructor(public readonly status: number, public readonly code: string, public readonly providerMessage: string | null = null) { super(code); }
}

/** A credential-like key (optionally prefixed, e.g. x-api-key, access_token, db_password), optionally quoted, then its separator and its value
 *  (a "double" or 'single' quoted string with escapes, or a bare run). */
const CREDENTIAL_PAIR = /(["']?)\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer|cookie|key))\1(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s,;()[\]{}"']+)/gi;
/** Operator-facing copy of a provider error message: control characters dropped, anything that looks like an email, IP address, UUID,
 *  long number (an id), long hex or long token-like run replaced, whitespace collapsed, at most 200 characters. Null when nothing is left. */
export function sanitizeProviderMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.slice(0, 2000)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, "[ip]")
    .replace(/(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?(?![\w:])/gi, (m) => /[0-9a-f]/i.test(m) ? "[ip]" : m)
    // Astra INTEGRATED-5 #4: credentials whatever their length or quoting: `Bearer <x>` / `Basic <x>`, then the VALUE of any credential-like
    // key (bare, "double" or 'single' quoted key and value, JSON or key: value / key=value).
    .replace(/\b(bearer|basic)\s+(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s,;()[\]{}"']+)/gi, "$1 [redacted]")
    .replace(CREDENTIAL_PAIR, (_m, q1: string, k: string, sep: string) => `${q1}${k}${q1}${sep}[redacted]`)
    .replace(/(?<![\w+/=.-])[\w+/=.-]{32,}(?![\w+/=.-])/g, "[token]")
    .replace(/(?<![\w+/=.-])(?=[\w+/=.-]*\d)(?=[\w+/=.-]*[A-Za-z])[\w+/=.-]{16,}(?![\w+/=.-])/g, "[token]")
    .replace(/\b[0-9a-f]{12,}\b/gi, "[id]")
    .replace(/\d{5,}/g, "[id]")
    .replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 200) : null;
}
/** `callKey` (round 12, Astra MAILRETRY-16 P1): the create call's own key the resource was labelled with, when it has one. */
export interface NativeServer { id: string; state: string; ips: string[]; callKey?: string | null; }
export interface NativeVolume { id: string; location: string; serverId: string | null; callKey?: string | null; }
/** `call`: the create call's own key (round 12), labelled on the resource so recovery adopts only that call's resource. */
export interface Labels { homeId: string; generation: number; role: "home" | "volume" | "snapshot"; call?: string; }
/** Round 12 (Astra MAILRETRY-16 P1): an error that is NOT the provider's answer to a create request (a listing or GET error, a step after
 *  the create was sent): it never settles a create call, whatever its status. */
export function markNotAnAnswer<E>(error: E): E {
  if (typeof error === "object" && error !== null) (error as { notAnAnswer?: boolean }).notAnAnswer = true;
  return error;
}

/** The single interface both clouds implement. Ids are provider-native strings. */
export interface HostingAdapter {
  readonly provider: "hetzner" | "vultr";
  /** Locations (subset of `candidates`, same order) where this type can be created right now. */
  availableLocations(serverType: string, candidates: string[]): Promise<string[]>;
  /** The image's disk in GB (build host `disk_size`), null when the provider does not say. Optional: Vultr has no such limit. */
  imageDiskGb?(image: string, signal?: AbortSignal): Promise<number | null>;
  /** The server type's disk in GB, null when unknown. */
  serverTypeDiskGb?(serverType: string, signal?: AbortSignal): Promise<number | null>;
  /** `signal` (round 11, Astra MAILRETRY-15): every create and destroy request is bound by its caller's deadline (fetch aborted). */
  createVolume(i: { name: string; sizeGb: number; location: string; labels: Labels; signal?: AbortSignal }): Promise<NativeVolume>;
  createServer(i: { name: string; serverType: string; location: string; image: VerifiedImage; userData: string;
    labels: Labels; volumeId: string | null; signal?: AbortSignal }): Promise<NativeServer>;
  findServers(labels: Omit<Labels, "role">): Promise<NativeServer[]>;
  findVolumes(labels: Omit<Labels, "role">): Promise<NativeVolume[]>;
  getServer(id: string): Promise<NativeServer>;
  getVolume(id: string): Promise<NativeVolume>;
  attachVolume(volumeId: string, serverId: string): Promise<void>;
  detachVolume(volumeId: string): Promise<void>;
  /** Returns the provider's action id when it gives one. */
  power(serverId: string, on: boolean): Promise<string | null | void>;
  /** Hard power cycle (the customer's Reboot button and the watchdog). Returns the provider's action id when it gives one. */
  reboot(serverId: string): Promise<string | null | void>;
  /** Status of this power call's own action, by the id its answer carried. Optional (Vultr returns no action id). */
  powerActionStatus?(serverId: string, command: "reboot" | "start", actionId: string): Promise<PowerStatus>;
  /** Recent provider-side actions on a server (newest first), for the owner's access notices. Optional: Vultr keeps no such history. */
  /** The server's action history, newest first, read page by page until a page reaches `stopBefore` (ms) or the history ends. `startedAt` is
   *  NaN when the provider's time cannot be parsed. Throws provider_actions_page_cap when the page cap is reached first. */
  listProviderActions?(serverId: string, stopBefore?: number): Promise<{ id: string; command: string; startedAt: number }[]>;
  quarantine(serverId: string, signal?: AbortSignal): Promise<void>;
  destroyServer(id: string, signal?: AbortSignal): Promise<void>;
  destroyVolume(id: string, signal?: AbortSignal): Promise<void>;
  /** `actionId` is the provider's own id of the snapshot action (null where the provider keeps no action history). */
  snapshotServer(serverId: string, labels: Labels): Promise<{ ref: string; actionId: string | null }>;
  /** Round 12: every page (a listing that cannot be read whole throws). `signal`: the caller's bound (the cleanup claim's lease). */
  listSnapshots(labels: Omit<Labels, "role">, signal?: AbortSignal): Promise<string[]>;
  deleteSnapshot(id: string, signal?: AbortSignal): Promise<void>;
}

/** Warm pool: a server as the provider shows it (status, the image it runs, labels, public IPv4). */
export interface PoolServer { id: string; status: string; imageId: string | null; labels: Record<string, string>; ipv4: string | null; name: string | null }
/** One row of the one-call server type catalogue: per location, live stock and the monthly net price in euro cents (null when unpriced). */
export interface ServerTypeInfo { name: string; cores: number; /** Disk in GB; absent or null when unknown. */ diskGb?: number | null; arch: "x86" | "arm" | "unknown"; deprecated: boolean;
  locations: Record<string, { available: boolean; deprecated?: boolean; monthlyNetCents: number | null }> }
export interface PoolActionResult { actionId: string | null; status: PowerStatus }
/** build-host-only methods the warm pool uses. Nothing in the live lifecycle calls these. */
export interface HetznerPoolAdapter {
  /** ONE `GET /server_types?per_page=50`: every type with per-location stock and monthly net price. Not paged on purpose (the plan fixes it at one call). */
  serverTypes(signal?: AbortSignal): Promise<ServerTypeInfo[]>;
  /** The image's disk in GB (build host `disk_size`), null when unknown. Optional so a host that cannot say never blocks a rung. */
  imageDiskGb?(image: string, signal?: AbortSignal): Promise<number | null>;
  /** Creates a server that stays OFF (`start_after_create:false`), IPv4 only, no volume. The caller labels the call (`murage/call`) so a lost answer is adopted via listByLabel. */
  createPoolServer(i: { name: string; type: string; location: string; image: VerifiedImage; labels: Record<string, string>; userData: string;
    firewallIds: number[]; sshKeyIds: number[]; signal?: AbortSignal }): Promise<PoolServer>;
  /** PUT /servers/{id}: only the fields given are sent. */
  updateServer(id: string, patch: { name?: string; labels?: Record<string, string> }, signal?: AbortSignal): Promise<PoolServer>;
  /** POST rebuild, then re-read the server. build host POWERS THE SERVER ON after a rebuild even if it was off (spike 2026-10-16), so the caller
   *  must check `server.status` and power it off again when it wants a pool server. The root password in the answer is dropped. */
  rebuildServer(id: string, image: VerifiedImage, signal?: AbortSignal): Promise<PoolActionResult & { server: PoolServer | undefined; serverError?: string }>;
  powerOn(id: string, signal?: AbortSignal): Promise<PoolActionResult>;
  /** The server's own actions of one kind, newest first (GET /servers/{id}/actions, sorted by `started` descending, filtered by command here).
   *  Recovery of a rebuild or power-on whose action id was never persisted: only an action started after the intent counts. */
  listServerActions(id: string, kind: "rebuild" | "start", signal?: AbortSignal): Promise<{ id: string; status: PowerStatus; startedMs: number }[]>;
  powerOff(id: string, signal?: AbortSignal): Promise<PoolActionResult>;
  /** Every page of servers matching a raw label selector, e.g. `murage/role=pool,murage/env=staging`. */
  listByLabel(selector: string, signal?: AbortSignal): Promise<PoolServer[]>;
  /** Named apart from HostingAdapter.getServer (which returns the lean NativeServer the live lifecycle uses). */
  getServerDetail(id: string, signal?: AbortSignal): Promise<PoolServer>;
  /** What the whole build host project uses right now: vCPUs of every server, primary IPs, volume GB (every page of three listings). */
  projectUsage(signal?: AbortSignal): Promise<{ vcpu: number; primaryIps: number; volumeGb: number }>;
  /** DELETE /servers/{id} keeping build host's deletion action (the delete is asynchronous). `gone` = the provider said 404: already deleted. */
  deleteServer(id: string, signal?: AbortSignal): Promise<PoolActionResult & { gone: boolean }>;
  /** GET /actions/{id}: "none" when the provider no longer knows the action. */
  actionStatus(actionId: string, signal?: AbortSignal): Promise<PowerStatus>;
}

interface HzAction { id: number; command: string; status: string; started: string }
interface HzActionAnswer { action?: HzAction }
const actionId = (r: HzActionAnswer) => (r.action?.id !== undefined ? String(r.action.id) : null);
const hzStatus = (status: string): PowerStatus => status === "success" ? "success" : status === "error" ? "error" : "running";

/** The label every creating call puts on the server it creates (KMS 13.1 H1): the dispatch_id of its image_dispatch_auth row. */
export const DISPATCH_LABEL = "murage/dispatch";
const serverIdText = (s: { id?: number } | undefined): string | undefined => (typeof s?.id === "number" && Number.isSafeInteger(s.id) ? String(s.id) : undefined);
const LABEL = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
function label(value: string | number): string {
  const v = String(value);
  if (!LABEL.test(v)) throw new Error("provider_label_invalid");
  return v;
}

async function parse<T>(response: Response, ignore404 = false): Promise<T> {
  if (!response.ok) {
    if (ignore404 && response.status === 404) return {} as T;
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: unknown } | string } | null;
    const code = typeof body?.error === "object" ? body.error?.code : undefined;
    const message = typeof body?.error === "object" ? body.error?.message : body?.error; // build host: error.message; Vultr: error (a string)
    throw new HostError(response.status, code ?? `http_${response.status}`, typeof message === "string" ? message : null);
  }
  if (response.status === 204) return {} as T;
  return await response.json().catch(() => ({})) as T;
}

// ---- build host Cloud -----------------------------------------------------------------------------------------------

/** build host label selector: comma-separated terms `key`, `!key`, `key=v`, `key!=v`, `key in (a,b)`, `key notin (a,b)`. */
const SEL_KEY = "[A-Za-z0-9](?:[A-Za-z0-9_.\\/-]{0,100}[A-Za-z0-9])?";
const SEL_VAL = "[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?";
const SEL_TERM = new RegExp(`^(?:!?${SEL_KEY}|${SEL_KEY}!?=${SEL_VAL}|${SEL_KEY} (?:in|notin) \\(${SEL_VAL}(?:,${SEL_VAL})*\\))$`);
export function validSelector(selector: string): boolean {
  if (selector.length < 1 || selector.length > 500) return false;
  return selector.split(/,(?![^()]*\))/).every((t) => SEL_TERM.test(t.trim()));
}

interface HzServer { id: number; name?: string; status: string; labels?: Record<string, string>; image?: { id?: number | null } | null; public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null } }
interface HzVolume { id: number; server: number | null; location: { name: string }; labels?: Record<string, string> }
interface HzPage { meta?: { pagination?: { next_page?: number | null } } }
/** Most pages of one server's action history a single read walks (50 actions a page). */
export const ACTION_PAGE_CAP = 20;
export function hetznerAdapter(token: string, config: Pick<ProvisionerConfig, "sshKeyIds" | "firewallIds"> & { quarantineFirewallId?: number },
  fetcher: HostFetch = fetch, clock: () => number = Date.now): HostingAdapter & HetznerPoolAdapter {
  /** The capability check every creating call makes before it sends anything. */
  const imageOf = (v: VerifiedImage) => assertVerifiedImage(v, { provider: "hetzner", now: clock() }).image;
  /** Right before the POST: the capability's epoch must still be current in D1 (the conditional authorization row, KMS 9.6 / 10.4). Returns the image id
   *  and the dispatch id, which the create labels as murage/dispatch (13.1 H1); a rebuild passes its server id so it is recorded at the INSERT. */
  const authorized = async (v: VerifiedImage, serverId?: string): Promise<{ image: string; dispatchId: string }> => {
    const image = imageOf(v); return { image, dispatchId: await authorizeDispatch(v, clock(), serverId === undefined ? {} : { serverId }) };
  };
  /** The dispatch POST, settled from the provider's answer (13.1 H4): a parsed 2xx with a server id is settled_created, a parsed 4xx (not a timeout) is
   *  settled_failed, anything else (network error, abort, 5xx, an answer with no id) leaves the row open. */
  const dispatched = async <T>(v: VerifiedImage, dispatchId: string, send: () => Promise<T>, serverIdOf: (r: T) => string | undefined): Promise<T> => {
    let answer: T;
    try { answer = await send(); }
    catch (e) {
      if (e instanceof HostError && e.status >= 400 && e.status < 500 && e.status !== 408) await settleDispatch(v, dispatchId, { refused: true }, clock());
      throw e;
    }
    const id = serverIdOf(answer);
    if (id !== undefined) await settleDispatch(v, dispatchId, { created: id }, clock());
    return answer;
  };
  const call = async <T>(method: string, path: string, body?: unknown, ignore404 = false, signal?: AbortSignal): Promise<T> => {
    try {
      return await parse<T>(await fetcher(`https://api.hetzner.cloud/v1${path}`, { method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, ...(signal ? { signal } : {}) }), ignore404);
    } catch (error) { throw method === "GET" ? markNotAnAnswer(error) : error; } // Astra MAILRETRY-16 P1: a GET error answers no create
  };
  /** Astra MAILRETRY-16 P1: every page of a listing (build host paginates at 25 by default); any page failing fails the listing. */
  const all = async <K extends string, T>(path: string, key: K, signal?: AbortSignal): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await call<HzPage & Record<K, T[]>>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`, undefined, false, signal);
      out.push(...(r[key] ?? []));
      if (!r.meta?.pagination?.next_page) return out;
    }
    throw markNotAnAnswer(new Error("provider_listing_incomplete"));
  };
  const selector = (l: Omit<Labels, "role">, role?: string) =>
    encodeURIComponent(`murage/home=${label(l.homeId)},murage/generation=${l.generation}${role ? `,murage/role=${role}` : ""}`);
  const labelsOf = (l: Labels) => ({ "murage/home": label(l.homeId), "murage/generation": String(l.generation), "murage/role": l.role,
    ...(l.call ? { "murage/call": label(l.call) } : {}) });
  const server = (s: HzServer): NativeServer => ({ id: String(s.id), state: s.status,
    ips: [s.public_net?.ipv4?.ip, s.public_net?.ipv6?.ip?.replace(/\/\d+$/, "")].filter((x): x is string => !!x), callKey: s.labels?.["murage/call"] ?? null });
  const volume = (v: HzVolume): NativeVolume => ({ id: String(v.id), location: v.location.name, serverId: v.server === null ? null : String(v.server),
    callKey: v.labels?.["murage/call"] ?? null });
  const poolServer = (s: HzServer): PoolServer => ({ id: String(s.id), status: s.status, name: s.name ?? null,
    imageId: s.image?.id === undefined || s.image?.id === null ? null : String(s.image.id), labels: s.labels ?? {}, ipv4: s.public_net?.ipv4?.ip ?? null });
  const poolLabels = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, label(v)]));
  const poolAction = (r: HzActionAnswer): PoolActionResult => ({ actionId: actionId(r), status: r.action ? hzStatus(r.action.status) : "none" });
  /** Disk sizes read once per adapter instance (an image's and a server type's disk never change under one id). */
  const imageDisk = new Map<string, number>();
  const typeDisk = new Map<string, number>();
  const cents = (v: unknown) => { const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN; return Number.isFinite(n) ? Math.round(n * 100) : null; };
  return {
    provider: "hetzner",
    async serverTypes(signal) {
      const data = await call<{ server_types?: { name: string; cores?: number; architecture?: string; deprecated?: boolean | null;
        locations?: { name: string; available?: boolean; deprecation?: unknown }[]; disk?: number; prices?: { location: string; price_monthly?: { net?: string } }[] }[] }>(
        "GET", "/server_types?per_page=50", undefined, false, signal);
      return (data.server_types ?? []).map((t) => {
        const locations: ServerTypeInfo["locations"] = {};
        for (const l of t.locations ?? []) {
          const dep = l.deprecation !== undefined && l.deprecation !== null;
          locations[l.name] = { available: l.available !== false && !dep, deprecated: dep, monthlyNetCents: null };
        }
        for (const pr of t.prices ?? []) {
          const entry = locations[pr.location] ?? (locations[pr.location] = { available: false, monthlyNetCents: null });
          entry.monthlyNetCents = cents(pr.price_monthly?.net);
        }
        return { name: t.name, cores: t.cores ?? 0, diskGb: typeof t.disk === "number" ? t.disk : null, arch: t.architecture === "x86" ? "x86" : t.architecture === "arm" ? "arm" : "unknown",
          deprecated: !!t.deprecated || (Object.keys(locations).length > 0 && Object.values(locations).every((l) => l.deprecated)), locations };
      });
    },
    async createPoolServer(i) {
      const { image, dispatchId } = await authorized(i.image);
      const r = await dispatched(i.image, dispatchId, () => call<{ server: HzServer }>("POST", "/servers", { name: i.name, server_type: i.type, location: i.location,
        image: Number(image), user_data: i.userData, labels: { ...poolLabels(i.labels), [DISPATCH_LABEL]: dispatchId },
        automount: false, ssh_keys: i.sshKeyIds, firewalls: i.firewallIds.map((id) => ({ firewall: id })),
        public_net: { enable_ipv4: true, enable_ipv6: false }, start_after_create: false }, false, i.signal), (x) => serverIdText(x.server));
      return poolServer(r.server);
    },
    async updateServer(id, patch, signal) {
      const r = await call<{ server: HzServer }>("PUT", `/servers/${Number(id)}`,
        { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.labels ? { labels: poolLabels(patch.labels) } : {}) }, false, signal);
      return poolServer(r.server);
    },
    async rebuildServer(id, verified, signal) {
      const { image, dispatchId } = await authorized(verified, id); // a rebuild records its server id at the INSERT and has no label to find it by
      const answer = await dispatched(verified, dispatchId, () => call<HzActionAnswer>("POST", `/servers/${Number(id)}/actions/rebuild`, { image: Number(image) }, false, signal),
        () => id);
      // The rebuild is sent from here on: a failed re-read must not lose the action id, so the caller can track it.
      try {
        const server = poolServer((await call<{ server: HzServer }>("GET", `/servers/${Number(id)}`, undefined, false, signal)).server);
        return { ...poolAction(answer), server };
      } catch (e) {
        return { ...poolAction(answer), server: undefined, serverError: e instanceof HostError ? e.code : "server_read_failed" };
      }
    },
    async powerOn(id, signal) { return poolAction(await call<HzActionAnswer>("POST", `/servers/${Number(id)}/actions/poweron`, {}, false, signal)); },
    async powerOff(id, signal) { return poolAction(await call<HzActionAnswer>("POST", `/servers/${Number(id)}/actions/poweroff`, {}, false, signal)); },
    async listServerActions(id, kind, signal) {
      const commands = kind === "rebuild" ? ["rebuild_server", "rebuild"] : ["start_server", "poweron"];
      const r = await call<{ actions?: HzAction[] }>("GET", `/servers/${Number(id)}/actions?sort=started:desc&per_page=50`, undefined, false, signal);
      return (r.actions ?? []).filter((a) => commands.includes(a.command))
        .map((a) => ({ id: String(a.id), status: hzStatus(a.status), startedMs: Date.parse(a.started) }))
        .filter((a) => Number.isFinite(a.startedMs)).sort((a, b) => b.startedMs - a.startedMs);
    },
    async listByLabel(selector, signal) {
      if (!validSelector(selector)) throw new Error("provider_label_invalid");
      return (await all<"servers", HzServer>(`/servers?label_selector=${encodeURIComponent(selector)}`, "servers", signal)).map(poolServer);
    },
    async getServerDetail(id, signal) { return poolServer((await call<{ server: HzServer }>("GET", `/servers/${Number(id)}`, undefined, false, signal)).server); },
    async deleteServer(id, signal) {
      try { return { ...poolAction(await call<HzActionAnswer>("DELETE", `/servers/${Number(id)}`, undefined, false, signal)), gone: false }; }
      catch (e) { if (e instanceof HostError && e.status === 404) return { actionId: null, status: "none", gone: true }; throw e; }
    },
    async actionStatus(actionId, signal) {
      const a = (await call<{ action?: HzAction }>("GET", `/actions/${Number(actionId)}`, undefined, true, signal)).action;
      return a ? hzStatus(a.status) : "none";
    },
    async projectUsage(signal) {
      const servers = await all<"servers", { server_type?: { cores?: number } }>("/servers", "servers", signal);
      const volumes = await all<"volumes", { size?: number }>("/volumes", "volumes", signal);
      const ips = await all<"primary_ips", unknown>("/primary_ips", "primary_ips", signal);
      return { vcpu: servers.reduce((n, x) => n + (x.server_type?.cores ?? 0), 0), primaryIps: ips.length,
        volumeGb: volumes.reduce((n, x) => n + (x.size ?? 0), 0) };
    },
    async imageDiskGb(image, signal) {
      if (imageDisk.has(image)) return imageDisk.get(image)!;
      const r = await call<{ image?: { disk_size?: number | null } }>("GET", `/images/${Number(image)}`, undefined, false, signal);
      const gb = typeof r.image?.disk_size === "number" ? r.image.disk_size : null;
      if (gb !== null) imageDisk.set(image, gb);
      return gb;
    },
    async serverTypeDiskGb(serverType, signal) {
      if (typeDisk.has(serverType)) return typeDisk.get(serverType)!;
      const data = await call<{ server_types?: { name: string; disk?: number }[] }>("GET", `/server_types?name=${encodeURIComponent(serverType)}`, undefined, false, signal);
      const gb = data.server_types?.find((t) => t.name === serverType)?.disk;
      if (typeof gb !== "number") return null;
      typeDisk.set(serverType, gb);
      return gb;
    },
    async availableLocations(serverType, candidates) {
      const data = await call<{ server_types: { name: string; locations?: { name: string; available?: boolean; deprecation?: unknown }[] }[] }>(
        "GET", `/server_types?name=${encodeURIComponent(serverType)}`);
      const type = data.server_types?.find((t) => t.name === serverType);
      if (!type?.locations) return [];
      // `available` is the live stock flag. A location that omits it is treated as unknown-but-possible; create decides.
      const ok = new Set(type.locations.filter((l) => l.available !== false).map((l) => l.name));
      return candidates.filter((c) => ok.has(c));
    },
    async createVolume(i) {
      const r = await call<{ volume: HzVolume }>("POST", "/volumes", { name: i.name, size: i.sizeGb, location: i.location,
        automount: false, labels: labelsOf(i.labels) }, false, i.signal);
      return volume(r.volume);
    },
    async createServer(i) {
      const { image, dispatchId } = await authorized(i.image);
      const r = await dispatched(i.image, dispatchId, () => call<{ server: HzServer }>("POST", "/servers", { name: i.name, server_type: i.serverType, location: i.location,
        image: Number(image), user_data: i.userData, labels: { ...labelsOf(i.labels), [DISPATCH_LABEL]: dispatchId },
        volumes: i.volumeId ? [Number(i.volumeId)] : [], automount: false, ssh_keys: config.sshKeyIds,
        firewalls: config.firewallIds.map((id) => ({ firewall: id })), public_net: { enable_ipv4: true, enable_ipv6: false },
        start_after_create: true }, false, i.signal), (x) => serverIdText(x.server));
      return server(r.server);
    },
    async findServers(l) {
      return (await all<"servers", HzServer>(`/servers?label_selector=${selector(l, "home")}`, "servers")).map(server);
    },
    async findVolumes(l) {
      return (await all<"volumes", HzVolume>(`/volumes?label_selector=${selector(l, "volume")}`, "volumes")).map(volume);
    },
    async getServer(id) { return server((await call<{ server: HzServer }>("GET", `/servers/${Number(id)}`)).server); },
    async getVolume(id) { return volume((await call<{ volume: HzVolume }>("GET", `/volumes/${Number(id)}`)).volume); },
    async attachVolume(v, s) { await call("POST", `/volumes/${Number(v)}/actions/attach`, { server: Number(s), automount: false }); },
    async detachVolume(v) { await call("POST", `/volumes/${Number(v)}/actions/detach`, {}); },
    async power(s, on) { return actionId(await call<HzActionAnswer>("POST", `/servers/${Number(s)}/actions/${on ? "poweron" : "poweroff"}`, {})); },
    async reboot(s) { return actionId(await call<HzActionAnswer>("POST", `/servers/${Number(s)}/actions/reset`, {})); },
    async powerActionStatus(_s, _command, id) {
      // Only the call's own action (its id came back with the answer) is this call: no other action is ever taken for it.
      const a = (await call<{ action?: HzAction }>("GET", `/actions/${Number(id)}`, undefined, true)).action;
      return a ? hzStatus(a.status) : "none";
    },
    async listProviderActions(s, stopBefore = 0) {
      const out: { id: string; command: string; startedAt: number }[] = [];
      for (let page = 1; page <= ACTION_PAGE_CAP; page++) {
        const r = await call<HzPage & { actions?: HzAction[] }>("GET", `/servers/${Number(s)}/actions?sort=id:desc&per_page=50&page=${page}`);
        const rows = (r.actions ?? []).map((a) => ({ id: String(a.id), command: a.command, startedAt: Date.parse(a.started) }));
        out.push(...rows);
        if (!r.meta?.pagination?.next_page) return out;
        if (rows.some((a) => a.startedAt < stopBefore)) return out;
      }
      throw new Error("provider_actions_page_cap");
    },
    async quarantine(s, signal) {
      if (!config.quarantineFirewallId) throw new Error("quarantine_firewall_missing");
      try {
        await call("POST", `/firewalls/${config.quarantineFirewallId}/actions/apply_to_resources`, { apply_to: [{ type: "server", server: { id: Number(s) } }] }, false, signal);
      } catch (e) {
        // Fencing runs on every reconcile of a suspended home; an already quarantined server is the goal state, not a failure.
        if (!(e instanceof HostError && e.code === "firewall_already_applied")) throw e;
      }
    },
    async destroyServer(id, signal) { await call("DELETE", `/servers/${Number(id)}`, undefined, true, signal); },
    async destroyVolume(id, signal) { await call("DELETE", `/volumes/${Number(id)}`, undefined, true, signal); },
    async snapshotServer(s, l) {
      const r = await call<{ image: { id: number } } & HzActionAnswer>("POST", `/servers/${Number(s)}/actions/create_image`,
        { type: "snapshot", description: `murage-${l.homeId}-${l.generation}`, labels: labelsOf(l) });
      return { ref: String(r.image.id), actionId: actionId(r) };
    },
    async listSnapshots(l, signal) {
      return (await all<"images", { id: number }>(`/images?type=snapshot&label_selector=${selector(l, "snapshot")}`, "images", signal)).map((i) => String(i.id));
    },
    async deleteSnapshot(id, signal) { await call("DELETE", `/images/${Number(id)}`, undefined, true, signal); },
  };
}

// ---- Vultr ------------------------------------------------------------------------------------------------------

interface VuInstance { id: string; main_ip?: string; power_status?: string; status?: string; server_status?: string; tags?: string[] }
interface VuPage { meta?: { links?: { next?: string | null } } }
interface VuBlock { id: string; region: string; attached_to_instance?: string | null; label?: string }
export function vultrAdapter(apiKey: string, config: Pick<ProvisionerConfig, "vultr" | "quarantineFirewallGroupId">, fetcher: HostFetch = fetch): HostingAdapter {
  const call = async <T>(method: string, path: string, body?: unknown, ignore404 = false, signal?: AbortSignal): Promise<T> => {
    try {
      return await parse<T>(await fetcher(`https://api.vultr.com/v2${path}`, { method,
        headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, ...(signal ? { signal } : {}) }), ignore404);
    } catch (error) { throw method === "GET" ? markNotAnAnswer(error) : error; } // Astra MAILRETRY-16 P1: a GET error answers no create
  };
  /** Astra MAILRETRY-16 P1: every page of a listing (Vultr pages by cursor, meta.links.next); any page failing fails the listing. */
  const all = async <K extends string, T>(path: string, key: K, signal?: AbortSignal): Promise<T[]> => {
    const out: T[] = [];
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const r = await call<VuPage & Record<K, T[]>>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        undefined, false, signal);
      out.push(...(r[key] ?? []));
      cursor = r.meta?.links?.next ?? "";
      if (!cursor) return out;
    }
    throw markNotAnAnswer(new Error("provider_listing_incomplete"));
  };
  const tag = (l: Omit<Labels, "role">) => `murage-${label(l.homeId)}-g${l.generation}`;
  const CALL_TAG = "murage-call-";
  const server = (s: VuInstance): NativeServer => ({ id: s.id,
    state: s.power_status === "running" && s.server_status === "ok" ? "running" : s.power_status === "stopped" ? "off" : (s.status ?? "unknown"),
    ips: s.main_ip && s.main_ip !== "0.0.0.0" ? [s.main_ip] : [],
    callKey: s.tags?.find((t) => t.startsWith(CALL_TAG))?.slice(CALL_TAG.length) ?? null });
  // A block's label is `name|tag` or (round 12) `name|tag|call`.
  const block = (b: VuBlock): NativeVolume => ({ id: b.id, location: b.region, serverId: b.attached_to_instance || null,
    callKey: b.label?.split("|")[2] ?? null });
  return {
    provider: "vultr",
    async availableLocations(plan, candidates) {
      const out: string[] = [];
      for (const region of candidates) {
        const r = await call<{ available_plans?: string[] }>("GET", `/regions/${encodeURIComponent(region)}/availability`);
        if (r.available_plans?.includes(plan)) out.push(region);
      }
      return out;
    },
    async createVolume(i) {
      const r = await call<{ block: VuBlock }>("POST", "/blocks", { region: i.location, size_gb: i.sizeGb,
        label: `${i.name}|${tag(i.labels)}${i.labels.call ? `|${label(i.labels.call)}` : ""}` }, false, i.signal);
      return block(r.block);
    },
    async createServer(i) {
      assertVerifiedImage(i.image, { provider: "vultr", now: Date.now() }); // no Vultr image can be verified: customer homes are build host only
      if (!config.vultr) throw markNotSent(new Error("vultr_firewall_missing")); // never create an unfirewalled home
      const r = await call<{ instance: VuInstance }>("POST", "/instances", { ...(config.vultr.sshKeyIds.length ? { sshkey_id: config.vultr.sshKeyIds } : {}),
        firewall_group_id: config.vultr.firewallGroupId, region: i.location, plan: i.serverType,
        snapshot_id: i.image.image, label: i.name, hostname: i.name.slice(0, 63),
        tags: [tag(i.labels), "murage-home", ...(i.labels.call ? [`${CALL_TAG}${label(i.labels.call)}`] : [])], enable_ipv6: false,
        backups: "disabled", user_data: btoa(i.userData) }, false, i.signal);
      // The instance exists from here on: an attach error is not the create's answer (Astra MAILRETRY-16 P1).
      if (i.volumeId) await call("POST", `/blocks/${i.volumeId}/attach`, { instance_id: r.instance.id, live: true }, false, i.signal).catch((e: unknown) => { throw markNotAnAnswer(e); });
      return server(r.instance);
    },
    async findServers(l) {
      return (await all<"instances", VuInstance>(`/instances?tag=${encodeURIComponent(tag(l))}`, "instances")).map(server);
    },
    async findVolumes(l) {
      return (await all<"blocks", VuBlock>("/blocks", "blocks")).filter((b) => b.label?.split("|")[1] === tag(l)).map(block);
    },
    async getServer(id) { return server((await call<{ instance: VuInstance }>("GET", `/instances/${encodeURIComponent(id)}`)).instance); },
    async getVolume(id) { return block((await call<{ block: VuBlock }>("GET", `/blocks/${encodeURIComponent(id)}`)).block); },
    async attachVolume(v, s) { await call("POST", `/blocks/${encodeURIComponent(v)}/attach`, { instance_id: s, live: true }); },
    async detachVolume(v) { await call("POST", `/blocks/${encodeURIComponent(v)}/detach`, { live: true }); },
    async power(s, on) { await call("POST", `/instances/${encodeURIComponent(s)}/${on ? "start" : "halt"}`, {}); },
    async reboot(s) { await call("POST", `/instances/${encodeURIComponent(s)}/reboot`, {}); },
    async quarantine(s) {
      const group = config.vultr?.quarantineFirewallGroupId ?? config.quarantineFirewallGroupId;
      if (!group) throw markNotSent(new Error("quarantine_firewall_missing"));
      await call("PATCH", `/instances/${encodeURIComponent(s)}`, { firewall_group_id: group });
    },
    async destroyServer(id, signal) { await call("DELETE", `/instances/${encodeURIComponent(id)}`, undefined, true, signal); },
    async destroyVolume(id, signal) { await call("DELETE", `/blocks/${encodeURIComponent(id)}`, undefined, true, signal); },
    async snapshotServer(s, l) {
      const r = await call<{ snapshot: { id: string } }>("POST", "/snapshots", { instance_id: s, description: `${tag(l)}` });
      return { ref: r.snapshot.id, actionId: null };
    },
    async listSnapshots(l, signal) {
      return (await all<"snapshots", { id: string; description: string }>("/snapshots", "snapshots", signal))
        .filter((s) => s.description === tag(l)).map((s) => s.id);
    },
    async deleteSnapshot(id, signal) { await call("DELETE", `/snapshots/${encodeURIComponent(id)}`, undefined, true, signal); },
  };
}

// ---- Ladder -----------------------------------------------------------------------------------------------------

export interface LadderChoice { provider: "hetzner" | "vultr"; serverType: string; location: string; arch: "x86" | "arm"; image: string }
export interface LadderAttempt { provider: string; serverType: string; arch: string; result: "chosen" | "no_stock" | "image_too_big" | "no_image" | "no_vultr_config" | "vultr_disabled" | "error" | `image_refused:${string}` }

/** Walk the rungs in order. First rung with stock (and a configured image) wins. */
export async function chooseRung(config: ProvisionerConfig, plan: string, adapters: Record<"hetzner" | "vultr", HostingAdapter | null>,
  /** Checks one rung's image (verifyImageForUse). A refusal skips the rung and is recorded; it never picks an unverified image. */
  verify: (r: { provider: "hetzner" | "vultr"; image: string; arch: "x86" | "arm" }) => Promise<unknown>):
  Promise<{ choice: LadderChoice; tried: LadderAttempt[] }> {
  const tried: LadderAttempt[] = [];
  for (const rung of ladderFor(config, plan)) {
    const image = rung.provider === "hetzner" ? config.images.hetzner[rung.arch] : rung.arch === "x86" ? config.images.vultr.x86 : undefined;
    const attempt = { provider: rung.provider, serverType: rung.serverType, arch: rung.arch };
    if (rung.provider === "vultr" && !config.allowVultrCustomerHomes) { tried.push({ ...attempt, result: "vultr_disabled" }); continue; }
    if (!image) { tried.push({ ...attempt, result: "no_image" }); continue; }
    try { await verify({ provider: rung.provider, image, arch: rung.arch }); }
    catch (e) {
      if (!(e instanceof ImageRefused)) throw e;
      tried.push({ ...attempt, result: `image_refused:${e.code}` }); continue;
    }
    if (rung.provider === "vultr" && !config.vultr) { tried.push({ ...attempt, result: "no_vultr_config" }); continue; }
    const adapter = adapters[rung.provider];
    if (!adapter) { tried.push({ ...attempt, result: "error" }); continue; }
    // Disk fit comes AFTER the signed-image gate (verify above) so a skip can never stand in for it. A too-big image is never sent to this type.
    if (rung.provider === "hetzner" && !await rungFits(adapter, image, rung.serverType)) { tried.push({ ...attempt, result: "image_too_big" }); continue; }
    try {
      const candidates: string[] = rung.provider === "hetzner" ? config.hetznerLocations : config.vultrRegions;
      const open = await adapter.availableLocations(rung.serverType, candidates);
      if (open.length === 0) { tried.push({ ...attempt, result: "no_stock" }); continue; }
      tried.push({ ...attempt, result: "chosen" });
      return { choice: { provider: rung.provider, serverType: rung.serverType, location: open[0], arch: rung.arch, image }, tried };
    } catch {
      tried.push({ ...attempt, result: "error" });
    }
  }
  throw Object.assign(new Error("no_capacity"), { tried });
}

// ---- ProviderAdapter for the B3 lifecycle (live mode) ---------------------------------------------------------------

const prefix = { hetzner: { server: "hs-", volume: "" }, vultr: { server: "vs-", volume: "vv-" } } as const;
function route(id: string): { provider: "hetzner" | "vultr"; role: ResourceRole; native: string } {
  if (/^\d+$/.test(id)) return { provider: "hetzner", role: "volume", native: id };
  if (id.startsWith("hs-")) return { provider: "hetzner", role: "home", native: id.slice(3) };
  if (id.startsWith("vs-")) return { provider: "vultr", role: "home", native: id.slice(3) };
  if (id.startsWith("vv-")) return { provider: "vultr", role: "volume", native: id.slice(3) };
  throw new Error("provider_identity_conflict");
}

/** The build host adapter carries the pool methods; the Vultr one and test doubles may not. */
const isPoolAdapter = (a: HostingAdapter): a is HostingAdapter & HetznerPoolAdapter => typeof (a as Partial<HetznerPoolAdapter>).updateServer === "function";

export interface LiveDeps { fetch?: HostFetch; now?: () => number; adapters?: Record<"hetzner" | "vultr", HostingAdapter | null>;
  /** One adapter for every configured box, or one per box id (tests). */
  storageBox?: StorageBoxAdapter | Record<number, StorageBoxAdapter>;
  /** Warm pool claim waits (volume attach, locked server, power-on). Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests: the key wrapper for the pool payload's data key (default keyWrapperFor(env)). */
  wrapper?: KeyWrapper;
  /** Tests: the signature check's fetch, trust lists and build environment (production passes nothing). */
  verify?: VerifyDeps;
}

/** Staging only (config.opsSshFrom): lets the operator network ssh to a new home (the image closes ssh to everyone else).
 *  A drop-in adds it when murage-egress next starts, and a runcmd adds it now in case the firewall is already loaded.
 *  Both lists are empty in production, where customer homes have no operator ssh. */
function opsSshFiles(from: string[]): string[] {
  if (!from.length) return [];
  const posts = from.map((net) => `ExecStartPost=/usr/sbin/nft add element inet murage_home qual_ssh { ${net} }`).join("\n");
  return ["  - path: /etc/systemd/system/murage-egress.service.d/ops-ssh.conf", "    permissions: '0644'", "    owner: root:root",
    "    encoding: b64", `    content: ${btoa(`[Service]\n${posts}\n`)}`];
}
function opsSshRunCmd(from: string[], hasRuncmd: boolean): string[] {
  if (!from.length) return [];
  const cmd = from.map((net) => `/usr/sbin/nft add element inet murage_home qual_ssh { ${net} } || true`).join("; ");
  return [...(hasRuncmd ? [] : ["runcmd:"]), `  - [sh, -c, "systemctl daemon-reload; ${cmd}"]`];
}

export function createLiveProvider(env: Env, deps: LiveDeps = {}): ProviderAdapter {
  const db = env.DB;
  const config = provisionerConfig(env);
  const adapters = deps.adapters ?? {
    hetzner: env.HCLOUD_TOKEN ? hetznerAdapter(env.HCLOUD_TOKEN, { ...config, quarantineFirewallId: config.quarantineFirewallId }, deps.fetch, deps.now) : null,
    vultr: env.VULTR_API_KEY ? vultrAdapter(env.VULTR_API_KEY, config, deps.fetch) : null,
  };
  // G3: before the first provisioning mutation of this provider instance, every configured build host image must be approved for this
  // environment and readable with this credential. Not cached across instances; a failure is remembered for this instance only.
  // Injected adapters (tests) have no real credential to check.
  let imagesChecked: Promise<void> | null = null;
  const imagesGate = (): Promise<void> => {
    if (deps.adapters) return Promise.resolve();
    imagesChecked ??= assertHetznerImagesApproved(env, config, env.HCLOUD_TOKEN, deps.fetch ?? fetch);
    return imagesChecked;
  };
  const need = (p: "hetzner" | "vultr") => adapters[p] ?? (() => { throw new Error("provider_unconfigured"); })();
  const now = deps.now ?? Date.now;
  const verifyDeps: VerifyDeps = { fetch: deps.fetch, ...deps.verify };
  const verify = (r: { provider: "hetzner" | "vultr"; image: string; arch: "x86" | "arm" }) => verifyImageForUse(env, config, r, now(), verifyDeps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const slots = (): BoxSlot[] => (config.storageBox ?? []).map((boxConfig) => {
    const given = deps.storageBox;
    const box = given ? ("createSubaccount" in given ? given : given[boxConfig.id])
      : env.STORAGEBOX_API_TOKEN && env.STORAGEBOX_MAIN_PASSWORD
        ? hetznerStorageBox(env.STORAGEBOX_API_TOKEN, boxConfig, env.STORAGEBOX_MAIN_PASSWORD, deps.fetch) : null;
    if (!box) throw new Error("storage_box_unconfigured");
    return { box, config: boxConfig };
  });
  /** Backup deps for a NEW home: the first box with room. All boxes full raises an alert and fails the create (reconcile retries).
   *  Round 11 (Astra MAILRETRY-15 P1-2): the restic password is the attempt's own, captured by the caller before its dispatch fence
   *  (CreateHomeInput.backup); nothing on this path reads the home's key material, so a reopen's fresh keys can never reach it. Fails closed
   *  when the caller did not give one. */
  const backup = async (homeId: string, given?: { resticPassword: string }): Promise<BackupDeps | null> => {
    const all = slots();
    if (!all.length) return null;
    const slot = await pickBox(all);
    if (!slot) {
      await persistAlert(env, { homeId, kind: "backup.storage_boxes_full", severity: "high", // recorded; the monitoring sweep sends it
        detail: `every configured Storage Box holds ${BOX_SOFT_LIMIT} or more sub-accounts; add a box to B5_PROVISIONER_CONFIG.storageBox` }, now());
      throw new Error("storage_boxes_full");
    }
    if (!given?.resticPassword) throw new Error("backup_password_unavailable");
    const resticPassword = given.resticPassword;
    return { ...slot, backupPassword: async () => resticPassword };
  };
  const toId = (provider: "hetzner" | "vultr", role: ResourceRole, native: string) => prefix[provider][role === "home" ? "server" : "volume"] + native;
  const homeOf = (id: string) => route(id);
  /** KMS 10.1/11/12.2: Start and Reboot never reach a warm-pool server whose enrollment was not consumed (its only power-on is the claim path's
   *  checked one). Stop and power-off stay allowed. */
  const refuseUnenrolledPool = async (r: { provider: "hetzner" | "vultr"; native: string }) => {
    if (await isUnenrolledPoolServer(db, r.provider, r.native)) throw markNotSent(new Error("pool_server_unenrolled"));
  };

  async function choiceFor(homeId: string, gen: number) {
    return db.prepare("SELECT * FROM provision_choices WHERE home_id=? AND resource_generation=?").bind(homeId, gen)
      .first<{ provider: "hetzner" | "vultr"; server_type: string; location: string; arch: "x86" | "arm"; image: string; pool_id: string | null }>();
  }
  async function planOf(homeId: string): Promise<string> {
    const row = await db.prepare("SELECT plan FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ plan: string }>();
    if (!row) throw new Error("plan_unknown"); // never guess a size: the bill depends on it
    return row.plan;
  }
  function descriptor(provider: "hetzner" | "vultr", v: NativeVolume, homeId: string, gen: number): VolumeDescriptor {
    const id = toId(provider, "volume", v.id);
    const serial = provider === "hetzner" ? `0HC_Volume_${v.id}` : v.id.replace(/-/g, "").slice(0, 20);
    const device = provider === "hetzner" ? `/dev/disk/by-id/scsi-0HC_Volume_${v.id}` : `/dev/disk/by-id/virtio-${serial}`;
    return validateVolume({ provider, id: provider === "hetzner" ? v.id : id, homeId, resourceGeneration: gen, device, serial, new: true,
      attachment: { serverId: v.serverId === null ? null : toId(provider, "home", v.serverId),
        state: v.serverId === null ? "detached" : "attached" } }, homeId, gen);
  }
  function resource(provider: "hetzner" | "vultr", s: NativeServer, homeId: string, gen: number, role: ResourceRole): ProviderResource {
    return { id: toId(provider, role, s.id), home_id: homeId, generation: gen, role, state: s.state, public_ips: JSON.stringify(s.ips), quarantined: 0,
      idempotency_key: s.callKey ?? null };
  }
  /** Astra MAILRETRY-16 P1: the create request's own refusal (it did not execute) is marked as its answer; anything else is not. */
  const answerOf = (e: unknown) => (e instanceof HostError && refusalStatus(e.status) && !(e as { notAnAnswer?: boolean }).notAnAnswer) ? markAnswered(e) : e;
  // A native id alone does not say which home it belongs to; the volume/server record is rediscovered through labels per call.
  const scope = new Map<string, { homeId: string; generation: number }>();
  /** The plan's other rungs on the pinned provider that have stock at the pinned place (the home's volume is there). Vultr rungs are
   *  only ever walked when customer homes are allowed on Vultr. */
  async function otherRungs(choice: { provider: "hetzner" | "vultr"; server_type: string; location: string; arch: "x86" | "arm" }, homeId: string) {
    const out: { serverType: string; arch: "x86" | "arm"; image: string }[] = [];
    if (choice.provider === "vultr" && !config.allowVultrCustomerHomes) return out;
    const adapter = adapters[choice.provider];
    if (!adapter) return out;
    for (const rung of ladderFor(config, await planOf(homeId))) {
      if (rung.provider !== choice.provider || rung.serverType === choice.server_type) continue;
      const image = rung.provider === "hetzner" ? config.images.hetzner[rung.arch] : rung.arch === "x86" ? config.images.vultr.x86 : undefined;
      if (!image || out.some((o) => o.serverType === rung.serverType)) continue;
      if (rung.provider === "hetzner" && !await rungFits(adapter, image, rung.serverType)) continue;
      try { if ((await adapter.availableLocations(rung.serverType, [choice.location])).includes(choice.location)) out.push({ serverType: rung.serverType, arch: rung.arch, image }); }
      catch { /* an unreadable rung is skipped */ }
    }
    return out;
  }
  /** Verifies a stored choice's image. A permanent refusal (not a transient build host re-check failure) of a ladder choice is repaired once with the
   *  CURRENT configured image of the same provider and arch, which must itself verify; location and volume are unchanged. */
  async function verifyChoice(homeId: string, gen: number, choice: { provider: "hetzner" | "vultr"; arch: "x86" | "arm"; image: string; pool_id: string | null }) {
    try { return await verify({ provider: choice.provider, image: choice.image, arch: choice.arch }); }
    catch (e) {
      if (!(e instanceof ImageRefused) || e.code === "image_recheck_failed" || choice.pool_id) throw e;
      const current = choice.provider === "hetzner" ? config.images.hetzner[choice.arch] : undefined;
      if (!current || current === choice.image) throw e;
      const v = await verify({ provider: choice.provider, image: current, arch: choice.arch });
      await db.prepare("UPDATE provision_choices SET image=? WHERE home_id=? AND resource_generation=? AND image=?").bind(current, homeId, gen, choice.image).run();
      choice.image = current;
      return v;
    }
  }
  /** Everything create_volume does before its POST (the rung choice, the label lookup, the plan): errors here mean "not sent". */
  async function prepareVolume(input: CreateVolumeInput) {
    await imagesGate();
    let choice = await choiceFor(input.homeId, input.resourceGeneration);
    if (!choice) {
      const plan = await planOf(input.homeId);
      // Warm pool (4.2): one atomic claim of a ready, powered-off server of the plan's class; a lost race or an empty pool is the ladder's.
      if (!await claimPoolServer(env, config, { homeId: input.homeId, resourceGeneration: input.resourceGeneration, plan, now: now() },
        (arch, image) => verify({ provider: "hetzner", image, arch }).then(() => true, (e) => { if (e instanceof ImageRefused) return false; throw e; }))) {
        let chosen: Awaited<ReturnType<typeof chooseRung>>;
        try { chosen = await chooseRung(config, plan, adapters, verify); }
        catch (e) {
          const tried = (e as { tried?: LadderAttempt[] }).tried ?? [];
          if (tried.some((t) => t.result.startsWith("image_refused:"))) {
            await persistAlert(env, { homeId: "platform", kind: "image.unverified", severity: "high",
              detail: tried.filter((t) => t.result.startsWith("image_refused:")).map((t) => `${t.serverType}:${t.result}`).join(" ").slice(0, 300) }, now()).catch(() => false);
          }
          const tooBig = tried.filter((t) => t.result === "image_too_big");
          if (tooBig.length) await raiseImageTooBig(env, tooBig.map((t) => ({ image: config.images.hetzner[t.arch as "x86" | "arm"] ?? "", serverType: t.serverType })), now());
          throw e;
        }
        const { choice: picked, tried } = chosen;
        // A later rung took the home, but a skipped rung means the plan is not on its intended (cheaper) type: the operator must know.
        const skipped = tried.filter((t) => t.result === "image_too_big");
        if (skipped.length) await raiseImageTooBig(env, skipped.map((t) => ({ image: config.images.hetzner[t.arch as "x86" | "arm"] ?? "", serverType: t.serverType })), now());
        await db.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(home_id,resource_generation) DO NOTHING`)
          .bind(input.homeId, input.resourceGeneration, picked.provider, picked.serverType, picked.location, picked.arch, picked.image,
            JSON.stringify(tried), now()).run();
      }
      choice = (await choiceFor(input.homeId, input.resourceGeneration))!;
    }
    const adapter = need(choice.provider);
    const existing = (await adapter.findVolumes({ homeId: input.homeId, generation: input.resourceGeneration }))[0];
    const plan = await planOf(input.homeId);
    return { adapter, choice, existing, plan };
  }
  /** Everything create does before its POST (the choice, the label lookup, the backup sub-account and the user-data): "not sent". The
   *  sub-account create is its own call in the ledger (prepareBackup records it before it is sent). */
  async function prepareServer(input: CreateHomeInput) {
    await imagesGate();
    const choice = await choiceFor(input.homeId, input.resourceGeneration);
    if (!choice) throw new Error("provision_choice_missing");
    const adapter = need(choice.provider);
    const existing = (await adapter.findServers({ homeId: input.homeId, generation: input.resourceGeneration }))[0];
    if (existing) return { adapter, choice, existing, userData: "", volumeNative: "", pool: null as PoolRow | null, verified: null as VerifiedImage | null };
    // No server is created from an image that fails the signature check (a thrown refusal is "not sent"; a later retry re-verifies).
    assertNoProdSshKeys(env, config, verifyDeps);
    const verified = await verifyChoice(input.homeId, input.resourceGeneration, choice);
    const volumeJson = JSON.stringify({ provider: input.userData.volume.provider, id: input.userData.volume.id.replace(/^vv-/, ""),
      device: input.userData.volume.device, new: input.userData.volume.new, generation: input.userData.volume.generation,
      homeId: input.homeId });
    const bk = await backup(input.homeId, input.backup);
    const backupFragment = bk ? await prepareBackup(db, bk, input.homeId, input.resourceGeneration, now()) : "";
    const userData = ["#cloud-config", `murage_home_id: ${input.userData.machineId}`,
      `murage_enrollment_token: ${input.userData.enrollmentToken}`, `murage_admin_url: ${input.userData.controlPlaneOrigin}`,
      "write_files:", ...opsSshFiles(config.opsSshFrom), "  - path: /etc/murage-home/volume.json", "    permissions: '0600'", "    owner: root:root",
      `    content: '${volumeJson}'`, ...(backupFragment ? [backupFragment.replace(/^write_files:\n/, "")] : []),
      ...opsSshRunCmd(config.opsSshFrom, Boolean(backupFragment)), ""].join("\n");
    // Warm pool (4.3 step 1): the identity payload is wrapped and stored BEFORE any provider call, so a failure here is "not sent". A claimed
    // row that is gone (failed) or whose adapter has no pool methods takes the normal create path instead.
    let pool: PoolRow | null = null;
    if (choice.pool_id && choice.provider === "hetzner" && isPoolAdapter(adapter)) {
      pool = await db.prepare("SELECT * FROM warm_pool WHERE id=? AND state='claimed' AND home_id=? AND resource_generation=? AND server_id IS NOT NULL")
        .bind(choice.pool_id, input.homeId, input.resourceGeneration).first<PoolRow>();
      if (pool) {
        try { await holds(input.fence); } catch (e) { throw markNotSent(e); }
        const wrapped = await sealPayload(deps.wrapper ?? keyWrapperFor(env), input.homeId, userData);
        const fg = fenceGuard(input.fence);
        // Guarded by the owner this attempt claimed: a stale claimant (its row released and taken by another home) writes nothing.
        const stored = await db.prepare(`INSERT INTO warm_pool_deliveries (pool_id,home_id,resource_generation,token_hash,payload_wrapped,created_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM warm_pool WHERE id=? AND state='claimed' AND home_id=? AND resource_generation=?)${fg.sql}
          ON CONFLICT(pool_id) DO UPDATE SET home_id=excluded.home_id,resource_generation=excluded.resource_generation,token_hash=excluded.token_hash,
            payload_wrapped=excluded.payload_wrapped,purged_at=NULL`)
          .bind(pool.id, input.homeId, input.resourceGeneration, await sha256(input.userData.enrollmentToken), wrapped, now(),
            pool.id, input.homeId, input.resourceGeneration, ...fg.binds).run();
        if (stored.meta.changes !== 1) { await holds(input.fence); throw new Error("pool_ownership_lost"); }
      }
    }
    return { adapter, choice, existing: undefined, userData, volumeNative: route(input.volume.id).native, pool, verified };
  }

  /** A build host action that locks the server (an attach in flight) answers 423 `locked` to the next one: wait and retry briefly. */
  const whenUnlocked = async <T>(op: () => Promise<T>): Promise<T> => {
    for (let waited = 0; ; waited += 2000) {
      try { return await op(); } catch (e) {
        if (!(e instanceof HostError && (e.status === 423 || e.code === "locked")) || waited >= 30_000) throw e;
        await sleep(2000);
      }
    }
  };
  /** Astra round 2 #1: the attempt's fencing token. Every pool-row write carries it in the statement itself (the guard below) and every provider
   *  mutation is preceded by `holds`, which renews the lease through a guarded UPDATE on the lease row (token must match, one row changed). An
   *  attempt that lost the lease (its lease expired and another attempt took it) aborts with PoolLeaseLost: it never fences, quarantines or
   *  touches the server. No fence (a caller outside the B3 lifecycle) means no check. */
  const fenceGuard = (f?: ProvisionFence) => f
    ? { sql: " AND EXISTS (SELECT 1 FROM provision_attempts a WHERE a.home_id=? AND a.resource_generation=? AND a.lease_token=?)", binds: [f.homeId, f.resourceGeneration, f.token] as unknown[] }
    : { sql: "", binds: [] as unknown[] };
  const holds = async (f?: ProvisionFence) => {
    if (!f) return;
    const r = await db.prepare(`UPDATE provision_attempts SET next_at=MAX(next_at,${DB_NOW}+?) WHERE home_id=? AND resource_generation=? AND lease_token=? AND gave_up_at IS NULL`)
      .bind(POOL_LEASE_RENEW_MS, f.homeId, f.resourceGeneration, f.token).run();
    if (r.meta.changes !== 1) throw new PoolLeaseLost();
  };
  /** Every pool-row write after the claim names the owner (id, home, resource generation, state) and the attempt's fence, and must change exactly
   *  one row; otherwise the row was released and taken by another home (or the lease was taken by another attempt) and this attempt stops. */
  const owned = async (poolId: string, homeId: string, gen: number, set: string, binds: unknown[] = [], fence?: ProvisionFence) => {
    const g = fenceGuard(fence);
    const r = await db.prepare(`UPDATE warm_pool SET ${set} WHERE id=? AND state='claimed' AND home_id=? AND resource_generation=?${g.sql}`)
      .bind(...binds, poolId, homeId, gen, ...g.binds).run();
    if (r.meta.changes !== 1) {
      if (fence) await holds(fence); // lost the lease: say so (this throws PoolLeaseLost)
      throw new Error("pool_ownership_lost");
    }
  };
  type ActionOutcome = "success" | "error" | "running" | "unknown";
  /** The terminal result of a power-on. With the action id persisted: that action's own status. Without it (the call was sent but its answer was
   *  lost or never persisted): the server's own action list, and only a start action STARTED AFTER the persisted intent counts. Anything not
   *  established ("none", no such action) is "unknown", which is never success. */
  async function actionOutcome(hz: HostingAdapter & HetznerPoolAdapter, p: { serverNative: string; signal?: AbortSignal },
    id: string | null, intentMs: number): Promise<ActionOutcome> {
    if (id) {
      const status = hz.powerActionStatus ? await hz.powerActionStatus(p.serverNative, "start", id) : "none";
      return status === "none" ? "unknown" : status;
    }
    const found = (await hz.listServerActions(p.serverNative, "start", p.signal)).find((a) => a.startedMs >= intentMs - ACTION_CLOCK_SKEW_MS);
    return found ? (found.status === "none" ? "unknown" : found.status) : "unknown";
  }
  /** The pool server's real image (what build host says it runs) must be the pool row's image and pass verifyImageForUse. */
  async function poolImageOk(detail: PoolServer, poolImage: string, arch: "x86" | "arm", choiceImage?: string): Promise<boolean> {
    if (detail.imageId === null || detail.imageId !== poolImage || (choiceImage !== undefined && detail.imageId !== choiceImage)) return false;
    try { await verify({ provider: "hetzner", image: detail.imageId, arch }); return true; }
    catch (e) { if (e instanceof ImageRefused) return false; throw e; }
  }
  /** Claim steps 3 and 4, idempotent (spike 2026-10-16 order; the server is already relabelled): attach the volume while the server is OFF, then
   *  power it on. There is no rebuild: the claim only takes a server on the current image. The intent of the power-on is persisted BEFORE it is
   *  sent (`power_on_sending@<ms>`) and its action id after (`powering_on@<id>`); `powered` is the finished claim. A server that is not off is
   *  finished only when the power-on action is established as successful (by id, or by the server's action list for an action started after the
   *  intent): running or unknown is retried later and is never success. A power-on sent twice is harmless. */
  async function finishPoolClaim(hz: HostingAdapter & HetznerPoolAdapter, p: { poolId: string; homeId: string; generation: number; serverNative: string;
    volumeNative: string; signal?: AbortSignal; fence?: ProvisionFence; image: string; arch: "x86" | "arm" }) {
    const own = (set: string, binds: unknown[] = []) => owned(p.poolId, p.homeId, p.generation, set, binds, p.fence);
    const detail = await hz.getServerDetail(p.serverNative, p.signal);
    if (!claimLabelsOk(detail.labels, p.homeId, p.generation)) throw new Error("claim_labels_incomplete"); // never finished on a server that still looks like pool stock
    // An unestablished claimed server (still off) is never attached or powered on unless the image it REALLY runs is the pool row's and verifies.
    if (detail.status === "off" && !await poolImageOk(detail, p.image, p.arch)) throw new Error("claim_image_rejected");
    const pollPowerOn = async (actionIdNow: string | null, intent: number) => {
      for (let waited = 0; ; waited += 2000) {
        const outcome = await actionOutcome(hz, p, actionIdNow, intent);
        if (outcome === "success") { await own("phase='powered'"); return; }
        if (outcome === "error") throw new Error("claim_power_on_failed"); // the server stays off: the next attempt powers it on again
        if (waited >= 60_000) throw new Error("claim_power_on_in_progress");
        await sleep(2000);
      }
    };
    if (detail.status !== "off") {
      const mine = await db.prepare("SELECT phase FROM warm_pool WHERE id=? AND state='claimed' AND home_id=? AND resource_generation=?")
        .bind(p.poolId, p.homeId, p.generation).first<{ phase: string | null }>();
      if (!mine) throw new Error("pool_ownership_lost");
      const phase = mine.phase ?? "";
      if (phase === "powered") return;
      const po = /^power_on_sending@(\d+)$/.exec(phase) ?? /^powering_on@(\d+)$/.exec(phase);
      if (po) {
        const sending = phase.startsWith("power_on_sending@");
        const outcome = await actionOutcome(hz, p, sending ? null : po[1], sending ? Number(po[1]) : 0);
        if (outcome === "success") { await own("phase='powered'"); return; }
        if (outcome === "error") throw new Error("claim_power_on_failed"); // the next attempt sees the server off and powers it on again
        throw new Error(outcome === "running" ? "claim_power_on_in_progress" : "claim_power_on_unconfirmed");
      }
      throw new Error("claim_server_unexpected_state"); // powered by nobody we know: never finished by guessing
    }
    let vol = await hz.getVolume(p.volumeNative);
    if (vol.serverId !== p.serverNative) {
      if (vol.serverId !== null) throw new Error("provider_attachment_conflict");
      await whenUnlocked(async () => { await holds(p.fence); await hz.attachVolume(p.volumeNative, p.serverNative); });
      for (let waited = 0; ; waited += 2000) {
        vol = await hz.getVolume(p.volumeNative);
        if (vol.serverId === p.serverNative) break;
        if (waited >= 30_000) throw new Error("provider_attachment_timeout");
        await sleep(2000);
      }
    }
    const intent = now();
    await holds(p.fence);
    await own("phase=?", [`power_on_sending@${intent}`]);
    const sent = await whenUnlocked(async () => { await holds(p.fence); return hz.powerOn(p.serverNative, p.signal); });
    if (sent.actionId) await own("phase=?", [`powering_on@${sent.actionId}`]);
    await pollPowerOn(sent.actionId, intent);
  }
  /** The claim relabel and its read-back, one routine for every path that takes a server for a claim (create, create's discovered-server return, B3's
   *  adoption in attach_volume). Fresh read before the PUT (a PUT replaces the whole label set); the read-back must satisfy `claimLabelsOk`. */
  async function relabelClaim(hz: HostingAdapter & HetznerPoolAdapter, adapter: HostingAdapter, serverNative: string, homeId: string, generation: number,
    call: string | undefined, labels: Labels, signal?: AbortSignal): Promise<void> {
    let current: PoolServer;
    try { current = await hz.getServerDetail(serverNative, signal); }
    catch (e) { throw markNotSent(e); }
    try {
      await hz.updateServer(serverNative, { name: `mcq-${homeId}-${generation}`.slice(0, 60),
        labels: { ...claimFleetLabels(current.labels), "murage/home": homeId, "murage/generation": String(generation), "murage/role": "home",
          ...(call ? { "murage/call": call } : {}) } }, signal);
    } catch (e) {
      if (isAnswered(answerOf(e))) throw answerOf(e); // refused: nothing was relabelled; the phase stays (a stale refusal must not erase a later attempt's marker)
      let again: NativeServer | undefined;
      try { again = call ? (await adapter.findServers(labels)).find((s) => s.callKey === call) : undefined; } catch { throw e; }
      if (!again) throw e;
    }
    // Read back: a home that is not fully labelled is never reported as claimed. The relabel marker stays, so a retry relabels again.
    let after: PoolServer;
    try { after = await hz.getServerDetail(serverNative, signal); }
    catch (e) { throw markNotAnAnswer(e); }
    if (!claimLabelsOk(after.labels, homeId, generation)) throw markNotAnAnswer(new HostError(0, "claim_labels_incomplete"));
  }
  /** A server found or adopted for a claim (create's discovered-server return; B3's adoption by label in attach_volume) is re-relabelled and read back
   *  when its row is still at `relabeling@*` or its labels fail the claim invariant: the claim is never finished on a server that kept expires_at. */
  async function reclaimPooled(adapter: HostingAdapter, serverNative: string, expect: { homeId: string; generation: number } | null, fence?: ProvisionFence, signal?: AbortSignal) {
    if (!config.pool || !isPoolAdapter(adapter)) return;
    const row = await db.prepare("SELECT * FROM warm_pool WHERE provider='hetzner' AND server_id=? AND state='claimed' AND phase IS NOT NULL")
      .bind(serverNative).first<PoolRow>();
    if (!row?.home_id || row.resource_generation === null) return;
    if (expect && (row.home_id !== expect.homeId || row.resource_generation !== expect.generation)) return;
    const cur = await adapter.getServerDetail(serverNative, signal);
    if (!(row.phase ?? "").startsWith("relabeling@") && claimLabelsOk(cur.labels, row.home_id, row.resource_generation)) return;
    await holds(fence);
    await relabelClaim(adapter, adapter, serverNative, row.home_id, row.resource_generation, cur.labels["murage/call"],
      { homeId: row.home_id, generation: row.resource_generation, role: "home", call: cur.labels["murage/call"] }, signal);
  }
  /** 4.3 for a claimed pool server. Null: the pool server is gone or not off (row failed and fenced): the caller takes the normal create path. */
  async function createFromPool(input: CreateHomeInput, adapter: HostingAdapter, pool: PoolRow, labels: Labels, choiceImage: string): Promise<ProviderResource | null> {
    const hz = adapter as HostingAdapter & HetznerPoolAdapter;
    const serverNative = pool.server_id!;
    let detail: PoolServer;
    const fence = input.fence;
    // A fence on a row is applied only while this attempt still holds the lease; losing it throws before anything is fenced or quarantined.
    const fenceRow = async (reason: string, adapterFor: (HostingAdapter & HetznerPoolAdapter) | null) => {
      try { await holds(fence); } catch (e) { throw markNotSent(e); }
      const g = fenceGuard(fence);
      const done = await fencePoolRow(env, pool, reason, false, adapterFor, now(), g);
      if (!done) { try { await holds(fence); } catch (e) { throw markNotSent(e); } }
    };
    try { detail = await hz.getServerDetail(serverNative, input.signal); }
    catch (e) {
      if (e instanceof HostError && e.status === 404) { await fenceRow("claim_server_gone", null); return null; }
      throw markNotSent(e);
    }
    // "Server running" seen by an attempt that no longer holds the lease (another attempt booted it) must never quarantine it.
    if (detail.status !== "off") { await fenceRow("claim_server_not_off", hz); return null; }
    // Before the relabel: the server must run the image the pool row and the stored choice name, and that image must verify.
    if (!await poolImageOk(detail, pool.image_id, pool.arch as "x86" | "arm", choiceImage)) { await fenceRow("claim_image_mismatch", hz); return null; }
    try { input.signal?.throwIfAborted(); await holds(fence); } catch (e) { throw markNotSent(e); }
    // Relabel (step 2): from here the home's recovery, listing, fencing and cleanup see the server through its labels.
    try { await owned(pool.id, input.homeId, input.resourceGeneration, "phase=?", [relabelPhase(now())], fence); } // lost ownership or lease: no provider call
    catch (e) { throw markNotSent(e); }
    await relabelClaim(hz, adapter, serverNative, input.homeId, input.resourceGeneration, input.idempotencyKey, labels, input.signal);
    try {
      await finishPoolClaim(hz, { poolId: pool.id, homeId: input.homeId, generation: input.resourceGeneration, serverNative, volumeNative: route(input.volume.id).native, signal: input.signal, fence, image: pool.image_id, arch: pool.arch as "x86" | "arm" });
    } catch (e) { throw markNotAnAnswer(e); } // the server exists and is labelled: this error is no answer to the create
    return resource("hetzner", await adapter.getServer(serverNative), input.homeId, input.resourceGeneration, "home");
  }

  return {
    async create_volume(input: CreateVolumeInput) {
      // Astra MAILRETRY-16 P1: everything before the POST is "not sent"; the POST's refusal is its answer; nothing else settles the call.
      const labels: Labels = { homeId: input.homeId, generation: input.resourceGeneration, role: "volume", call: input.idempotencyKey };
      let pre: { adapter: HostingAdapter; choice: NonNullable<Awaited<ReturnType<typeof choiceFor>>>; existing?: NativeVolume; plan: string };
      try {
        pre = await prepareVolume(input);
        input.signal?.throwIfAborted();
      } catch (e) { throw markNotSent(e); }
      const { adapter, choice, existing, plan } = pre;
      let native: NativeVolume;
      try {
        native = existing ?? await adapter.createVolume({ name: `mcq-${input.homeId}-${input.resourceGeneration}-vol`.slice(0, 60),
          sizeGb: config.volumeGb[plan] ?? 50, location: choice.location, labels, signal: input.signal });
      } catch (e) { throw answerOf(e); }
      scope.set(toId(choice.provider, "volume", native.id), { homeId: input.homeId, generation: input.resourceGeneration });
      return descriptor(choice.provider, native, input.homeId, input.resourceGeneration);
    },
    async create(input: CreateHomeInput) {
      const labels: Labels = { homeId: input.homeId, generation: input.resourceGeneration, role: "home", call: input.idempotencyKey };
      let pre: { adapter: HostingAdapter; choice: NonNullable<Awaited<ReturnType<typeof choiceFor>>>; existing?: NativeServer; userData: string; volumeNative: string;
        pool: PoolRow | null; verified: VerifiedImage | null };
      try {
        pre = await prepareServer(input);
        if (!pre.existing) input.signal?.throwIfAborted(); // past the ledger's deadline: never sent
      } catch (e) { throw markNotSent(e); }
      const { adapter, choice, existing, userData, volumeNative, pool, verified } = pre;
      if (existing) {
        try { await reclaimPooled(adapter, existing.id, { homeId: input.homeId, generation: input.resourceGeneration }, input.fence, input.signal); }
        catch (e) { throw markNotAnAnswer(e); }
        return resource(choice.provider, existing, input.homeId, input.resourceGeneration, "home");
      }
      if (pool) {
        const pooled = await createFromPool(input, adapter, pool, labels, choice.image);
        if (pooled) return pooled;
      }
      const rungs: { serverType: string; arch: "x86" | "arm"; image: string; verified?: VerifiedImage }[] = [{ serverType: choice.server_type, arch: choice.arch, image: choice.image, verified: verified ?? undefined }];
      const refused: LadderAttempt[] = [];
      let tooBigRaised = false;
      let sent = 0; // the rung whose create was last sent
      const pinRung = (i: number) => db.prepare("UPDATE provision_choices SET server_type=?,arch=?,image=?,tried=? WHERE home_id=? AND resource_generation=?")
        .bind(rungs[i].serverType, rungs[i].arch, rungs[i].image, JSON.stringify(refused), input.homeId, input.resourceGeneration).run();
      try {
        for (let i = 0; i < rungs.length; i++) {
          const rung = rungs[i];
          sent = i;
          try {
            // The first rung was verified in prepareServer; another rung's image is verified here, and a refusal skips that rung only.
            let image = rung.verified;
            if (!image) {
              try { image = await verify({ provider: choice.provider, image: rung.image, arch: rung.arch }); }
              catch (v) {
                if (!(v instanceof ImageRefused)) throw v;
                refused.push({ provider: choice.provider, serverType: rung.serverType, arch: rung.arch, result: `image_refused:${v.code}` });
                continue;
              }
            }
            const created = await adapter.createServer({ name: `mcq-${input.homeId}-${input.resourceGeneration}`.slice(0, 60),
              serverType: rung.serverType, location: choice.location, image, userData, labels,
              volumeId: choice.provider === "hetzner" ? volumeNative : null, signal: input.signal });
            if (i > 0) await pinRung(i);
            return resource(choice.provider, created, input.homeId, input.resourceGeneration, "home");
          } catch (e) {
            const tooBig = imageTooBigRefusal(e);
            if (!(isAnswered(answerOf(e)) && (stockRefusal(e) || tooBig))) throw e;
            // A stock refusal closes this rung for this attempt only: the other rungs of the plan's ladder are tried at the same place (the
            // home's volume is already there). The pinned choice is changed only by a create that succeeds.
            refused.push({ provider: choice.provider, serverType: rung.serverType, arch: rung.arch, result: tooBig ? "image_too_big" : "no_stock" });
            if (tooBig && !tooBigRaised) { tooBigRaised = true; await raiseImageTooBig(env, [{ image: rung.image, serverType: rung.serverType }], now()); }
            if (i === 0) rungs.push(...await otherRungs(choice, input.homeId));
          }
        }
        // Every rung refused for stock: the customer's wait for capacity, never the provider's raw refusal.
        throw markAnswered(new Error("no_capacity"));
      } catch (e) {
        if (e instanceof Error && e.message === "no_capacity") throw e;
        if (isAnswered(answerOf(e))) throw e; // refused: nothing was created
        // Unanswered (lost response, abort, 5xx, a step after the create): adopt ONLY the server labelled with THIS call's key. A listing
        // error never stands in for the create's answer: the original (unanswered) error is thrown.
        let again: NativeServer | undefined;
        try { again = (await adapter.findServers(labels)).find((s) => s.callKey === input.idempotencyKey); } catch { throw e; }
        if (again) {
          if (sent > 0) await pinRung(sent);
          return resource(choice.provider, again, input.homeId, input.resourceGeneration, "home");
        }
        throw e;
      }
    },
    async list_by_tag(homeId, generation, role) {
      const choice = await choiceFor(homeId, generation);
      if (!choice) return [];
      const adapter = need(choice.provider);
      const labels = { homeId, generation };
      if (role === "home") return (await adapter.findServers(labels)).map((s) => resource(choice.provider, s, homeId, generation, "home"));
      return (await adapter.findVolumes(labels)).map((v) => {
        scope.set(toId(choice.provider, "volume", v.id), { homeId, generation });
        // Astra INTEGRATED-8 P2: the late volume carries its create call's key; dropping it left the call unsettled after cleanup.
        return resource(choice.provider, { id: v.id, state: v.serverId ? "attached" : "detached", ips: [], callKey: v.callKey ?? null }, homeId, generation, "volume");
      });
    },
    async public_ips(id) { const r = homeOf(id); return (await need(r.provider).getServer(r.native)).ips; },
    async start(id) { const r = homeOf(id); await refuseUnenrolledPool(r); return { actionId: (await need(r.provider).power(r.native, true)) ?? null }; },
    async stop(id) { const r = homeOf(id); await need(r.provider).power(r.native, false); },
    async power_off(id) { const r = homeOf(id); await need(r.provider).power(r.native, false); },
    async reboot(id) {
      const r = homeOf(id); if (r.role !== "home") throw new Error("provider_identity_conflict");
      await refuseUnenrolledPool(r);
      return { actionId: (await need(r.provider).reboot(r.native)) ?? null };
    },
    async power_action_status(id, action, actionId) {
      const r = homeOf(id); const adapter = need(r.provider);
      if (!adapter.powerActionStatus) throw new Error("provider_power_status_unavailable");
      return adapter.powerActionStatus(r.native, action, actionId);
    },
    async server_up(id) { const r = homeOf(id); return (await need(r.provider).getServer(r.native)).state === "running"; },
    async fence_network(id, _relayIP) { const r = homeOf(id); await need(r.provider).quarantine(r.native); },
    async destroy(id, signal) {
      const r = homeOf(id);
      signal?.throwIfAborted();
      if (r.role === "home") await need(r.provider).destroyServer(r.native, signal); else await need(r.provider).destroyVolume(r.native, signal);
    },
    async server_exists(id) {
      const r = homeOf(id); if (r.role !== "home") throw new Error("provider_identity_conflict");
      try { await need(r.provider).getServer(r.native); return true; }
      catch (e) { if (e instanceof HostError && e.status === 404) return false; throw e; }
    },
    wants_backup_password: () => (config.storageBox ?? []).length > 0,
    async volume(id) {
      const r = homeOf(id);
      const native = await need(r.provider).getVolume(r.native);
      const owner = scope.get(id) ?? await ownerOfVolume(db, r.provider, native);
      return descriptor(r.provider, native, owner.homeId, owner.generation);
    },
    async attach_volume(volumeId, serverId, fence) {
      const v = homeOf(volumeId); const s = homeOf(serverId);
      if (v.provider !== s.provider) throw new Error("provider_attachment_conflict");
      const adapter = need(v.provider);
      if (v.provider === "hetzner") await reclaimPooled(adapter, s.native, null, fence);
      const current = await adapter.getVolume(v.native);
      if (current.serverId !== s.native) {
        if (current.serverId !== null) throw new Error("provider_attachment_conflict");
        await adapter.attachVolume(v.native, s.native);
      }
      // A claimed pool server whose claim was interrupted after the relabel (a retry finds it by label and never calls create again) is
      // finished here, after its volume is attached and while it is still off.
      if (config.pool && v.provider === "hetzner" && isPoolAdapter(adapter)) {
        const claimed = await db.prepare("SELECT * FROM warm_pool WHERE provider='hetzner' AND server_id=? AND state='claimed' AND phase IS NOT NULL")
          .bind(s.native).first<PoolRow>();
        if (claimed?.home_id && claimed.resource_generation !== null) await finishPoolClaim(adapter, { poolId: claimed.id, homeId: claimed.home_id!, generation: claimed.resource_generation!, serverNative: s.native, volumeNative: v.native, fence, image: claimed.image_id, arch: claimed.arch as "x86" | "arm" });
      }
      return this.volume(volumeId);
    },
    async detach_volume(volumeId, serverId) {
      const v = homeOf(volumeId); const s = homeOf(serverId);
      const adapter = need(v.provider);
      const current = await adapter.getVolume(v.native);
      if (current.serverId !== null && current.serverId !== s.native) throw new Error("provider_attachment_conflict");
      if (current.serverId !== null) await adapter.detachVolume(v.native);
      return this.volume(volumeId);
    },
    async snapshot_home(homeId, generation) {
      if (!config.snapshotAtSuspension) return;
      const choice = await choiceFor(homeId, generation);
      if (!choice) return;
      const adapter = need(choice.provider);
      const labels = { homeId, generation };
      if ((await adapter.listSnapshots(labels)).length) return;
      const server = (await adapter.findServers(labels))[0];
      if (!server) return;
      const { ref, actionId: snapshotAction } = await adapter.snapshotServer(server.id, { ...labels, role: "snapshot" });
      await recordOwnProviderAction(db, { homeId, generation, actionId: snapshotAction, kind: "provider_snapshot", actor: "system",
        reason: "snapshot of the server taken at the hosting company" });
      // Honest receipt: a provider snapshot covers the root disk only. Neither build host nor Vultr snapshots attached volumes.
      await db.prepare(`INSERT INTO volume_snapshots (home_id,resource_generation,kind,ref,covers_volume,created_at) VALUES (?,?,?,?,0,?)
        ON CONFLICT(home_id,resource_generation) DO NOTHING`).bind(homeId, generation, "server_snapshot", `${choice.provider}:${ref}`, now()).run();
    },
    async purge_snapshots(homeId, generation, signal) {
      // Astra MAILRETRY-16 P3: every provider call of the purge (snapshot listing and deletion, the Storage Box purge) carries the caller's
      // bound; an aborted purge throws, so it is never recorded done.
      const choice = await choiceFor(homeId, generation);
      if (choice) {
        const adapter = need(choice.provider);
        for (const id of await adapter.listSnapshots({ homeId, generation }, signal)) { signal?.throwIfAborted(); await adapter.deleteSnapshot(id, signal); }
        // Verify, so nothing survives: a leftover is a failure that reconcile retries.
        if ((await adapter.listSnapshots({ homeId, generation }, signal)).length) throw new Error("snapshot_purge_incomplete");
      }
      await db.prepare("DELETE FROM volume_snapshots WHERE home_id=? AND resource_generation=?").bind(homeId, generation).run();
      // The home's backups are deleted with it, in the same step: nothing is kept after day 14. Astra MAILRETRY-16 P2-a: keyed to the
      // sub-accounts that EXIST on every configured box for this home and generation (looked up by their deterministic directory), not
      // only to our records, and verified absent afterwards.
      const all = slots();
      if (all.length) await purgeBackup(db, (boxId) => {
        const slot = all.find((x) => x.config.id === boxId);
        if (!slot) throw new Error("storage_box_unconfigured");
        return slot.box;
      }, homeId, generation, now(), { signal, boxes: all.map((x) => ({ id: x.config.id, box: x.box })) });
    },
  };
}

/** A volume id read back after a restart: find which home it belongs to through the recorded choices and labels. */
async function ownerOfVolume(db: D1Database, provider: "hetzner" | "vultr", native: NativeVolume): Promise<{ homeId: string; generation: number }> {
  const rows = await db.prepare("SELECT home_id,resource_generation FROM cloud_provision_intents WHERE volume_id IN (?,?)")
    .bind(native.id, prefix[provider].volume + native.id).all<{ home_id: string; resource_generation: number }>();
  if (rows.results.length !== 1) throw new Error("provider_volume_conflict");
  return { homeId: rows.results[0].home_id, generation: rows.results[0].resource_generation };
}
export type { LadderRung };
