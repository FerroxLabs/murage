// A card run's result is put in the project room by a delivery that can be repeated (a locked database, a restart). Every
// attempt asks again what the result is NOW, so a message deleted, forgotten or withdrawn since an earlier attempt is never
// written from a copy held in memory.
export type CardResultSource<M extends { id: string }> =
  /** a result was recorded for the run but is gone now: nothing is posted and the owed delivery is dropped */
  | { drop: true }
  /** `message` is undefined when the run recorded no result; `allowed` says whether its sources may be shown in the room */
  | { drop: false; message: M | undefined; allowed: boolean };

export function resolveCardResult<M extends { id: string }>(resultId: string | undefined, read: (id: string) => M | undefined, eligible: (message: M) => boolean): CardResultSource<M> {
  if (!resultId) return { drop: false, message: undefined, allowed: false };
  const message = read(resultId);
  if (!message) return { drop: true };
  return { drop: false, message, allowed: eligible(message) };
}

/** Which room request a stored delegation receipt answers. A receipt written before requests were recorded on it is found by
 * its own id (a shared ask exposes its request id as the task id), then the delegation's admission key (a conflict between the two is a mismatch); formerly by the key, or by its own id (a shared ask exposes its request id as the task id). A request found
 * this way must be the same work: the same worker and the same source conversation. A found request that does not match
 * is "mismatch" (never trusted); none found is "unbound". */
export type ReceiptBinding = { kind: "bound"; requestId: string } | { kind: "mismatch" } | { kind: "unbound" };
export function resolveReceiptBinding(receipt: { id: string; requestId?: string; sourceThreadId: string; toBotId: string }, find: { byId: (id: string) => { id: string; toBotId: string | null; rootThreadId: string } | null; byKey: (key: string) => { id: string; toBotId: string | null; rootThreadId: string } | null }): ReceiptBinding {
  if (receipt.requestId) return { kind: "bound", requestId: receipt.requestId };
  // the request of the receipt's own id is found first; the key is only a fallback, and a key that names a DIFFERENT request than the id is a conflict, never trusted
  const byId = find.byId(receipt.id), byKey = find.byKey(`ask:delegation:${receipt.id}`);
  if (byId && byKey && byId.id !== byKey.id) return { kind: "mismatch" };
  const found = byId ?? byKey;
  if (!found) return { kind: "unbound" };
  return found.toBotId === receipt.toBotId && found.rootThreadId === receipt.sourceThreadId ? { kind: "bound", requestId: found.id } : { kind: "mismatch" };
}

/** The line a result carries when nothing proves whose work it was (see server/result-egress.ts, the one place a stored result leaves). */
export const RECEIPT_ORIGIN_UNCONFIRMED_LINE = "Result not shown: where it came from was not recorded.";
