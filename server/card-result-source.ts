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

/** The one gate for any path that copies, mirrors, records or returns a result's text somewhere else (card delivery, shared
 * delivery, the shared reply an asker reads): the result is read now, and its text is handed on only while its source ancestry
 * is still eligible. Anything else yields undefined, so no plaintext reaches a copy, a mirror, a receipt or a reply. */
export function eligibleResultMessage<M extends { id: string }>(resultId: string | undefined, read: (id: string) => M | undefined, eligible: (message: M) => boolean): M | undefined {
  const source = resolveCardResult(resultId, read, eligible);
  return !source.drop && source.message && source.allowed ? source.message : undefined;
}

/** What an asker reads back for a settled shared request. Authorization and ancestry are asked now; a copy already delivered
 * to the asker's thread is never a source of text, so an ineligible original yields the outcome note only. */
export function sharedAskReplyText<M extends { id: string; text?: string }>(input: { authorized: boolean; resultId: string | undefined; read: (id: string) => M | undefined; eligible: (message: M) => boolean; outcomeNote?: string | null }): string {
  const result = input.authorized ? eligibleResultMessage(input.resultId, input.read, input.eligible) : undefined;
  return result?.text ?? input.outcomeNote ?? "The request finished.";
}

/** Which room request a stored delegation receipt answers. A receipt written before requests were recorded on it is found by
 * the delegation's admission key, or by its own id (a shared ask exposes its request id as the task id). A request found
 * this way must be the same work: the same worker and the same source conversation. A found request that does not match
 * is "mismatch" (never trusted); none found is "unbound". */
export type ReceiptBinding = { kind: "bound"; requestId: string } | { kind: "mismatch" } | { kind: "unbound" };
export function resolveReceiptBinding(receipt: { id: string; requestId?: string; sourceThreadId: string; toBotId: string }, find: { byId: (id: string) => { id: string; toBotId: string | null; rootThreadId: string } | null; byKey: (key: string) => { id: string; toBotId: string | null; rootThreadId: string } | null }): ReceiptBinding {
  if (receipt.requestId) return { kind: "bound", requestId: receipt.requestId };
  const found = find.byKey(`ask:delegation:${receipt.id}`) ?? find.byId(receipt.id);
  if (!found) return { kind: "unbound" };
  return found.toBotId === receipt.toBotId && found.rootThreadId === receipt.sourceThreadId ? { kind: "bound", requestId: found.id } : { kind: "mismatch" };
}

/** What a stored delegation receipt hands back on replay (check_delegation / wait_delegation). A receipt holds the text as it
 * was at delivery, so it is bound to its request: every replay asks the SAME delivery authorization again (sharing, partition,
 * revocation) before any text leaves. When that is denied, or the existing lineage rules withhold it, the status is returned
 * with the reason and no text. A receipt with no recoverable request returns text only when its work is POSITIVELY known to be
 * the owner's own unshared work (`ownUnsharedWork`); a shared origin, an unknown origin or a mismatched binding returns the
 * status and a reason, no text. */
export const RECEIPT_ORIGIN_UNCONFIRMED_LINE = "Result not shown: where it came from was not recorded.";
export function gatedReceiptReplay(input: { requestId: string | undefined; binding?: "mismatch"; ownUnsharedWork?: () => boolean; authorize: (requestId: string) => { ok: true } | { ok: false; code: string; line: string }; withheld: boolean; withheldLine: string; text: string | undefined }): { result: string; reason?: string } {
  if (input.requestId && input.binding !== "mismatch") {
    const verdict = input.authorize(input.requestId);
    if (!verdict.ok) return { result: verdict.line, reason: verdict.code };
  } else if (input.binding === "mismatch" || !input.ownUnsharedWork || !input.ownUnsharedWork()) {
    return { result: RECEIPT_ORIGIN_UNCONFIRMED_LINE, reason: "origin_unconfirmed" };
  }
  return { result: input.withheld ? input.withheldLine : input.text ?? "" };
}
