// SPDX-License-Identifier: AGPL-3.0-or-later
// An owned MCP proxy stand-in for the mount relay's metering tests. The io preload has already sent its first receipt;
// this writes 8192 counted bytes, says so on stderr, and in "unknown" / "foreign-io" mode also sends one unrelated IPC
// frame (an application type, or a receipt-shaped frame under a generation nobody observes). It ends
// like a proxy: stdin closed, then the final receipt and its acknowledgement before exit.
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {exitWithChildIoReceipt} from "../sentinel/io-child-receipts.ts";
const [dir,mode]=process.argv.slice(2);
writeFileSync(join(dir!,`proxy-${process.pid}`),Buffer.alloc(8192));
if(mode==="unknown")process.send!({type:"fixture-unknown"});
if(mode==="foreign-io")process.send!({type:"io",ioProtocol:1,generation:"fixture-foreign-generation",sequence:1,fsWriteBlocks:0,ioBytes:0,known:true,final:false});
process.stderr.write("fixture-proxy-written\n");
process.stdin.resume();
process.stdin.on("end",()=>{void exitWithChildIoReceipt(0);});
