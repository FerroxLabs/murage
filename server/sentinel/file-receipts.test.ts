// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer/consumer acceptance owner: scperf-p2-rd2; packaged F14 owner: MAIN.
import {it,expect,beforeAll,afterAll} from "vitest";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
let root:string;
beforeAll(()=>{root=mkdtempSync(join(tmpdir(),"sentinel-native-"));execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",join(root,"engine-exclusion.node")]);});
afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true});});
function run(kind:string):any{
 const code=`const {fileScenario}=await import('./server/testing/sentinel-file-fixture.ts');console.log(JSON.stringify(await fileScenario(${JSON.stringify(kind)})));`;
 return JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8",env:{...process.env,MURAGE_RESOURCES_PATH:root}}).trim());
}
it("F1/F10 descriptor without a receipt or enrollment is UNKNOWN",()=>{expect(run("missing").known).toBe(false);expect(run("boot").known).toBe(false);});
it("F2 fresh file handshake qualifies a scheduled producer without server IPC",()=>{const r=run("baseline");expect(r.cold.known).toBe(false);expect(r.first.known).toBe(true);expect(r.first.baseline).toBe(true);expect(r.first.bytes).toBe(0);expect(r.receipt.phase).toBe("sealed");expect(r.receipt.totalBytes).toBe(8192);});
it("F3 stable endpoints charge controlled writes plus both transport publications exactly once",()=>{const r=run("delta");expect(r.second.known).toBe(true);expect(r.second.bytes).toBe(1234+8192);expect(r.same.bytes).toBe(r.second.bytes);expect(r.same.known).toBe(true);});
it("F4 cumulative checkpoint sums several outer runs and duplicate polls add zero",()=>{const r=run("several");expect(r.second.bytes).toBe(111+222+333+3*8192);expect(r.same.bytes).toBe(r.second.bytes);});
for(const kind of ["active","orphan","contention"])it(`F5 ${kind} blocks exclusive snapshots and clean handshake restores eligibility`,()=>{const r=run(kind);expect(r.blocked.known).toBe(false);if(kind==="orphan"){expect(r.held.known).toBe(false);expect(r.sealed).toBe(false);}expect(r.after.known).toBe(true);});
it("F6/F7 crashed ACTIVE cannot hide loss across polls",()=>{const r=run("crash");expect(r.changed.lossSerial).toBe(r.before.lossSerial+1);expect(r.changed.epoch).not.toBe(r.before.epoch);expect(r.after.known).toBe(false);expect(r.handshake.known).toBe(true);expect(r.handshake.baseline).toBe(true);});
for(const kind of ["mac","short","nonce","id","digest","entry","revision","sequence","counter","epoch","key","request","native"])it(`F8/F11 rejects ${kind} and preserves accepted floors`,()=>{const r=run(`bad-${kind}`);expect(r.first.known).toBe(true);expect(r.bad.known).toBe(false);expect(r.bad.bytes).toBeGreaterThanOrEqual(r.first.bytes);});
for(const kind of ["stale","future","suspend"])it(`F9 ${kind} endpoint is UNKNOWN until fresh challenge`,()=>{const r=run(kind);expect(r.invalid.known).toBe(false);expect(r.fresh.known).toBe(true);expect(r.fresh.baseline).toBe(true);});
for(const kind of ["missing","request","permissions","directory","parent","hardlink","link","denied"])it(`F10 native handle security rejects ${kind}`,()=>{const r=run(`fs-${kind}`);expect(r.first.known).toBe(true);expect(r.bad.known).toBe(false);});
it("F8 canonical fixed receipt rejects duplicate/unknown/overflow and trailing bytes",()=>{expect(run("codec")).toEqual({size:4096,valid:"sealed",rejected:[true,true,true,true,true]});});
it("F10 existing enrollment never regenerates a lost key",()=>{expect(run("no-regen")).toEqual({provisioned:false,known:false});});
it("F12 server restart requires a new nonce and does not charge historical bytes",()=>{const r=run("restart");expect(r.old.known).toBe(false);expect(r.fresh.known).toBe(true);expect(r.fresh.bytes).toBe(0);expect(r.next.bytes).toBe(1000+8192);});
it("F16 duplicate samples retain a constant bounded operation and byte count",()=>{const r=run("cost");expect(r.every((s:any)=>s.known)).toBe(true);expect(new Set(r.map((s:any)=>s.reads)).size).toBe(1);expect(new Set(r.map((s:any)=>s.bytes)).size).toBe(1);expect(r[0].reads).toBe(4);});

