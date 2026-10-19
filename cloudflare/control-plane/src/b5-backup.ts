// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 backups (lane 3's design, docs/cloud/b5/BACKUPS.md): one build host Storage Box sub-account per home, restic over SFTP.
// This file creates and destroys the sub-account and produces the four files the home needs; it never stores a secret.
import { generateOpenSshEd25519 } from "./b5-sshkey";
import type { HostFetch } from "./b5-provisioner";
import { isAnswered, markAnswered, recordSubaccountCall, refusalStatus, settleCall } from "./dispatch-ledger";

export interface StorageBoxConfig { id: number; host: string; mainUser: string; knownHosts: string; baseDir: string }
export interface Subaccount { id: string; username: string; server: string; directory: string }

/** The Storage Box API behind one interface so tests and other backends can replace it. */
/** `signal` (round 12, Astra MAILRETRY-16 P3): the caller's bound (the cleanup claim's lease), passed to every request. */
export interface StorageBoxAdapter {
  /** `call`: the ledger call recording this create (round 12), labelled on the sub-account. An error the box gave as its answer to the
   *  create request is marked `providerAnswered`; an error after the box accepted it carries `subaccountId`. */
  createSubaccount(i: { homeId: string; generation: number; password: string; call?: string }): Promise<Subaccount>;
  /** Removes the home's data directory and everything in it. Idempotent. */
  purgeDirectory(directory: string, signal?: AbortSignal): Promise<void>;
  directoryExists(directory: string, signal?: AbortSignal): Promise<boolean>;
  deleteSubaccount(id: string, signal?: AbortSignal): Promise<void>;
  /** Round 12 (Astra MAILRETRY-16 P2-a): the sub-accounts that EXIST on the box for this home and generation (by their deterministic
   *  directory), from a complete listing; throws when it cannot be read whole. Optional: a box without it is purged by our records only. */
  findSubaccounts?(homeId: string, generation: number, signal?: AbortSignal): Promise<{ id: string; directory: string; callKey?: string | null }[]>;
  /** How many sub-accounts the box holds now (a box allows at most 100). */
  countSubaccounts(): Promise<number>;
  /** Streams one file (a customer export archive, already encrypted by the home). Optional: a box without it cannot serve exports. */
  download?(path: string): Promise<Response>;
  /** Creates a directory on the main account (idempotent). With moveDirectory: keeps ready export archives through a home's deletion. */
  makeDirectory?(directory: string): Promise<void>;
  /** Moves a directory on the main account (never overwriting). */
  moveDirectory?(from: string, to: string): Promise<void>;
}

/** A box is used until it holds this many sub-accounts; the rest of the 100 is headroom for retries and leftovers. */
export const BOX_SOFT_LIMIT = 95;
export interface BoxSlot { box: StorageBoxAdapter; config: StorageBoxConfig }
/** First box (in configured order) with room, or null when every box is full. */
export async function pickBox(slots: BoxSlot[]): Promise<BoxSlot | null> {
  for (const slot of slots) if (await slot.box.countSubaccounts() < BOX_SOFT_LIMIT) return slot;
  return null;
}

/** build host Storage Box: sub-accounts through api.hetzner.com, data deletion through WebDAV on the main account
 *  (WebDAV DELETE on a collection is recursive; deleting a sub-account alone leaves its files behind). */
