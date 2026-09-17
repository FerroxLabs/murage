import {execFileSync} from "node:child_process";
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
export function buildNotificationAuthorization({platform=process.platform,exec=execFileSync,headerDirectory=path.resolve(path.dirname(realpathSync(process.execPath)),"../include/node"),outputRoot=path.join(root,"dist-native/notification-authorization")}={}){
 if(platform!=="darwin")throw Error("NOTIFICATION_AUTH_BUILD_REQUIRES_MACOS");
 const headers=["node_api.h","node_api_types.h","js_native_api.h","js_native_api_types.h","node_version.h"];
 const hashes={};for(const name of headers){const file=path.join(headerDirectory,name);if(!existsSync(file))throw Error("NOTIFICATION_AUTH_HEADERS_REQUIRED");hashes[name]=createHash("sha256").update(readFileSync(file)).digest("hex");}
 const version=readFileSync(path.join(headerDirectory,"node_version.h"),"utf8");
 const parts=["MAJOR","MINOR","PATCH"].map(part=>Number(new RegExp("#define NODE_"+part+"_VERSION +([0-9]+)").exec(version)?.[1]));
 if(parts.join(".")!==process.versions.node)throw Error("NOTIFICATION_AUTH_HEADER_VERSION_MISMATCH");
 const source=path.join(root,"native/notification-authorization/authorization.mm"),sourceSha256=createHash("sha256").update(readFileSync(source)).update(readFileSync(path.join(root,"native/notification-authorization/lifetime.h"))).digest("hex");
 const outputs=[];
 for(const [arch,target] of [["arm64","arm64"],["x64","x86_64"]]){
  const directory=path.join(outputRoot,arch);mkdirSync(directory,{recursive:true});const output=path.join(directory,"notification-authorization.node");
  exec("/usr/bin/xcrun",["clang++","-std=c++17","-fobjc-arc","-fblocks","-DNAPI_VERSION=9","-mmacosx-version-min=12.0","-arch",target,"-bundle","-undefined","dynamic_lookup","-I",headerDirectory,"-framework","Foundation","-framework","UserNotifications",source,"-o",output],{timeout:120000,stdio:"inherit"});
  exec("/usr/bin/lipo",["-verify_arch",target,output],{timeout:5000,stdio:"inherit"});
  const receipt={version:1,target:"darwin-"+arch,napiVersion:9,nodeHeadersVersion:parts.join("."),headerSha256:hashes,sourceSha256,sha256:createHash("sha256").update(readFileSync(output)).digest("hex")};
  writeFileSync(path.join(directory,"build.json"),JSON.stringify(receipt,null,2)+"\n");outputs.push(receipt);
 }
 return outputs;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)buildNotificationAuthorization();
