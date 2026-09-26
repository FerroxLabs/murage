// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SFTP off-site destinations: Murage's own ed25519 key, the pinned server
// identity, the exact ssh argument vector restic and the folder probe use, and
// a minimal SFTP v3 client for "Test connection". Main-process only.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resticSftpCredentialsSchema, resticSftpTargetSchema, sftpHostKeySchema, SFTP_HOST_KEY_TYPES, type ResticSftpCredentials, type ResticSftpTarget } from "./backup-restic-target.ts";

export interface SshTools { ssh:string; keyscan:string }
export type SftpHostKey = { type:(typeof SFTP_HOST_KEY_TYPES)[number]; key:string };

const sshString=(bytes:Buffer)=>{const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes]);};
const uint32=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(value);return bytes;};

/** A fresh unencrypted OpenSSH-format ed25519 key. The comment is fixed so the
 * public line names what it is for in the server's authorized keys. */
export function createSshKeyPair():ResticSftpCredentials{
  const pair=generateKeyPairSync("ed25519");
  const spki=pair.publicKey.export({format:"der",type:"spki"}),pkcs8=pair.privateKey.export({format:"der",type:"pkcs8"});
  const pub=Buffer.from(spki.subarray(spki.length-32)),seed=Buffer.from(pkcs8.subarray(pkcs8.length-32));pkcs8.fill(0);
  const type=Buffer.from("ssh-ed25519"),blob=Buffer.concat([sshString(type),sshString(pub)]),check=randomBytes(4);
  const secret=Buffer.concat([seed,pub]);seed.fill(0);
  let body=Buffer.concat([check,check,sshString(type),sshString(pub),sshString(secret),sshString(Buffer.from("murage-backup"))]);secret.fill(0);
  const padding:number[]=[];for(let i=1;(body.length+padding.length)%8;i++)padding.push(i);
  const privateSection=Buffer.concat([body,Buffer.from(padding)]);body.fill(0);body=Buffer.alloc(0);
  const file=Buffer.concat([Buffer.from("openssh-key-v1\0"),sshString(Buffer.from("none")),sshString(Buffer.from("none")),sshString(Buffer.alloc(0)),uint32(1),sshString(blob),sshString(privateSection)]);
  privateSection.fill(0);
  const encoded=file.toString("base64");file.fill(0);
  const privateKey=`-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded.match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return resticSftpCredentialsSchema.parse({privateKey,publicKey:`ssh-ed25519 ${blob.toString("base64")} murage-backup`});
}

/** OpenSSH's SHA256 fingerprint: unpadded base64 of the key blob's digest. */
export function sshFingerprint(key:string){return "SHA256:"+createHash("sha256").update(Buffer.from(key,"base64")).digest("base64").replace(/=+$/,"");}

/** The blob must name its own type, so a scan cannot pass one key off as another. */
export function checkedHostKey(value:unknown):SftpHostKey{
  const key=sftpHostKeySchema.parse(value),blob=Buffer.from(key.key,"base64");
  if(blob.toString("base64")!==key.key||blob.length<4)throw Error("RESTIC_SFTP_HOST_KEY_INVALID");
  const length=blob.readUInt32BE(0);if(length>64||blob.subarray(4,4+length).toString("latin1")!==key.type)throw Error("RESTIC_SFTP_HOST_KEY_INVALID");
  return key;
}
/** ssh-keyscan output: prefer ed25519, then ECDSA, then RSA. Comment lines ignored. */
export function chooseScannedHostKey(stdout:string):SftpHostKey{
  const keys:SftpHostKey[]=[];
  for(const line of stdout.split(/\r?\n/)){
    if(!line||line.startsWith("#"))continue;const fields=line.trim().split(/\s+/);if(fields.length!==3)continue;
    try{keys.push(checkedHostKey({type:fields[1],key:fields[2]}));}catch{/* not a usable key line */}
  }
  for(const type of SFTP_HOST_KEY_TYPES){const found=keys.filter(key=>key.type===type);if(found.length===1)return found[0];if(found.length>1)throw Error("RESTIC_SFTP_HOST_KEY_INVALID");}
  throw Error("RESTIC_SFTP_UNREACHABLE");
}
const hostKeyAlgorithms=(type:SftpHostKey["type"])=>type==="ssh-rsa"?"rsa-sha2-512,rsa-sha2-256":type;
export const SFTP_HOST_KEY_ALIAS="murage-backup-server";
export function knownHostsLine(hostKey:SftpHostKey){const key=checkedHostKey(hostKey);return `${SFTP_HOST_KEY_ALIAS} ${key.type} ${key.key}\n`;}

const plainPath=(value:string)=>typeof value==="string"&&(isAbsolute(value)||/^[A-Za-z]:\\/.test(value))&&value.length<=4096&&!/["\x00-\x1f\x7f]/.test(value);
/** The complete ssh argument vector (after the executable). Only Murage's key
 * and pinned identity are used: no config files, agent, forwarding, proxies,
 * password prompts or the person's own known_hosts. */
export function sftpSshArguments(rawTarget:ResticSftpTarget,files:{identityFile:string;knownHostsFile:string}):string[]{
  const target=resticSftpTargetSchema.parse(rawTarget);if(!target.hostKey)throw Error("RESTIC_SFTP_HOST_KEY_REQUIRED");
  if(!plainPath(files.identityFile)||!plainPath(files.knownHostsFile))throw Error("RESTIC_SFTP_MATERIAL_INVALID");
  const options=["BatchMode=yes","IdentitiesOnly=yes",`IdentityFile=${files.identityFile}`,"IdentityAgent=none","PubkeyAuthentication=yes","PasswordAuthentication=no","KbdInteractiveAuthentication=no","PreferredAuthentications=publickey",
    "StrictHostKeyChecking=yes",`UserKnownHostsFile=${files.knownHostsFile}`,`GlobalKnownHostsFile=${files.knownHostsFile}`,`HostKeyAlias=${SFTP_HOST_KEY_ALIAS}`,`HostKeyAlgorithms=${hostKeyAlgorithms(target.hostKey.type)}`,
    "CheckHostIP=no","UpdateHostKeys=no","VerifyHostKeyDNS=no","ForwardAgent=no","ForwardX11=no","ClearAllForwardings=yes","PermitLocalCommand=no","ProxyCommand=none","ControlMaster=no","ControlPath=none",
    "ConnectTimeout=20","ServerAliveInterval=15","ServerAliveCountMax=4","LogLevel=ERROR"];
  return ["-F","none",...options.flatMap(option=>["-o",option]),"-p",String(target.port),"-l",target.user,"-s","--",target.host,"sftp"];
}
/** restic's -o flag is CSV and its sftp.command is split on spaces with quotes.
 * Every word is double-quoted (backslashes stay literal, which Windows paths
 * need) and the whole option is CSV-quoted. Quotes are refused upstream. */
export function resticSftpCommandOption(ssh:string,args:string[]){
  if(!plainPath(ssh)||args.some(arg=>typeof arg!=="string"||/["\x00-\x1f\x7f]/.test(arg)))throw Error("RESTIC_SFTP_MATERIAL_INVALID");
  const command=[ssh,...args].map(word=>`"${word}"`).join(" ");
  return `"sftp.command=${command.replaceAll('"','""')}"`;
}

