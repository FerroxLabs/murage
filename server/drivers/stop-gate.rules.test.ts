// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STOP-NONACP r3 section C + r3.1 D1-D5: the structural guarantee behind the stop gate, as one AST test.
//   production scan   R1 (awaits, promise chains, detached promises), R2 (turn endings and starts), R3 (launch primitives) over the scanned files
//   self-test         the checker is itself tested before the scan counts: accepted, rejected, production-shaped, discovery, exemptions
//   MS1 fixtures      every gate wrapper on the turn path is found, in a turn-path function, and dropping it turns R1 red
// ONE TypeScript Program (compiler options of tsconfig.server.json, root files = the scanned set + the in-memory mutated copies) serves every
// check, so the cost stays bounded. The rules and the config format are in stop-gate.rules.checker.ts and stop-gate.rules.config.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awaitSites, bodyPoints, check, createRulesProgram, formatDiagnostics, launchCallbacks } from "./stop-gate.rules.checker.ts";
import type { Ctx, Diagnostic, RuleId } from "./stop-gate.rules.checker.ts";
import { ENGINES, PENDING_ENGINES } from "./stop-gate.rules.config.ts";
import type { EngineRules } from "./stop-gate.rules.config.ts";

const T0 = performance.now();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");

/** The scanned set, written out on purpose: the Discovery group compares it with the config and with the files that really use the gate. */
const SCANNED = [
  "server/drivers/claude.ts",
  "server/drivers/muse-code.ts",
  "server/drivers/boxagent.ts",
  "server/drivers/antigravity.ts",
  "server/drivers/pi.ts",
  "server/drivers/codex.ts",
  "server/cloud-computer-turns.ts",
];

const isPending = (e: EngineRules): boolean => PENDING_ENGINES.includes(e.id);
const enforced = ENGINES.filter((e) => !isPending(e));

// ------------------------------------------------------------------------------------------------ in-memory edits (a mutation that applies zero edits FAILS)
interface Edit { start: number; end: number; text: string }

function applyEdits(label: string, original: string, edits: Edit[]): string {
  if (edits.length === 0) throw new Error(`mutation ${label} applies zero edits`);
  let out = original;
  let low = Number.POSITIVE_INFINITY;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    if (e.end > low) throw new Error(`mutation ${label}: overlapping edits`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    low = e.start;
  }
  if (out === original) throw new Error(`mutation ${label} left the source unchanged`);
  return out;
}

// ------------------------------------------------------------------------------------------------ production-shaped mutation plans
type PlanId = "unwrap" | "cleanup-rename" | "direct-ending" | "unlaunch" | "timeout-move" | "request-insert" | "extra-await";

/** Which plans must apply to which engine. A plan that finds nothing to edit in an engine listed here FAILS (it never silently skips). */
const APPLIES: Record<string, PlanId[]> = {
  codex: ["unwrap", "cleanup-rename", "direct-ending", "unlaunch", "timeout-move", "request-insert", "extra-await"],
  pi: ["unwrap", "cleanup-rename", "direct-ending", "unlaunch", "timeout-move", "extra-await"],
  antigravity: ["unwrap", "cleanup-rename", "direct-ending", "unlaunch", "timeout-move", "extra-await"],
  boxagent: ["unwrap", "cleanup-rename", "direct-ending", "unlaunch", "timeout-move", "extra-await"],
  "cloud-computer-turns": ["unwrap", "extra-await"],
  // not enforced yet (PENDING_ENGINES): their plans start to run when the integrator empties the skip list. A plan that finds nothing to edit fails.
  claude: ["unwrap", "cleanup-rename", "direct-ending", "unlaunch", "timeout-move", "extra-await"],
  "muse-code": ["unwrap", "cleanup-rename", "direct-ending", "unlaunch", "timeout-move", "extra-await"],
};

