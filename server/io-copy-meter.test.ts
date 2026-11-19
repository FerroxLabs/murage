// SPDX-License-Identifier: AGPL-3.0-or-later
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {afterAll,beforeAll,expect,it} from "vitest";
let nativeRoot:string,binary:string;
beforeAll(()=>{
 nativeRoot=mkdtempSync(join(tmpdir(),"copy-meter-native-"));binary=join(nativeRoot,"engine-exclusion.node");
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{stdio:"pipe"});
});
afterAll(()=>{if(nativeRoot)rmSync(nativeRoot,{recursive:true,force:true});});
function probe(body:string){
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`
 import fs from 'node:fs';import fsp from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
 const reserved=await import(${JSON.stringify(pathToFileURL(resolve("server/drivers/no-limits-state.ts")).href)});
 const meter=await import(${JSON.stringify(pathToFileURL(resolve("server/io-meter.ts")).href)});
 meter.installCopyMeter?.();meter.ensureIoMeter();
 const dir=fs.mkdtempSync(join(tmpdir(),'copy-meter-'));
 try {const source=join(dir,'source'),dest=join(dir,'dest');fs.mkdirSync(source);fs.writeFileSync(join(source,'a'),'abcde');
 const before=meter.ioMeterSnapshot().total;${body}
 console.log(JSON.stringify({delta:meter.ioMeterSnapshot().total-before,known:meter.ioMeterSnapshot().known}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 `],{encoding:"utf8",env:{...process.env,NODE_ENV:"test",MURAGE_ENGINE_EXCLUSION_PATH:binary}});
 return JSON.parse(output.trim());
}
it("T10 reserved named cpSync binding counts a recursive session copy without editing the reserved file",()=>{
 expect(probe(`fs.mkdirSync(join(source,'sessions'));fs.renameSync(join(source,'a'),join(source,'sessions','a'));fs.mkdirSync(dest);reserved.linkNoLimitsState(source,dest,['sessions']);`)).toEqual({delta:5,known:true});
});
it.each([
 ["copyFileSync",`fs.copyFileSync(join(source,'a'),dest);`],
 ["copyFileSync reflink",`fs.copyFileSync(join(source,'a'),dest,fs.constants.COPYFILE_FICLONE);`],
 ["copyFile promise reflink",`await fsp.copyFile(join(source,'a'),dest,fs.constants.COPYFILE_FICLONE);`],
 ["copyFile callback",`await new Promise((ok,no)=>fs.copyFile(join(source,'a'),dest,e=>e?no(e):ok()));`],
 ["copyFile promise",`await fsp.copyFile(join(source,'a'),dest);`],
 ["fs.promises.copyFile",`await fs.promises.copyFile(join(source,'a'),dest);`],
 ["cpSync",`fs.cpSync(source,dest,{recursive:true});`],
 ["cp callback",`await new Promise((ok,no)=>fs.cp(source,dest,{recursive:true},e=>e?no(e):ok()));`],
 ["cp promise",`await fsp.cp(source,dest,{recursive:true});`],
 ["fs.promises.cp",`await fs.promises.cp(source,dest,{recursive:true});`],
])("T10 %s returns a logical-size receipt exactly once",(_name,body)=>{
 expect(probe(body)).toEqual({delta:5,known:true});
});
it("T10 repeated installation is idempotent and a chained async filter only counts accepted entries",()=>{
 expect(probe(`meter.installCopyMeter?.();fs.writeFileSync(join(source,'skip'),'not copied');await fsp.cp(source,dest,{recursive:true,filter:async p=>!p.endsWith('skip')});if(fs.existsSync(join(dest,'skip')))throw Error('filter ignored');`)).toEqual({delta:5,known:true});
});
it("T10 nested entries and dereferenced links are counted per entry",()=>{
 expect(probe(`fs.mkdirSync(join(source,'nested'));fs.writeFileSync(join(source,'nested','b'),'1234567');fs.symlinkSync(join(source,'a'),join(source,'link'));fs.cpSync(source,dest,{recursive:true,dereference:true});`)).toEqual({delta:17,known:true});
});
it("T10 a partial recursive-copy failure keeps its charged floor and invalidates coverage",()=>{
 const result=probe(`fs.writeFileSync(join(source,'b'),'12345');let accepted;try{fs.cpSync(source,dest,{recursive:true,filter:p=>{if(fs.lstatSync(p).isFile()){if(accepted)throw Error('fixture refusal');accepted=p;}return true;}});}catch{}if(!accepted||!fs.existsSync(join(dest,accepted.split('/').at(-1))))throw Error('missing completed prefix');`);
 expect(result,"a failed recursive copy retains its completed prefix and invalidates coverage").toEqual({delta:5,known:false});
});
it("T10 copies performed by the user filter remain separate counted writes",()=>{
 expect(probe(`await fsp.cp(source,dest,{recursive:true,filter:async p=>{if(p.endsWith('a'))await fsp.copyFile(p,join(dir,'filter-copy'));return true;}});`)).toEqual({delta:10,known:true});
});

it("T10 a rejecting synchronous filter preserves Node semantics without charging skipped entries",()=>{
 expect(probe(`fs.cpSync(source,dest,{recursive:true,filter:()=>false});if(fs.existsSync(dest))throw Error('rejected copy ran');`)).toEqual({delta:0,known:true});
});

it("T10 truthy synchronous filters retain Node's copy semantics and their receipt",()=>{
 expect(probe(`fs.cpSync(source,dest,{recursive:true,filter:()=>1});`)).toEqual({delta:5,known:true});
});