/** Absolute tool paths only; PATH is never consulted. */
export function resolveSshTools(platform:NodeJS.Platform=process.platform,exists:(file:string)=>boolean=file=>{try{return statSync(file).isFile();}catch{return false;}}):SshTools{
  const candidates:[string,string][]=platform==="win32"?[["C:\\Windows\\System32\\OpenSSH\\ssh.exe","C:\\Windows\\System32\\OpenSSH\\ssh-keyscan.exe"]]
    :platform==="darwin"?[["/usr/bin/ssh","/usr/bin/ssh-keyscan"]]:[["/usr/bin/ssh","/usr/bin/ssh-keyscan"],["/bin/ssh","/bin/ssh-keyscan"]];
  for(const [ssh,keyscan] of candidates)if(exists(ssh)&&exists(keyscan))return{ssh,keyscan};
  throw Error(platform==="win32"?"RESTIC_SFTP_SSH_MISSING_WINDOWS":"RESTIC_SFTP_SSH_MISSING");
}

/** Child processes get a dedicated environment, never a copy of Murage's. */
export function sshChildEnvironment(cwd:string):Record<string,string>{
  const env:Record<string,string>={HOME:cwd,PATH:"",TMPDIR:cwd};
  if(process.platform==="win32"&&process.env.SystemRoot&&/^[A-Za-z]:\\[^"]*$/.test(process.env.SystemRoot))env.SystemRoot=process.env.SystemRoot;
  return env;
}

/** What ssh said, reduced to a code. Raw stderr never leaves this module. */
export function classifySshFailure(stderr:string):string{
  if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .{1,200} has changed|no matching host key type found|No [A-Z0-9]+ host key is known/i.test(stderr))return "RESTIC_SFTP_HOST_KEY_CHANGED";
  if(/Permission denied \(|Too many authentication failures|no mutual signature algorithm/i.test(stderr))return "RESTIC_SFTP_KEY_REFUSED";
  if(/subsystem request failed/i.test(stderr))return "RESTIC_SFTP_UNAVAILABLE";
  return "RESTIC_SFTP_UNREACHABLE";
}

/** Writes Murage's key and the pinned identity into a fresh private folder for
 * one run, and removes it afterwards. Files are 0600 in a 0700 folder under the
 * remote work directory, which lives outside the data folder and its backups. */
export function writeSshMaterial(workDirectory:string,target:ResticSftpTarget,credentials:ResticSftpCredentials){
  const parsed=resticSftpTargetSchema.parse(target),secret=resticSftpCredentialsSchema.parse(credentials);if(!parsed.hostKey)throw Error("RESTIC_SFTP_HOST_KEY_REQUIRED");
  const directory=mkdtempSync(join(workDirectory,"ssh-"));
  const cleanup=()=>{try{rmSync(directory,{recursive:true,force:true});}catch{/* sweepSshMaterial removes it next time */}};
  try{
    const identityFile=join(directory,"key"),knownHostsFile=join(directory,"known_hosts");
    writeFileSync(identityFile,secret.privateKey,{flag:"wx",mode:0o600});writeFileSync(knownHostsFile,knownHostsLine(parsed.hostKey),{flag:"wx",mode:0o600});
    return{identityFile,knownHostsFile,cleanup};
  }catch(error){cleanup();throw error;}
}
/** Leftovers from a run that was killed. Called only while holding the work lease. */
export function sweepSshMaterial(workDirectory:string){
  let names:string[]=[];try{names=readdirSync(workDirectory);}catch{return;}
  for(const name of names){if(!/^ssh-[A-Za-z0-9]{6}$/.test(name))continue;const path=join(workDirectory,name);try{const stat=lstatSync(path);if(stat.isDirectory()&&!stat.isSymbolicLink())rmSync(path,{recursive:true,force:true});}catch{/* reported by the next run */}}
}

function runTool(executable:string,args:string[],cwd:string,timeoutMs:number):Promise<{code:number|null;stdout:string;stderr:string;timedOut:boolean}>{
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env:sshChildEnvironment(cwd),stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="",timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},timeoutMs);
    child.stdout.on("data",chunk=>{if(stdout.length<256*1024)stdout+=chunk;});child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-16384);});
    child.once("error",()=>{clearTimeout(timer);reject(Error("RESTIC_SFTP_SSH_MISSING"));});
    child.once("close",code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut});});
  });
}
/** Reads the server's host key for the owner to compare. Nothing is trusted here. */
export async function scanHostKey(tools:SshTools,rawTarget:ResticSftpTarget,cwd:string,timeoutMs=30000){
  const target=resticSftpTargetSchema.parse(rawTarget);
  const result=await runTool(tools.keyscan,["-T","15","-p",String(target.port),"-t","ed25519,ecdsa,rsa","--",target.host],cwd,timeoutMs);
  if(result.timedOut)throw Error("RESTIC_SFTP_UNREACHABLE");
  const key=chooseScannedHostKey(result.stdout);return{...key,fingerprint:sshFingerprint(key.key)};
}

