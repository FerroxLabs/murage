// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: the supervisor's end of the Flux sub-key hand-off written by the root poller
// (deploy/cloud-home/murage-control). The supervisor READS the hand-off (it stays in place),
// seals the key, and only then writes a durable receipt {op_id, generation} (no key material)
// and deletes the hand-off. The poller acks the control plane only when it finds that receipt.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { fluxHandoff, fluxReceipt } from "../../shared/flux-renewal-wire.ts";
import { cloudHomeCopy } from "./copy.ts";
import { isHomeFluxKey } from "./flux-home-gate.ts";

export const FLUX_SUBKEY_DIR = "/run/murage-control/flux-subkey";
export const FLUX_HANDOFF_FILE = "key.json";
export const FLUX_RECEIPT_FILE = "receipt.json";

/** The hand-off file: the shared renewal wire answer {key, generation, expiresAt, capUsd} plus op_id (shared/flux-renewal-wire.ts). */
export interface FluxSubkeyDelivery { key: string; generation: number; expiresAt: string; capUsd: number; op_id: string; /** File mtime (ms): when the poller wrote this hand-off. Not part of the wire. */ writtenAtMs?: number }

// Ownership. The poller (murage-control) runs as root with NO capabilities, so it cannot chown to the supervisor's uid. Instead the
// directory and the key file belong to the poller (root, `pollerUid`) and to the supervisor's GROUP (the poller is made a member by
// SupplementaryGroups= in murage-control.service, which lets an owner chgrp without CAP_CHOWN). Directory 0770 root:supervisor, key
// 0640 root:supervisor: the supervisor reads the key and, through the group write bit on the directory, writes the receipt and removes
// the key; no other uid (a turn is a different user and group) has any access. The receipt is the supervisor's own 0640 file.
const safeDir = (directory: string, pollerUid: number, gid: number): boolean => {
  const dir = lstatSync(directory);
  return dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === pollerUid && dir.gid === gid && !(dir.mode & 0o007) && (dir.mode & 0o070) === 0o070;
};

/** Returns the waiting sub-key or null when none is waiting or the hand-off is unsafe. The file is NOT removed
 *  (only a malformed one is, so it cannot wedge the loop). Never throws, never logs the key. */
export function peekFluxSubkey(directory = FLUX_SUBKEY_DIR, pollerUid = 0, gid: number = process.getgid?.() ?? -1): FluxSubkeyDelivery | null {
  const path = `${directory}/${FLUX_HANDOFF_FILE}`;
  try {
    if (!safeDir(directory, pollerUid, gid)) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string, writtenAtMs: number;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== pollerUid || info.gid !== gid || (info.mode & 0o137) || !(info.mode & 0o040) || info.size > 4096) return null;
      raw = readFileSync(fd, "utf8"); writtenAtMs = info.mtimeMs;
    } finally { closeSync(fd); }
    let parsed: ReturnType<typeof fluxHandoff.safeParse>;
    try { parsed = fluxHandoff.safeParse(JSON.parse(raw)); } catch { parsed = fluxHandoff.safeParse(undefined); }
    if (!parsed.success || !isHomeFluxKey(parsed.data.key)) { try { unlinkSync(path); } catch { /* nothing to remove */ } return null; }
    return { ...parsed.data, writtenAtMs };
  } catch { return null; }
}

/** After the key is sealed: write the receipt (0600, atomic, fsynced), then remove the hand-off if it is still this one. */
export function completeFluxSubkey(delivery: FluxSubkeyDelivery, directory = FLUX_SUBKEY_DIR, pollerUid = 0, gid: number = process.getgid?.() ?? -1): void {
  if (!safeDir(directory, pollerUid, gid)) throw new Error(cloudHomeCopy.fluxHandoffNotPrivate);
  const receipt = fluxReceipt.parse({ op_id: delivery.op_id, generation: delivery.generation });
  const temporary = `${directory}/.receipt-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  // 0640: the root poller (no DAC override) reads it through the group, nobody else at all.
  try { fchmodSync(fd, 0o640); writeSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, `${directory}/${FLUX_RECEIPT_FILE}`);
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  // A newer hand-off may have replaced this one while it was being sealed: leave that one for the next read.
  const current = peekFluxSubkey(directory, pollerUid, gid);
  if (current && current.op_id === delivery.op_id && current.generation === delivery.generation) {
    try { unlinkSync(`${directory}/${FLUX_HANDOFF_FILE}`); } catch { /* the next read finds nothing or re-applies idempotently */ }
  }
}