it("F2 real --once CLI publishes cumulative file receipts without server IPC",()=>{const r=run("cli");expect(r.output).toContain('"status":"done"');expect(r.receipt.phase).toBe("sealed");expect(r.receipt.known).toBe(true);expect(r.receipt.totalBytes).toBeGreaterThan(8192);});
for(const kind of ["missing-final","partial-final","replace-error","late-write"])it(`F6/F11 ${kind} cannot leave a valid lower sealed checkpoint`,()=>{const r=run(kind);expect(r.sealed).toBe(false);expect(r.snapshot.known).toBe(false);});

it("F3 consumer Windows control and actual budget tick import the external delta once",()=>{const r=run("consumer");expect(r.native).toBe(true);expect(r.known).toBe(true);expect(r.desktopControl).toBe(true);expect(r.measured.writeBytesPerMinute).toBe(1234+8192);expect(r.duplicate.writeBytesPerMinute).toBe(0);expect(r.samples.at(-2).discontinuity).toBe(false);expect(r.duplicateIpc).toBe(0);expect(r.otherGap).toBe(false);expect(r.admissionReceiptReads).toBe(0);});
it("F13 concurrent scheduler and fallback serialize; losing launcher writes nothing",()=>{const r=run("concurrent");expect(r.loser).toBe(false);expect(r.writes).toBe(0);expect(r.receipt.phase).toBe("sealed");});

it("F5 orphaned descendant keeps its own OS lease after the supervisor releases its handles",()=>{const r=run("orphan-process");expect(r.blocked.known).toBe(false);expect(r.refused).toBe(true);});
it("F16 1k versus 100k history and many previous runs have identical bounded snapshot costs",()=>{const small=run("cost-1k"),large=run("cost-100k");expect(small.map((s:any)=>[s.known,s.reads,s.bytes])).toEqual(large.map((s:any)=>[s.known,s.reads,s.bytes]));expect(small.every((s:any)=>s.known)).toBe(true);});

it("F13 upgrade without legacy writer exclusion remains unenrolled and UNKNOWN",()=>{const r=run("legacy");expect(r.enrolled).toBe(false);expect(r.exists).toBe(false);expect(r.snapshot.known).toBe(false);});
it("F15 installer includes authenticated file enrollment only after explicit legacy drain",()=>{expect(run("installer")).toEqual({legacy:true,legacyKnown:false,legacyEnrolled:false,enrolled:true,key:true});});

it("F7 a fresh file cycle may measure a new endpoint while IPC retains prior child loss",()=>{expect(run("child-recovery")).toEqual({legacyKnown:false,cycleKnown:true});});

it("F15 server resolves the canonical installation receipt when the scanner sees a projected root",()=>{const r=run("projection");expect(r.projectedExists).toBe(false);expect(r.before.known).toBe(false);expect(r.after.known).toBe(true);});

it("F11/F13 writable installation probe enters the barrier and includes redirected output before sealing",()=>{const r=run("probe");expect(r.code).toBe(3);expect(r.receipt.phase).toBe("sealed");expect(r.receipt.known).toBe(true);expect(r.outputBytes).toBeGreaterThan(0);expect(r.receipt.totalBytes).toBeGreaterThanOrEqual(2*8192+r.outputBytes);});

it("F15 installer forwards qualified native resources and Windows OS paths without qualifying coverage from environment",()=>{expect(run("installer-env")).toEqual({resources:true,windows:true,stripped:true,known:false});});

it("F3 sampling timestamps the counters after acquiring and reading the receipt",()=>{const r=run("sample-time");expect(r.snapshot.known).toBe(true);expect(r.snapshot.at).toBe(r.process.at);});

it("F3 one receipt endpoint captures process counters once even when the callback returns undefined",()=>{expect(run("capture-once")).toEqual({known:true,calls:1});});

it("F1/F11 a child environment flag without IPC cannot admit an unreported writer into ACTIVE",()=>{expect(run("child-flag")).toEqual({code:12,stdout:"",unchanged:true});});

it("F15 scanner retains the macOS OS byte floor and rejects a missing OS reading",()=>{const r=run("darwin-floor");expect(r.positive).toBe(true);expect(r.bytes).toBe(r.floor);expect(r.missing).toBe(false);});

// MAIN RULING 1114-SCPERF-RECEIPT: no-follow applies to the scanner as well as its reader.
for(const kind of ["directory","dangling","lock","temporary","destination"])it(`F17 ${kind} symlink refuses scanner writes and complete coverage`,()=>{
 const r=run(`nofollow-${kind}`);expect(r.positive).toBe(true);expect(r.bad).toBe(false);expect(r.code).not.toBe(0);expect(r.unchanged).toBe(true);
});
it("F17 a directory swapped after native open invalidates that same snapshot",()=>{
 expect(run("nofollow-swap")).toEqual({first:true,swapped:true,bad:false});
});
