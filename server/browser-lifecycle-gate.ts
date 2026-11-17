import { SessionGate } from './browser-session-gate.ts';
/** Admission and selection changes share this gate. A lease lives beyond the
 * admission callback, until the turn-end path synchronously releases it. */
export class BrowserLifecycleGate {
  private readonly gate = new SessionGate();
  private readonly leases = new Map<string, string>();
  private readonly admitting = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private admission: (botId: string) => Promise<void> = async () => {};
  onAdmission(fn: (botId: string) => Promise<void>) { this.admission = fn; }
  private idle: (botId: string) => Promise<void> = async () => {};
  private afterIdle: (botId:string) => void = () => {};
  onAfterIdle(fn:(botId:string)=>void){this.afterIdle=fn;}
  get size() { return this.gate.size; }
  onIdle(fn: (botId: string) => Promise<void>) { this.idle = fn; }
  run<T>(botId: string, fn: () => Promise<T> | T) { return this.gate.run([botId], fn); }
  hasLease(botId: string) { return [...this.leases.values()].includes(botId); }
  admitTurn<T>(botId: string, threadId: string, fn: () => Promise<T>): Promise<T> {
    return this.run(botId, async () => {
      if (this.leases.has(threadId) || this.admitting.has(threadId)) throw new Error('browser_turn_already_admitted');
      this.admitting.set(threadId, botId);
      try {
        await this.admission(botId);
        if (this.cancelled.has(threadId)) throw new Error('browser_turn_cancelled');
        this.leases.set(threadId, botId);
        return await fn();
      } catch (error) { this.leases.delete(threadId); throw error; }
      finally { this.admitting.delete(threadId); this.cancelled.delete(threadId); }
    });
  }
  releaseTurn(threadId: string): Promise<void> {
    const botId = this.leases.get(threadId) ?? this.admitting.get(threadId); if (!botId) return Promise.resolve();
    if (this.admitting.has(threadId)) this.cancelled.add(threadId);
    this.leases.delete(threadId);
    // Enqueue before returning a promise, ahead of any later admission.
    return this.run(botId, async () => { if (!this.hasLease(botId)) await this.idle(botId); }).then(()=>{this.afterIdle(botId);});
  }
}
