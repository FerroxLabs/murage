// SPDX-License-Identifier: AGPL-3.0-or-later
import {writeFileSync} from "node:fs";
import {join} from "node:path";
if(process.argv[3]==="release-stop"){
 const {processProxyRelease}=await import("../proxy-turn-release.ts");
 processProxyRelease("fixture");
 process.send?.({type:"fixture-ready"});
}
for await(const _ of process.stdin){writeFileSync(join(process.argv[2],"proxy-write"),Buffer.alloc(8192));process.stdout.write("fixture response\n");}
if(process.argv[3]==="release-ipc"){
 const {processProxyRelease}=await import("../proxy-turn-release.ts");
 const release=processProxyRelease("fixture");
 const {exitWithChildIoReceipt}=await import("../io-child-receipts.ts");
 await exitWithChildIoReceipt(0,code=>{process.send?.({type:"fixture-release",sealed:release.sealed,code},()=>process.exit(code));});
}
