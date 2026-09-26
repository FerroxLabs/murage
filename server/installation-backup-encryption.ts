import { constants, closeSync, fstatSync, openSync, createWriteStream, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { win32 } from "node:path";
import { backupAgePinForTarget } from "../shared/backup-age-pin.ts";
import { trustedBackupAgeExecutable, normalizeBackupAgeDiagnostic } from "../electron/backup-age-attestation.mjs";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import { createWindowsBackupResourceResolver } from "./windows-backup-resources.ts";
import { redactCauseText } from "../shared/backup-capture-failure.mjs";
function fail(code: string): never { throw new InstallationSnapshotError(code); }
export function assertBackupAgeTool(executable: string, operation: "encrypt"|"decrypt" = "encrypt") {
  if (!backupAgePinForTarget(process.platform, process.arch)) fail("AGE_TOOL_PLATFORM_UNQUALIFIED");
  let observed:Record<string,unknown>|undefined;
  if(!trustedBackupAgeExecutable(executable,{report:(facts:Record<string,unknown>)=>{observed??=facts;}})){
    const diagnostic=normalizeBackupAgeDiagnostic({...observed,operation});
    throw Object.assign(new InstallationSnapshotError("AGE_TOOL_UNVERIFIED"),diagnostic?{backupAgeAttestation:diagnostic}:{});
  }
}
/** Private host policy: derived only from the actual installed process, never
 * a renderer resource root, trust flag, or injected verification callback. */
export async function resolveWindowsBackupRuntime(requestedAge: string) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("AGE_TOOL_PLATFORM_UNQUALIFIED");
  const verifyHelper = createWindowsBackupResourceResolver({ resourcesPath: win32.join(win32.dirname(process.execPath), "resources"), currentExecutable: process.execPath });
  const { executable } = await verifyHelper();
  const ageExecutable = win32.join(win32.dirname(executable), "age.exe");
  if (typeof requestedAge !== "string" || requestedAge.toLowerCase() !== ageExecutable.toLowerCase()) fail("AGE_TOOL_UNVERIFIED");
  return { ageExecutable, verifyHelper };
}
export function backupIdentity(input: string): string {
  const lines=input.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith("#"));
  if(input.length>4096||lines.length!==1||!/^AGE-SECRET-KEY-1[A-Z0-9]{40,120}$/.test(lines[0])) fail("AGE_NATIVE_IDENTITY_REQUIRED");
  return lines[0]+"\n";
}
export function backupRecipient(input: string): string {
  if(!/^age1[a-z0-9]{40,100}$/.test(input)) fail("AGE_NATIVE_RECIPIENT_REQUIRED");
  return input;
}
export interface BackupAgeLimits { maxBytes: number; signal?: AbortSignal; timeoutMs?: number; closeTimeoutMs?: number }
/** Never equate a kill request with observed process closure. */
export async function stopBackupAgeProcess(child: { kill: (signal: NodeJS.Signals) => unknown }, isClosed: () => boolean, closed: Promise<unknown>, waitMs: number): Promise<boolean> {
  for(const signal of ["SIGTERM","SIGKILL"] as const){
    if(isClosed())return true;
    try{child.kill(signal);}catch{/* Still require observed closure. */}
    let timer:ReturnType<typeof setTimeout>|undefined;
    const observed=await Promise.race([closed.then(isClosed,isClosed),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),waitMs);})]);
    if(timer)clearTimeout(timer);
    if(observed||isClosed())return true;
  }
  return isClosed();
}
async function runAge(executable: string,args: string[],input: Readable,output: string,options: BackupAgeLimits, inputFd?: number) {
  if(options.signal?.aborted) fail("SNAPSHOT_CANCELLED");
  const timeoutMs=options.timeoutMs??15*60_000,closeTimeoutMs=options.closeTimeoutMs??5000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30*60_000||!Number.isSafeInteger(closeTimeoutMs)||closeTimeoutMs<1||closeTimeoutMs>30_000)fail("INVALID_AGE_PROCESS_LIMITS");
  const outputFd=openSync(output,"wx",0o600);
  let bytes=0;
  const child=spawn(executable,args,{stdio:inputFd===undefined?["pipe","pipe","pipe"]:["pipe","pipe","pipe",inputFd],env:{PATH:""},windowsHide:true});
  let didClose=false;
  // Log-only facts about the tool (never shown, never returned to a window):
  // its exit, a spawn errno, and the head of its error output. The head is
  // redacted by the log writer and again here, because it may name files.
  const tool:{tool:"age";exitCode?:number;signal?:string;errno?:string;stderr?:string}={tool:"age"};
  const closed=new Promise<void>((resolve,reject)=>{child.once("error",error=>{if(!child.pid)didClose=true;const errno=(error as NodeJS.ErrnoException).code;if(typeof errno==="string")tool.errno=errno;reject(new InstallationSnapshotError("AGE_PROCESS_FAILED"));});child.once("close",(code,signal)=>{didClose=true;if(typeof code==="number")tool.exitCode=code;if(signal)tool.signal=signal;code===0?resolve():reject(new InstallationSnapshotError("AGE_PROCESS_FAILED"));});});
  void closed.catch(()=>{});
  // Native stderr is never shown: it may contain filenames or key parser
  // input. Only a bounded head is kept, and only for the redacted log.
  let stderrHead="";
  child.stderr!.on("data",(chunk:Buffer)=>{if(stderrHead.length<1024)stderrHead+=chunk.toString("utf8").slice(0,1024-stderrHead.length);});
  const withTool=(code:string)=>{const stderr=redactCauseText(stderrHead);return Object.assign(new InstallationSnapshotError(code),{toolDiagnostic:{...tool,...(stderr?{stderr}:{}),...(tool.errno?{errno:tool.errno,syscall:"spawn"}:{})}});};
  const destination=createWriteStream(output,{fd:outputFd,autoClose:true});
  const bound=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>options.maxBytes?new InstallationSnapshotError("BACKUP_LIMIT_EXCEEDED"):null,chunk);}});
  const abort=()=>{child.kill("SIGTERM");};
  options.signal?.addEventListener("abort",abort,{once:true});
  const transfers=[pipeline(input,child.stdin!,{signal:options.signal}),pipeline(child.stdout!,bound,destination,{signal:options.signal})];
  for(const transfer of transfers)void transfer.catch(()=>{});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new InstallationSnapshotError("AGE_TOOL_TIMEOUT")),timeoutMs);});
  try {
    await Promise.race([Promise.all([...transfers,closed]),deadline]);
  } catch (error) {
    const confirmed=await stopBackupAgeProcess(child,()=>didClose,closed,closeTimeoutMs);
    input.destroy();child.stdin?.destroy();child.stdout?.destroy();destination.destroy();
    if(!confirmed){child.stderr?.destroy();child.unref();throw withTool("AGE_PROCESS_CLOSE_UNCONFIRMED");}
    await Promise.allSettled(transfers);
    if(process.platform!=="win32")rmSync(output,{force:true});
    const reported=withTool(options.signal?.aborted?"SNAPSHOT_CANCELLED":error instanceof InstallationSnapshotError&&error.code==="AGE_TOOL_TIMEOUT"?"AGE_TOOL_TIMEOUT":"AGE_PROCESS_FAILED");
    // A pipe failure (the zip stream feeding age, or the output file) is the
    // real cause when age itself exited cleanly: keep its errno for the log.
    const pipe=error as NodeJS.ErrnoException|undefined;
    if(!(error instanceof InstallationSnapshotError)&&pipe&&typeof pipe==="object")Object.assign(reported.toolDiagnostic,{...(typeof pipe.code==="string"&&/^E[A-Z]/.test(pipe.code)?{errno:pipe.code}:{}),...(typeof pipe.syscall==="string"?{syscall:pipe.syscall}:{}),...(typeof pipe.message==="string"?{message:redactCauseText(pipe.message,160)}:{})});
    else{const inner=(error as {toolDiagnostic?:object}|undefined)?.toolDiagnostic;if(inner&&typeof inner==="object")Object.assign(reported.toolDiagnostic,inner);}
    throw reported;
  } finally {
    if(timer)clearTimeout(timer);
    options.signal?.removeEventListener("abort",abort);
    input.destroy();destination.destroy();
  }
}
export async function encryptBackupStream(executable: string,recipient: string,input: Readable,output: string,options: BackupAgeLimits) {
  if(process.platform==="win32")await resolveWindowsBackupRuntime(executable);
  else assertBackupAgeTool(executable,"encrypt");
  return runAge(executable,["--encrypt","--recipient",backupRecipient(recipient),"--output","-"],input,output,options);
}
export async function decryptBackupFile(executable: string,identity: string,input: string,output: string,options: BackupAgeLimits) {
  assertBackupAgeTool(executable,"decrypt"); // Windows decrypt must use the native transport, never fd3.
  const key=backupIdentity(identity);
  const fd=openSync(input,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)fail("UNSAFE_ARCHIVE_FILE");
    // The admitted POSIX tool reads this already-open descriptor; path replacement
    // cannot redirect decryption to a different file. Identity stays on stdin.
    await runAge(executable,["--decrypt","--identity","-","--output","-","/dev/fd/3"],Readable.from([key]),output,options,fd);
  } finally { closeSync(fd); }
}
