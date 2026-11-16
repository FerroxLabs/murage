import {exitWithChildIoReceipt} from "../io-child-receipts.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import {writeFileSync,appendFileSync,openSync,writeSync,closeSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {fork} from "node:child_process";
import {mkdirSync} from "node:fs";
import {registerOwnedChildForTest} from "../io-child-meter.ts";
import {join} from "node:path";
import {writeFileSync as countedWrite} from "../counted-fs.ts";
import {ioMeterSnapshot} from "../io-meter.ts";
const root=process.argv[2];
if(process.argv[3]==="file-log"){
 const usage=process.resourceUsage.bind(process);process.resourceUsage=()=>({...usage(),fsWrite:0});
}
writeFileSync(join(root,"raw"),"12345");appendFileSync(join(root,"raw"),"123");
const fd=openSync(join(root,"descriptor"),"w");try{writeSync(fd,Buffer.from("1234"));}finally{closeSync(fd);}
await writeFile(join(root,"promise"),"123456");countedWrite(join(root,"routed"),"1234567");
let nestedFinal:unknown,foreign:unknown;
if(process.argv[3]==="nested"){
 registerOwnedChildForTest("testing/io-owned-child.fixture");const nested=join(root,"nested");mkdirSync(nested);
 const child=fork(process.argv[1],[nested,"natural"],{stdio:["ignore","ignore","ignore","ipc"]});
 child.on("message",raw=>{const message=raw as {type?:string;final?:boolean};if(message.type==="io"&&message.final)nestedFinal=raw;});
 await new Promise<void>((done,reject)=>{child.on("error",reject);child.on("exit",code=>code===0?done():reject(Error("nested fixture failed")));});
}
if(process.argv[3]==="foreign"||process.argv[3]==="file-log"){
 const entry=join(root,"foreign.mjs");
 writeFileSync(entry,"console.log(JSON.stringify({generation:!!process.env.MURAGE_IO_GENERATION,child:!!process.env.MURAGE_IO_CHILD,preload:process.execArgv.some(a=>a.startsWith('--import=')&&a.includes('io-child-bootstrap'))}))");
 const child=fork(entry,[],{stdio:["ignore","pipe","ignore","ipc"]});
 let output="";child.stdout!.on("data",chunk=>output+=chunk);
 await new Promise<void>((done,reject)=>{child.on("error",reject);child.on("close",code=>code===0?done():reject(Error("foreign fixture failed")));});foreign=JSON.parse(output);
}
process.send?.({type:"fixture-summary",snapshot:ioMeterSnapshot(),nestedFinal,foreign});
if(process.argv[3]==="explicit")await exitWithChildIoReceipt(0);
