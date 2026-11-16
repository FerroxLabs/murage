// SPDX-License-Identifier: AGPL-3.0-or-later
// D6: the guard over the five production files, and every listed mutant, each RED by assertion (the guard names the violation).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { GUARD_FILES, walGuard, type GuardSources } from "./testing/wal-guard.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const real = Object.fromEntries(GUARD_FILES.map(f => [f, readFileSync(join(repo, f), "utf8")])) as GuardSources;
const WM = "server/wal-maintenance.ts", IB = "server/io-budget.ts", AS = "server/admission-shared.ts", IM = "server/io-meter.ts", EE = "server/engine-exclusion.ts";
type F = (typeof GUARD_FILES)[number];
const rep = (file: F, old: string, to: string) => ({ file, mut: (t: string) => { expect(t.split(old).length - 1, `mutant anchor in ${file}: ${old.slice(0, 50)}`).toBe(1); return t.replace(old, () => to); } });
const add = (file: F, text: string) => ({ file, mut: (t: string) => t + "\n" + text + "\n" });
const MUTANTS: Array<[string, { file: F; mut: (t: string) => string }, RegExp]> = [
  ["restore the eval barrier seam", add(WM, 'const hooks = workerData.barrier ? (0,eval)("("+workerData.barrier.source+")") : {};'), /seam: wal-maintenance.ts reads a workerData field/],
  ["restore walWorkerSeam", add(WM, "export const walWorkerSeam: { barrier: null } = { barrier: null };"), /seam: .*walWorkerSeam/],
  ["restore walMaintenanceTestHooks", add(WM, "export const walMaintenanceTestHooks = { retryMs: 1 };"), /seam: .*walMaintenanceTestHooks/],
  ["a workerData test field", rep(WM, "debtFd: debtFdFor(file),", "debtFd: debtFdFor(file), barrier: null,"), /workerData field "barrier"/],
  ["restore onWalPass / passListeners", add(WM, "const passListeners = new Set<() => void>(); export function onWalPass() {}"), /seam: .*(passListeners|onWalPass)/],
  ["restore a readAdmissionProcess override parameter", rep(IB, "export function readAdmissionProcess():IoReading {", "export function readAdmissionProcess(platform:string=process.platform):IoReading {"), /readAdmissionProcess takes a parameter/],
  ["a registerTestHandle call", add(IB, 'registerTestHandle("stop", () => {});'), /seam: .*registerTestHandle/],
  ["setAdmissionClockOffsetForFixture", add(IB, "export function setAdmissionClockOffsetForFixture(ms:number):void {}"), /seam: .*(ForFixture|setAdmissionClockOffsetForFixture)/],
  ["P1 dropped closure: checkpointLedger references a module-level const", { file: AS, mut: t => { const o = "const slots=new BigInt64Array(buffer);"; expect(t.split(o).length - 1).toBe(1); return "const EXT_CONST=1;\n" + t.replace(o, o + "const q=EXT_CONST;"); } }, /P1: checkpointLedger closes over EXT_CONST/],
  ["P1 sibling local cannot mask an external reference", { file: AS, mut: t => "const EXTERNAL=1;\n" + t.replace("const slots=new BigInt64Array(buffer);", "const slots=new BigInt64Array(buffer); function sibling() { const EXTERNAL=0; return EXTERNAL; } const q=EXTERNAL;") }, /P1: checkpointLedger closes over EXTERNAL/],
  ["P1 module binding shadows a worker global", { file: AS, mut: t => "let Atomics=globalThis.Atomics;\n" + t }, /P1: checkpointLedger closes over Atomics/],
  ["P2 a local shadows checkpointLedger at the spawn", rep(WM, "admissionSource:checkpointLedger.toString()", "admissionSource:(()=>{const checkpointLedger=()=>0;return checkpointLedger;})().toString()"), /P2: (admissionSource|checkpointLedger is shadowed)/],
  ["P2 the import specifier points at another module", rep(WM, 'import { checkpointLedger } from "./admission-shared.ts";', 'import { checkpointLedger } from "./other-shared.ts";'), /P2: wal-maintenance.ts checkpointLedger is not the ImportSpecifier/],
  ["P2 the exporting module reassigns the export before spawn", add(AS, "checkpointLedger = (() => 0) as never;"), /P2: admission-shared.ts reassigns/],
  ["P3 a second eval site", add(WM, '(0,eval)("1");'), /P3: server\/wal-maintenance.ts does not hold exactly the audited eval sites/],
  ["P3 member-form eval", add(WM, 'globalThis.eval("1");'), /P3: .*member-form eval/],
  ["P3 Function(...)", add(WM, 'Function("return 1")();'), /P3: .*Function/],
  ["P3 new Function", add(WM, 'new Function("return 1");'), /P3: .*Function/],
  ["P3 admissionSource from another producer", rep(WM, "admissionSource:checkpointLedger.toString()", "admissionSource:String(Date.now)"), /P2: admissionSource is not/],
  ["P4 ioMeterNativePath shadowed at the spawn", rep(WM, "nativeMeterPath:ioMeterNativePath(),", 'nativeMeterPath:(() => { const ioMeterNativePath = () => "/tmp/x"; return ioMeterNativePath(); })(),'), /P4: nativeMeterPath is not the zero-argument call/],
  ["P4 its specifier redirected", rep(WM, 'import { ioMeterNativeId, ioMeterNativePath, ioMeterPageSize } from "./io-meter.ts";', 'import { ioMeterNativeId, ioMeterNativePath, ioMeterPageSize } from "./io-meter-x.ts";'), /P4: ioMeterNativePath is not the ImportSpecifier/],
  ["P4 ioMeterNativePath reassigned in io-meter.ts", add(IM, 'ioMeterNativePath = () => "/x";'), /P4: io-meter.ts reassigns/],
  ["P4 nativeMeterPath assigned from another expression", rep(IM, "nativeMeterPath=path;nativeMeterId=id;", 'nativeMeterPath="/tmp/x.node";nativeMeterId=id;'), /P5b: nativeMeterPath is not published/],
  ["P5 a new candidates() push (spawn expression unchanged)", rep(EE, "  return out;\n}\n\n/** The resolved test override", '  out.push(path.resolve("/tmp/evil.node"));\n  return out;\n}\n\n/** The resolved test override'), /P5e: candidates\(\) holds 5 pushes|candidates differs/],
  ["P5a return {addon,path} before usable() (qualification bypass)", rep(EE, "const addon=require(held.copy) as Partial<ExclusionAddon>;", "const addon=require(held.copy) as Partial<ExclusionAddon>;\n      return {addon:addon as ExclusionAddon,path:held.copy,id:held.id};"), /P5a: loadIoMeterAddon returns a non-null value/],
  ["P5a drop one meter check", rep(EE, "&&addon.ioMeterBytes)return {addon,path:held.copy,id:held.id}", ")return {addon,path:held.copy,id:held.id}"), /P5a: loadIoMeterAddon returns a non-null value/],
  ["P5a the loader import redirected to another module", rep(IM, 'from "./engine-exclusion.ts";', 'from "./engine-exclusion-x.ts";'), /P5a: loadIoMeterAddon is not the ImportSpecifier/],
  ["P5b nativeMeterPath assigned before loadExtension", rep(IM, 'try{db.loadExtension(path,', 'try{nativeMeterPath=path;db.loadExtension(path,'), /P5b: nativeMeterPath is not assigned exactly once/],
  ["P5c the overrideAllowed gate removed", rep(EE, 'return env.NODE_ENV === "test" && ', "return "), /P5: engine-exclusion.ts overrideAllowed differs/],
  ["P5d a candidates() entry without path.resolve", rep(EE, "if (trimmed) out.push(path.resolve(trimmed));", "if (trimmed) out.push(trimmed);"), /P5d: a candidates\(\) push is not wrapped/],
  ["P5d the worker's absolute check removed", rep(WM, 'if (typeof p !== "string" || !path.isAbsolute(p)) refuse("the path is not absolute");', ""), /P5g: the worker's native meter check lacks path.isAbsolute/],
  ["P5e here base rewritten", rep(EE, "const here = path.dirname(fileURLToPath(import.meta.url));", 'const here = "/tmp/planted";'), /P5: engine-exclusion.ts candidates differs/],
  ["P5e a loader iterates something other than candidates()", rep(EE, "for(const file of candidates()){", "for(const file of candidates().reverse()){"), /P5e: a loader iterates something other than candidates/],
  ["P5f usable() override argument forced to true", rep(EE, "usable(addon,Boolean(explicit)&&file===explicit)&&addon.ioMeterAdd", "usable(addon,true)&&addon.ioMeterAdd"), /P5a: loadIoMeterAddon returns a non-null value/],
  ["P5f explicit = file", rep(EE, "const explicit=explicitOverride();", "const explicit=file;"), /P5: engine-exclusion.ts loadIoMeterAddon differs/],
  ["P5f unresolved operand", rep(EE, "return trimmed ? path.resolve(trimmed) : undefined;", "return trimmed ? trimmed : undefined;"), /P5: engine-exclusion.ts explicitOverride differs/],
  ["P5c overrideAllowed called with an argument", rep(EE, "if (!overrideAllowed()) return undefined;", "if (!overrideAllowed(process.env)) return undefined;"), /P5c: overrideAllowed is called with an argument/],
  ["P5e a relative resources root resolved via cwd", rep(EE, "if (rawResources && path.isAbsolute(rawResources)) out.push", "if (rawResources) out.push"), /P5: engine-exclusion.ts candidates differs/],
  ["P5e an empty override pushed as path.resolve(\"\")", rep(EE, "if (trimmed) out.push(path.resolve(trimmed));", 'out.push(path.resolve(trimmed ?? ""));'), /P5: engine-exclusion.ts candidates differs/],
  ["P5g a symlink candidate followed", rep(EE, "if (!st.isFile() || realpathSync(file) !== file) return null;", "if (!st.isFile()) return null;"), /P5: engine-exclusion.ts privateCopy differs/],
  ["P5g sha256 not checked in the worker", rep(WM, ' || crypto.createHash("sha256").update(bytes).digest("hex") !== id.sha256', ""), /P5g: the worker's native meter check lacks/],
  ["P5g dev/ino/size not checked in the worker", rep(WM, "st.dev !== id.dev || st.ino !== id.ino || st.size !== id.size", "false"), /P5g: the worker's native meter check lacks st.dev/],
  ["P5g nativeMeterPath is the candidate path rather than the private copy", rep(EE, "return {addon,path:held.copy,id:held.id}", "return {addon,path:file,id:held.id}"), /P5a: loadIoMeterAddon returns a non-null value/],
];

it("the guard is clean on the real production files", () => { expect(walGuard(real)).toEqual([]); });
for (const [name, m, expected] of MUTANTS) it(`mutant RED by assertion: ${name}`, () => {
  const mutated = { ...real, [m.file]: m.mut(real[m.file]) } as GuardSources;
  const violations = walGuard(mutated);
  expect(violations.length, `the guard missed: ${name}`).toBeGreaterThan(0);
  expect(violations.join("\n")).toMatch(expected);
});

it("P1 keeps block, parameter, destructuring and shorthand bindings local", () => {
  const sources = { ...real, [AS]: real[AS].replace("const slots=new BigInt64Array(buffer);", "const slots=new BigInt64Array(buffer); { const { name: local } = { name: 1 }; function sibling(local: number) { return { local }; } sibling(local); }") } as GuardSources;
  expect(walGuard(sources)).toEqual([]);
});
