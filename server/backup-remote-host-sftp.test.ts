// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {describe,expect,it,vi} from "vitest";
import {createBackupRemoteHost,BACKUP_REMOTE_BINDING_KEY} from "./backup-remote-host.ts";
import {sshFingerprint} from "./backup-sftp.ts";

const blob=(fill:number)=>{const name=Buffer.from("ssh-ed25519"),length=Buffer.alloc(4);length.writeUInt32BE(name.length);const body=Buffer.alloc(36,fill);body.writeUInt32BE(32);return Buffer.concat([length,name,body]).toString("base64");};
const serverKey=blob(1),otherKey=blob(2);
const privateKey="-----BEGIN OPENSSH PRIVATE KEY-----\nRkFLRV9QUklWQVRFX0tFWV9DQU5BUlk=\n-----END OPENSSH PRIVATE KEY-----\n";
const input={kind:"sftp",label:"Home NAS",host:"nas.example.com",port:22,user:"backup",folder:"murage-backups"};
const receipt={jobId:"a".repeat(64),installationRef:"install",destinationRef:"local",selectionHash:"b".repeat(64),snapshotId:"97d4fa8e-2c50-4cba-a66f-a7bb84b13d42",artifactRef:"artifact",sha256:"c".repeat(64),bytes:10,verifiedAt:1};

function fixture(){
  let document:Record<string,unknown>={untouched:"preserve"},count=0,keys=0,scanned=serverKey;
  const connected=new Map<string,string>();const forgotten:string[]=[];const adapters:any[]=[];
  const prepare=vi.fn(async(binding:any)=>{const created=!connected.size;connected.set(`${binding.target.remoteRef}:${binding.target.revision}`,"d".repeat(64));return{connected:true,created,remoteRef:binding.target.remoteRef,revision:binding.target.revision,repositoryId:"d".repeat(64)};});
  let failure:string|undefined;
  const host=createBackupRemoteHost({supported:()=>true,readProtected:async()=>structuredClone(document),updateProtected:async derive=>{document=derive(structuredClone(document));},
    selectPassword:async()=>({passwordRef:"independent-password"}),latestVerified:async()=>({archivePath:"/host/verified.age",receipt}),latestReceipt:()=>receipt,now:()=>10,createId:()=>`ref-${++count}`,
    createSshKey:()=>{keys++;return{privateKey,publicKey:`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(40)+keys} murage-backup`};},
    forgetLocalState:ref=>{forgotten.push(ref);},
    createAdapter:binding=>{adapters.push(binding);return{
      connectionStatus:()=>({state:connected.has(`${binding.target.remoteRef}:${binding.target.revision}`)?"connected":"disconnected",repositoryId:"d".repeat(64)}),
      connect:async()=>({connected:true,remoteRef:binding.target.remoteRef,revision:binding.target.revision,repositoryId:"d".repeat(64)}),
      store:async()=>{if(failure)throw Error(failure);return{state:"verified",snapshotId:"e".repeat(64)};},
      scanServerIdentity:async()=>({type:"ssh-ed25519",key:scanned,fingerprint:sshFingerprint(scanned)}),
      prepareRepository:async()=>{if(failure)throw Error(failure);return prepare(binding);},
      previewRetention:async()=>({previewId:"f".repeat(64),repositoryId:"d".repeat(64),remove:[],keep:1}),
    };}});
  return{host,document:()=>document,forgotten,adapters,prepare,keys:()=>keys,setScanned:(key:string)=>{scanned=key;},fail:(code?:string)=>{failure=code;}};
}
async function saved(f:ReturnType<typeof fixture>){await f.host.save(0,input);const ref=(await f.host.status()).remoteRef!;await f.host.selectRepositoryPassword(ref,1);return ref;}

