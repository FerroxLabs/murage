// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Release gate: a packaged app carries the pinned backup tools for its own
// platform and architecture. Without them the Backups page offers no local or
// off-site copy, and nothing else in the build would notice.
//   node scripts/verify-packaged-backup-tools.mjs <resources dir> <platform> <arch>
// macOS: age and restic are the pinned payloads, signed by the app's own team
// (their bytes change when the release signs them, so the payload is compared
// with its signature normalised away). Linux: exact upstream bytes, executable.
// Windows: the raw upstream inventory, including restic.exe, never signed.
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {lstatSync,readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizedAgePayloadHash} from "../electron/backup-age-attestation.mjs";
import {backupAgePinForTarget} from "../shared/backup-age-pins.mjs";
import {resticPinForTarget} from "../shared/backup-restic-pin.mjs";
import {verifyWindowsBackupTools} from "./prepare-windows-backup-tools.mjs";

const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const codesign=args=>spawnSync("/usr/bin/codesign",args,{encoding:"utf8"});
function regular(file){const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>64*1024**2)throw Error(`BACKUP_TOOL_UNSAFE: ${file}`);return stat;}
const team=result=>/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(result.stderr))?.[1];
export function verifyPackagedBackupTools(resources,platform,arch,{run=codesign,requireSignature=true}={}){
 const checked=[];
 if(platform==="win32"){
  if(arch!=="x64")throw Error("BACKUP_TOOL_TARGET_UNSUPPORTED");
  verifyWindowsBackupTools(path.join(resources,"backup-tools","x64"));return["age.exe","age-keygen.exe","LICENSE","restic.exe"];
 }
 const age=backupAgePinForTarget(platform,arch),restic=resticPinForTarget(platform,arch);
 if(!age||!restic)throw Error(`BACKUP_TOOL_TARGET_UNSUPPORTED: ${platform}-${arch}`);
 const tools=[["age",age.executableSha256,age.payloadSha256],["restic",restic.originalSha256,restic.payloadSha256]];
 let appTeam;
 if(platform==="darwin"&&requireSignature){const app=path.dirname(path.dirname(resources));appTeam=team(run(["--display","--verbose=4",app]));if(!appTeam)throw Error("BACKUP_TOOL_APP_UNSIGNED");}
 for(const [name,original,payload] of tools){
  const file=path.join(resources,"backup-tools",arch,name),stat=regular(file),bytes=readFileSync(file);
  if(!(stat.mode&0o111))throw Error(`BACKUP_TOOL_NOT_EXECUTABLE: ${name}`);
  if(platform==="linux"){if(digest(bytes)!==original)throw Error(`BACKUP_TOOL_PIN_MISMATCH: ${name}`);}
  else{
   if(normalizedAgePayloadHash(bytes)!==payload)throw Error(`BACKUP_TOOL_PIN_MISMATCH: ${name}`);
   if(requireSignature){
    if(run(["--verify","--strict",file]).status!==0)throw Error(`BACKUP_TOOL_SIGNATURE_INVALID: ${name}`);
    if(team(run(["--display","--verbose=4",file]))!==appTeam)throw Error(`BACKUP_TOOL_TEAM_MISMATCH: ${name}`);
   }
  }
  checked.push(name);
 }
 return checked;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [resources,platform,arch,...rest]=process.argv.slice(2);if(!resources||!platform||!arch||rest.length)throw Error("usage: verify-packaged-backup-tools.mjs <resources> <platform> <arch>");
 console.log(`ok: ${platform}-${arch} backup tools ${verifyPackagedBackupTools(path.resolve(resources),platform,arch).join(", ")}`);
}