export function hetznerStorageBox(token: string, box: StorageBoxConfig, mainPassword: string, fetcher: HostFetch = fetch): StorageBoxAdapter {
  const api = async (method: string, path: string, body?: unknown, ok404 = false, signal?: AbortSignal) => {
    const r = await fetcher(`https://api.hetzner.com/v1/storage_boxes/${box.id}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
      ...(signal ? { signal } : {}) });
    if (!r.ok && !(ok404 && r.status === 404)) {
      const error = Object.assign(new Error(`storage_box_http_${r.status}`), { status: r.status });
      // Astra MAILRETRY-16 P1: only the create request's own refusal is its answer (a GET error never is).
      throw method === "POST" && path === "/subaccounts" && refusalStatus(r.status) ? markAnswered(error) : error;
    }
    return r.status === 204 || r.status === 404 ? {} : await r.json().catch(() => ({})) as Record<string, any>;
  };
  const dav = (method: string, directory: string, headers: Record<string, string> = {}, signal?: AbortSignal) => fetcher(
    `https://${box.host}/${directory.split("/").map(encodeURIComponent).join("/")}/`,
    { method, headers: { authorization: `Basic ${btoa(`${box.mainUser}:${mainPassword}`)}`, ...headers }, ...(signal ? { signal } : {}) });
  const directoryOf = (homeId: string, generation: number) => `${box.baseDir}/${homeId}-g${generation}`;
  return {
    async createSubaccount(i) {
      const directory = directoryOf(i.homeId, i.generation);
      const r = await api("POST", "/subaccounts", { home_directory: directory, password: i.password,
        description: `murage home ${i.homeId} g${i.generation}`.slice(0, 100),
        labels: { "murage/home": i.homeId, "murage/generation": String(i.generation), ...(i.call ? { "murage/call": i.call } : {}) },
        access_settings: { reachable_externally: true, ssh_enabled: true, samba_enabled: false, webdav_enabled: false, readonly: false } });
      // The live API answers {action, subaccount:{id, storage_box}} at once and creates the account asynchronously: the
      // username is only there once GET /subaccounts/<id> finds it. A sub-account logs in on the box's own host.
      let s = r.subaccount ?? {};
      if (!s.id) throw new Error("storage_box_bad_response");
      const accepted = String(s.id);
      try {
        for (let attempt = 0; !s.username && attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 0 : 1000));
          const found = await api("GET", `/subaccounts/${encodeURIComponent(accepted)}`, undefined, true);
          if (found.subaccount?.username) s = found.subaccount;
        }
        if (!s.username) throw new Error("storage_box_subaccount_pending");
      } catch (e) { throw Object.assign(e as Error, { subaccountId: accepted }); } // the box accepted the create: it exists
      return { id: accepted, username: String(s.username), server: box.host, directory };
    },
    async findSubaccounts(homeId, generation, signal) {
      const directory = directoryOf(homeId, generation);
      const out: { id: string; directory: string; callKey: string | null }[] = [];
      for (let page = 1; page <= 20; page++) {
        const r = await api("GET", `/subaccounts?per_page=100&page=${page}`, undefined, false, signal);
        if (!Array.isArray(r.subaccounts)) throw new Error("storage_box_listing_unreadable");
        for (const sub of r.subaccounts as { id: unknown; home_directory?: unknown; labels?: Record<string, unknown> }[]) {
          // Astra INTEGRATED-8 P2: the create call's own key (its label) comes back with the sub-account, so its discovery settles that call.
          const call = sub.labels?.["murage/call"];
          if (typeof sub.home_directory === "string" && sub.home_directory.replace(/^\/+|\/+$/g, "") === directory) {
            out.push({ id: String(sub.id), directory, callKey: typeof call === "string" && call ? call : null });
          }
        }
        if (!r.meta?.pagination?.next_page) return out;
      }
      throw new Error("storage_box_listing_incomplete");
    },
    async purgeDirectory(directory, signal) {
      const r = await dav("DELETE", directory, {}, signal);
      if (!r.ok && r.status !== 404) throw new Error(`storage_box_purge_${r.status}`);
    },
    async directoryExists(directory, signal) {
      const r = await dav("PROPFIND", directory, { depth: "0" }, signal);
      if (r.status === 404) return false;
      if (r.status === 207 || r.ok) return true;
      throw new Error(`storage_box_probe_${r.status}`);
    },
    async countSubaccounts() {
      const r = await api("GET", "/subaccounts?per_page=100");
      const total = r.meta?.pagination?.total_entries;
      return typeof total === "number" ? total : Array.isArray(r.subaccounts) ? r.subaccounts.length : Number.POSITIVE_INFINITY;
    },
    async deleteSubaccount(id, signal) { await api("DELETE", `/subaccounts/${encodeURIComponent(id)}`, undefined, true, signal); },
    async download(path) {
      const r = await fetcher(`https://${box.host}/${path.split("/").map(encodeURIComponent).join("/")}`,
        { method: "GET", headers: { authorization: `Basic ${btoa(`${box.mainUser}:${mainPassword}`)}` } });
      if (!r.ok || !r.body) throw new Error(`storage_box_download_${r.status}`);
      return r;
    },
    async makeDirectory(directory) {
      const r = await dav("MKCOL", directory);
      if (!r.ok && r.status !== 405) throw new Error(`storage_box_mkcol_${r.status}`); // 405: it exists
    },
    async moveDirectory(from, to) {
      const r = await dav("MOVE", from, { destination: `https://${box.host}/${to.split("/").map(encodeURIComponent).join("/")}/`, overwrite: "F" });
      if (!r.ok) throw new Error(`storage_box_move_${r.status}`);
    },
  };
}