// Minimal SFTP v3 (draft-ietf-secsh-filexfer-02) over ssh's -s sftp channel.
const FXP={INIT:1,VERSION:2,OPEN:3,CLOSE:4,WRITE:6,OPENDIR:11,READDIR:12,REMOVE:13,MKDIR:14,STAT:17,STATUS:101,HANDLE:102,NAME:104,ATTRS:105} as const;
const STATUS={OK:0,EOF:1,NO_SUCH_FILE:2,PERMISSION_DENIED:3} as const;
class Reader{
  private offset=0;constructor(private bytes:Buffer){}
  u32(){if(this.offset+4>this.bytes.length)throw Error("RESTIC_SFTP_PROTOCOL");const value=this.bytes.readUInt32BE(this.offset);this.offset+=4;return value;}
  u64(){this.u32();this.u32();}
  string(){const length=this.u32();if(this.offset+length>this.bytes.length)throw Error("RESTIC_SFTP_PROTOCOL");const value=this.bytes.subarray(this.offset,this.offset+length);this.offset+=length;return value;}
  attrs(){const flags=this.u32();let permissions:number|undefined;if(flags&1)this.u64();if(flags&2){this.u32();this.u32();}if(flags&4)permissions=this.u32();if(flags&8){this.u32();this.u32();}if(flags&0x80000000){const count=this.u32();for(let i=0;i<count;i++){this.string();this.string();}}return{permissions};}
}
class SftpError extends Error{constructor(readonly status:number){super("RESTIC_SFTP_STATUS");}}
class SftpSession{
  private buffer=Buffer.alloc(0);private waiters=new Map<number,(packet:{type:number;body:Buffer})=>void>();private id=0;private version?:(ok:boolean)=>void;private failed=false;
  constructor(private child:ReturnType<typeof spawn>){
    child.stdout!.on("data",(chunk:Buffer)=>{this.buffer=Buffer.concat([this.buffer,chunk]);this.drain();});
    child.once("close",()=>this.fail());child.stdin!.on("error",()=>this.fail());
  }
  private fail(){if(this.failed)return;this.failed=true;this.version?.(false);for(const waiter of this.waiters.values())waiter({type:-1,body:Buffer.alloc(0)});this.waiters.clear();}
  private drain(){
    while(this.buffer.length>=4){
      const length=this.buffer.readUInt32BE(0);if(length<1||length>256*1024){this.child.kill("SIGKILL");this.fail();return;}
      if(this.buffer.length<4+length)return;
      const packet=this.buffer.subarray(4,4+length);this.buffer=this.buffer.subarray(4+length);
      if(packet[0]===FXP.VERSION){this.version?.(true);this.version=undefined;continue;}
      if(packet.length<5)continue;const id=packet.readUInt32BE(1),waiter=this.waiters.get(id);this.waiters.delete(id);waiter?.({type:packet[0],body:packet.subarray(5)});
    }
  }
  private send(type:number,parts:Buffer[]){const body=Buffer.concat([Buffer.from([type]),...parts]);this.child.stdin!.write(Buffer.concat([uint32(body.length),body]));}
  init(){return new Promise<boolean>(resolve=>{if(this.failed)return resolve(false);this.version=resolve;this.send(FXP.INIT,[uint32(3)]);});}
  private request(type:number,parts:Buffer[]){
    return new Promise<{type:number;body:Buffer}>((resolve,reject)=>{
      if(this.failed)return reject(Error("RESTIC_SFTP_CLOSED"));const id=++this.id;
      this.waiters.set(id,packet=>packet.type===-1?reject(Error("RESTIC_SFTP_CLOSED")):resolve(packet));this.send(type,[uint32(id),...parts]);
    });
  }
  private static status(packet:{type:number;body:Buffer}){if(packet.type!==FXP.STATUS)throw Error("RESTIC_SFTP_PROTOCOL");return new Reader(packet.body).u32();}
  private async expectOk(type:number,parts:Buffer[]){const status=SftpSession.status(await this.request(type,parts));if(status!==STATUS.OK)throw new SftpError(status);}
  private async handle(type:number,parts:Buffer[]){const packet=await this.request(type,parts);if(packet.type===FXP.HANDLE)return new Reader(packet.body).string();throw new SftpError(SftpSession.status(packet));}
  async stat(path:string){const packet=await this.request(FXP.STAT,[sshString(Buffer.from(path))]);if(packet.type===FXP.ATTRS){const {permissions}=new Reader(packet.body).attrs();return{exists:true,directory:permissions!==undefined&&(permissions&0o170000)===0o040000};}const status=SftpSession.status(packet);if(status===STATUS.NO_SUCH_FILE)return{exists:false,directory:false};throw new SftpError(status);}
  mkdir(path:string){return this.expectOk(FXP.MKDIR,[sshString(Buffer.from(path)),uint32(4),uint32(0o700)]);}
  async list(path:string){
    const handle=await this.handle(FXP.OPENDIR,[sshString(Buffer.from(path))]),names:string[]=[];
    try{
      for(;;){
        const packet=await this.request(FXP.READDIR,[sshString(handle)]);
        if(packet.type===FXP.STATUS){const status=new Reader(packet.body).u32();if(status===STATUS.EOF)break;throw new SftpError(status);}
        if(packet.type!==FXP.NAME)throw Error("RESTIC_SFTP_PROTOCOL");
        const reader=new Reader(packet.body),count=reader.u32();
        for(let i=0;i<count;i++){const name=reader.string().toString("utf8");reader.string();reader.attrs();if(name!=="."&&name!=="..")names.push(name);}
        if(names.length>100000)throw Error("RESTIC_SFTP_PROTOCOL");
      }
    }finally{await this.expectOk(FXP.CLOSE,[sshString(handle)]).catch(()=>{});}
    return names;
  }
  async writeCheck(path:string){
    const handle=await this.handle(FXP.OPEN,[sshString(Buffer.from(path)),uint32(0x02|0x08|0x20),uint32(4),uint32(0o600)]);
    try{await this.expectOk(FXP.WRITE,[sshString(handle),uint32(0),uint32(0),sshString(randomBytes(16))]);}finally{await this.expectOk(FXP.CLOSE,[sshString(handle)]).catch(()=>{});}
    await this.expectOk(FXP.REMOVE,[sshString(Buffer.from(path))]);
  }
}
export type SftpFolderState="empty"|"repository"|"other-files";
/** Connects with the pinned identity, creates the folder if it is missing,
 * proves it is writable with a throwaway file, and says what is in it. */
