import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstallationArchive, writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { restoreInstallation, rollbackInstallationRestore } from "./installation-restore.ts";
import { reviewInstallation, activateInstallation } from "./installation-activation.ts";
import { writeInstallationDamagedExport } from "./installation-damaged-export.ts";
import { writeEncryptedInstallationBackup, inspectEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { resolveWindowsBackupRuntime } from "./installation-backup-encryption.ts";

export const usage = "Usage: installation-recovery backup --data-dir <stopped-installation> --output <new-backup.zip> | export-damaged --data-dir <stopped-installation> --output <private-preservation.zip> | inspect --archive <backup.zip> | plan-restore --archive <backup.zip> | restore --data-dir <stopped-installation> --archive <backup.zip> --sha256 <inspected-hash> | rollback --data-dir <installation> | backup-encrypted --data-dir <stopped-installation> --output <new-backup.age> --age-tool <verified-age> --recipient <age-recipient> --credential-policy preserve-in-encrypted-fidelity | inspect-encrypted --archive <backup.age> --age-tool <verified-age> | restore-encrypted-new --data-dir <new-installation> --archive <backup.age> --sha256 <inspected-hash> --age-tool <verified-age>. Encrypted commands read the recovery identity from stdin.";

async function identityFromStdin(): Promise<string> {
  let identity="";
  for await(const chunk of process.stdin){identity+=chunk.toString();if(identity.length>4096)throw new Error("AGE_NATIVE_IDENTITY_REQUIRED");}
  return identity;
}

export async function installationRecoveryCommand(args: string[], input: { readIdentity?: () => Promise<string> } = {}): Promise<Record<string, unknown>> {
  const command = args[0];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  const encryptedRequired=["--data-dir","--output","--age-tool","--recipient","--credential-policy"];
  if(command==="backup-encrypted"&&encryptedRequired.every(key=>options.has(key))&&[...options.keys()].every(key=>[...encryptedRequired,"--max-bytes","--max-duration-ms"].includes(key))){
    if(options.get("--credential-policy")!=="preserve-in-encrypted-fidelity")throw new Error("BACKUP_CREDENTIAL_POLICY_REQUIRED");
    const numeric=(key:string,min:number,max:number)=>{const raw=options.get(key);if(raw===undefined)return undefined;const value=Number(raw);if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)throw new Error("INVALID_BACKUP_BUDGET");return value;};
    const maxBytes=numeric("--max-bytes",1,1024**4),timeoutMs=numeric("--max-duration-ms",1000,30*60000);
    if(process.platform==="win32")await resolveWindowsBackupRuntime(options.get("--age-tool")!);
    const result=await writeEncryptedInstallationBackup(options.get("--data-dir")!,options.get("--output")!,{ageExecutable:options.get("--age-tool")!,recipient:options.get("--recipient")!,identity:await(input.readIdentity??identityFromStdin)(),selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},...(maxBytes===undefined?{}:{maxBytes}),...(timeoutMs===undefined?{}:{timeoutMs,signal:AbortSignal.timeout(timeoutMs)})});
    return{ok:true,operation:command,...result};
  }
  if(command==="inspect-encrypted"&&options.size===2&&options.has("--archive")&&options.has("--age-tool")){
    if(process.platform==="win32")await resolveWindowsBackupRuntime(options.get("--age-tool")!);
    const scratch=process.platform==="win32"?tmpdir():mkdtempSync(join(tmpdir(),"murage-encrypted-inspect-command-"));
    let completedDirectory:string|undefined;
    try{
      const result=await inspectEncryptedInstallationBackup(options.get("--archive")!,scratch,{ageExecutable:options.get("--age-tool")!,identity:await(input.readIdentity??identityFromStdin)()});
      completedDirectory=result.directory;
      return{ok:true,operation:command,sha256:result.sha256,snapshotId:result.manifest.snapshotId,coverage:result.manifest.coverage,restorePolicy:result.manifest.restorePolicy,activationAvailable:false};
    }finally{if(process.platform!=="win32")rmSync(scratch,{recursive:true,force:true});else if(completedDirectory)rmSync(completedDirectory,{recursive:true,force:true});}
  }
  if(command==="restore-encrypted-new"&&options.size===4&&["--data-dir","--archive","--sha256","--age-tool"].every(key=>options.has(key))){
    if(process.platform==="win32")await resolveWindowsBackupRuntime(options.get("--age-tool")!);
    return{ok:true,operation:command,...await restoreEncryptedInstallationNew(options.get("--data-dir")!,options.get("--archive")!,options.get("--sha256")!,{ageExecutable:options.get("--age-tool")!,identity:await(input.readIdentity??identityFromStdin)()})};
  }
  if (command === "backup" && options.size === 2 && options.has("--data-dir") && options.has("--output")) {
    const result = await writeInstallationArchive(options.get("--data-dir")!, options.get("--output")!);
    return { ok: true, operation: "backup", path: result.path, sha256: result.sha256, snapshotId: result.manifest.snapshotId, files: result.manifest.files.length, omitted: result.manifest.omitted, missing: result.manifest.missing, restorePolicy: result.manifest.restorePolicy };
  }
  if (command === "export-damaged" && options.size === 2 && options.has("--data-dir") && options.has("--output")) {
    const result = await writeInstallationDamagedExport(options.get("--data-dir")!, options.get("--output")!);
    return { ok: true, operation: "export-damaged", path: result.path, sha256: result.sha256,
      snapshotId: result.manifest.snapshotId, files: result.manifest.files.length,
      omitted: result.manifest.omitted, missing: result.manifest.missing,
      restorePolicy: result.manifest.restorePolicy, complete: false, activationAvailable: false,
      warning: "Private preservation only: raw files may contain credentials and personal data. Do not share this archive. It is not a complete backup and cannot be restored automatically." };
  }
  if (command === "inspect" && options.size === 1 && options.has("--archive")) {
    const scratch = mkdtempSync(join(tmpdir(), "murage-backup-inspect-command-"));
    try {
      const result = await inspectInstallationArchive(options.get("--archive")!, scratch);
      return { ok: true, operation: "inspect", sha256: result.sha256, snapshotId: result.manifest.snapshotId, createdAt: result.manifest.createdAt, files: result.manifest.files.length, database: result.manifest.database, omitted: result.manifest.omitted, missing: result.manifest.missing, restorePolicy: result.manifest.restorePolicy, activationAvailable: false };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  if (command === "plan-restore" && options.size === 1 && options.has("--archive")) {
    const scratch = mkdtempSync(join(tmpdir(), "murage-restore-plan-command-"));
    try {
      const result = await prepareInstallationRestore(options.get("--archive")!, scratch);
      return { ok: true, operation: "plan-restore", sha256: result.sha256, snapshotId: result.manifest.snapshotId, restorePolicy: "paused-review-required", modifications: result.modifications, quarantined: result.quarantined, omitted: result.manifest.omitted, missing: result.manifest.missing, activationAvailable: false };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  if (command === "restore" && options.size === 3 && options.has("--data-dir") && options.has("--archive") && options.has("--sha256")) {
    return { ok: true, operation: "restore", ...await restoreInstallation(options.get("--data-dir")!, options.get("--archive")!, options.get("--sha256")!) };
  }
  if (command === "rollback" && options.size === 1 && options.has("--data-dir")) {
    return { ok: true, operation: "rollback", ...rollbackInstallationRestore(options.get("--data-dir")!) };
  }
  if (command === "review" && options.size === 1 && options.has("--data-dir")) {
    return { ok: true, operation: "review", ...reviewInstallation(options.get("--data-dir")!) };
  }
  if (command === "activate" && options.size === 2 && options.has("--data-dir") && options.has("--review-hash")) {
    return { ok: true, operation: "activate", ...activateInstallation(options.get("--data-dir")!, options.get("--review-hash")!) };
  }
  throw new Error(usage);
}