/** Where a deleted home's still-available export archives are kept: beside the homes, outside any home's directory. */
export function retainedExportsDirectory(homeDirectory: string): string {
  const cut = homeDirectory.lastIndexOf("/");
  return `${cut < 0 ? "" : homeDirectory.slice(0, cut + 1)}retained-exports/${homeDirectory.slice(cut + 1)}`;
}
export const isRetainedExports = (directory: string) => /(^|\/)retained-exports\/[^/]+$/.test(directory);

/** Ready export archives still within their promised availability survive the home's deletion: they are moved out of the home's
 *  directory (which the purge deletes whole) into retainedExportsDirectory, and purged by the export sweep at available_until. */
async function retainReadyExports(db: D1Database, box: StorageBoxAdapter, homeId: string, directory: string, now: number, signal?: AbortSignal) {
  const live = await db.prepare(`SELECT DISTINCT archive_id FROM cloud_export_jobs WHERE home_id=? AND directory=? AND state='ready' AND purged_at IS NULL
    AND available_until>? AND archive_id IS NOT NULL`).bind(homeId, directory, now).all<{ archive_id: string }>();
  if (!live.results.length) return;
  if (!box.makeDirectory || !box.moveDirectory) throw new Error("export_retention_unsupported"); // never purge a promised archive
  const kept = retainedExportsDirectory(directory);
  for (const dir of [kept.slice(0, kept.lastIndexOf("/")), kept, `${kept}/exports`]) await box.makeDirectory(dir);
  for (const { archive_id: archive } of live.results) {
    const from = `${directory}/exports/${archive}`;
    const to = `${kept}/exports/${archive}`;
    signal?.throwIfAborted();
    if (await box.directoryExists(from, signal)) await box.moveDirectory(from, to);
    else if (!await box.directoryExists(to, signal)) continue; // nothing there to keep (the archive is already gone)
    await db.prepare("UPDATE cloud_export_jobs SET directory=? WHERE archive_id=? AND directory=?").bind(kept, archive, directory).run();
  }
}

const b64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (c) => String.fromCharCode(c)).join(""));
const randomPassword = () => { const b = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "x") + "Aa1!"; };

export interface BackupFiles { cloudConfig: string }
/** The ledger's expectation of a sub-account create (its deadline_at): the create waits up to 30 s for the username. */
const SUBACCOUNT_CALL_MS = 10 * 60_000;
export interface BackupDeps { box: StorageBoxAdapter; config: StorageBoxConfig; backupPassword(homeId: string): Promise<string> }

/** Creates the home's sub-account (replacing a leftover from a failed earlier attempt, since the secret half is never stored)
 *  and returns the cloud-config fragment that writes backup.json/pass/key/known_hosts and authorizes the key on first boot. */
