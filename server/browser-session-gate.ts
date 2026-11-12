import { AsyncLocalStorage } from 'node:async_hooks';

export type GateToken = { readonly keys: readonly string[] };
const tokens = new WeakMap<object, { live: boolean; keys: Set<string> }>();
export function assertGateToken(token: unknown, key: string): asserts token is GateToken {
  const state = token && typeof token === 'object' ? tokens.get(token) : undefined;
  if (!state?.live || !state.keys.has(key)) throw new Error('gate_token');
}
type Scope = { live: boolean; keys: Set<string> };
type Job = { keys: string[]; start: () => void };
/** FIFO for overlapping sets, with no retained mutex for an idle session.
 * Sorted sets also give callers one canonical order for multi-profile commits. */
export class SessionGate {
  private readonly context = new AsyncLocalStorage<readonly Scope[]>();
  private readonly held = new Set<string>();
  private readonly queue: Job[] = [];
  get size() { return new Set([...this.held, ...this.queue.flatMap(job => job.keys)]).size; }
  run<T>(keys: readonly string[], fn: (token: GateToken) => Promise<T> | T): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const inherited = (this.context.getStore() ?? []).filter(scope => scope.live);
    if (ordered.some(key => inherited.some(scope => scope.keys.has(key)))) return Promise.reject(new Error('gate_reentry'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { keys: ordered, start: () => {
        for (const key of ordered) this.held.add(key);
        const token: GateToken = Object.freeze({ keys: Object.freeze(ordered) });
        const state = { keys: new Set(ordered), live: true }; tokens.set(token, state);
        const finish = () => { state.live = false; for (const key of ordered) this.held.delete(key); this.pump(); };
        this.context.run([...inherited, state], () => {
          try { Promise.resolve(fn(token)).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); }); }
          catch (error) { finish(); reject(error); }
        });
      } };
      this.queue.push(job); this.pump();
    });
  }
  private pump() {
    const waiting = new Set<string>();
    for (let i = 0; i < this.queue.length;) {
      const job = this.queue[i]!;
      if (job.keys.some(key => this.held.has(key) || waiting.has(key))) {
        for (const key of job.keys) waiting.add(key); i++;
      } else { this.queue.splice(i, 1); job.start(); }
    }
  }
}
