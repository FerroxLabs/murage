import { appendFileSync,linkSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it,vi } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { createLifecycleRecorder } from "./drivers/lifecycle-diagnostic.ts";
import { INCIDENT_LINE_BYTES,INCIDENT_MAX_ROWS,INCIDENT_OUTPUT_BYTES,INCIDENT_READ_BYTES,parseIncidentDiagnostics,readIncidentDiagnostics } from "./incident-diagnostics.ts";
const mutation=vi.hoisted(()=>({file:""}));
vi.mock("node:fs",async original=>{const fs=await original<typeof import("node:fs")>();return{...fs,readSync:(...args:Parameters<typeof fs.readSync>)=>{const count=fs.readSync(...args);if(mutation.file){fs.appendFileSync(mutation.file,"changed\n");mutation.file="";}return count;}};});
const roots:string[]=[];
afterEach(()=>{mutation.file="";for(const root of roots.splice(0))safeWipeSync(root);});
function fixture(){
 const nativeDir=mkdtempSync(join(tmpdir(),"murage-incident-reader-"));roots.push(nativeDir);
 const turnId="11111111-1111-4111-8111-111111111111",threadId="thread-fixture";let raw:any;
 const recorder=createLifecycleRecorder({threadId,turnId,driver:"fuigoAgent",instanceId:"private-account-canary",sink:(_thread,entry)=>{raw={at:"2026-09-13T00:00:00.000Z",...entry};}});
 recorder.record("rpc_rejected",{rpcId:3,method:"session/prompt",rpcCode:-32603,httpStatus:402,terminalKind:"http",observedKind:"api"});
 const diagnostic={version:1 as const,diagnosticId:"ev-m00001-1",turnId,processGeneration:recorder.generation,rpcId:3,method:"session/prompt" as const,rpcCode:-32603,httpStatus:402};
 return{nativeDir,threadId,diagnostic,raw,current:join(nativeDir,threadId+".ndjson"),previous:join(nativeDir,threadId+".previous.ndjson"),read(){return readIncidentDiagnostics({nativeDir,threadId,diagnostic});},line:(value:unknown)=>JSON.stringify(value)+"\n"};
}
it("projects actual lifecycle rows by exact generation AND turn, never raw protocol/account/body",()=>{
 const f=fixture();writeFileSync(f.current,[{...f.raw,dir:"in",msg:{body:"private-protocol-canary"}}, {...f.raw,msg:{...f.raw.msg,turnId:"22222222-2222-4222-8222-222222222222"}}, {...f.raw,msg:{...f.raw.msg,processGeneration:"22222222-2222-4222-8222-222222222222"}}, {...f.raw,msg:{...f.raw.msg,message:"private-body-canary",url:"https://private.invalid/key"}}, {...f.raw,msg:{...f.raw.msg,event:"events_omitted",turnId:undefined,omitted:99,omittedReason:"budget"}}].map(f.line).join(""));
 const result=f.read();expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({event:"rpc_rejected",turnId:f.diagnostic.turnId,processGeneration:f.diagnostic.processGeneration,httpStatus:402,terminalKind:"http",observedKind:"api"});expect(result.diagnostic).toEqual(f.diagnostic);
 expect(JSON.stringify(result)).not.toMatch(/private-|private\.invalid|instanceId|driver|source|body|omittedReason/);expect(result.coverage.omittedRows).toBe(0);expect(parseIncidentDiagnostics(result)).toEqual(result);
});
it("reads exactly the writer's previous segment with remaining budget and keeps newest100 rows",()=>{
 const f=fixture();const rows=(start:number,end:number)=>Array.from({length:end-start+1},(_,index)=>f.line({...f.raw,msg:{...f.raw.msg,sequence:start+index}})).join("");writeFileSync(f.previous,rows(1,60));writeFileSync(f.current,rows(61,120));
 const result=f.read();expect(result.coverage.segments).toEqual({current:"read",previous:"read"});expect(result.rows).toHaveLength(INCIDENT_MAX_ROWS);expect(result.rows.map(row=>row.sequence)).toEqual(Array.from({length:100},(_,index)=>21+index));expect(result.coverage).toMatchObject({omittedRows:20,truncated:true,tailLimited:false});expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(INCIDENT_OUTPUT_BYTES);
});
it("limits aggregate read to1MiB and reports skipped previous, incomplete prefix and oversized lines",()=>{
 const f=fixture();writeFileSync(f.current,"x".repeat(INCIDENT_READ_BYTES+100)+"\n"+"y".repeat(INCIDENT_LINE_BYTES+1)+"\n"+f.line(f.raw));writeFileSync(f.previous,f.line(f.raw));
 const result=f.read();expect(result.coverage).toMatchObject({readBytes:INCIDENT_READ_BYTES,tailLimited:true,truncated:true,oversizedLines:1,segments:{current:"read",previous:"budget-skipped"}});expect(result.rows).toHaveLength(1);expect(parseIncidentDiagnostics(result)).toBeDefined();
});
it("reports malformed lifecycle and trailing partial records without claiming complete history",()=>{
 const f=fixture();writeFileSync(f.current,"not-json\n"+f.line({...f.raw,msg:{...f.raw.msg,httpStatus:"402"}})+f.line({...f.raw,msg:{...f.raw.msg,terminalKind:"private-kind-canary"}})+f.line(f.raw)+"{partial-private");
 const result=f.read();expect(result.rows).toHaveLength(1);expect(result.coverage).toMatchObject({invalidLines:3,truncated:true,missing:false});expect(JSON.stringify(result)).not.toMatch(/private|partial/);
});
it("missing files or generation remain explicitly missing with no invented incident rows",()=>{
 const f=fixture();expect(f.read().coverage).toMatchObject({missing:true,unavailable:false,segments:{current:"missing",previous:"missing"}});
 const {processGeneration:_generation,...diagnostic}=f.diagnostic;const result=readIncidentDiagnostics({...f,diagnostic});expect(result.coverage).toMatchObject({generationMissing:true,missing:true,readBytes:0,segments:{current:"not-requested",previous:"not-requested"}});expect(result.rows).toEqual([]);
});
it("refuses traversal, symlinks, hardlinks and nonregular files without leaking paths",()=>{
 const f=fixture();expect(()=>readIncidentDiagnostics({...f,threadId:"../outside"})).toThrow("INVALID_INCIDENT_SELECTION");expect(()=>readIncidentDiagnostics({...f,diagnostic:{...f.diagnostic,diagnosticId:"private"}})).toThrow("INVALID_INCIDENT_SELECTION");
 const target=join(f.nativeDir,"outside");writeFileSync(target,"private-file-canary");symlinkSync(target,f.current);mkdirSync(f.previous);const symlink=f.read();expect(symlink.coverage.unavailable).toBe(true);expect(symlink.rows).toEqual([]);
 const other=fixture();linkSync(target,other.current);expect(other.read().coverage.segments.current).toBe("unavailable");expect(readFileSync(target,"utf8")).toBe("private-file-canary");
});
it("refuses a file changed during its held-FD read and does not exceed aggregate budget",()=>{
 const f=fixture();writeFileSync(f.current,f.line(f.raw));mutation.file=f.current;const result=f.read();expect(result.coverage).toMatchObject({unavailable:true,missing:true,segments:{current:"unavailable"}});expect(result.rows).toEqual([]);expect(result.coverage.readBytes).toBeLessThanOrEqual(INCIDENT_READ_BYTES);
});
it("native response parser rejects unknown/private fields, foreign rows and excessive bounds",()=>{
 const f=fixture();appendFileSync(f.current,f.line(f.raw));const result=f.read();for(const value of [{...result,raw:"private-canary"},{...result,rows:[{...result.rows[0],message:"private-canary"}]},{...result,rows:[{...result.rows[0],turnId:"22222222-2222-4222-8222-222222222222"}]},{...result,rows:Array(101).fill(result.rows[0])},{...result,coverage:{...result.coverage,readBytes:INCIDENT_READ_BYTES+1}},{...result,rows:[{...result.rows[0],engineVersion:"private-canary"}]},{...result,coverage:{...result.coverage,missing:true}}])expect(parseIncidentDiagnostics(value)).toBeUndefined();
});
