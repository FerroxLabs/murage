// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { execFileSync,spawn,type ChildProcess } from "node:child_process";
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir,userInfo } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic } from "./backup-restic.ts";
import type { ResticSftpTarget } from "./backup-restic-target.ts";
import { createSshKeyPair,resolveSshTools,sshFingerprint } from "./backup-sftp.ts";

// Pinned restic 0.19.1 and the system OpenSSH client against an unprivileged
// loopback sshd (internal-sftp) that this test starts on a free port. The same
// product adapter, runner, ssh arguments and folder probe the app uses; the
// only difference from a real server is 127.0.0.1. It logs in as the current
// user and only ever touches absolute folders inside its own temp directory.
const tool=process.env.MURAGE_BACKUP_TEST_RESTIC;
const qualified=!!tool&&process.env.MURAGE_BACKUP_TEST_SSHD==="1"&&process.platform==="darwin"&&existsSync("/usr/sbin/sshd");
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const hex=/^[a-f0-9]{64}$/;
const cleanups:(()=>unknown)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const freePort=()=>new Promise<number>(resolve=>{const server=createServer();server.listen(0,"127.0.0.1",()=>{const port=(server.address() as {port:number}).port;server.close(()=>resolve(port));});});

async function sshd(root:string,name:string){
  const keyFile=join(root,`${name}_host_key`);if(!existsSync(keyFile))execFileSync("/usr/bin/ssh-keygen",["-q","-t","ed25519","-N","","-f",keyFile]);
  const port=await freePort(),config=join(root,`${name}_sshd_config`);
  writeFileSync(config,[`Port ${port}`,"ListenAddress 127.0.0.1",`HostKey ${keyFile}`,`PidFile ${join(root,name+".pid")}`,`AuthorizedKeysFile ${join(root,"authorized_keys")}`,"PasswordAuthentication no","KbdInteractiveAuthentication no","UsePAM no","StrictModes no","Subsystem sftp internal-sftp",""].join("\n"));
  const child:ChildProcess=spawn("/usr/sbin/sshd",["-D","-e","-f",config],{stdio:["ignore","ignore","pipe"]});
  await new Promise<void>((resolve,reject)=>{let text="";child.stderr!.on("data",chunk=>{text+=chunk;if(text.includes("Server listening"))resolve();});child.once("exit",()=>reject(Error("sshd exited: "+text)));});
  const stop=()=>new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once("exit",()=>resolve());child.kill("SIGTERM");});
  cleanups.push(stop);
  const publicKey=readFileSync(keyFile+".pub","utf8").trim().split(/\s+/)[1];
  return{port,stop,fingerprint:sshFingerprint(publicKey)};
}

async function fixture(){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-sftp-loopback-")));cleanups.push(()=>safeWipeSync(root));
  writeFileSync(join(root,"authorized_keys"),"",{mode:0o600});
  const server=await sshd(root,"first");
  const key=createSshKeyPair(),password=randomBytes(24).toString("hex");
  const bytes=Buffer.concat([Buffer.from("age-encryption.org/v1\n"),randomBytes(128*1024)]),input=join(root,"synthetic.age");writeFileSync(input,bytes,{mode:0o600});
  const receipt=(job="b")=>({jobId:job.repeat(64),installationRef:"installation",destinationRef:"local-destination",selectionHash:"c".repeat(64),snapshotId:randomUUID(),artifactRef:"artifact",sha256:sha(bytes),bytes:bytes.length,verifiedAt:1});
  const base:ResticSftpTarget={kind:"sftp",remoteRef:"loopback",revision:1,credentialRef:"loopback-key",host:"127.0.0.1",port:server.port,user:userInfo().username,folder:join(root,"server","backups","murage")};
  const sshTools=resolveSshTools();
  const adapter=(target:ResticSftpTarget,options:{work?:string;password?:string}={})=>new BackupRestic({executable:tool!,repository:target,workDirectory:join(root,options.work??`work dir ${target.revision}`),password:async()=>Buffer.from(options.password??password),credentials:async()=>key,sshTools,timeoutMs:60000});
  const authorize=()=>writeFileSync(join(root,"authorized_keys"),key.publicKey+"\n",{mode:0o600});
  return{root,server,key,password,bytes,input,receipt,base,adapter,authorize};
}
const privateKeyOnDisk=(directory:string)=>readdirSync(directory,{recursive:true,withFileTypes:true}).some(entry=>entry.isFile()&&readFileSync(join(entry.parentPath,entry.name),"utf8").includes("OPENSSH PRIVATE KEY"));

