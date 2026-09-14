import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync,existsSync,mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { backupFixture,testAgeKeys } from "./testing/backup-fixture.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const worker = fileURLToPath(new URL("../scripts/installation-recovery-worker.ts", import.meta.url));

it("the actual worker emits a bounded summary without archive contents or inherited provider configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-recovery-worker-")); roots.push(root);
  const data = join(root, "source"); mkdirSync(data);
  const original = '{"profile":{"name":"Private fixture"},"flux":{"apiKey":"private-worker-canary"}}';
  writeFileSync(join(data, "config.json"), original);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [worker, "backup", "--data-dir", data, "--output", join(root, "backup.zip")], { timeout: 20_000, env: { PATH: dirname(process.execPath), HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ ok: true, operation: "backup", omittedCount: 1 });
  expect(stdout.length).toBeLessThan(4096);
  expect(stdout + stderr).not.toContain("private-worker-canary");
  expect(result.omitted).toBeUndefined();
  expect(readFileSync(join(data, "config.json"), "utf8")).toBe(original);
});

async function privateWorker(args:string[],identity:string,home:string,wrongNonce=false){
  const entry=process.env.MURAGE_BACKUP_WORKER_ENTRY??worker;
  const source=`import {parentPort} from 'node:worker_threads';
const listeners=new Map();process.parentPort={on(name,fn){const wrap=data=>fn({data});listeners.set(fn,wrap);parentPort.on(name,wrap);},removeListener(name,fn){parentPort.removeListener(name,listeners.get(fn));listeners.delete(fn);},postMessage:value=>parentPort.postMessage(value)};
process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  const child=new Worker(new URL("data:text/javascript,"+encodeURIComponent(source)),{stdout:true,stderr:true,execArgv:["--experimental-strip-types"],env:{PATH:dirname(process.execPath),HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:join(home,"worker-profile")}});
  let logs="",requests=0,reply:Record<string,unknown>|undefined;
  child.stdout.on("data",chunk=>{logs+=chunk;});child.stderr.on("data",chunk=>{logs+=chunk;});
  child.on("message",message=>{
    if(message.type==="murage:recovery-input-ready"){requests++;child.postMessage({type:"murage:recovery-input",nonce:wrongNonce?"wrong":message.nonce,identity});}
    if(message.type==="murage:recovery-result"){reply=message.result;child.postMessage({type:"murage:recovery-result-ack",nonce:message.nonce});}
  });
  const code=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>{void child.terminate().then(()=>reject(Error("fixture worker timeout")));},20000);child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("exit",code=>{clearTimeout(timer);resolve(code);});});
  expect(logs.includes(identity.trim())).toBe(false);expect(logs.includes("FAKE-CREDENTIAL-CANARY")).toBe(false);
  return{code,requests,reply};
}
it("actual private worker encrypts and restores using one-use identity IPC and packaged tool layout",async()=>{
  const f=backupFixture(),keys=testAgeKeys();roots.push(f.parent);
  try{
    const resource=join(f.parent,"Resources","backup-tools","arm64");mkdirSync(resource,{recursive:true});
    const ageTool=join(resource,"age");copyFileSync(new URL("../dist-native/backup-age/arm64/age",import.meta.url),ageTool);
    const archive=join(f.parent,"private.age");
    const saved=await privateWorker(["backup-encrypted","--data-dir",f.data,"--output",archive,"--age-tool",ageTool,"--recipient",keys.recipient,"--credential-policy","preserve-in-encrypted-fidelity"],keys.identity,f.parent);
    expect(saved.code).toBe(0);expect(saved.requests).toBe(1);expect(saved.reply).toMatchObject({ok:true,operation:"backup-encrypted",coverage:{scope:"application-data",fullInstallation:false}});
    const target=join(f.parent,"private-restore");
    const restored=await privateWorker(["restore-encrypted-new","--data-dir",target,"--archive",archive,"--sha256",String(saved.reply!.sha256),"--age-tool",ageTool],keys.identity,f.parent);
    expect(restored.code).toBe(0);expect(restored.requests).toBe(1);expect(restored.reply).toMatchObject({ok:true,operation:"restore-encrypted-new",activationAvailable:false,rawFidelityActivated:false});
    expect(existsSync(join(target,"bots.json"))).toBe(true);
    const refused=await privateWorker(["inspect-encrypted","--archive",archive,"--age-tool",ageTool],keys.identity,f.parent,true);
    expect(refused.code).toBe(1);expect(refused.reply?.error).toBe("INVALID_RECOVERY_INPUT");
  }finally{f.db.close();}
},60000);
