// Readable counterexamples: for each step the move, the reducer events it caused, the actions the reducer emitted, and the
// state diff (paths changed, old -> new).
import type { StepResult } from "./world.ts";
import type { WorldX } from "./types.ts";

export function diff(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (x: unknown) => x !== null && typeof x === "object";
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  } else out.push(`${path}: ${JSON.stringify(a) ?? "∅"} -> ${JSON.stringify(b) ?? "∅"}`);
  return out;
}
const strip = (w: WorldX) => { const { trace: _t, nextReq: _n, ...rest } = w; return rest; };
export const worldDiff = (a: WorldX, b: WorldX) => diff(strip(a), strip(b));

export function printStep(i: number, prev: WorldX, s: StepResult): string {
  const lines = [`#${i + 1} move ${JSON.stringify(s.move)}`, `    action ${JSON.stringify(s.action)}`];
  for (const r of s.reductions) {
    lines.push(`    reducer(${r.home}) event ${JSON.stringify(r.event)}`);
    lines.push(`      actions ${r.actions.length ? JSON.stringify(r.actions) : "(none)"}`);
  }
  if (s.error) lines.push(`    REDUCER THREW: ${s.error}`);
  const d = worldDiff(prev, s.world);
  lines.push(d.length ? d.map((x) => `    ~ ${x}`).join("\n") : "    (state unchanged)");
  return lines.join("\n");
}
export function printTrace(title: string, seedName: string, seed: WorldX, steps: StepResult[]): string {
  const out = [`=== ${title} (seed: ${seedName}, ${steps.length} steps) ===`];
  let prev = seed;
  steps.forEach((s, i) => { out.push(printStep(i, prev, s)); prev = s.world; });
  return out.join("\n");
}