describe.skipIf(!qualified)("pinned restic over a loopback SFTP server",()=>{
  it("key made by Murage, fingerprint scan, refused key, repository created then reopened, verified copy, download",async()=>{
    const f=await fixture();
    // The generated key is a real OpenSSH key: ssh-keygen derives the same public line.
    const keyFile=join(f.root,"check_key");writeFileSync(keyFile,f.key.privateKey,{mode:0o600});
    expect(execFileSync("/usr/bin/ssh-keygen",["-y","-f",keyFile],{encoding:"utf8"}).trim().split(" ").slice(0,2).join(" ")).toBe(f.key.publicKey.split(" ").slice(0,2).join(" "));
    // First contact: the scan reports exactly the server's own fingerprint and trusts nothing.
    const scanned=await f.adapter(f.base).scanServerIdentity();expect(scanned.fingerprint).toBe(f.server.fingerprint);expect(scanned.type).toBe("ssh-ed25519");
    const pinned:ResticSftpTarget={...f.base,revision:2,hostKey:{type:"ssh-ed25519",key:scanned.key}};
    // The key is not on the server yet: refused clearly, and nothing is created.
    await expect(f.adapter(pinned).prepareRepository()).rejects.toThrow("RESTIC_SFTP_KEY_REFUSED");
    expect(f.adapter(pinned).connectionStatus()).toMatchObject({state:"disconnected",serverCheck:"key-refused"});expect(existsSync(pinned.folder)).toBe(false);
    f.authorize();
    const created=await f.adapter(pinned).prepareRepository();expect(created).toMatchObject({connected:true,created:true,remoteRef:"loopback",revision:2,repositoryId:expect.stringMatching(hex)});
    expect(readdirSync(pinned.folder).sort()).toEqual(["config","data","index","keys","locks","snapshots"]);
    expect(f.adapter(pinned).connectionStatus()).toEqual({remoteRef:"loopback",revision:2,state:"connected",repositoryId:created.repositoryId});
    // A second test opens the same repository instead of creating another.
    expect(await f.adapter(pinned).prepareRepository()).toMatchObject({created:false,repositoryId:created.repositoryId});
    const receipt=f.receipt(),stored=await f.adapter(pinned).store(f.input,receipt);
    expect(stored).toMatchObject({state:"verified",snapshotId:expect.stringMatching(hex),repositoryId:created.repositoryId,jobId:receipt.jobId});
    expect(f.adapter(pinned).storedBackupStatus(receipt)).toMatchObject({state:"verified"});
    const listed=await f.adapter(pinned).listBackups();expect(listed.backups).toEqual([{snapshotId:stored.snapshotId,jobId:receipt.jobId,createdAt:expect.any(Number),verified:false}]);
    // Restore from SFTP alone: a fresh work folder (new installation) with the same key and password.
    const fresh=f.adapter(pinned,{work:"fresh-installation"});expect(await fresh.prepareRepository()).toMatchObject({created:false,repositoryId:created.repositoryId});
    const copy=await fresh.downloadBackup(stored.snapshotId!);expect(readFileSync(copy.archivePath)).toEqual(f.bytes);expect(copy.receipt).toEqual(receipt);
    // The private key is on disk only while ssh runs.
    for(const work of ["work dir 2","fresh-installation"]){expect(privateKeyOnDisk(join(f.root,work))).toBe(false);expect(readdirSync(join(f.root,work)).some(name=>name.startsWith("ssh-"))).toBe(false);}
  },120000);

  it("a wrong password, a folder with other files and a changed server identity are refused",async()=>{
    const f=await fixture();f.authorize();
    const scanned=await f.adapter(f.base).scanServerIdentity(),pinned:ResticSftpTarget={...f.base,revision:2,hostKey:{type:"ssh-ed25519",key:scanned.key}};
    const created=await f.adapter(pinned).prepareRepository();expect(created.created).toBe(true);
    await expect(f.adapter(pinned,{work:"other-password",password:"not-the-password"}).prepareRepository()).rejects.toThrow("RESTIC_WRONG_PASSWORD");
    const occupied=join(f.root,"server","photos");mkdirSync(occupied,{recursive:true});writeFileSync(join(occupied,"holiday.jpg"),"x");
    await expect(f.adapter({...pinned,folder:occupied},{work:"occupied"}).prepareRepository()).rejects.toThrow("RESTIC_SFTP_FOLDER_NOT_EMPTY");
    expect(readdirSync(occupied)).toEqual(["holiday.jpg"]);
    const stored=await f.adapter(pinned).store(f.input,f.receipt("d"));expect(stored.state).toBe("verified");
    // The server is replaced: same address and port, different host key.
    await f.server.stop();const port=f.base.port;
    const config=readFileSync(join(f.root,"first_sshd_config"),"utf8").replace(join(f.root,"first_host_key"),join(f.root,"second_host_key"));
    execFileSync("/usr/bin/ssh-keygen",["-q","-t","ed25519","-N","","-f",join(f.root,"second_host_key")]);writeFileSync(join(f.root,"second_sshd_config"),config.replace(`Port ${port}`,`Port ${port}`));
    const second=spawn("/usr/sbin/sshd",["-D","-e","-f",join(f.root,"second_sshd_config")],{stdio:["ignore","ignore","pipe"]});cleanups.push(()=>new Promise<void>(resolve=>{if(second.exitCode!==null)return resolve();second.once("exit",()=>resolve());second.kill("SIGTERM");}));
    await new Promise<void>((resolve,reject)=>{let text="";second.stderr!.on("data",chunk=>{text+=chunk;if(text.includes("Server listening"))resolve();});second.once("exit",()=>reject(Error(text)));});
    await expect(f.adapter(pinned).prepareRepository()).rejects.toThrow("RESTIC_SFTP_HOST_KEY_CHANGED");
    await expect(f.adapter(pinned).store(f.input,f.receipt("e"))).rejects.toThrow("RESTIC_SFTP_HOST_KEY_CHANGED");
    expect(f.adapter(pinned).connectionStatus()).toMatchObject({serverCheck:"host-key-changed"});
    await expect(f.adapter(pinned).listBackups()).rejects.toThrow();
    // Never auto-accepted: the pinned file still holds only the original key, and scanning shows the new one for the owner.
    const rescanned=await f.adapter(pinned).scanServerIdentity();expect(rescanned.key).not.toBe(scanned.key);
  },120000);
});
