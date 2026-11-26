// Skills owns bounded effects; decision owns this shared automatic-work lane.
// A lane lease controls capacity only; the executor still requires token/current-policy authority.
import { AsyncLocalStorage } from 'node:async_hooks';

export class SkillSettlementWork {
  private scope = new AsyncLocalStorage<object>();
  private active?: object;
  private waiting = 0;
  private tail = Promise.resolve();
  private owns(): boolean { return !!this.active && this.scope.getStore() === this.active; }
  available(): boolean { return this.owns() || !this.active && this.waiting === 0; }
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    const idle = !this.active && this.waiting === 0;
    this.waiting++;
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.waiting--;
        const lease = {}; this.active = lease;
        this.scope.run(lease, async () => {
          let value!: T, error: unknown, failed = false;
          try { value = await work(); } catch (caught) { failed = true; error = caught; }
          // Even a partial final batch releases its allowance only after a tick.
          try { await new Promise<void>(done => setImmediate(done)); }
          catch (caught) { failed = true; error = caught; }
          this.active = undefined; release();
          if (failed) reject(error); else resolve(value);
        });
      };
      if (idle) start(); else void previous.then(start);
    });
  }
  drain<T>(work: () => T | Promise<T>): Promise<T> { return this.enqueue(work); }
  item<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.owns()) { try { return Promise.resolve(work()); } catch (error) { return Promise.reject(error); } }
    return this.enqueue(work);
  }
  owner<T>(work: () => T | Promise<T>): Promise<T | undefined> {
    if (!this.available()) return Promise.resolve(undefined);
    return this.item(work);
  }
  now<T>(work: () => T): T | undefined {
    if (this.owns()) return work();
    if (!this.available()) return;
    const lease = {}; this.active = lease;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try { return this.scope.run(lease, work); }
    finally {
      const finish = () => { this.active = undefined; release(); };
      try { setImmediate(finish); } catch (error) { finish(); throw error; }
    }
  }
}

let lane = new SkillSettlementWork();
export const skillSettlementWork = {
  drain: <T>(work: () => T | Promise<T>) => lane.drain(work),
  item: <T>(work: () => T | Promise<T>) => lane.item(work),
  owner: <T>(work: () => T | Promise<T>) => lane.owner(work),
  now: <T>(work: () => T) => lane.now(work),
  available: () => lane.available(),
};
// A replacement host is a new runtime; old answer flights cannot own its lane.
export function installSkillSettlementWork(): void { lane = new SkillSettlementWork(); }
