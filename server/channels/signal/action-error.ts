// SPDX-License-Identifier: AGPL-3.0-or-later
// Action failures may carry Signal evidence or local paths. Only closed cause codes and fixed copy leave this boundary.
const PERMISSION = "Murage does not have permission to change the Signal files on this computer.";
const BUSY = "The Signal files are in use. Close the other process and try again.";
const KEPT = "Murage kept your Signal files. Review the connection in Signal settings before trying again.";
const COPY: Readonly<Record<string, string>> = {
  EPERM: PERMISSION, EACCES: PERMISSION,
  ENOSPC: "There is no room on this disk to save the Signal changes.",
  EDQUOT: "This computer's storage allowance is full, so Murage cannot save the Signal changes.",
  EROFS: "This disk is read-only, so Murage cannot save the Signal changes.",
  EIO: "This disk could not read or save the Signal files. Check the disk and try again.",
  ENOENT: "A Signal file or required program is missing. Reopen Murage and try again.",
  EBUSY: BUSY, busy: BUSY, "kept-busy": BUSY,
  offline: "Signal is not connected. Connect again in Signal settings.",
  timeout: "Signal took too long to answer. Try again in Signal settings.",
  "broken-pipe": "The Signal connection closed during this step. Connect again in Signal settings.",
  "needs-update": "Signal needs a newer Murage. Check for updates in Signal settings.",
  "storage-permissions": PERMISSION,
  "storage-owner": "Another account on this computer owns the Signal files. Review the connection in Signal settings.",
  "link-required": "Signal needs a new link on this computer. Connect again in Signal settings.",
  "identity-unavailable": "Signal did not say which account this is. Connect again in Signal settings.",
  "identity-mismatch": "A different Signal account answered. Disconnect before linking this one.",
  "revoke-recovery-required": "Murage did not finish disconnecting Signal. Finish disconnecting in Signal settings.",
  "disk-full": "There is no room on this disk to save the Signal changes.",
  "storage-slow": "The disk is taking too long to save the Signal changes. Check the disk and try again.",
  "ledger-write-failed": "Murage could not save a Signal note. Try again in Signal settings.",
  "notes-stuck": "Murage could not save a Signal note. Try again in Signal settings.",
  "reply-lost": "Murage lost track of a Signal answer. Review it in Signal settings.",
  durability: "Murage cannot confirm the Signal changes were saved. Open Murage again before linking Signal.",
  adoption: "Murage cannot confirm an earlier Signal process has stopped. Keep Signal paused and reopen Murage.",
  pending: "Murage is still disconnecting an earlier Signal link. Reopen Murage to finish.",
  changed: "The Signal files changed during this step. Reopen Murage to check them again.",
  device: "The Signal files are on different disks. Review the connection in Signal settings.",
  unsafe: KEPT, conflict: KEPT, bound: KEPT, "kept-check": KEPT, "files-kept": KEPT,
  refused: "Signal refused this step. Review the connection in Signal settings.",
  disconnecting: "Signal is disconnecting. Wait for it to finish before trying again.",
};
const MESSAGE_CAUSES: Readonly<Record<string, string>> = {
  "Signal files are kept": "files-kept", "Signal request refused": "refused", "Signal is disconnecting": "disconnecting",
};

export function signalActionFailure(error: unknown): { cause: string; message: string } {
  const e = error as { code?: unknown; reason?: unknown; message?: unknown } | null;
  for (const candidate of [e?.code, e?.reason]) {
    if (typeof candidate === "string" && Object.hasOwn(COPY, candidate)) return { cause: candidate, message: COPY[candidate]! };
  }
  if (typeof e?.message === "string" && Object.hasOwn(MESSAGE_CAUSES, e.message)) {
    const cause = MESSAGE_CAUSES[e.message]!;
    return { cause, message: COPY[cause]! };
  }
  return { cause: "error", message: "Signal did not report why this step stopped. Try again in Signal settings." };
}
