// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import {execFileSync} from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { forgetExclusionAddon } from "./engine-exclusion.ts";
import { ioMeterTotal, resetIoMeterForTest } from "./io-meter.ts";
import { readProcess } from "./io-budget.ts";
let nativeRoot:string;
const priorNativePath=process.env.MURAGE_ENGINE_EXCLUSION_PATH;
beforeAll(()=>{
 nativeRoot=mkdtempSync(join(tmpdir(),"murage-meter-native-"));
 const binary=join(nativeRoot,"engine-exclusion.node");
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{windowsHide:true,stdio:"pipe"});
 process.env.MURAGE_ENGINE_EXCLUSION_PATH=binary;forgetExclusionAddon();resetIoMeterForTest();
});
afterAll(()=>{
 if(priorNativePath===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;
 else process.env.MURAGE_ENGINE_EXCLUSION_PATH=priorNativePath;
 forgetExclusionAddon();resetIoMeterForTest();
 if(nativeRoot)rmSync(nativeRoot,{recursive:true,force:true});
});
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const root=()=>{const p=mkdtempSync(join(tmpdir(),"win-iometer-"));roots.push(p);return p;};
it.each(['registration','function'])('failed SQL deadline %s leaves the original SQLite VFS usable', failure => {
 const source=readFileSync('native/engine-exclusion/meter.c','utf8');
 const needle=failure==='registration'?'sqlite3_auto_extension((void(*)(void))install_grant_deadline)':'return sqlite3_create_function_v2';
 expect(source).toContain(needle);
 const file=join(nativeRoot,'refused-meter.c'),binary=join(nativeRoot,'refused-meter.node');
 writeFileSync(file,source.replace(needle,failure==='registration'?'SQLITE_NOMEM':'return SQLITE_NOMEM ? SQLITE_NOMEM : sqlite3_create_function_v2'));
 execFileSync('cc',['-std=c11','-D_GNU_SOURCE','-O2','-Wall','-Werror','-fPIC','-shared','-DNAPI_VERSION=9',
  '-I',resolve(dirname(process.execPath),'../include/node'),'-I',resolve('native/engine-exclusion'),
  'native/engine-exclusion/exclusion.c',file,'-o',binary],{stdio:'pipe'});
 const entry=pathToFileURL(resolve('server/io-meter.ts')).href;
 const program=`import {createRequire} from 'node:module';import {DatabaseSync} from 'node:sqlite';
  import {ensureIoMeter} from ${JSON.stringify(entry)};
  const addon=createRequire(import.meta.url)(${JSON.stringify(binary)});addon.disableCoreDumps();
  if(ensureIoMeter())throw Error('failed extension was admitted');
  const db=new DatabaseSync(${JSON.stringify(join(nativeRoot,`${failure}-fallback.db`))});
  db.exec('CREATE TABLE t(v); INSERT INTO t VALUES(1)');
  if(db.prepare('SELECT v FROM t').get().v!==1)throw Error('fallback lost data');db.close();`;
 expect(()=>execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',program],
  {cwd:nativeRoot,env:{...process.env,MURAGE_ENGINE_EXCLUSION_PATH:binary},stdio:'pipe'})).not.toThrow();
});
// Compatible baseline adapters: the RED is a missing byte reading after real
// successful writes, rather than an unresolved module or a missing symbol.
async function fsLayer(){const name="./counted-"+"fs.ts";return import(/* @vite-ignore */ name).catch(()=>import("node:fs"));}
async function sqliteLayer(){const name="./sqlite-"+"open.ts";return import(/* @vite-ignore */ name).catch(()=>({openSqlite:(p:string)=>new DatabaseSync(p)}));}
it("Windows counts repeated same-size file overwrites, including append and descriptor writes",async()=>{
 const fs=await fsLayer(),file=join(root(),"same-size");const bytes=Buffer.alloc(512*1024,97);
 const before=readProcess("win32").fsWriteBlocks;
 fs.writeFileSync(file,bytes);fs.writeFileSync(file,bytes);fs.appendFileSync(file,bytes);
 const fd=fs.openSync(file,"r+");try{fs.writeSync(fd,bytes,0,bytes.length,0);}finally{fs.closeSync(fd);}
 expect(readFileSync(file).length).toBe(2*bytes.length);
 expect((readProcess("win32").fsWriteBlocks-before)*512).toBeGreaterThanOrEqual(4*bytes.length);
});
it.each(["WAL","DELETE","OFF"])("Windows counts SQLite %s writes and checkpoint copies without a file-size delta",async mode=>{
 const {openSqlite}=await sqliteLayer(),file=join(root(),"index.db"),db=openSqlite(file);
 try{
  db.exec(`PRAGMA journal_mode=${mode}; PRAGMA synchronous=FULL; CREATE TABLE t(k PRIMARY KEY,v)`);
  const before=readProcess("win32").fsWriteBlocks;
  const insert=db.prepare("INSERT OR REPLACE INTO t VALUES(1,?)");
  for(let i=0;i<4;i++){insert.run(Buffer.alloc(512*1024,i));if(mode==="WAL")db.exec("PRAGMA wal_checkpoint(TRUNCATE)");}
  expect((readProcess("win32").fsWriteBlocks-before)*512).toBeGreaterThanOrEqual(2*1024*1024);
  expect(db.prepare("SELECT length(v) AS n FROM t").get()?.n).toBe(512*1024);
 }finally{db.close();}
});
it("invalid asynchronous file data is rejected before truncating an existing file",async()=>{
 const fs=await import("node:fs"),counted=await import("./counted-fs-promises.ts"),file=join(root(),"keep-existing");
 fs.writeFileSync(file,"kept");
 await expect(counted.writeFile(file,null as unknown as string)).rejects.toBeInstanceOf(TypeError);
 expect(readFileSync(file,"utf8")).toBe("kept");
 for(const options of [{flush:"invalid"},{signal:{aborted:false}}]){
  await expect(counted.writeFile(file,"replacement",options as never)).rejects.toBeInstanceOf(TypeError);
  expect(readFileSync(file,"utf8")).toBe("kept");
 }
});
it("native file copies keep their result and count the destination logical size",async()=>{
 const fs=await import("node:fs"),counted=await import("./counted-fs-promises.ts"),dir=root(),source=join(dir,"source"),dest=join(dir,"dest");
 fs.writeFileSync(source,"copy me");
 // MAIN RULING (binding design 2.7a): "copyFile is counted as the size of the destination. Reflinks count logical size (over-count is safe)."
 const before=ioMeterTotal();expect(before).not.toBeNull();
 await counted.copyFile(source,dest);
 expect(readFileSync(dest,"utf8")).toBe("copy me");
 expect(ioMeterTotal()).toBe(before!+Buffer.byteLength("copy me"));
});
it("successful writes stay charged after a partial copy failure makes coverage unknown",async()=>{
 const counted=await import("./counted-fs-promises.ts"),dir=root(),file=join(dir,"diagnostic");
 const bytes=Buffer.alloc(2*1024*1024,13);
 const raw=await import("node:fs"),source=join(dir,"source");
 raw.mkdirSync(source);raw.writeFileSync(join(source,"a"),"copy fixture");
 // MAIN RULING (binding design 2.7a): "cp is counted per entry through a chained filter"; a failed recursive copy still has an unobservable partial tail.
 await expect(counted.cp(source,join(dir,"copy"),{recursive:true,filter:path=>{if(path.endsWith("a"))throw new Error("fixture refusal");return true;}})).rejects.toThrow("fixture refusal");
 // Coverage stays unknown; later observed writes must still reach the judge.
 const before=readProcess("win32");
 await counted.writeFile(file,bytes);
 const after=readProcess("win32");
 expect(readFileSync(file)).toEqual(bytes);
 expect(after.osKnown).toBe(false);
 expect((after.fsWriteBlocks-before.fsWriteBlocks)*512).toBeGreaterThanOrEqual(bytes.length);
});

