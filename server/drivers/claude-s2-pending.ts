/** Input belongs to the pending logical turn, including its cold successor.
 * Keep the submission fence, not serialized user bytes: it runs at the write. */
type Input = { text: string; beforeWrite?: () => void; resolve: (ok: boolean) => void };
const pending = new Map<string, Input[]>();
const rows = new Map<string, Set<number>>();
const liveTurns = new Map<string, () => boolean>();
export const claudeS2HasLiveTurn = (threadId: string): boolean | undefined => liveTurns.get(threadId)?.();
export function claudeS2OwnsEarlier(threadId: string, earlier: readonly number[]): boolean {
  const owned = rows.get(threadId);
  return !!owned && earlier.every(seq => owned.has(seq));
}
export const hasClaudeS2Pending = (threadId: string): boolean => pending.has(threadId);
/** Admission runs the existing lineage fence now and again at submission.
 * This marks a deadline as uncertain (with late reconciliation), so the
 * dispatcher cannot time out and enqueue a duplicate while input is held. */
export function claudeS2SteerAdapter(threadId: string, rowSeq?: number) {
  if (!pending.has(threadId)) return undefined;
  return {
    capabilities: { queueing: true },
    steer(id: string, text: string, beforeWrite?: () => void) {
      if (id !== threadId || !pending.has(id)) return Promise.resolve(false);
      beforeWrite?.();
      if (rowSeq !== undefined) rows.get(id)?.add(rowSeq);
      return holdClaudeS2Input(id, text, beforeWrite).then(ok => {
        if (!ok && rowSeq !== undefined) rows.get(id)?.delete(rowSeq);
        return ok;
      });
    },
  };
}
export function holdClaudeS2Input(threadId: string, text: string, beforeWrite?: () => void): Promise<boolean> {
  const queue = pending.get(threadId);
  if (!queue) return Promise.resolve(false);
  return new Promise(resolve => queue.push({ text, beforeWrite, resolve }));
}
export function beginClaudeS2Pending(threadId: string, hasLiveTurn: () => boolean) {
  if (pending.has(threadId)) throw new Error("S2 turn already pending");
  const queue: Input[] = [];
  pending.set(threadId, queue);
  rows.set(threadId, new Set());
  liveTurns.set(threadId, hasLiveTurn);
  return {
    async flush(write: (text: string, fence?: () => void) => Promise<boolean>) {
      while (queue.length) {
        const input = queue.shift()!;
        try { input.resolve(await write(input.text, input.beforeWrite)); }
        catch { input.resolve(false); }
      }
    },
    close() {
      if (pending.get(threadId) === queue) pending.delete(threadId);
      rows.delete(threadId);
      liveTurns.delete(threadId);
      for (const input of queue.splice(0)) input.resolve(false);
    },
  };
}
