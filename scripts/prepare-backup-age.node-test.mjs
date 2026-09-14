import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKUP_AGE_PINS, BACKUP_AGE_LICENSE_SHA256, backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { trustedBackupAgeExecutable } from "../electron/backup-age-attestation.mjs";
import { verifiedBackupTool } from "../electron/backup-mode.mjs";
import { stageBackupAge } from "./prepare-backup-age.mjs";
const sha=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
function fixture(){
  const root=mkdtempSync(path.join(tmpdir(),"murage-linux-source-test-"));
  mkdirSync(path.join(root,"third_party","age"),{recursive:true});
  copyFileSync(new URL("../third_party/age/LICENSE",import.meta.url),path.join(root,"third_party","age","LICENSE"));
  return root;
}
test("immutable metadata admits only exact Mac arm64 and Linux x64 targets",()=>{
  for(const pin of Object.values(BACKUP_AGE_PINS)){
    assert.equal(backupAgePinForTarget(pin.platform,pin.arch),pin);assert.equal(Object.isFrozen(pin),true);
  }
  for(const pair of [["darwin","x64"],["linux","arm64"],["win32","x64"],["linux","amd64"],["linux-x64",""],["__proto__",""]])assert.equal(backupAgePinForTarget(...pair),null);
  assert.notEqual(BACKUP_AGE_PINS["linux-x64"].executableSha256,BACKUP_AGE_PINS["darwin-arm64"].executableSha256);
  assert.equal(Object.isFrozen(BACKUP_AGE_PINS),true);
});
test("public Linux archive is staged without execution, with complete license and separate root",async()=>{
  assert.ok(process.env.MURAGE_BACKUP_LINUX_TEST_ARCHIVE,"public verified archive path required");
  const root=fixture();
  try{
    const file=await stageBackupAge({root,target:"linux-x64",archive:process.env.MURAGE_BACKUP_LINUX_TEST_ARCHIVE});
    assert.equal(file,path.join(root,"dist-native","backup-age-linux","x64","age"));
    assert.equal(sha(file),BACKUP_AGE_PINS["linux-x64"].executableSha256);assert.equal(statSync(file).mode&0o777,0o755);
    for(const directory of ["backup-age","backup-age-linux"])assert.equal(sha(path.join(root,"dist-native",directory,"LICENSE")),BACKUP_AGE_LICENSE_SHA256);
    assert.equal(existsSync(path.join(root,"dist-native","backup-age","x64","age")),false);
    const resources=path.join(root,"Resources"),target=path.join(resources,"backup-tools","x64");mkdirSync(target,{recursive:true});copyFileSync(file,path.join(target,"age"));
    const onLinux=process.platform==="linux"&&process.arch==="x64";
    assert.equal(trustedBackupAgeExecutable(file),onLinux);
    assert.equal(verifiedBackupTool(resources),onLinux?path.join(target,"age"):null);
    assert.equal(verifiedBackupTool(resources,"linux","x64"),verifiedBackupTool(resources));
    assert.equal(await stageBackupAge({root,target:"linux-x64"}),file);
    writeFileSync(file,"tampered");await assert.rejects(stageBackupAge({root,target:"linux-x64"}),/RESOURCE_MISMATCH/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("unsupported metadata, wrong archives and linked inputs refuse without staging executables",async()=>{
  const root=fixture();
  try{
    await assert.rejects(stageBackupAge({root,target:"win32-x64"}),/TARGET_UNSUPPORTED/);
    await stageBackupAge({root});
    const wrong=path.join(root,"wrong.tar.gz");writeFileSync(wrong,"not the pinned archive");
    await assert.rejects(stageBackupAge({root,target:"linux-x64",archive:wrong}),/ARCHIVE_MISMATCH/);
    const linked=path.join(root,"linked");symlinkSync(wrong,linked);
    await assert.rejects(stageBackupAge({root,target:"linux-x64",archive:linked}),/FILE_UNSAFE/);
    rmSync(linked);linkSync(wrong,linked);
    await assert.rejects(stageBackupAge({root,target:"linux-x64",archive:linked}),/FILE_UNSAFE/);
    assert.equal(existsSync(path.join(root,"dist-native","backup-age-linux","x64","age")),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("only the recorded old staged license may be refreshed; unknown bytes refuse",async()=>{
  const root=fixture();
  try{
    const directory=path.join(root,"dist-native","backup-age");mkdirSync(directory,{recursive:true});
    // The prior source-only license omitted the bundled Go notice and used four-space bullets.
    const complete=readFileSync(path.join(root,"third_party","age","LICENSE"),"utf8");
    const old=complete.split("\n---\n")[0].trimEnd().replace("met:\n\n","met:\n").replaceAll("   *","    *")+"\n";
    const license=path.join(directory,"LICENSE");writeFileSync(license,old);
    assert.equal(sha(license),"76f9171771a05e91cfd270480ba507dcf57b05a391d2aea8329be42aaf963813");
    await stageBackupAge({root});assert.equal(sha(license),BACKUP_AGE_LICENSE_SHA256);
    writeFileSync(license,"unknown owned by somebody else");await assert.rejects(stageBackupAge({root}),/LICENSE_MISMATCH/);
    assert.equal(readFileSync(license,"utf8"),"unknown owned by somebody else");
  }finally{rmSync(root,{recursive:true,force:true});}
});
