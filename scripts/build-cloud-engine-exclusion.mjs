// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud image resource owner: scperf-p2. Built on the image's pinned Ubuntu/Node
// toolchain for its own architecture; Desktop keeps its separate glibc floor.
import {execFileSync} from "node:child_process";
import {chmodSync,mkdirSync,realpathSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {createRequire} from "node:module";

if(process.platform!=="linux")throw Error("CLOUD_NATIVE_LINUX_REQUIRED");
const headers=resolve(dirname(realpathSync(process.execPath)),"../include/node");
const resources=resolve("resources");
mkdirSync(resources,{recursive:true,mode:0o755});
const output=join(resources,"engine-exclusion.node");
execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",headers,
 "native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",output],{stdio:"inherit",timeout:120000});
chmodSync(output,0o644);
// A compiler success alone must not admit an unloadable resource into the slot.
const addon=createRequire(import.meta.url)(output);
for(const name of ["version","lock","writers","fullSync","ioMeterAdd","ioMeterTotal","ioMeterBytes","sentinelIoRoot","sentinelIoCreateRoot","sentinelIoOpen","sentinelIoRead","sentinelIoWrite","sentinelIoReplace","sentinelIoLock","sentinelIoClose","sentinelIoAwakeMs"]){
 if(typeof addon[name]!=="function")throw Error("CLOUD_NATIVE_EXPORT_REQUIRED: "+name);
}
