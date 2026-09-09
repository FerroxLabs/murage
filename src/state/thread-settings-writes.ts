/** Sends wait for the selected thread's settings, never another thread's lane.
 * A failed write refuses the already-waiting send. Only successful authority
 * reconciliation clears the lane for a later deliberate retry. */
export class ThreadSettingsWrites {
  private readonly pending = new Map<string, Promise<void>>();

  write(threadId: string, save: () => Promise<void>, reconcile: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(threadId);
    let recovered = false;
    const work = (previous ?? Promise.resolve()).catch(() => {}).then(save).catch(async error => {
      await reconcile();
      recovered = true;
      throw error;
    });
    this.pending.set(threadId, work);
    void work.then(() => {
      if (this.pending.get(threadId) === work) this.pending.delete(threadId);
    }, () => {
      if (recovered && this.pending.get(threadId) === work) this.pending.delete(threadId);
    });
    return work;
  }

  async ready(threadId: string): Promise<void> {
    for (;;) {
      const current = this.pending.get(threadId);
      if (!current) return;
      await current;
      if (this.pending.get(threadId) === current) return;
    }
  }
}