export async function prepareBackup(db: D1Database, deps: BackupDeps, homeId: string, generation: number, now: number): Promise<string> {
  const leftover = await db.prepare("SELECT subaccount_id,directory FROM backup_subaccounts WHERE home_id=? AND resource_generation=? AND deleted_at IS NULL")
    .bind(homeId, generation).first<{ subaccount_id: string; directory: string }>();
  if (leftover) {
    await deps.box.purgeDirectory(leftover.directory);
    await deps.box.deleteSubaccount(leftover.subaccount_id);
    await db.prepare("UPDATE backup_subaccounts SET deleted_at=? WHERE home_id=? AND resource_generation=?").bind(now, homeId, generation).run();
  }
  const resticPassword = await deps.backupPassword(homeId);
  const password = randomPassword();
  // Round 12 (Astra MAILRETRY-16 P2-a): recorded in the generation's ledger BEFORE it is sent (the ledger re-opens, its purge owed again),
  // settled only by the box's answer to this request (the accepted id, or its refusal); otherwise it stays unsettled and keeps the
  // generation open until a listing after the provider lifetime finds no sub-account for it.
  const callId = await recordSubaccountCall(db, homeId, generation, now, SUBACCOUNT_CALL_MS);
  let sub: Subaccount;
  try {
    sub = await deps.box.createSubaccount({ homeId, generation, password, call: callId });
  } catch (e) {
    const accepted = (e as { subaccountId?: unknown }).subaccountId;
    if (typeof accepted === "string") await settleCall(db, callId, "created", now, `subaccount:${deps.config.id}:${accepted}`);
    else if (isAnswered(e)) await settleCall(db, callId, "failed", now);
    throw e;
  }
  await settleCall(db, callId, "created", now, `subaccount:${deps.config.id}:${sub.id}`);
  await db.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(home_id,resource_generation) DO UPDATE SET subaccount_id=excluded.subaccount_id,
      username=excluded.username,server=excluded.server,directory=excluded.directory,created_at=excluded.created_at,deleted_at=NULL`)
    .bind(homeId, generation, deps.config.id, sub.id, sub.username, sub.server, sub.directory, now).run();
  const key = await generateOpenSshEd25519(`murage-home-${homeId}`);
  const files: [string, string][] = [
    ["/etc/murage-home/backup.json", JSON.stringify({ repository: `sftp://${sub.username}@${sub.server}:23/restic`,
      passwordFile: "/etc/murage-home/backup.pass", sshKey: "/etc/murage-home/backup.key", knownHosts: "/etc/murage-home/backup.known_hosts" })],
    ["/etc/murage-home/backup.pass", resticPassword],
    ["/etc/murage-home/backup.key", key.privateKey],
    ["/etc/murage-home/backup.known_hosts", deps.config.knownHosts.endsWith("\n") ? deps.config.knownHosts : deps.config.knownHosts + "\n"],
    // One-time: installs the public key on the sub-account with its password, then shreds this file.
    ["/etc/murage-home/backup.bootstrap", JSON.stringify({ user: sub.username, host: sub.server, password, publicKey: key.publicKey })],
  ];
  return [...files.flatMap(([path, content]) => [`  - path: ${path}`, "    permissions: '0600'", "    owner: root:root", "    encoding: b64", `    content: ${b64(content)}`]),
    "runcmd:", "  - [/usr/local/libexec/murage-backup-authorize]"].join("\n");
}

/** Day-14 deletion: the home's backups go with it. Safe to repeat; fails (so reconcile retries) if any data remains. A customer export
 *  archive still within the date it was promised is first moved out (retainReadyExports) and purged by the export sweep on that date. */
export async function purgeBackup(db: D1Database, boxFor: (boxId: number) => StorageBoxAdapter, homeId: string, generation: number, now: number,
  opts: { signal?: AbortSignal; boxes?: { id: number; box: StorageBoxAdapter }[] } = {}): Promise<void> {
  const { signal } = opts;
  const purgeOne = async (box: StorageBoxAdapter, subaccountId: string, directory: string) => {
    signal?.throwIfAborted();
    await retainReadyExports(db, box, homeId, directory, now, signal);
    await box.purgeDirectory(directory, signal);
    if (await box.directoryExists(directory, signal)) throw new Error("backup_purge_incomplete");
    await box.deleteSubaccount(subaccountId, signal);
  };
  const rows = await db.prepare("SELECT subaccount_id,directory,box_id FROM backup_subaccounts WHERE home_id=? AND resource_generation=? AND deleted_at IS NULL")
    .bind(homeId, generation).all<{ subaccount_id: string; directory: string; box_id: number }>();
  for (const r of rows.results) {
    await purgeOne(boxFor(r.box_id), r.subaccount_id, r.directory);
    await db.prepare("UPDATE backup_subaccounts SET deleted_at=? WHERE home_id=? AND resource_generation=?").bind(now, homeId, generation).run();
  }
  // Round 12 (Astra MAILRETRY-16 P2-a): whatever our records say, every sub-account that EXISTS for this home and generation on any box
  // (a create whose answer was lost, or one made after an earlier purge) is purged too, then the box is listed again: the purge is complete
  // only once none is left. A listing that fails fails the purge (it is retried; nothing is recorded done).
  for (const { id: boxId, box } of opts.boxes ?? []) {
    if (!box.findSubaccounts) continue;
    for (const sub of await box.findSubaccounts(homeId, generation, signal)) {
      // Astra INTEGRATED-8 P2: a sub-account found carrying a call's key IS that call's answer (the create executed): settled with its evidence
      // before it is purged, so a late (day-3) sub-account closes its call instead of keeping the generation open and alerting forever.
      if (sub.callKey) await settleCall(db, sub.callKey, "created", now, `subaccount:${boxId}:${sub.id}`);
      await purgeOne(box, sub.id, sub.directory);
    }
    if ((await box.findSubaccounts(homeId, generation, signal)).length) throw new Error("backup_purge_incomplete");
  }
}
