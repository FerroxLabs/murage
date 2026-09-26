// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync,readFileSync,readdirSync,realpathSync,statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic,type ResticRun,type ResticResult } from "./backup-restic.ts";
import type { ResticS3Target,ResticSftpTarget } from "./backup-restic-target.ts";
import { createSshKeyPair,type SftpFolderState } from "./backup-sftp.ts";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))safeWipeSync(root);});
const repositoryId="e".repeat(64);
const blob=(type:string)=>{const name=Buffer.from(type),length=Buffer.alloc(4);length.writeUInt32BE(name.length);const body=Buffer.alloc(36);body.writeUInt32BE(32);return Buffer.concat([length,name,body]).toString("base64");};
const key=createSshKeyPair();
const target:ResticSftpTarget={kind:"sftp",remoteRef:"remote-one",revision:2,credentialRef:"key-one",host:"nas.example.com",port:22,user:"backup",folder:"murage-backups",hostKey:{type:"ssh-ed25519",key:blob("ssh-ed25519")}};
const operation=(args:string[])=>["init","cat","backup","snapshots","restore","forget"].find(op=>args.includes(op));

function fixture(options:{folder?:SftpFolderState|Error;exists?:boolean;runner?:(run:ResticRun)=>ResticResult|undefined}={}){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-restic-sftp-unit-")));roots.push(root);const workDirectory=join(root,"work");
  const calls:ResticRun[]=[],seen:{key:string;knownHosts:string;keyMode:number}[]=[],probes:{args:string[];folder:string}[]=[];let exists=options.exists??false;
  const runner=async(run:ResticRun):Promise<ResticResult>=>{
    calls.push(run);
    // While restic runs, the key and pinned identity exist as private files named in sftp.command.
    const option=run.args[run.args.indexOf("-o")+1],identity=/IdentityFile=([^"]+)/.exec(option)![1],known=/UserKnownHostsFile=([^"]+)/.exec(option)![1];
    seen.push({key:readFileSync(identity,"utf8"),knownHosts:readFileSync(known,"utf8"),keyMode:statSync(identity).mode&0o777});
    const custom=options.runner?.(run);if(custom)return custom;
    const op=operation(run.args);
    if(op==="cat")return exists?{code:0,stdout:JSON.stringify({version:2,id:repositoryId})}:{code:10,stdout:""};
    if(op==="init"){exists=true;return{code:0,stdout:"{}"};}
    return{code:1,stdout:""};
  };
  const probeFolder=async(input:{args:string[];folder:string})=>{probes.push({args:input.args,folder:input.folder});if(options.folder instanceof Error)throw options.folder;return options.folder??"empty";};
  const adapter=(t:ResticSftpTarget=target)=>new BackupRestic({executable:"/fixture/restic",repository:t,workDirectory,password:async()=>Buffer.from("FAKE_REPOSITORY_PASSWORD"),credentials:async()=>key,sshTools:{ssh:"/usr/bin/ssh",keyscan:"/usr/bin/ssh-keyscan"},runner,probeFolder});
  return{root,workDirectory,calls,seen,probes,adapter};
}
const noKeyLeft=(directory:string)=>readdirSync(directory,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).every(entry=>!readFileSync(join(entry.parentPath,entry.name),"utf8").includes("PRIVATE KEY"));

