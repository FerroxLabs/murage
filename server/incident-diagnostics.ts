import { constants,closeSync,fstatSync,lstatSync,openSync,readSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute,join } from "node:path";
import { z } from "zod";
import { DIAGNOSTIC_FAILURE_KINDS,DIAGNOSTIC_RPC_METHODS,parseRuntimeErrorDiagnostic,runtimeErrorDiagnosticSchema,type RuntimeErrorDiagnostic } from "../shared/error-diagnostic.ts";

export const INCIDENT_READ_BYTES=1024*1024;
export const INCIDENT_LINE_BYTES=64*1024;
export const INCIDENT_MAX_ROWS=100;
export const INCIDENT_OUTPUT_BYTES=128*1024;
const natural=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer=z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const version=z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,24})?$/).nullable();
const method=z.enum([...DIAGNOSTIC_RPC_METHODS,"other"]);
const rowSchema=z.object({
  at:z.iso.datetime(),event:z.enum(["spawn_requested","spawned","spawn_failed","rpc_requested","rpc_rejected","stop_requested","stop_route","stop_route_result","turn_settled","closed","events_omitted","mcp_ready","mcp_ready_timeout"]),
  processGeneration:z.uuid(),turnId:z.uuid(),sequence:natural.min(1),elapsedMs:natural,platform:z.enum(["darwin","linux","win32","other"]),
  appVersion:version.optional(),engineVersion:version.optional(),pid:natural.min(1).nullable().optional(),
  rpcId:natural.optional(),method:method.optional(),rpcCode:integer.optional(),httpStatus:z.number().int().min(100).max(599).optional(),
  terminalKind:z.enum(DIAGNOSTIC_FAILURE_KINDS).optional(),observedKind:z.enum(DIAGNOSTIC_FAILURE_KINDS).optional(),
  pendingMethods:z.array(method).max(8).optional(),pendingCount:natural.optional(),
  reason:z.enum(["user_cancel","driver_dispose","turn_complete","turn_failure","cancel_timeout","unspecified"]).optional(),
  route:z.enum(["windows_taskkill","windows_child_kill","posix_group_sigterm","posix_child_sigterm","already_exited"]).optional(),
  result:z.enum(["requested","succeeded","failed","fallback"]).optional(),
  errno:z.enum(["ENOENT","EACCES","EPERM","ESRCH","EINVAL","ENAMETOOLONG","E2BIG","EAGAIN","ENOMEM","EMFILE","ETIMEDOUT","EPIPE","ECHILD","other"]).optional(),
  code:integer.nullable().optional(),signal:z.string().refine(value=>Object.hasOwn(osConstants.signals,value)).nullable().optional(),
  settled:z.boolean().optional(),cancelRequested:z.boolean().optional(),promptSent:z.boolean().optional(),
}).strict();
export type IncidentLifecycleRow=z.infer<typeof rowSchema>;
const segmentStatus=z.enum(["read","missing","unavailable","budget-skipped","not-requested"]);
const coverageSchema=z.object({scope:z.literal("current-and-previous-tail"),segments:z.object({current:segmentStatus,previous:segmentStatus}).strict(),readBytes:z.number().int().min(0).max(INCIDENT_READ_BYTES),missing:z.boolean(),unavailable:z.boolean(),generationMissing:z.boolean(),tailLimited:z.boolean(),truncated:z.boolean(),invalidLines:natural.max(INCIDENT_READ_BYTES),oversizedLines:natural.max(INCIDENT_READ_BYTES),omittedRows:natural.max(INCIDENT_READ_BYTES)}).strict();
const responseSchema=z.object({version:z.literal(1),diagnostic:runtimeErrorDiagnosticSchema,rows:z.array(rowSchema).max(INCIDENT_MAX_ROWS),coverage:coverageSchema}).strict().superRefine((value,context)=>{
  if(value.rows.some(row=>row.turnId!==value.diagnostic.turnId||row.processGeneration!==value.diagnostic.processGeneration)||value.coverage.missing!==(value.rows.length===0)||value.coverage.generationMissing!==(value.diagnostic.processGeneration===undefined))context.addIssue({code:"custom",message:"Invalid incident correlation"});
});
export type IncidentDiagnostics=z.infer<typeof responseSchema>;
/** Pure, strict native-boundary validation; importing this module reads no files. */
export function parseIncidentDiagnostics(value:unknown):IncidentDiagnostics|undefined{
  try{
    if(!value||typeof value!=="object"||!Array.isArray((value as {rows?:unknown}).rows)||(value as {rows:unknown[]}).rows.length>INCIDENT_MAX_ROWS)return;
    const parsed=responseSchema.safeParse(value);if(!parsed.success||Buffer.byteLength(JSON.stringify(parsed.data))>INCIDENT_OUTPUT_BYTES)return;return parsed.data;
  }catch{return;}
}
const ROW_FIELDS=["event","processGeneration","turnId","sequence","elapsedMs","platform","appVersion","engineVersion","pid","rpcId","method","rpcCode","httpStatus","terminalKind","observedKind","pendingMethods","pendingCount","reason","route","result","errno","code","signal","settled","cancelRequested","promptSent"] as const;
type Segment="current"|"previous";