describe("SFTP destinations in the remote host",()=>{
  it("saving makes Murage's key in main; status shows only the public half",async()=>{
    const f=fixture();await f.host.save(0,input);expect(f.keys()).toBe(1);
    expect(String(f.document()[BACKUP_REMOTE_BINDING_KEY])).toContain("OPENSSH PRIVATE KEY");
    const status=await f.host.status();
    expect(status).toMatchObject({configured:true,kind:"sftp",state:"password-required",sftp:{host:"nas.example.com",port:22,user:"backup",folder:"murage-backups",publicKey:expect.stringMatching(/^ssh-ed25519 .+ murage-backup$/)}});
    expect(status.sftp).not.toHaveProperty("fingerprint");expect(JSON.stringify(status)).not.toMatch(/PRIVATE|RkFLRV9QUklW/);
  });
  it("rejects option-shaped or malformed fields and any key sent from the window",async()=>{
    const f=fixture();
    for(const patch of [{host:"-oProxyCommand=x"},{host:"nas example"},{user:"-l"},{user:"a b"},{folder:"../x"},{folder:"-x"},{port:0},{port:"22"},{privateKey},{credentials:{privateKey}},{kind:"ftp"}])await expect(f.host.save(0,{...input,...patch})).rejects.toThrow("INPUT_INVALID");
    expect(f.document()[BACKUP_REMOTE_BINDING_KEY]).toBeUndefined();expect(f.keys()).toBe(0);
  });
  it("first test shows the fingerprint and connects nowhere; trusting pins exactly that key",async()=>{
    const f=fixture(),ref=await saved(f);
    const first=await f.host.testConnection(ref,2);expect(first).toEqual({state:"trust-required",fingerprint:sshFingerprint(serverKey),keyType:"ssh-ed25519"});expect(f.prepare).not.toHaveBeenCalled();
    // The server changes between showing and trusting: nothing is pinned.
    f.setScanned(otherKey);await expect(f.host.trustServer(ref,2,first.fingerprint)).rejects.toThrow("BACKUP_REMOTE_TRUST_CHANGED");expect((await f.host.status()).sftp?.fingerprint).toBeUndefined();
    f.setScanned(serverKey);await expect(f.host.trustServer(ref,2,"SHA256:bad")).rejects.toThrow("INPUT_INVALID");
    expect(await f.host.trustServer(ref,2,first.fingerprint)).toEqual({trusted:true,fingerprint:first.fingerprint});
    expect(await f.host.status()).toMatchObject({revision:3,state:"disconnected",sftp:{fingerprint:first.fingerprint}});
    await expect(f.host.trustServer(ref,3,first.fingerprint)).rejects.toThrow("BACKUP_REMOTE_CHANGED");
    expect(await f.host.testConnection(ref,3)).toEqual({state:"connected",created:true,remoteRef:ref,revision:3,repositoryId:"d".repeat(64)});
    expect(f.adapters.at(-1).target.hostKey).toEqual({type:"ssh-ed25519",key:serverKey});expect(await f.host.status()).toMatchObject({state:"connected"});
  });
  it("refusals reach the window as codes a person can act on",async()=>{
    const f=fixture(),ref=await saved(f);const {fingerprint}=await f.host.testConnection(ref,2) as {fingerprint:string};await f.host.trustServer(ref,2,fingerprint);
    for(const [code,shown] of [["RESTIC_SFTP_HOST_KEY_CHANGED","BACKUP_REMOTE_HOST_KEY_CHANGED"],["RESTIC_SFTP_KEY_REFUSED","BACKUP_REMOTE_KEY_REFUSED"],["RESTIC_SFTP_FOLDER_NOT_EMPTY","BACKUP_REMOTE_FOLDER_NOT_EMPTY"],["RESTIC_WRONG_PASSWORD","BACKUP_REMOTE_WRONG_PASSWORD"],["RESTIC_SFTP_SSH_MISSING_WINDOWS","BACKUP_REMOTE_SSH_MISSING_WINDOWS"],["RESTIC_SFTP_UNAVAILABLE","BACKUP_REMOTE_SFTP_UNAVAILABLE"],["RESTIC_CONNECT_UNCONFIRMED","BACKUP_REMOTE_STORAGE_UNREACHABLE"],["RESTIC_INIT_UNCONFIRMED","BACKUP_REMOTE_CREATE_FAILED"],["RESTIC_PASSWORD_UNAVAILABLE","BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE"],["RESTIC_TOOL_UNVERIFIED","BACKUP_REMOTE_TOOL_UNVERIFIED"],["RESTIC_TARGET_REVIEW_REQUIRED","BACKUP_REMOTE_SETUP_INTERRUPTED"],["something private at /path","BACKUP_REMOTE_REVIEW_REQUIRED"]]){
      f.fail(code);await expect(f.host.testConnection(ref,3)).rejects.toThrow(shown);
    }
    f.fail();await f.host.testConnection(ref,3);f.fail("RESTIC_SFTP_HOST_KEY_CHANGED");await expect(f.host.uploadLatest(ref,3,receipt.jobId)).rejects.toThrow("BACKUP_REMOTE_HOST_KEY_CHANGED");
  });
  it("changing the folder keeps the key already on the server but always asks to trust again",async()=>{
    const f=fixture(),ref=await saved(f);const {fingerprint}=await f.host.testConnection(ref,2) as {fingerprint:string};await f.host.trustServer(ref,2,fingerprint);
    const before=JSON.parse(String(f.document()[BACKUP_REMOTE_BINDING_KEY]));
    await f.host.save(3,{...input,folder:"other-folder"});const after=JSON.parse(String(f.document()[BACKUP_REMOTE_BINDING_KEY]));
    expect(after.credentials).toEqual(before.credentials);expect(after.target.hostKey).toBeUndefined();expect(after.passwordRef).toBe("independent-password");expect(f.keys()).toBe(1);
    expect(await f.host.testConnection(ref,4)).toMatchObject({state:"trust-required"});
    // Switching kind replaces the key: an S3 destination has none.
    await f.host.save(4,{kind:"s3",label:"Bucket",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage",region:"auto",bucketLookup:"auto",credentials:{accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET"}});
    expect(String(f.document()[BACKUP_REMOTE_BINDING_KEY])).not.toContain("PRIVATE KEY");expect((await f.host.status()).kind).toBe("s3");
    await f.host.save(5,input);expect(f.keys()).toBe(2);
  });
  it("removing forgets the settings, the key and the pinned identity",async()=>{
    const f=fixture(),ref=await saved(f);const {fingerprint}=await f.host.testConnection(ref,2) as {fingerprint:string};await f.host.trustServer(ref,2,fingerprint);
    await expect(f.host.remove(ref,2)).rejects.toThrow("BACKUP_REMOTE_CHANGED");
    expect(await f.host.remove(ref,3)).toEqual({removed:true});
    expect(f.document()[BACKUP_REMOTE_BINDING_KEY]).toBeUndefined();expect(f.document().untouched).toBe("preserve");
    expect(JSON.stringify(f.document())).not.toMatch(/PRIVATE KEY|ssh-ed25519/);expect(f.forgotten).toEqual([ref]);
    expect(await f.host.status()).toMatchObject({configured:false,state:"unconfigured",revision:0});
  });
  it("SFTP clean-up uses the destination's own key; S3 still needs a separate maintenance key",async()=>{
    const f=fixture(),ref=await saved(f);const {fingerprint}=await f.host.testConnection(ref,2) as {fingerprint:string};await f.host.trustServer(ref,2,fingerprint);await f.host.testConnection(ref,3);
    await expect(f.host.saveMaintenanceCredentials(ref,3,{accessKeyId:"x",secretAccessKey:"y"})).rejects.toThrow("INPUT_INVALID");
    expect(await f.host.previewRetention(ref,3,{keepLast:3})).toMatchObject({previewId:"f".repeat(64),keep:1});
  });
});