export async function probeSftpFolder(input:{ssh:string;args:string[];folder:string;cwd:string;timeoutMs?:number}):Promise<SftpFolderState>{
  if(!plainPath(input.ssh))throw Error("RESTIC_SFTP_SSH_MISSING");
  const child=spawn(input.ssh,input.args,{cwd:input.cwd,env:sshChildEnvironment(input.cwd),stdio:["pipe","pipe","pipe"],windowsHide:true});
  let stderr="",spawnFailed=false;child.stderr!.on("data",chunk=>{stderr=(stderr+chunk).slice(-16384);});child.once("error",()=>{spawnFailed=true;});
  const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  const timer=setTimeout(()=>child.kill("SIGKILL"),input.timeoutMs??60000);
  const session=new SftpSession(child);
  const failure=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exited;if(spawnFailed)return Error("RESTIC_SFTP_SSH_MISSING");return Error(classifySshFailure(stderr));};
  const denied=(error:unknown)=>error instanceof SftpError&&error.status===STATUS.PERMISSION_DENIED;
  try{
    if(!await session.init())throw await failure();
    const prefix=input.folder.startsWith("/")?"/":"",parts=input.folder.split("/").filter(Boolean);let current="";
    try{
      for(let index=0;index<parts.length;index++){
        current=prefix+parts.slice(0,index+1).join("/");
        const found=await session.stat(current);
        if(found.exists){if(!found.directory)throw Error("RESTIC_SFTP_FOLDER_INVALID");continue;}
        await session.mkdir(current);
      }
      const names=await session.list(current);
      const state:SftpFolderState=names.length===0?"empty":names.includes("config")&&names.includes("keys")&&names.includes("data")?"repository":"other-files";
      await session.writeCheck(`${current}/.murage-write-check-${randomBytes(8).toString("hex")}`);
      return state;
    }catch(error){
      if(error instanceof Error&&error.message==="RESTIC_SFTP_FOLDER_INVALID")throw error;
      if(denied(error))throw Error("RESTIC_SFTP_FOLDER_NOT_WRITABLE");
      if(error instanceof SftpError)throw Error("RESTIC_SFTP_FOLDER_NOT_WRITABLE");
      throw await failure();
    }
  }finally{clearTimeout(timer);child.stdin!.end();const late=setTimeout(()=>child.kill("SIGKILL"),5000);await exited;clearTimeout(late);}
}