/** Server-owned path and already-authorized selected diagnostic only. This does
 * not discover threads or authorize callers. Counts describe inspected tails,
 * never the complete incident history. No raw in/out record reaches the DTO. */
export function readIncidentDiagnostics(input:{nativeDir:string;threadId:string;diagnostic:RuntimeErrorDiagnostic}):IncidentDiagnostics{
  const diagnostic=parseRuntimeErrorDiagnostic(input.diagnostic);
  if(!diagnostic||!isAbsolute(input.nativeDir)||!/^[A-Za-z0-9_-]{1,128}$/.test(input.threadId))throw Error("INVALID_INCIDENT_SELECTION");
  const result:IncidentDiagnostics={version:1,diagnostic,rows:[],coverage:{scope:"current-and-previous-tail",segments:{current:"not-requested",previous:"not-requested"},readBytes:0,missing:true,unavailable:false,generationMissing:diagnostic.processGeneration===undefined,tailLimited:false,truncated:false,invalidLines:0,oversizedLines:0,omittedRows:0}};
  const coverage=result.coverage;
  if(!diagnostic.processGeneration)return result;
  try{const dir=lstatSync(input.nativeDir);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error();}
  catch(error){const missing=(error as NodeJS.ErrnoException).code==="ENOENT";coverage.segments={current:missing?"missing":"unavailable",previous:missing?"missing":"unavailable"};coverage.unavailable=!missing;return result;}
  for(const segment of ["current","previous"] as const){
    const remaining=INCIDENT_READ_BYTES-coverage.readBytes;
    if(!remaining){coverage.segments[segment]="budget-skipped";coverage.tailLimited=true;continue;}
    readSegment(segment,join(input.nativeDir,`${input.threadId}${segment==="previous"?".previous":""}.ndjson`),remaining);
  }
  result.rows.reverse();coverage.missing=result.rows.length===0;
  while(Buffer.byteLength(JSON.stringify(result))>INCIDENT_OUTPUT_BYTES&&result.rows.length){result.rows.shift();coverage.omittedRows++;coverage.truncated=true;}
  coverage.missing=result.rows.length===0;
  return result;

  function readSegment(segment:Segment,file:string,limit:number){
    let fd:number|undefined;let buffer:Buffer;
    try{
      const before=lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error();
      fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const opened=fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw Error();
      const length=Math.min(opened.size,limit),offset=opened.size-length;buffer=Buffer.alloc(length);let read=0;
      while(read<length){const count=readSync(fd,buffer,read,length-read,offset+read);if(!count)break;read+=count;coverage.readBytes+=count;}
      buffer=buffer.subarray(0,read);
      const after=fstatSync(fd),named=lstatSync(file);
      if(read!==length||[after,named].some(stat=>!stat.isFile()||stat.nlink!==1||stat.dev!==opened.dev||stat.ino!==opened.ino||stat.size!==opened.size||stat.mtimeMs!==opened.mtimeMs||stat.ctimeMs!==opened.ctimeMs))throw Error();
      coverage.segments[segment]="read";
      if(offset>0){coverage.tailLimited=true;coverage.truncated=true;const newline=buffer.indexOf(10);buffer=newline<0?Buffer.alloc(0):buffer.subarray(newline+1);}
    }catch(error){coverage.segments[segment]=(error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"unavailable";coverage.unavailable ||= coverage.segments[segment]==="unavailable";return;}
    finally{if(fd!==undefined)closeSync(fd);}
    // Only newline-terminated records are complete. Scan newest first so the
    // shared row cap prioritizes current over the previous rotated segment.
    let end=buffer.lastIndexOf(10);if(end!==buffer.length-1)coverage.truncated=true;
    while(end>=0){const start=end===0?0:buffer.lastIndexOf(10,end-1)+1,line=buffer.subarray(start,end);end=start-1;if(!line.length)continue;
      if(line.length>INCIDENT_LINE_BYTES){coverage.oversizedLines++;coverage.truncated=true;continue;}
      let value:any;try{value=JSON.parse(line.toString("utf8"));}catch{coverage.invalidLines++;continue;}
      if(value?.dir!=="lifecycle"||value.source!=="murage.engine-lifecycle"||value.msg?.processGeneration!==diagnostic!.processGeneration||value.msg?.turnId!==diagnostic!.turnId)continue;
      if(value.msg.type!=="engine_lifecycle"||value.msg.schema!==1){coverage.invalidLines++;continue;}
      const projection:Record<string,unknown>={at:value.at};for(const key of ROW_FIELDS)if(Object.hasOwn(value.msg,key))projection[key]=value.msg[key];
      const parsed=rowSchema.safeParse(projection);if(!parsed.success){coverage.invalidLines++;continue;}
      if(result.rows.length>=INCIDENT_MAX_ROWS){coverage.omittedRows++;coverage.truncated=true;}else result.rows.push(parsed.data);
    }
  }
}
