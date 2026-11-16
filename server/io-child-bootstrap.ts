// SPDX-License-Identifier: AGPL-3.0-or-later
// A packaged entry as well as a source preload. Only an explicitly owned launch
// installs these hooks; foreign Node programs never get this preload.
import "../shared/win-hide-child-process.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import * as counted from "./counted-fs.ts";
import * as countedPromises from "./counted-fs-promises.ts";
import {installCopyMeter,ioMeterSnapshot} from "./io-meter.ts";
import {installChildProcessMeter,reportChildIoCensus} from "./io-child-meter.ts";
import {ChildIoReporter,ownedChildIoBytes,ownedChildIoKnown,setChildIoFinisher,exitWithChildIoReceipt} from "./sentinel/io-child-receipts.ts";
installCopyMeter();
installChildProcessMeter();
if(process.env.MURAGE_IO_CHILD==="1"&&process.env.MURAGE_IO_GENERATION&&process.send){
 // Existing counted writers use captured native methods, so a raw write and an
 // explicitly routed write both reach exactly one boundary.
 for(const name of ["writeSync","write","writevSync","writev","writeFileSync","appendFileSync","writeFile","appendFile","createWriteStream"] as const)
  Object.assign(fs,{[name]:counted[name]});
 for(const name of ["open","writeFile","appendFile"] as const)Object.assign(fsp,{[name]:countedPromises[name]});
 syncBuiltinESMExports();
 const reporter=new ChildIoReporter(process.env.MURAGE_IO_GENERATION,()=>{
  const snapshot=ioMeterSnapshot(),blocks=process.platform==="win32"?0:process.resourceUsage().fsWrite;
  return {blocks,bytes:Math.max(blocks*512,snapshot?.total??0)+ownedChildIoBytes(),known:snapshot?.known===true&&ownedChildIoKnown()};
 },message=>process.send!(message));
 const interval=setInterval(()=>reporter.report(),10_000);interval.unref();
 reporter.report();
 let stopping:Promise<void>|undefined;
 const finish=()=>stopping??=(async()=>{
  clearInterval(interval);
  reportChildIoCensus();
  const acknowledge=(message:unknown)=>reporter.accept(message);
  process.on("message",acknowledge);
  try{await reporter.finish();}finally{process.off("message",acknowledge);}
 })();
 setChildIoFinisher(finish);
 process.once("beforeExit",code=>{void exitWithChildIoReceipt(code);});
}
