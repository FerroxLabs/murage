import { isReadOnly } from "./read-only-state.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// File producer and server consumer owner: scperf-p2-rd2. IPC is a separate
// transport and cannot establish closure of scheduled or orphaned writers.
import {join} from "node:path";
import {homedir} from "node:os";
import {SentinelFileReceiver,prepareDefaultFileReceipts,type SentinelFileSnapshot} from "./sentinel/file-receipts.ts";
let receiver:SentinelFileReceiver|undefined,root:string|undefined;
let bytes=0,defaultBoot=false;
/** Called only by the shipped server boot boundary. Ordinary coverage reads
 * never manufacture proof from absent files. The launcher uses the same API. */
export function enableDefaultSentinelCoverage(){defaultBoot=true;}
export const sentinelExternalIoBytes=()=>bytes;
export function sampleSentinelFileIo<T>(capture:()=>T):{snapshot:SentinelFileSnapshot;process:T}{
 const dataDir=process.env.MURAGE_DATA_DIR??join(homedir(),".murage");
 if(defaultBoot&&!isReadOnly())prepareDefaultFileReceipts(dataDir);
 if(!receiver||root!==dataDir){root=dataDir;receiver=new SentinelFileReceiver(dataDir);}
 const sample=receiver.sample(capture);bytes=Math.max(bytes,sample.snapshot.bytes);return sample;
}
