import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const MAX_COORDINATION_DEPTH = 2;
export const MAX_HANDOFFS_PER_TURN = 16;
export const MAX_HANDOFFS_PER_ROOT = 32;
export const MAX_CONCURRENT_HANDOFFS = 4;
const id = z.string().min(1).max(180);
export const coordinationTraceSchema = z.object({ rootId: id, path: z.array(id).min(1).max(3) }).strict();
export type CoordinationTrace = z.infer<typeof coordinationTraceSchema>;
const rootSchema = z.object({
  id, owner: id, expiresAt: z.number().finite(),
  paths: z.array(z.array(id).min(2).max(3)).max(MAX_HANDOFFS_PER_ROOT),
}).strict();
const stateSchema = z.object({ version: z.literal(1), roots: z.array(rootSchema).max(4096) }).strict();
type State = z.infer<typeof stateSchema>;

/** Server-owned chain allowance. Missing/invalid ancestry never creates a fresh allowance. */
export class CoordinationBudget {
  private state: State = { version: 1, roots: [] };
  /** Roots of turns that have not handed off yet. In memory only: an ordinary turn never touches the disk or the 4,096 cap. */
  private readonly pending = new Map<string, { owner: string; expiresAt: number }>();
  private readonly file: string;
  private readonly now: () => number;
  constructor(file: string, now: () => number = Date.now) {
    this.file = file; this.now = now;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("COORDINATION_STATE_INVALID");
      this.state = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (new Set(this.state.roots.map(root => root.id)).size !== this.state.roots.length) throw new Error("COORDINATION_STATE_INVALID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A bad 24 h allowance file must not stop the app: keep it for review and start empty.
        this.state = { version: 1, roots: [] };
        try {
          const kept = `${file}.invalid-${this.now()}`;
          renameSync(file, kept);
          console.error(`[coordination] unreadable ${file}; kept as ${kept} and started with an empty allowance table`);
        } catch (renameError) {
          console.error(`[coordination] unreadable ${file} could not be set aside (${(renameError as Error).message}); started empty`);
        }
      }
    }
  }
  private save(next: State): void {
    writeFileAtomic(this.file, JSON.stringify(stateSchema.parse(next)), { mode: 0o600 });
    this.state = next;
  }
  /** Never throws for a full table: an owner turn always starts. The persisted root is made on the first handoff. */
  begin(owner: string, rootId: string = randomUUID()): CoordinationTrace {
    id.parse(owner); id.parse(rootId);
    const now = this.now();
    const prior = this.state.roots.find(root => root.id === rootId && root.expiresAt > now) ?? this.pending.get(rootId);
    if (prior) {
      if (prior.owner !== owner) throw new Error("COORDINATION_OWNER_MISMATCH");
    } else {
      for (const [key, root] of this.pending) if (root.expiresAt <= now) this.pending.delete(key);
      while (this.pending.size >= 4096) this.pending.delete(this.pending.keys().next().value as string);
      this.pending.set(rootId, { owner, expiresAt: now + 24 * 60 * 60_000 });
    }
    return { rootId, path: [owner] };
  }
  advance(trace: CoordinationTrace | undefined, sender: string, target: string): CoordinationTrace {
    if (!trace || !coordinationTraceSchema.safeParse(trace).success) throw new Error("COORDINATION_ALLOWANCE_UNAVAILABLE: start a new owner task");
    let root = this.state.roots.find(root => root.id === trace.rootId && root.expiresAt > this.now());
    let promoting: State["roots"] | undefined;
    const waiting = this.pending.get(trace.rootId);
    if (!root && waiting && waiting.expiresAt > this.now() && trace.path.length === 1 && trace.path[0] === waiting.owner) {
      // First handoff of this turn: only now does it cost a persisted record.
      const live = this.state.roots.filter(item => item.expiresAt > this.now());
      if (live.length >= 4096) throw new Error("COORDINATION_ROOT_LIMIT: too many delegating tasks in the last day");
      root = { id: trace.rootId, owner: waiting.owner, expiresAt: waiting.expiresAt, paths: [] };
      promoting = live; // committed only after every check below passes
    }
    if (!root || trace.path[0] !== root.owner || trace.path.at(-1) !== sender) throw new Error("COORDINATION_ALLOWANCE_UNAVAILABLE: start a new owner task");
    if (trace.path.length > 1 && !root.paths.some(path => JSON.stringify(path) === JSON.stringify(trace.path))) throw new Error("COORDINATION_ANCESTRY_INVALID");
    if (trace.path.includes(target)) throw new Error("COORDINATION_CYCLE: that bot is already in this delegation chain");
    if (trace.path.length > MAX_COORDINATION_DEPTH) throw new Error("COORDINATION_DEPTH_LIMIT: the Chief-to-lead-to-specialist allowance is exhausted");
    if (root.paths.length >= MAX_HANDOFFS_PER_ROOT) throw new Error("COORDINATION_BUDGET_EXHAUSTED: this owner task has used its handoff allowance");
    id.parse(target);
    const path = [...trace.path, target];
    const next: State = promoting ? { version: 1, roots: [...promoting, { ...root, paths: [path] }] }
      : (() => { const copy = structuredClone(this.state); copy.roots.find(item => item.id === root.id)!.paths.push(path); return copy; })();
    // Consumed before dispatch: uncertainty may spend an allowance, never grant an extra one.
    this.save(next);
    if (promoting) this.pending.delete(trace.rootId);
    return { rootId: root.id, path };
  }
}