describe("SFTP repository: init-or-open",()=>{
  it("an empty folder gets a new repository, created once; the key never outlives the run",async()=>{
    const f=fixture({folder:"empty"});
    expect(await f.adapter().prepareRepository()).toEqual({connected:true,created:true,remoteRef:"remote-one",revision:2,repositoryId});
    expect(f.calls.map(call=>operation(call.args))).toEqual(["cat","init","cat"]);
    const first=f.calls[0].args;expect(first.slice(0,2)).toEqual(["--repo","sftp:murage-backup-server:murage-backups"]);expect(first[2]).toBe("-o");expect(first[3]).toMatch(/^"sftp\.command=""\/usr\/bin\/ssh"" ""-F"" ""none""/);
    expect(f.calls.every(call=>call.sftp===true&&call.s3===undefined&&!call.args.join(" ").includes("PRIVATE KEY"))).toBe(true);
    expect(f.seen.every(item=>item.key===key.privateKey&&item.keyMode===0o600&&item.knownHosts===`murage-backup-server ssh-ed25519 ${target.hostKey!.key}\n`)).toBe(true);
    expect(f.probes).toHaveLength(1);expect(f.probes[0].folder).toBe("murage-backups");expect(f.probes[0].args).toContain("StrictHostKeyChecking=yes");
    expect(readdirSync(f.workDirectory).some(name=>name.startsWith("ssh-"))).toBe(false);expect(noKeyLeft(f.workDirectory)).toBe(true);
    expect(f.adapter().connectionStatus()).toEqual({remoteRef:"remote-one",revision:2,state:"connected",repositoryId});
    // Testing again opens the same repository.
    const g=fixture({folder:"repository",exists:true});expect(await g.adapter().prepareRepository()).toMatchObject({created:false,repositoryId});expect(g.calls.map(call=>operation(call.args))).toEqual(["cat"]);
  });
  it("a folder with other files is never turned into a repository",async()=>{
    const f=fixture({folder:"other-files"});await expect(f.adapter().prepareRepository()).rejects.toThrow("RESTIC_SFTP_FOLDER_NOT_EMPTY");expect(f.calls).toEqual([]);
    // Listed as a repository but restic finds none: still refused, still no init.
    const g=fixture({folder:"repository",exists:false});await expect(g.adapter().prepareRepository()).rejects.toThrow("RESTIC_SFTP_FOLDER_NOT_EMPTY");expect(g.calls.map(call=>operation(call.args))).toEqual(["cat"]);
  });
  it("a wrong password opens nothing and creates nothing",async()=>{
    const f=fixture({folder:"repository",exists:true,runner:run=>operation(run.args)==="cat"?{code:12,stdout:""}:undefined});
    await expect(f.adapter().prepareRepository()).rejects.toThrow("RESTIC_WRONG_PASSWORD");expect(f.calls.map(call=>operation(call.args))).toEqual(["cat"]);
  });
  it("a changed identity or refused key is kept for status and never retried as a new trust",async()=>{
    const f=fixture({folder:Error("RESTIC_SFTP_HOST_KEY_CHANGED")});
    await expect(f.adapter().prepareRepository()).rejects.toThrow("RESTIC_SFTP_HOST_KEY_CHANGED");expect(f.calls).toEqual([]);
    expect(f.adapter().connectionStatus()).toMatchObject({state:"disconnected",serverCheck:"host-key-changed"});
    // restic's own ssh reports it too, mid-operation.
    const g=fixture({folder:"repository",exists:true});await g.adapter().prepareRepository();
    const refusing=fixture({folder:"repository",exists:true,runner:()=>({code:1,stdout:"",sshFailure:"RESTIC_SFTP_KEY_REFUSED"})});
    await expect(refusing.adapter().connect()).rejects.toThrow("RESTIC_SFTP_KEY_REFUSED");expect(refusing.adapter().connectionStatus()).toMatchObject({serverCheck:"key-refused"});
    expect(noKeyLeft(refusing.workDirectory)).toBe(true);
  });
  it("an SFTP target without a pinned identity never runs ssh or restic",async()=>{
    const {hostKey:_none,...unpinned}=target;const f=fixture();
    await expect(f.adapter(unpinned as ResticSftpTarget).prepareRepository()).rejects.toThrow("HOST_KEY_REQUIRED");expect(f.calls).toEqual([]);expect(f.probes).toEqual([]);
  });
  it("missing ssh tools are reported, not looked up on PATH",async()=>{
    const f=fixture();const adapter=new BackupRestic({executable:"/fixture/restic",repository:target,workDirectory:f.workDirectory,password:async()=>Buffer.from("x"),credentials:async()=>key,runner:async()=>({code:0,stdout:""})});
    await expect(adapter.prepareRepository()).rejects.toThrow(/RESTIC_SFTP_SSH_MISSING/);
  });
});

describe("S3 repository: Test connection creates a missing one through the guard",()=>{
  const s3:ResticS3Target={kind:"s3",remoteRef:"remote-s3",revision:1,credentialRef:"cred",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage",region:"auto",bucketLookup:"auto"};
  it("missing repository: guard, init, open; present: open only; no guard: refused",async()=>{
    const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-restic-s3-prepare-")));roots.push(root);let exists=false,guarded=0;const ops:string[]=[];
    const runner=async(run:ResticRun):Promise<ResticResult>=>{const op=operation(run.args)!;ops.push(op);if(op==="cat")return exists?{code:0,stdout:JSON.stringify({version:2,id:repositoryId})}:{code:10,stdout:""};if(op==="init"){exists=true;return{code:0,stdout:"{}"};}return{code:1,stdout:""};};
    const make=(guard=true,work="work")=>new BackupRestic({executable:"/fixture/restic",repository:s3,workDirectory:join(root,work),password:async()=>Buffer.from("pw"),credentials:async()=>({accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET"}),runner,...(guard?{authorizeInitialization:async()=>{guarded++;}}:{})});
    await expect(make(false,"unguarded").prepareRepository()).rejects.toThrow("GUARD_REQUIRED");expect(ops).toEqual(["cat"]);ops.length=0;
    expect(await make().prepareRepository()).toMatchObject({created:true,repositoryId});expect(ops).toEqual(["cat","init","cat"]);expect(guarded).toBe(1);ops.length=0;
    expect(await make(true,"second").prepareRepository()).toMatchObject({created:false,repositoryId});expect(ops).toEqual(["cat"]);
  });
});
