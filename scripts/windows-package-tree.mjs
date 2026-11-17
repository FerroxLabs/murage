// Package freeze/ASAR verifier owner: win-sac-sign; exact-byte Windows qualification consumer: MAIN.
import { lstat, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
const fail=()=>{throw Error("WINDOWS_PACKAGE_TREE_REJECTED");};

export async function windowsPackageTree(root) {
  const files=[];let total=0;
  const walk=async(name="",depth=0)=>{
    if(depth>64)fail();const file=path.join(root,name),stat=await lstat(file);if(stat.isSymbolicLink())fail();
    if(stat.isDirectory()){for(const entry of (await readdir(file)).sort())await walk(name?`${name}/${entry}`:entry,depth+1);}
    else{
      if(!stat.isFile()||stat.nlink!==1||stat.size>2*1024**3||(total+=stat.size)>16*1024**3||files.length>=100_000)fail();
      files.push({path:name,sha256:peSha256((await readWindowsPeSnapshot(file)).bytes)});
    }
  };await walk();return files;
}

export function verifyNoPackedWindowsPe(archive) {
  const builder=createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  const asar=createRequire(builder.resolve("app-builder-lib/package.json"))("@electron/asar");
  asar.uncache(archive);
  for(const entry of asar.listPackage(archive)){
    const name=entry.replace(/^\//,""),info=asar.statFile(archive,name,false);
    if(info.files)continue;if(info.link)fail();if(info.unpacked)continue;
    if(!Number.isSafeInteger(info.size)||info.size>2*1024**3)fail();
    const bytes=asar.extractFile(archive,name);
    if(/\.(?:exe|dll|node|pyd)$/i.test(name)||bytes.subarray(0,2).toString("ascii")==="MZ")fail();
  }
}
