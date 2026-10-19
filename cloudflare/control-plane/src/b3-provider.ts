// SPDX-License-Identifier: AGPL-3.0-or-later
// Persisted fake protocol only: no transport, HTTP factory or live-mode fallback.
import { z } from "zod";
export type ResourceRole = "home" | "volume";
export interface ProviderResource {
  id: string; home_id: string; generation: number; role: string; state: string;
  public_ips: string; quarantined: number;
  /** Round 12 (Astra MAILRETRY-16 P1): the key of the create call that made this resource (its label), when the provider shows one. Recovery
   *  after an unanswered create adopts only a resource carrying that call's own key. */
  idempotency_key?: string | null;
}
export interface VolumeDescriptor {
  provider: "hetzner" | "vultr"; id: string; homeId: string; resourceGeneration: number;
  device: string; serial: string; new: boolean;
  attachment: { serverId: string | null; state: "detached" | "attaching" | "attached" };
}
export interface CreateVolumeInput {
  homeId: string; resourceGeneration: number; idempotencyKey: string; provider: VolumeDescriptor["provider"];
  /** Round 11 (Astra MAILRETRY-15 P1-1): bounds the provider call to the resource ledger's expectation; aborted means unsettled. */
  signal?: AbortSignal;
}
export interface CreateHomeInput {
  homeId: string; resourceGeneration: number; idempotencyKey: string; type: string; location: string;
  image: string; labels: { homeId: string; resourceGeneration: string; role: "home" };
  userData: { machineId: string; enrollmentToken: string; controlPlaneOrigin: string; generation: number;
    volume: { provider: VolumeDescriptor["provider"]; id: string; device: string; new: boolean; generation: number; homeId: string } };
  volume: VolumeDescriptor;
  /** Round 11 (Astra MAILRETRY-15 P1-1): bounds the provider call to the resource ledger's expectation; aborted means unsettled. */
  signal?: AbortSignal;
  /** Round 11 (Astra MAILRETRY-15 P1-2): the restic password of THIS attempt, derived from its own key material read BEFORE the dispatch
   *  fence and never re-read after it (a reopen deletes that key material in the batch that moves the generation on). An adapter with
   *  backups uses this value only and fails closed without it. */
  backup?: { resticPassword: string };
}
/** A provider power call's identity: the provider's action id, which its terminal status is later confirmed by. */
export interface PowerReceipt { actionId: string | null }
export type PowerStatus = "running" | "success" | "error" | "none";
export interface ProviderAdapter {
  create(input: CreateHomeInput): Promise<ProviderResource>;
  list_by_tag(homeId: string, generation: number, role: ResourceRole): Promise<ProviderResource[]>;
  public_ips(id: string): Promise<string[]>;
  start(id: string): Promise<void | PowerReceipt>;
  stop(id: string): Promise<void>;
  fence_network(id: string, relayIP: string): Promise<void>;
  power_off(id: string): Promise<void>;
  /** Power-cycles a home server (customer reboot and the watchdog). Optional: an adapter without it cannot reboot. */
  reboot?(id: string): Promise<void | PowerReceipt>;
  /** The provider's own record of this power call, by the action id its answer carried (the only correlated receipt). "none": no
   *  such action. Optional: without it no reservation is ever completed by the provider's word. */
  power_action_status?(id: string, action: "reboot" | "start", actionId: string): Promise<PowerStatus>;
  /** Whether the server is up now (build host status running; Vultr power_status running and server_status ok). Optional. */
  server_up?(id: string): Promise<boolean>;
  /** `signal`: the caller's bound (the cleanup claim's lease): an in-flight destroy is aborted before the claim could be taken over. */
  destroy(id: string, signal?: AbortSignal): Promise<void>;
  /** Round 11 (Astra MAILRETRY-15 P1-2): true when create() needs CreateHomeInput.backup (backups configured). Optional: false. */
  wants_backup_password?(): boolean;
  create_volume(input: CreateVolumeInput): Promise<VolumeDescriptor>;
  volume(id: string): Promise<VolumeDescriptor>;
  attach_volume(volumeId: string, serverId: string): Promise<VolumeDescriptor>;
  detach_volume(volumeId: string, serverId: string): Promise<VolumeDescriptor>;
  /** Optional (live only). Called while a home is suspended; idempotent. Snapshots exist only for the retention window. */
  snapshot_home?(homeId: string, resourceGeneration: number): Promise<void>;
  /** Optional (live only). Deletes every snapshot, backup and archive of the home at day 14; nothing is kept. Idempotent. */
  purge_snapshots?(homeId: string, resourceGeneration: number, signal?: AbortSignal): Promise<void>;
}
const id = z.string().regex(/^[\w-]{1,128}$/);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const volumeSchema = z.object({ provider: z.enum(["hetzner", "vultr"]), id, homeId: id,
  resourceGeneration: generation, device: z.string(), serial: id, new: z.boolean(),
  attachment: z.object({ serverId: id.nullable(), state: z.enum(["detached", "attaching", "attached"]) }).strict(),
}).strict();
export function validateVolume(value: VolumeDescriptor, homeId: string, resourceGeneration: number): VolumeDescriptor {
  const v = volumeSchema.parse(value);
  const expected = v.provider === "hetzner" ? `/dev/disk/by-id/scsi-0HC_Volume_${v.id}` : `/dev/disk/by-id/virtio-${v.serial}`;
  if (v.homeId !== homeId || v.resourceGeneration !== resourceGeneration || v.device !== expected
    || (v.provider === "hetzner" && v.serial !== `0HC_Volume_${v.id}`)
    || ((v.attachment.state === "detached") !== (v.attachment.serverId === null))) {
    throw new Error("provider_volume_conflict");
  }
  return v;
}
interface FakeResource extends ProviderResource { provider: VolumeDescriptor["provider"]; serial: string | null; attachment_server_id: string | null; last_attachment_server_id: string | null; }
export function fakeProvider(db: D1Database): ProviderAdapter {
  async function find(id: string) {
    const row = await db.prepare("SELECT * FROM cloud_fake_resources WHERE id=?").bind(id).first<FakeResource>();
    if (!row) throw new Error("fake_resource_missing");
    return row;
  }
  async function createResource(homeId: string, gen: number, key: string, role: ResourceRole, provider: VolumeDescriptor["provider"]) {
    id.parse(homeId); generation.parse(gen);
    const resourceId = `fake-${role}-${homeId}-${gen}`;
    const serial = provider === "hetzner" ? `0HC_Volume_${resourceId}` : `fixture-${homeId}-${gen}`;
    await db.prepare(`INSERT INTO cloud_fake_resources
      (id,home_id,generation,role,state,public_ips,idempotency_key,provider,serial)
      VALUES (?,?,?,?,?,?,?, ?,?) ON CONFLICT(home_id,generation,role) DO NOTHING`)
      .bind(resourceId, homeId, gen, role, role === "home" ? "running" : "detached",
        JSON.stringify(role === "home" ? ["203.0.113.10", "2001:db8::10"] : []), key, provider, role === "volume" ? serial : null).run();
    const row = await find(resourceId);
    if (row.provider !== provider || row.state === "destroyed") throw new Error("provider_identity_conflict");
    return row;
  }
  async function volume(volumeId: string): Promise<VolumeDescriptor> {
    const row = await find(volumeId);
    if (row.role !== "volume" || !row.serial || row.state === "destroyed") throw new Error("provider_volume_conflict");
    return validateVolume({ provider: row.provider, id: row.id, homeId: row.home_id, resourceGeneration: row.generation,
      serial: row.serial, device: row.provider === "hetzner" ? `/dev/disk/by-id/scsi-0HC_Volume_${row.id}` : `/dev/disk/by-id/virtio-${row.serial}`,
      new: true, attachment: { serverId: row.attachment_server_id,
        state: row.state === "attached" ? "attached" : row.state === "attaching" ? "attaching" : "detached" } }, row.home_id, row.generation);
  }
  async function state(resourceId: string, value: string) {
    await find(resourceId);
    await db.prepare("UPDATE cloud_fake_resources SET state=? WHERE id=?").bind(value, resourceId).run();
  }
  return {
    async create(input) {
      const v = validateVolume(input.volume, input.homeId, input.resourceGeneration);
      const boot = input.userData.volume;
      if (!/^[\w-]{1,64}$/.test(input.type) || !/^[\w-]{1,64}$/.test(input.location)
        || !/^sha256:[0-9a-f]{64}$/.test(input.image) || input.labels.homeId !== input.homeId
        || input.labels.resourceGeneration !== String(input.resourceGeneration) || input.labels.role !== "home"
        || input.userData.machineId !== input.homeId || !input.userData.enrollmentToken
        || input.userData.generation < 1 || !Number.isSafeInteger(input.userData.generation)
        || boot.provider !== v.provider || boot.id !== v.id || boot.device !== v.device || boot.new !== v.new
        || boot.homeId !== input.homeId || boot.generation !== input.userData.generation) throw new Error("provider_create_invalid");
      const origin = new URL(input.userData.controlPlaneOrigin);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("provider_create_invalid");
      }
      // userData is delivered only in memory, never recorded by the fake.
      const resource = await createResource(input.homeId, input.resourceGeneration, input.idempotencyKey, "home", v.provider);
      // Initial attachment strategy, explicit completed exact pair.
      await this.attach_volume(v.id, resource.id);
      return resource;
    },
    async list_by_tag(homeId, gen, role) {
      return (await db.prepare(`SELECT * FROM cloud_fake_resources
        WHERE home_id=? AND generation=? AND role=? AND state<>'destroyed'`)
        .bind(homeId, gen, role).all<ProviderResource>()).results;
    },
    async public_ips(resourceId) { return JSON.parse((await find(resourceId)).public_ips) as string[]; },
    start: (resourceId) => state(resourceId, "running"), stop: (resourceId) => state(resourceId, "stopped"),
    async fence_network(resourceId, relayIP) {
      await find(resourceId);
      await db.prepare("UPDATE cloud_fake_resources SET quarantined=1,quarantine_relay_ip=? WHERE id=?").bind(relayIP, resourceId).run();
    },
    power_off: (resourceId) => state(resourceId, "powered_off"), destroy: (resourceId) => state(resourceId, "destroyed"),
    reboot: (resourceId) => state(resourceId, "running"),
    // The fake executes power actions at once: each is confirmed done.
    async power_action_status() { return "success" as const; },
    async server_up(resourceId) { return (await find(resourceId)).state === "running"; },
    async create_volume(input) {
      const row = await createResource(input.homeId, input.resourceGeneration, input.idempotencyKey, "volume", input.provider);
      return volume(row.id);
    },
    volume,
    async attach_volume(volumeId, serverId) {
      const v = await volume(volumeId); const server = await find(serverId); const original = await find(volumeId);
      if (server.role !== "home" || server.state === "destroyed" || server.home_id !== v.homeId
        || server.generation !== v.resourceGeneration || server.provider !== v.provider
        || (v.attachment.serverId !== null && v.attachment.serverId !== serverId)
        || (original.last_attachment_server_id !== null && original.last_attachment_server_id !== serverId)) throw new Error("provider_attachment_conflict");
      const result = await db.prepare(`UPDATE cloud_fake_resources SET state='attached',attachment_server_id=?,last_attachment_server_id=?
        WHERE id=? AND role='volume' AND state<>'destroyed' AND (attachment_server_id IS NULL OR attachment_server_id=?)`)
        .bind(serverId, serverId, volumeId, serverId).run();
      if (result.meta.changes !== 1) throw new Error("provider_attachment_conflict");
      return volume(volumeId);
    },
    async detach_volume(volumeId, serverId) {
      const v = await volume(volumeId);
      if (v.attachment.serverId === null) {
        // Detached idempotency still validates the identical home/generation pair.
        const server = await find(serverId); const original = await find(volumeId);
        if (original.last_attachment_server_id !== serverId || server.role !== "home" || server.home_id !== v.homeId || server.generation !== v.resourceGeneration) throw new Error("provider_attachment_conflict");
        return v;
      }
      if (v.attachment.serverId !== serverId) throw new Error("provider_attachment_conflict");
      const result = await db.prepare(`UPDATE cloud_fake_resources SET state='detached',attachment_server_id=NULL
        WHERE id=? AND attachment_server_id=? AND state<>'destroyed'`).bind(volumeId, serverId).run();
      if (result.meta.changes !== 1) throw new Error("provider_attachment_conflict");
      return volume(volumeId);
    },
  };
}
