// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture and receipt boundary owner: scperf-p2. Isolated process use only.
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {sentinelInstallationIdOf} from "../../shared/sentinel-installation.mjs";
import {defaultOutputRoot,sourcePaths,writeDescriptor,type SentinelDescriptor} from "../sentinel/paths.ts";
import {provisionFileReceipts,SentinelFileWriter} from "../sentinel/file-receipts.ts";
import {scannerNative} from "../sentinel/io-meter.ts";
import {sampleSentinelFileIo} from "../sentinel-file-sampling.ts";

export function sealedCoverageFixture(){
 const root=mkdtempSync(join(tmpdir(),"sealed-coverage-")),data=join(root,"data");
 mkdirSync(data,{mode:0o700});
 process.env.MURAGE_DATA_DIR=data;process.env.MURAGE_SENTINEL_STATE_DIR=join(root,"state");
 const installationId=sentinelInstallationIdOf(data),outputRoot=defaultOutputRoot(installationId)!;
 mkdirSync(outputRoot,{recursive:true,mode:0o700});
 const entry=resolve("server/sentinel/cli.ts");
 const descriptor:SentinelDescriptor={version:1,installationId,installationRoot:data,inputRoot:join(data,"health"),outputRoot,
  sources:sourcePaths(join(data,"health")),executable:{path:process.execPath,entry,sha256:createHash("sha256").update(readFileSync(entry)).digest("hex")},scheduleRevision:1};
 if(!writeDescriptor(descriptor).ok||!provisionFileReceipts(data,{legacyExcluded:true}))throw Error("FIXTURE_ENROLLMENT");
 const api=scannerNative() as ReturnType<typeof scannerNative>&{ioMeterSnapshot():{total:number;known:boolean}};
 const read=()=>{const s=api.ioMeterSnapshot!();return {bytes:s.total,known:s.known};};
 const cycle=()=>{const writer=SentinelFileWriter.begin(descriptor,read);if(!writer?.finish(read,true))throw Error("FIXTURE_SEAL");};
 if(sampleSentinelFileIo(()=>null).snapshot.known)throw Error("FIXTURE_COLD");
 cycle();
 return {descriptor,cycle,close:()=>rmSync(root,{recursive:true,force:true})};
}
