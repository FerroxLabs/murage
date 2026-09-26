import { normalizeBackupAgeDiagnostic } from "../electron/backup-age-attestation.mjs";
import { installationRecoveryCommand } from "../server/installation-recovery-command.ts";
import { recoveryDesktopSummary } from "../electron/installation-recovery-protocol.mjs";
import { randomUUID } from "node:crypto";
import { describeCaptureError } from "../shared/backup-capture-failure.mjs";

const parentPort = (process as typeof process & { parentPort?: { on(event: string, listener: (event: { data?: unknown }) => void): void; removeListener(event: string, listener: (event: { data?: unknown }) => void): void; postMessage(value: unknown): void } }).parentPort;
let inputUsed=false;
async function privateIdentity():Promise<string>{
  if(!parentPort||inputUsed)throw Object.assign(new Error("INVALID_RECOVERY_INPUT"),{code:"INVALID_RECOVERY_INPUT"});
  inputUsed=true;const nonce=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{parentPort.removeListener("message",receive);reject(Object.assign(new Error("RECOVERY_INPUT_TIMEOUT"),{code:"RECOVERY_INPUT_TIMEOUT"}));},30000);
    const receive=(event:{data?:unknown})=>{
      const message=event.data as {type?:unknown;nonce?:unknown;identity?:unknown}|undefined;
      if(message?.type!=="murage:recovery-input")return;
      clearTimeout(timer);parentPort.removeListener("message",receive);
      if(message.nonce!==nonce||typeof message.identity!=="string"||Buffer.byteLength(message.identity)>4096){reject(Object.assign(new Error("INVALID_RECOVERY_INPUT"),{code:"INVALID_RECOVERY_INPUT"}));return;}
      resolve(message.identity);
    };
    parentPort.on("message",receive);parentPort.postMessage({type:"murage:recovery-input-ready",nonce});
  });
}

let reply: Record<string, unknown>;
let exitCode = 0;
try {
  reply = recoveryDesktopSummary(await installationRecoveryCommand(process.argv.slice(2),parentPort?{readIdentity:privateIdentity}:{}));
} catch (error) {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate) ? candidate : "RECOVERY_OPERATION_FAILED";
  const retainedDirectory=(process.platform==="win32"||code==="AGE_PROCESS_CLOSE_UNCONFIRMED")&&error&&typeof error==="object"&&"retainedDirectory"in error&&typeof error.retainedDirectory==="string"&&error.retainedDirectory.length<=8192?error.retainedDirectory:undefined;
  let backupAgeAttestation;try{if(code==="AGE_TOOL_UNVERIFIED"&&error&&typeof error==="object"&&"backupAgeAttestation" in error)backupAgeAttestation=normalizeBackupAgeDiagnostic(error.backupAgeAttestation);}catch{/* Keep the original failure. */}
  // Log-only, redacted: the step, errno and tool exit behind the code.
  let cause;try{cause=describeCaptureError(error)??undefined;}catch{/* Keep the original failure. */}
  reply = { ok: false, error: code, ...(retainedDirectory?{retainedDirectory}:{}),...(backupAgeAttestation?{backupAgeAttestation}:{}),...(cause?{cause}:{}) };
  exitCode = 1;
}
if (parentPort) {
  // Electron's stdout stream need not emit end after utility exit. Send a
  // bounded result on the private channel and wait for its exact ACK before
  // exit; the parent still requires actual exit to finish the operation.
  const nonce = randomUUID();
  const timer = setTimeout(() => process.exit(1), 10_000);
  parentPort.on("message", event => {
    const value = event.data as { type?: string; nonce?: string } | undefined;
    if (value?.type === "murage:recovery-result-ack" && value.nonce === nonce) {
      clearTimeout(timer);
      process.exit(exitCode);
    }
  });
  parentPort.postMessage({ type: "murage:recovery-result", nonce, result: reply });
} else {
  process.stdout.write(JSON.stringify(reply) + "\n", () => process.exit(exitCode));
}