const PRIMITIVE_CALLBACK = /\b(spawnCli|execCli|fetch)\(|\.stdin\.(write|end)\(|\brequest\(/;
const HELPER_CALLBACK = /^(async\s+)?\(\)\s*=>\s*[A-Za-z_$][\w$]*\(\)$/;

interface Plan {
  name: string;
  engine: EngineRules;
  virtualPath: string;
  text?: string;
  error?: string;
  verify: (ds: Diagnostic[]) => void;
}

const virtualCopyPath = (engine: EngineRules, tag: string): string => path.posix.join(path.posix.dirname(engine.file), `${path.posix.basename(engine.file, ".ts")}.__rules_${tag}.ts`);

const has = (ds: Diagnostic[], pred: (d: Diagnostic) => boolean): boolean => ds.some(pred);

function buildPlan(engine: EngineRules, id: PlanId): Plan {
  const original = read(engine.file);
  const plan: Plan = { name: `${engine.id}: ${id}`, engine, virtualPath: virtualCopyPath(engine, id), verify: () => { /* set below */ } };
  try {
    const sites = awaitSites(original, engine.file, engine.id);
    const wrapped = sites.filter((s) => s.wrapper !== "bare");
    const points = bodyPoints(original, engine.file, engine.id);
    const cleanup = new Set(engine.cleanup);
    switch (id) {
      case "unwrap": {
        // drop each fixture's gate wrapper: `await gate.step(e, X)` becomes `await (X)`; every one must turn R1 red at its own key and ordinal
        const edits = wrapped.map((s) => ({ start: s.start, end: s.end, text: `await (${original.slice(s.argStart, s.argEnd)})` }));
        plan.text = applyEdits(plan.name, original, edits);
        plan.verify = (ds) => {
          const missed = wrapped.filter((s) => !has(ds, (d) => d.rule === "R1" && d.kind === "await" && d.key === s.key && d.ordinal === s.ordinal));
          expect(missed.map((s) => `${s.key} #${s.ordinal}`), "fixtures whose unwrapped await the checker did not flag").toEqual([]);
        };
        break;
      }
      case "cleanup-rename": {
        // step -> cleanupStep in a function that is not on the CLEANUP list
        const s = wrapped.find((x) => x.wrapper === "step" && !cleanup.has(x.key));
        if (!s) throw new Error(`mutation ${plan.name}: no gate.step outside the CLEANUP list`);
        expect(original.slice(s.calleeEnd - 4, s.calleeEnd)).toBe("step");
        plan.text = applyEdits(plan.name, original, [{ start: s.calleeEnd - 4, end: s.calleeEnd, text: "cleanupStep" }]);
        plan.verify = (ds) => expect(has(ds, (d) => d.rule === "R1" && d.key === s.key && /cleanupStep outside/.test(d.message))).toBe(true);
        break;
      }
      case "direct-ending": {
        // a direct turn.completed, and a built-then-emitted ending (`const t = "turn.started"; emit({ type: t })`)
        const emitter = engine.emitters[0];
        const s = wrapped.find((x) => x.wrapper === "step" && points.has(x.key));
        if (!emitter || !s) throw new Error(`mutation ${plan.name}: no emitter or no block-bodied step function`);
        const at = (points.get(s.key) as { bodyStart: number }).bodyStart;
        plan.text = applyEdits(plan.name, original, [{ start: at, end: at, text: ` ${emitter}({ type: "turn.completed", ok: true }); const __t = "turn.started"; ${emitter}({ type: __t }); ` }]);
        plan.verify = (ds) => {
          expect(has(ds, (d) => d.rule === "R2" && d.key === s.key && /type "turn\.completed"/.test(d.message))).toBe(true);
          expect(has(ds, (d) => d.rule === "R2" && d.key === s.key && d.kind === "emit" && /not a string literal/.test(d.message))).toBe(true);
        };
        break;
      }
      case "unlaunch": {
        // `gate.launch(e, cb)` -> `(cb)()`: the primitive is no longer inside a gate.launch callback
        const cbs = launchCallbacks(original, engine.file, engine.id);
        const direct = cbs.filter((c) => PRIMITIVE_CALLBACK.test(c.callbackText));
        const helper = cbs.filter((c) => !PRIMITIVE_CALLBACK.test(c.callbackText) && HELPER_CALLBACK.test(c.callbackText));
        plan.text = applyEdits(plan.name, original, [...direct, ...helper].map((c) => ({ start: c.callStart, end: c.callEnd, text: `(${c.callbackText})()` })));
        plan.verify = (ds) => {
          const r3 = ds.filter((d) => d.rule === "R3");
          expect(direct.filter((c) => !has(r3, (d) => d.key === c.cbKey)).map((c) => c.cbKey), "launch callbacks whose primitive stayed green outside gate.launch").toEqual([]);
          expect(r3.length).toBeGreaterThanOrEqual(direct.length + (helper.length > 0 ? 1 : 0));
        };
        break;
      }
      case "timeout-move": {
        // the primitive moves into a setTimeout inside its launch callback
        const c = launchCallbacks(original, engine.file, engine.id).find((x) => PRIMITIVE_CALLBACK.test(x.callbackText));
        if (!c) throw new Error(`mutation ${plan.name}: no gate.launch callback with a primitive`);
        const inner = original.slice(c.bodyStart, c.bodyEnd);
        plan.text = applyEdits(plan.name, original, [{ start: c.bodyStart, end: c.bodyEnd, text: `{ setTimeout(${/\bawait\b/.test(inner) ? "async " : ""}() => ${inner}, 0); }` }]);
        plan.verify = (ds) => expect(has(ds, (d) => d.rule === "R3" && d.key.startsWith(`${c.cbKey}>`) && /nearest enclosing function/.test(d.message))).toBe(true);
        break;
      }
      case "request-insert": {
        // codex: request(m) with a non-literal method and request("turn/start") outside gate.launch
        const key = `${engine.id}>create>sendTurnBody>launchBody`;
        const p = points.get(key);
        if (!p || !engine.requestFns?.length) throw new Error(`mutation ${plan.name}: ${key} not found`);
        plan.text = applyEdits(plan.name, original, [{ start: p.bodyStart, end: p.bodyStart, text: ` const __m: string = "x"; void request(__m, {}); void request("turn/start", {}); ` }]);
        plan.verify = (ds) => {
          expect(has(ds, (d) => d.rule === "R3" && d.key === key && /request\(non-literal method\)/.test(d.message))).toBe(true);
          expect(has(ds, (d) => d.rule === "R3" && d.key === key && /request\(turn\/start\)/.test(d.message))).toBe(true);
        };
        break;
      }
      case "extra-await": {
        // a new await in a function that keeps bare sites
        const fn = engine.fns.find((f) => (f.awaits?.length ?? 0) > 0 && points.get(f.key)?.isAsync);
        if (!fn) throw new Error(`mutation ${plan.name}: no async exempt function with awaits`);
        const at = (points.get(fn.key) as { bodyStart: number }).bodyStart;
        plan.text = applyEdits(plan.name, original, [{ start: at, end: at, text: " await Promise.resolve(); " }]);
        plan.verify = (ds) => expect(has(ds, (d) => d.rule === "R1" && d.key === fn.key && d.kind === "await" && d.ordinal === 1 && d.text === "Promise.resolve()")).toBe(true);
        break;
      }
    }
  } catch (e) {
    plan.error = e instanceof Error ? e.message : String(e);
  }
  return plan;
}

const plans: Plan[] = [];
for (const engine of enforced) for (const id of APPLIES[engine.id] ?? []) plans.push(buildPlan(engine, id));

// ------------------------------------------------------------------------------------------------ inline sources
const PRE = `
import { createStopGate } from "./stop-gate.ts";
import { spawnCli } from "../procs.ts";
const gate = createStopGate({ engineName: "X", emit: () => {}, base: () => ({}) });
declare function emit(e: Record<string, unknown>): void;
declare function work(): Promise<number>;
declare function work2(): Promise<number>;
declare function request(method: string, params?: unknown): Promise<unknown>;
declare function sync(): void;
declare const ev: Record<string, unknown>;
declare const extra: Record<string, unknown>;
declare const child: { stdin: { write(s: string): void; end(s?: string): void } };
declare const entry: ReturnType<typeof gate.enter>;
declare let method: string;
`;

const inl = (over: Partial<EngineRules> = {}): EngineRules => ({ id: "inl", file: "", emitters: ["emit"], requestFns: ["request"], cleanup: [], fns: [], fixtures: [], ...over });
const probeRule = (rows: Array<[number, string]>, extra: Partial<EngineRules> = {}): EngineRules => inl({ fns: [{ key: "inl>probe", kind: "not-turn", reason: "a probe", awaits: rows }], ...extra });

interface Case { name: string; src: string; rules?: EngineRules }
interface Bad extends Case { rule: RuleId; kind?: string; msg?: RegExp; key?: string }

const ACCEPTED: Case[] = [
  { name: "step in a turn-path function", src: `export async function turn() { return await gate.step(entry, work()); }` },
  { name: "the gate through a parameter (resolved by type)", src: `export async function viaParam(stop: { gate: typeof gate }) { await stop.gate.step(entry, work()); }` },
  { name: "cleanupStep in a CLEANUP function", src: `export async function stopper() { await gate.cleanupStep(entry, work()); }`, rules: inl({ cleanup: ["inl>stopper"] }) },
  { name: "a bare await at an exempt site", src: `export async function probe() { await work(); }`, rules: probeRule([[1, "work()"]]) },
  { name: "finish, markStarted and non-ending emits", src: `export function ending() { entry.markStarted(); entry.finish({ ok: true, stopReason: null }); emit({ type: "item.completed", id: 1 }); emit({ ...({ a: 1 } as object), type: "runtime.error", message: "x" }); }` },
  { name: "a spread after the type whose type cannot carry a type", src: `export function f(d: { detail: number } | undefined) { emit({ type: "runtime.error", message: "x", ...(d ? { detail: d.detail } : {}), ...d }); }` },
  {
    name: "primitives synchronous in a gate.launch callback, a literal non-launch request",
    src: `export async function launches() {
      gate.launch(entry, () => spawnCli("x", [], {} as never));
      gate.launch(entry, () => child.stdin.write("p"));
      await gate.step(entry, gate.launch(entry, async () => fetch("http://x"), { liveOn: "resolve" }));
      await gate.step(entry, gate.launch(entry, () => request("turn/start", {})));
      await gate.step(entry, gate.launch(entry, () => request(method, {})));
      await gate.step(entry, request("initialize", {}));
    }`,
  },
  { name: "a helper whose every reference is a gate.launch callback", src: `const writeIt = () => child.stdin.end("x"); export function viaHelper() { gate.launch(entry, () => writeIt()); }` },
  { name: "stdin.end() with no data is not a prompt write", src: `export function closeIn() { child.stdin.end(); }` },
  { name: "gate.handoff and an async function handed to it", src: `async function body() { await gate.step(entry, work()); } export function start() { gate.handoff(entry, async () => { await gate.step(entry, work()); }, () => null); gate.handoff(entry, body, () => null); }` },
  { name: "a not-turn function called inside a gate.step argument", src: `function npp(): Promise<number> { return work(); } export async function g() { await gate.step(entry, npp()); }`, rules: inl({ fns: [{ key: "inl>npp", kind: "not-turn", reason: "probe" }] }) },
  { name: "a reap function called inside a catch", src: `function rp() {} export function f() { try { sync(); } catch { rp(); } }`, rules: inl({ fns: [{ key: "inl>rp", kind: "reap", reason: "cleanup" }] }) },
];

const REJECTED: Bad[] = [
  { name: "a bare await", src: `export async function f() { await work(); }`, rule: "R1", kind: "await" },
  { name: "a for await", src: `export async function f() { for await (const x of (async function* () { yield 1; })()) { void x; } }`, rule: "R1", kind: "await" },
  { name: ".then on a promise", src: `export function f() { return work().then((x) => x); }`, rule: "R1", kind: "chain" },
  { name: "a detached void promise", src: `export function f() { void work(); }`, rule: "R1", kind: "detached" },
  { name: "an unused promise statement", src: `export function f() { work(); }`, rule: "R1", kind: "detached" },
  { name: "an await inside a nested callback", src: `export function f() { [1].forEach(async () => { await work(); }); }`, rule: "R1", kind: "await" },
  { name: "cleanupStep outside the CLEANUP list", src: `export async function f() { await gate.cleanupStep(entry, work()); }`, rule: "R1", msg: /cleanupStep outside/ },
  { name: "a local object named gate is not the stop gate", src: `export async function f() { const gate = { step: async (_e: unknown, p: Promise<number>) => p }; await gate.step(1, work()); }`, rule: "R1", kind: "await" },
  { name: "a not-turn function called outside a gate.step argument", src: `function np() {} export function f() { np(); }`, rules: inl({ fns: [{ key: "inl>np", kind: "not-turn", reason: "r" }] }), rule: "R1", kind: "call" },
  { name: "a reap function called outside a catch or finally", src: `function rp() {} export function f() { rp(); }`, rules: inl({ fns: [{ key: "inl>rp", kind: "reap", reason: "r" }] }), rule: "R1", kind: "call" },
  { name: "an async turn-path function used as a value", src: `async function a() {} export function f() { setTimeout(a, 0); }`, rule: "R1", kind: "ref" },
  { name: "a direct turn.completed", src: `export function f() { emit({ type: "turn.completed", ok: true }); }`, rule: "R2", msg: /turn\.completed/ },
  { name: "a direct turn.started", src: `export function f() { emit({ type: "turn.started" }); }`, rule: "R2", msg: /turn\.started/ },
  { name: "an ending in a template literal", src: "export function f() { emit({ type: `turn.completed` }); }", rule: "R2", msg: /turn\.completed/ },
  { name: "an ending type held in a variable", src: `export function f() { const t = "turn.completed"; emit({ type: t }); }`, rule: "R2", kind: "emit", msg: /not a string literal/ },
  { name: "an event that is not an object literal", src: `export function f() { emit(ev); }`, rule: "R2", kind: "emit", msg: /not an object literal/ },
  { name: "an alias of the emitter", src: `export function f() { const send = emit; send({ type: "item.completed" }); }`, rule: "R2", kind: "emit", msg: /alias/ },
  { name: "an ending built first and emitted later", src: `export function f() { const e2 = { type: "turn.completed" as const }; emit(e2); }`, rule: "R2", msg: /turn\.completed/ },
  { name: "a spread after the type can overwrite it", src: `export function f() { emit({ type: "item.completed", ...extra }); }`, rule: "R2", kind: "emit" },
  { name: "a spread of a typed ending after the type", src: `export function f() { emit({ type: "item.completed", ...({ type: "turn.completed" } as { type: "turn.completed" }) }); }`, rule: "R2", kind: "emit" },
  { name: "a bare spawnCli", src: `export function f() { spawnCli("x", [], {} as never); }`, rule: "R3" },
  { name: "a primitive in a setTimeout inside the launch callback", src: `export function f() { gate.launch(entry, () => { setTimeout(() => spawnCli("x", [], {} as never), 0); }); }`, rule: "R3", msg: /nearest enclosing function/ },
  { name: "an await before the primitive in the launch callback", src: `export async function f() { await gate.step(entry, gate.launch(entry, async () => { await work(); return spawnCli("x", [], {} as never); })); }`, rule: "R3", msg: /await or yield precedes/ },
  { name: "a bare fetch", src: `export async function f() { await gate.step(entry, fetch("http://x")); }`, rule: "R3" },
  { name: "a bare stdin write", src: `export function f() { child.stdin.write("x"); }`, rule: "R3" },
  { name: "request(method) with a non-literal method outside gate.launch", src: `export async function f() { await gate.step(entry, request(method, {})); }`, rule: "R3", msg: /non-literal/ },
  { name: "request(\"turn/start\") outside gate.launch", src: `export async function f() { await gate.step(entry, request("turn/start", {})); }`, rule: "R3", msg: /turn\/start/ },
  { name: "a helper also referenced outside gate.launch", src: `const w = () => child.stdin.end("x"); export function f() { gate.launch(entry, () => w()); w(); }`, rule: "R3", key: "inl>w" },
];

const EXEMPT_BASE = `export async function probe() { await work(); await gate.step(entry, work2()); }
export async function stopper() { await gate.cleanupStep(entry, work()); }`;
const exemptRules = (rows: Array<[number, string]>, extra: Partial<EngineRules> = {}): EngineRules => probeRule(rows, { cleanup: ["inl>stopper"], ...extra });

interface ExemptCase extends Case { expect: "clean" | { rule: RuleId; kind?: string; ordinal?: number; msg?: RegExp } }
const EXEMPTIONS: ExemptCase[] = [
  { name: "a listed site and a CLEANUP function's cleanupStep pass", src: EXEMPT_BASE, rules: exemptRules([[1, "work()"]]), expect: "clean" },
  { name: "the same site with its operand text changed is red", src: EXEMPT_BASE, rules: exemptRules([[1, "work2()"]]), expect: { rule: "R1", kind: "await", ordinal: 1 } },
  { name: "the operand text changed leaves a stale site", src: EXEMPT_BASE, rules: exemptRules([[1, "work2()"]]), expect: { rule: "CFG", msg: /stale exempt site/ } },
  { name: "an extra await in the exempt function is red", src: EXEMPT_BASE.replace("await work();", "await work(); await work();"), rules: exemptRules([[1, "work()"]]), expect: { rule: "R1", kind: "await", ordinal: 2 } },
  { name: "an inserted await shifts the ordinals and is red", src: EXEMPT_BASE.replace("await work();", "await work2(); await work();"), rules: exemptRules([[1, "work()"]]), expect: { rule: "R1", kind: "await", ordinal: 2 } },
  { name: "a stale site (matches no await) is red", src: EXEMPT_BASE, rules: exemptRules([[1, "work()"], [2, "work()"]]), expect: { rule: "CFG", msg: /stale exempt site/ } },
  { name: "a site for an unknown function is red", src: EXEMPT_BASE, rules: exemptRules([[1, "work()"]], { fns: [{ key: "inl>probe", kind: "not-turn", reason: "a probe", awaits: [[1, "work()"]] }, { key: "inl>gone", kind: "not-turn", reason: "r", awaits: [[1, "x"]] }] }), expect: { rule: "CFG", msg: /no function with this key/ } },
  { name: "an exempt function without a reason is red", src: EXEMPT_BASE, rules: exemptRules([[1, "work()"]], { fns: [{ key: "inl>probe", kind: "not-turn", reason: " ", awaits: [[1, "work()"]] }] }), expect: { rule: "CFG", msg: /needs a reason/ } },
  { name: "a turn-path site without its own reason is red", src: EXEMPT_BASE, rules: exemptRules([[1, "work()"]], { fns: [{ key: "inl>probe", kind: "turn", reason: "turn", awaits: [[1, "work()"]] }] }), expect: { rule: "CFG", msg: /own reason/ } },
  { name: "the same cleanupStep moved to a non-CLEANUP function is red", src: `export async function probe() { await work(); await gate.cleanupStep(entry, work2()); }\nexport async function stopper() { await gate.step(entry, work()); }`, rules: exemptRules([[1, "work()"]]), expect: { rule: "R1", msg: /cleanupStep outside/ } },
  { name: "a CLEANUP key that never calls cleanupStep is red", src: `export async function probe() { await work(); }\nexport async function stopper() { await gate.step(entry, work()); }`, rules: exemptRules([[1, "work()"]]), expect: { rule: "CFG", msg: /never calls gate\.cleanupStep/ } },
  { name: "a CLEANUP key that is not in the file is red", src: EXEMPT_BASE, rules: exemptRules([[1, "work()"]], { cleanup: ["inl>stopper", "inl>nowhere"] }), expect: { rule: "CFG", msg: /CLEANUP key/ } },
];

// ------------------------------------------------------------------------------------------------ Discovery inputs (text maps, so a test can mutate them in memory)
const gateUsers = (files: Map<string, string>): string[] =>
  [...files.entries()]
    .filter(([rel, text]) => !/\.test\.ts$/.test(rel) && !/stop-gate\.[^/]*$/.test(rel) && /\bcreateStopGate\s*\(|\b\w*[gG]ate\.enter\s*\(/.test(text))
    .map(([rel]) => rel)
    .sort();

const missingScanned = (files: Map<string, string>, scanned: string[]): string[] => scanned.filter((f) => !files.has(f));

function readServerTree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (ent.isFile() && rel.endsWith(".ts")) out.set(rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    }
  };
  walk("server");
  return out;
}

// ------------------------------------------------------------------------------------------------ the shared Program
const INLINE_FILES = [...ACCEPTED.map((c, i) => ({ c, tag: `a${i}` })), ...REJECTED.map((c, i) => ({ c, tag: `r${i}` })), ...EXEMPTIONS.map((c, i) => ({ c, tag: `e${i}` }))];
const inlinePath = (tag: string): string => `server/drivers/__rules_inline_${tag}.ts`;

let ctx: Ctx;
let programMs = 0;
const diagCache = new Map<string, Diagnostic[]>();
const diagsOf = (file: string, engine: EngineRules): Diagnostic[] => {
  const key = `${file}|${engine.id}`;
  let ds = diagCache.get(key);
  if (!ds) { ds = check(ctx, file, engine); diagCache.set(key, ds); }
  return ds;
};

beforeAll(() => {
  const virtual: Record<string, string> = {};
  for (const { c, tag } of INLINE_FILES) virtual[inlinePath(tag)] = PRE + c.src;
  for (const p of plans) if (p.text !== undefined) virtual[p.virtualPath] = p.text;
  const t = performance.now();
  ctx = createRulesProgram(repoRoot, SCANNED, virtual);
  programMs = performance.now() - t;
}, 120_000);

afterAll(() => {
  const wall = performance.now() - T0;
  console.info(`[stop-gate.rules] Program built in ${Math.round(programMs)} ms; whole file ${Math.round(wall)} ms (${plans.length} production-shaped copies, ${INLINE_FILES.length} inline sources)`);
});

// ------------------------------------------------------------------------------------------------ self-test bookkeeping
const selfFailed: string[] = [];
const st = (name: string, fn: () => void | Promise<void>): void => {
  it(name, async () => {
    try { await fn(); } catch (e) { selfFailed.push(name); throw e; }
  });
};
const expectDiag = (ds: Diagnostic[], want: { rule: RuleId; kind?: string; key?: string; ordinal?: number; msg?: RegExp }): void => {
  const hit = ds.some((d) => d.rule === want.rule && (want.kind === undefined || d.kind === want.kind) && (want.key === undefined || d.key === want.key) && (want.ordinal === undefined || d.ordinal === want.ordinal) && (want.msg === undefined || want.msg.test(d.message)));
  expect(hit, `expected ${JSON.stringify({ ...want, msg: want.msg?.source })} in:\n${formatDiagnostics(ds) || "(no diagnostics)"}`).toBe(true);
};
const inlineDiags = (tag: string, rules: EngineRules | undefined): Diagnostic[] => diagsOf(inlinePath(tag), rules ?? inl());

// ------------------------------------------------------------------------------------------------ the tests
describe("self-test accepted", () => {
  ACCEPTED.forEach((c, i) => st(`accepts: ${c.name}`, () => {
    const ds = inlineDiags(`a${i}`, c.rules);
    expect(formatDiagnostics(ds), "an always-red checker fails here").toBe("");
  }));
});

describe("self-test rejected", () => {
  REJECTED.forEach((c, i) => st(`rejects: ${c.name}`, () => {
    expectDiag(inlineDiags(`r${i}`, c.rules), c);
  }));
  st("a mutation that applies zero edits fails (MurageMain binding 2)", () => {
    expect(() => applyEdits("none", "abc", [])).toThrow(/zero edits/);
    expect(() => applyEdits("noop", "abc", [{ start: 0, end: 1, text: "a" }])).toThrow(/unchanged/);
    expect(() => applyEdits("overlap", "abcdef", [{ start: 0, end: 4, text: "x" }, { start: 2, end: 3, text: "y" }])).toThrow(/overlapping/);
    expect(applyEdits("ok", "abc", [{ start: 1, end: 2, text: "X" }])).toBe("aXc");
  });
});

describe("self-test production-shaped", () => {
  st("every engine that must be mutated has every plan, and each plan applied at least one edit", () => {
    const wanted = enforced.flatMap((e) => (APPLIES[e.id] ?? []).map((id) => `${e.id}: ${id}`));
    expect(plans.map((p) => p.name)).toEqual(wanted);
    expect(plans.filter((p) => p.error).map((p) => `${p.name}: ${p.error}`)).toEqual([]);
    expect(enforced.filter((e) => !(e.id in APPLIES)).map((e) => e.id), "an enforced engine with no mutation plans").toEqual([]);
  });
  for (const p of plans) {
    st(p.name, () => {
      expect(p.error, p.error).toBeUndefined();
      expect(p.text, "mutated text").toBeDefined();
      const ds = diagsOf(p.virtualPath, p.engine);
      try { p.verify(ds); } catch (e) {
        throw new Error(`${(e as Error).message}\nreds in ${p.virtualPath}:\n${formatDiagnostics(ds).slice(0, 3000)}`);
      }
    });
  }
});

describe("self-test discovery", () => {
  st("the scanned set is exactly claude, muse-code, boxagent, antigravity, pi, codex and the cloud-turn helper", () => {
    expect(ENGINES.map((e) => e.file).sort()).toEqual([...SCANNED].sort());
    expect(new Set(ENGINES.map((e) => e.id)).size).toBe(ENGINES.length);
  });
  st("every scanned file exists and the gate users are exactly the scanned engines", () => {
    const files = readServerTree();
    expect(missingScanned(files, SCANNED)).toEqual([]);
    const users = gateUsers(files);
    expect(users.filter((f) => !SCANNED.includes(f)), "a file that calls createStopGate or gate.enter and is not scanned").toEqual([]);
    for (const f of SCANNED.filter((x) => x !== "server/cloud-computer-turns.ts" && !isPending(ENGINES.find((e) => e.file === x) as EngineRules))) expect(users, `${f} no longer uses the gate`).toContain(f);
  });
  st("a new gate user outside the set is red", () => {
    const files = readServerTree();
    files.set("server/drivers/newengine.ts", `import { createStopGate } from "./stop-gate.ts"; export const g = createStopGate({} as never);`);
    expect(gateUsers(files).filter((f) => !SCANNED.includes(f))).toEqual(["server/drivers/newengine.ts"]);
    files.set("server/drivers/other.ts", `const e = gate.enter("t");`);
    expect(gateUsers(files).filter((f) => !SCANNED.includes(f))).toEqual(["server/drivers/newengine.ts", "server/drivers/other.ts"]);
  });
  st("a missing scanned file is red", () => {
    const files = readServerTree();
    files.delete("server/drivers/codex.ts");
    expect(missingScanned(files, SCANNED)).toEqual(["server/drivers/codex.ts"]);
  });
  st("every engine file is in the shared Program", () => {
    for (const e of ENGINES) expect(ctx.program.getSourceFile(path.join(repoRoot, e.file)), e.file).toBeDefined();
  });
});

describe("self-test exemptions", () => {
  EXEMPTIONS.forEach((c, i) => st(c.name, () => {
    const ds = inlineDiags(`e${i}`, c.rules);
    if (c.expect === "clean") expect(formatDiagnostics(ds)).toBe("");
    else expectDiag(ds, c.expect);
  }));
});

describe("MS1 fixtures", () => {
  for (const e of enforced) {
    st(`${e.id}: every gate wrapper on the turn path is a fixture, found and in a turn-path function`, () => {
      expect(e.fixtures.length, "no fixtures").toBeGreaterThan(0);
      const sites = awaitSites(read(e.file), e.file, e.id);
      const notTurn = new Set(e.fns.filter((f) => f.kind !== "turn").map((f) => f.key));
      const cleanup = new Set(e.cleanup);
      const bad: string[] = [];
      for (const f of e.fixtures) {
        const s = sites.find((x) => x.key === f.key && x.ordinal === f.ordinal);
        if (!s || s.wrapper !== f.wrapper || s.arg !== f.operand) bad.push(`${f.key} #${f.ordinal}: not found as ${f.wrapper}(${f.operand})`);
        else if (f.wrapper === "step" && notTurn.has(f.key) && !cleanup.has(f.key)) bad.push(`${f.key}: a gate.step in a function the config marks not-turn, close or reap`);
        else if (f.wrapper === "cleanupStep" && !cleanup.has(f.key)) bad.push(`${f.key}: cleanupStep outside the CLEANUP list`);
      }
      expect(bad).toEqual([]);
      // and none is missing from the list
      const listed = new Set(e.fixtures.map((f) => `${f.key}#${f.ordinal}`));
      expect(sites.filter((s) => s.wrapper !== "bare" && !listed.has(`${s.key}#${s.ordinal}`)).map((s) => `${s.key} #${s.ordinal}`), "wrapped awaits not listed as fixtures").toEqual([]);
    });
  }
});

describe("pending engines", () => {
  st("the skip list is empty: every scanned engine is enforced and none is marked todo", () => {
    expect(PENDING_ENGINES, "PENDING_ENGINES must stay empty").toEqual([]);
    for (const e of ENGINES) expect(e.todo, `${e.id} is enforced but still marked todo`).toBeUndefined();
    expect(enforced.map((e) => e.id).sort()).toEqual(ENGINES.map((e) => e.id).sort());
  });
});

describe("production scan", () => {
  const scan = (rules: RuleId[]): string => {
    expect(selfFailed, "the checker self-tests must pass before the scan counts").toEqual([]);
    return enforced.map((e) => formatDiagnostics(diagsOf(e.file, e).filter((d) => rules.includes(d.rule)))).filter(Boolean).join("\n");
  };
  it("R1", () => {
    expect(scan(["R1", "CFG"])).toBe("");
  });
  it("R2", () => {
    expect(scan(["R2"])).toBe("");
  });
  it("R3", () => {
    expect(scan(["R3"])).toBe("");
  });
});
