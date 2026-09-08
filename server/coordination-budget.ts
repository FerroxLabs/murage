import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("COORDINATION_STATE_INVALID: preserve the original file and review recovery");
    }
  }
  private save(next: State): void {
    writeFileAtomic(this.file, JSON.stringify(stateSchema.parse(next)), { mode: 0o600 });
    this.state = next;
  }
  begin(owner: string, rootId: string = randomUUID()): CoordinationTrace {
    id.parse(owner); id.parse(rootId);
    const roots = this.state.roots.filter(root => root.expiresAt > this.now());
    const prior = roots.find(root => root.id === rootId);
    if (prior) {
      if (prior.owner !== owner) throw new Error("COORDINATION_OWNER_MISMATCH");
    } else {
      if (roots.length >= 4096) throw new Error("COORDINATION_ROOT_LIMIT");
      roots.push({ id: rootId, owner, expiresAt: this.now() + 24 * 60 * 60_000, paths: [] });
      this.save({ version: 1, roots });
    }
    return { rootId, path: [owner] };
  }
  advance(trace: CoordinationTrace | undefined, sender: string, target: string): CoordinationTrace {
    if (!trace || !coordinationTraceSchema.safeParse(trace).success) throw new Error("COORDINATION_ALLOWANCE_UNAVAILABLE: start a new owner task");
    const root = this.state.roots.find(root => root.id === trace.rootId && root.expiresAt > this.now());
    if (!root || trace.path[0] !== root.owner || trace.path.at(-1) !== sender) throw new Error("COORDINATION_ALLOWANCE_UNAVAILABLE: start a new owner task");
    if (trace.path.length > 1 && !root.paths.some(path => JSON.stringify(path) === JSON.stringify(trace.path))) throw new Error("COORDINATION_ANCESTRY_INVALID");
    if (trace.path.includes(target)) throw new Error("COORDINATION_CYCLE: that bot is already in this delegation chain");
    if (trace.path.length > MAX_COORDINATION_DEPTH) throw new Error("COORDINATION_DEPTH_LIMIT: the Chief-to-lead-to-specialist allowance is exhausted");
    if (root.paths.length >= MAX_HANDOFFS_PER_ROOT) throw new Error("COORDINATION_BUDGET_EXHAUSTED: this owner task has used its handoff allowance");
    id.parse(target);
    const next = structuredClone(this.state), path = [...trace.path, target];
    next.roots.find(item => item.id === root.id)!.paths.push(path);
    // Consumed before dispatch: uncertainty may spend an allowance, never grant an extra one.
    this.save(next);
    return { rootId: root.id, path };
  }
}
