// Build-only target selection. Never execute the staged tool or search PATH.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BACKUP_AGE_PINS, BACKUP_AGE_LICENSE_SHA256 } from "../shared/backup-age-pins.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const oldLicenseHash = "76f9171771a05e91cfd270480ba507dcf57b05a391d2aea8329be42aaf963813";
function hash(file) {
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64*1024**2)throw Error("BACKUP_AGE_FILE_UNSAFE");
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
export async function stageBackupAge({root=repository,target,archive}={}) {
  if(target!==undefined&&!Object.hasOwn(BACKUP_AGE_PINS,target))throw Error("BACKUP_AGE_BUILD_TARGET_UNSUPPORTED");
  const sourceLicense=join(root,"third_party","age","LICENSE");
  if(hash(sourceLicense)!==BACKUP_AGE_LICENSE_SHA256)throw Error("BACKUP_AGE_LICENSE_MISMATCH");
  // Both roots exist for cross-platform packaging; unsupported targets get no tool.
  for(const pin of Object.values(BACKUP_AGE_PINS)){
    const directory=join(root,"dist-native",pin.stagingDirectory);mkdirSync(directory,{recursive:true});
    const license=join(directory,"LICENSE");
    if(existsSync(license)){
      const existing=hash(license);
      if(existing===oldLicenseHash)copyFileSync(sourceLicense,license);
      else if(existing!==BACKUP_AGE_LICENSE_SHA256)throw Error("BACKUP_AGE_LICENSE_MISMATCH");
    }else copyFileSync(sourceLicense,license,constants.COPYFILE_EXCL);
  }
  if(target===undefined)return;
  const pin=BACKUP_AGE_PINS[target],directory=join(root,"dist-native",pin.stagingDirectory,pin.arch),executable=join(directory,"age");
  if(existsSync(executable)){
    if(hash(executable)!==pin.executableSha256)throw Error("BACKUP_AGE_RESOURCE_MISMATCH");
    chmodSync(executable,0o755);return executable;
  }
  const scratch=mkdtempSync(join(tmpdir(),"murage-backup-tool-stage-"));
  try{
    const input=archive??join(scratch,"age.tar.gz");
    if(!archive){
      const response=await fetch(pin.url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok||!response.body)throw Error("BACKUP_AGE_DOWNLOAD_FAILED");
      let total=0;const chunks=[];
      for await(const chunk of response.body){total+=chunk.length;if(total>64*1024**2)throw Error("BACKUP_AGE_DOWNLOAD_LIMIT");chunks.push(Buffer.from(chunk));}
      writeFileSync(input,Buffer.concat(chunks),{flag:"wx",mode:0o600});
    }
    if(hash(input)!==pin.archiveSha256)throw Error("BACKUP_AGE_ARCHIVE_MISMATCH");
    execFileSync("/usr/bin/tar",["-xzf",input,"-C",scratch,"age/age"],{stdio:"pipe",timeout:30000});
    const verified=join(scratch,"age","age");
    if(hash(verified)!==pin.executableSha256)throw Error("BACKUP_AGE_RESOURCE_MISMATCH");
    mkdirSync(directory,{recursive:true});copyFileSync(verified,executable,constants.COPYFILE_EXCL);chmodSync(executable,0o755);
    return executable;
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),explicit=args[0]?.startsWith("--target=");
  // A macOS package job builds both architectures, so it stages both tools.
  const targets=explicit?[args.shift().slice(9)]:(process.platform==="darwin"?["darwin-arm64","darwin-x64"]:process.platform==="linux"&&process.arch==="x64"?["linux-x64"]:[undefined]);
  if(args.length>1||(args.length&&targets.length>1))throw Error("BACKUP_AGE_BUILD_ARGUMENTS_INVALID");
  for(const target of targets)await stageBackupAge({target,archive:args[0]});
}