it("descriptor writeFileSync calls retain their API and count complete repeated writes", async () => {
 const raw=await import("node:fs"),counted=await import("./counted-fs.ts"),file=join(root(),"descriptor"),bytes=Buffer.alloc(1024*1024,19);
 const before=readProcess("win32").fsWriteBlocks;
 for(let n=0;n<2;n++){
  const fd=raw.openSync(file,"w");
  try{counted.writeFileSync(fd,bytes);}finally{raw.closeSync(fd);}
 }
 expect(raw.statSync(file).size).toBe(bytes.length);
 expect((readProcess("win32").fsWriteBlocks-before)*512).toBeGreaterThanOrEqual(2*bytes.length);
});


it("the first SQLite constructor in a fresh process is metered before any explicit meter read", () => {
 const file=join(root(),"cold.sqlite");
 const sqlite=pathToFileURL(resolve("server/sqlite-open.ts")).href;
 const meter=pathToFileURL(resolve("server/io-meter.ts")).href;
 const source=`import {DatabaseSync} from ${JSON.stringify(sqlite)};
 import {ioMeterSnapshot} from ${JSON.stringify(meter)};
 const db=new DatabaseSync(${JSON.stringify(file)});
 db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE t(v BLOB)");
 db.prepare("INSERT INTO t VALUES(?)").run(Buffer.alloc(512*1024,17));
 db.close();
 console.log(JSON.stringify(ioMeterSnapshot()));`;
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",source],{windowsHide:true,encoding:"utf8",env:process.env});
 const receipt=JSON.parse(output.trim().split("\n").at(-1)!);
 expect(receipt.known).toBe(true);
 expect(receipt.total).toBeGreaterThanOrEqual(512*1024);
});
