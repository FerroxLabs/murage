// Owned-process crash fixture owner: win-sac-sign; Windows VM disposal and upload/extraction crash witnesses owner: MAIN.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const phase=process.argv[2];
const pause=async(f)=>{process.send({phase,root:f.root,file:f.receiptFile});await new Promise(()=>{});};
let f,synced=false;
if(["during-commit","disk-full","verify-sync"].includes(phase)){
  const original=fs.promises.open;
  const rename=fs.promises.rename;
  fs.promises.rename=async(...args)=>{if(phase==="verify-sync"&&!synced)throw Error("fixture rename preceded flush");return rename(...args);};
  fs.promises.open=async(...args)=>{
    const handle=await original(...args);
    if(String(args[0]).endsWith(".partial")){
      const write=handle.writeFile.bind(handle);
      const sync=handle.sync.bind(handle);
      handle.sync=async()=>{await sync();synced=true;};
      handle.writeFile=async bytes=>{
        if(phase==="disk-full")throw Object.assign(Error("fixture output exhausted"),{code:"ENOSPC"});
        await write(bytes);if(phase!=="verify-sync"){await handle.sync();await pause(f);}
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
const {receiptFixture}=await import("./windows-signing-receipt.mjs");
f=receiptFixture([]);
try{
  if(phase==="after-sign"){
    await f.produce("gepa");await f.sign("gepa");await pause(f);
  }else if(phase==="before-embed"){
    await f.prepare("gepa");await f.writer.package("app",async()=>{
      await f.prepare("app");await f.prepare("uninstaller");await pause(f);
    });
  }else{
    await f.build();await f.complete();
    if(phase!=="verify-sync")throw Error("fixture commit unexpectedly succeeded");
    process.send({phase,root:f.root,file:f.receiptFile,synced});process.disconnect();
  }
}catch(error){
  if(phase!=="disk-full"||error.code!=="ENOSPC")throw error;
  process.send({phase,root:f.root,file:f.receiptFile,code:error.code,partial:fs.existsSync(`${f.receiptFile}.partial`)});
  process.disconnect();
}
