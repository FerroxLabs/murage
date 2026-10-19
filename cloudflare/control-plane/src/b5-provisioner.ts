// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 provisioner: one HostingAdapter interface, a real build host adapter and a Vultr adapter,
// the plan ladder with live stock checks, and the ProviderAdapter the frozen B3 lifecycle drives in live mode.
import { persistAlert } from "./ops-monitor";
import { ladderFor, provisionerConfig, type LadderRung, type ProvisionerConfig } from "./b5-config";
import type { CreateHomeInput, CreateVolumeInput, PowerStatus, ProviderAdapter, ProviderResource, ResourceRole, VolumeDescriptor } from "./b3-provider";
import { validateVolume } from "./b3-provider";
import { BOX_SOFT_LIMIT, hetznerStorageBox, pickBox, prepareBackup, purgeBackup, type BackupDeps, type BoxSlot, type StorageBoxAdapter } from "./b5-backup";
import { isAnswered, markAnswered, markNotSent, refusalStatus } from "./dispatch-ledger";

export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>;
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
  /** `signal` (round 11, Astra MAILRETRY-15): every create and destroy request is bound by its caller's deadline (fetch aborted). */
  createVolume(i: { name: string; sizeGb: number; location: string; labels: Labels; signal?: AbortSignal }): Promise<NativeVolume>;
  createServer(i: { name: string; serverType: string; location: string; image: string; userData: string;
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
  quarantine(serverId: string): Promise<void>;
  destroyServer(id: string, signal?: AbortSignal): Promise<void>;
  destroyVolume(id: string, signal?: AbortSignal): Promise<void>;
  snapshotServer(serverId: string, labels: Labels): Promise<string>;
  /** Round 12: every page (a listing that cannot be read whole throws). `signal`: the caller's bound (the cleanup claim's lease). */
  listSnapshots(labels: Omit<Labels, "role">, signal?: AbortSignal): Promise<string[]>;
  deleteSnapshot(id: string, signal?: AbortSignal): Promise<void>;
}

interface HzAction { id: number; command: string; status: string; started: string }
interface HzActionAnswer { action?: HzAction }
const actionId = (r: HzActionAnswer) => (r.action?.id !== undefined ? String(r.action.id) : null);
const hzStatus = (status: string): PowerStatus => status === "success" ? "success" : status === "error" ? "error" : "running";

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

interface HzServer { id: number; status: string; labels?: Record<string, string>; public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null } }
interface HzVolume { id: number; server: number | null; location: { name: string }; labels?: Record<string, string> }
interface HzPage { meta?: { pagination?: { next_page?: number | null } } }
export function hetznerAdapter(token: string, config: Pick<ProvisionerConfig, "sshKeyIds" | "firewallIds"> & { quarantineFirewallId?: number },
  fetcher: HostFetch = fetch): HostingAdapter {
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
  return {
    provider: "hetzner",
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
      const r = await call<{ server: HzServer }>("POST", "/servers", { name: i.name, server_type: i.serverType, location: i.location,
        image: /^\d+$/.test(i.image) ? Number(i.image) : i.image, user_data: i.userData, labels: labelsOf(i.labels),
        volumes: i.volumeId ? [Number(i.volumeId)] : [], automount: false, ssh_keys: config.sshKeyIds,
        firewalls: config.firewallIds.map((id) => ({ firewall: id })), public_net: { enable_ipv4: true, enable_ipv6: false },
        start_after_create: true }, false, i.signal);
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
    async quarantine(s) {
      if (!config.quarantineFirewallId) throw new Error("quarantine_firewall_missing");
      try {
        await call("POST", `/firewalls/${config.quarantineFirewallId}/actions/apply_to_resources`, { apply_to: [{ type: "server", server: { id: Number(s) } }] });
      } catch (e) {
        // Fencing runs on every reconcile of a suspended home; an already quarantined server is the goal state, not a failure.
        if (!(e instanceof HostError && e.code === "firewall_already_applied")) throw e;
      }
    },
    async destroyServer(id, signal) { await call("DELETE", `/servers/${Number(id)}`, undefined, true, signal); },
    async destroyVolume(id, signal) { await call("DELETE", `/volumes/${Number(id)}`, undefined, true, signal); },
    async snapshotServer(s, l) {
      const r = await call<{ image: { id: number } }>("POST", `/servers/${Number(s)}/actions/create_image`,
        { type: "snapshot", description: `murage-${l.homeId}-${l.generation}`, labels: labelsOf(l) });
      return String(r.image.id);
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
      if (!config.vultr) throw markNotSent(new Error("vultr_firewall_missing")); // never create an unfirewalled home
      const r = await call<{ instance: VuInstance }>("POST", "/instances", { sshkey_id: config.vultr.sshKeyIds,
        firewall_group_id: config.vultr.firewallGroupId, region: i.location, plan: i.serverType,
        snapshot_id: i.image, label: i.name, hostname: i.name.slice(0, 63),
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
      return r.snapshot.id;
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
export interface LadderAttempt { provider: string; serverType: string; arch: string; result: "chosen" | "no_stock" | "no_image" | "no_vultr_config" | "error" }

/** Walk the rungs in order. First rung with stock (and a configured image) wins. */
export async function chooseRung(config: ProvisionerConfig, plan: string, adapters: Record<"hetzner" | "vultr", HostingAdapter | null>):
  Promise<{ choice: LadderChoice; tried: LadderAttempt[] }> {
  const tried: LadderAttempt[] = [];
  for (const rung of ladderFor(config, plan)) {
    const image = rung.provider === "hetzner" ? config.images.hetzner[rung.arch] : rung.arch === "x86" ? config.images.vultr.x86 : undefined;
    const attempt = { provider: rung.provider, serverType: rung.serverType, arch: rung.arch };
    if (!image) { tried.push({ ...attempt, result: "no_image" }); continue; }
    if (rung.provider === "vultr" && !config.vultr) { tried.push({ ...attempt, result: "no_vultr_config" }); continue; }
    const adapter = adapters[rung.provider];
    if (!adapter) { tried.push({ ...attempt, result: "error" }); continue; }
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
  throw new Error("no_capacity");
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

export interface LiveDeps { fetch?: HostFetch; now?: () => number; adapters?: Record<"hetzner" | "vultr", HostingAdapter | null>;
  /** One adapter for every configured box, or one per box id (tests). */
  storageBox?: StorageBoxAdapter | Record<number, StorageBoxAdapter>;
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
    hetzner: env.HCLOUD_TOKEN ? hetznerAdapter(env.HCLOUD_TOKEN, { ...config, quarantineFirewallId: config.quarantineFirewallId }, deps.fetch) : null,
    vultr: env.VULTR_API_KEY ? vultrAdapter(env.VULTR_API_KEY, config, deps.fetch) : null,
  };
  const need = (p: "hetzner" | "vultr") => adapters[p] ?? (() => { throw new Error("provider_unconfigured"); })();
  const now = deps.now ?? Date.now;
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

  async function choiceFor(homeId: string, gen: number) {
    return db.prepare("SELECT * FROM provision_choices WHERE home_id=? AND resource_generation=?").bind(homeId, gen)
      .first<{ provider: "hetzner" | "vultr"; server_type: string; location: string; arch: "x86" | "arm"; image: string }>();
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
  /** Everything create_volume does before its POST (the rung choice, the label lookup, the plan): errors here mean "not sent". */
  async function prepareVolume(input: CreateVolumeInput) {
    let choice = await choiceFor(input.homeId, input.resourceGeneration);
    if (!choice) {
      const { choice: picked, tried } = await chooseRung(config, await planOf(input.homeId), adapters);
      await db.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(home_id,resource_generation) DO NOTHING`)
        .bind(input.homeId, input.resourceGeneration, picked.provider, picked.serverType, picked.location, picked.arch, picked.image,
          JSON.stringify(tried), now()).run();
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
    const choice = await choiceFor(input.homeId, input.resourceGeneration);
    if (!choice) throw new Error("provision_choice_missing");
    const adapter = need(choice.provider);
    const existing = (await adapter.findServers({ homeId: input.homeId, generation: input.resourceGeneration }))[0];
    if (existing) return { adapter, choice, existing, userData: "", volumeNative: "" };
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
    return { adapter, choice, existing: undefined, userData, volumeNative: route(input.volume.id).native };
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
      let pre: { adapter: HostingAdapter; choice: NonNullable<Awaited<ReturnType<typeof choiceFor>>>; existing?: NativeServer; userData: string; volumeNative: string };
      try {
        pre = await prepareServer(input);
        if (!pre.existing) input.signal?.throwIfAborted(); // past the ledger's deadline: never sent
      } catch (e) { throw markNotSent(e); }
      const { adapter, choice, existing, userData, volumeNative } = pre;
      if (existing) return resource(choice.provider, existing, input.homeId, input.resourceGeneration, "home");
      try {
        const created = await adapter.createServer({ name: `mcq-${input.homeId}-${input.resourceGeneration}`.slice(0, 60),
          serverType: choice.server_type, location: choice.location, image: choice.image, userData, labels,
          volumeId: choice.provider === "hetzner" ? volumeNative : null, signal: input.signal });
        return resource(choice.provider, created, input.homeId, input.resourceGeneration, "home");
      } catch (e) {
        if (isAnswered(answerOf(e))) throw e; // refused: nothing was created
        // Unanswered (lost response, abort, 5xx, a step after the create): adopt ONLY the server labelled with THIS call's key. A listing
        // error never stands in for the create's answer: the original (unanswered) error is thrown.
        let again: NativeServer | undefined;
        try { again = (await adapter.findServers(labels)).find((s) => s.callKey === input.idempotencyKey); } catch { throw e; }
        if (again) return resource(choice.provider, again, input.homeId, input.resourceGeneration, "home");
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
    async start(id) { const r = homeOf(id); return { actionId: (await need(r.provider).power(r.native, true)) ?? null }; },
    async stop(id) { const r = homeOf(id); await need(r.provider).power(r.native, false); },
    async power_off(id) { const r = homeOf(id); await need(r.provider).power(r.native, false); },
    async reboot(id) {
      const r = homeOf(id); if (r.role !== "home") throw new Error("provider_identity_conflict");
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
    wants_backup_password: () => (config.storageBox ?? []).length > 0,
    async volume(id) {
      const r = homeOf(id);
      const native = await need(r.provider).getVolume(r.native);
      const owner = scope.get(id) ?? await ownerOfVolume(db, r.provider, native);
      return descriptor(r.provider, native, owner.homeId, owner.generation);
    },
    async attach_volume(volumeId, serverId) {
      const v = homeOf(volumeId); const s = homeOf(serverId);
      if (v.provider !== s.provider) throw new Error("provider_attachment_conflict");
      const adapter = need(v.provider);
      const current = await adapter.getVolume(v.native);
      if (current.serverId !== s.native) {
        if (current.serverId !== null) throw new Error("provider_attachment_conflict");
        await adapter.attachVolume(v.native, s.native);
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
      const ref = await adapter.snapshotServer(server.id, { ...labels, role: "snapshot" });
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
