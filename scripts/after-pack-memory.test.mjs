import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validatePackagedMemoryRuntime } from "./after-pack.mjs";

const roots=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function header(platform,arch){
  const bytes=Buffer.alloc(128);
  if(platform==="darwin"){bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(arch==="arm64"?0x0100000c:0x01000007,4);}
  else if(platform==="linux"){Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(bytes);bytes.writeUInt16LE(0x3e,18);}
  else{bytes.write("MZ",0);bytes.writeUInt32LE(0x40,0x3c);bytes.write("PE\0\0",0x40);bytes.writeUInt16LE(0x8664,0x44);}
  return bytes;
}
function fixture(platform,arch){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"murage-memory-artifact-"));roots.push(root);
  const server=path.join(root,"server"),runtimePath="node_modules/@huggingface/transformers/node_modules/onnxruntime-node",runtime=path.join(server,runtimePath),native=path.join(runtime,"bin/napi-v6",platform,arch);
  fs.mkdirSync(native,{recursive:true});fs.mkdirSync(path.join(server,"memory"),{recursive:true});
  fs.writeFileSync(path.join(server,"memory/worker.js"),"// fixture module presence only\n");
  fs.writeFileSync(path.join(server,"memory-model-manifest.json"),JSON.stringify({runtimeVersion:"4.2.0"}));
  fs.writeFileSync(path.join(runtime,"package.json"),JSON.stringify({name:"onnxruntime-node",version:"1.24.3"}));
  const manifest=path.join(server,"memory-runtime-manifest.json");
  const sharpPath="node_modules/@huggingface/transformers/node_modules/sharp",sharp=path.join(server,sharpPath),target=`${platform}-${arch}`;
  const addonDir=path.join(sharp,"node_modules/@img",`sharp-${target}`,"lib"),addon=path.join(addonDir,`sharp-${target}.node`);
  const libvips=platform==="darwin"?path.join(sharp,"node_modules/@img",`sharp-libvips-${target}`,"lib/libvips-cpp.8.17.3.dylib"):platform==="linux"?path.join(sharp,"node_modules/@img",`sharp-libvips-${target}`,"lib/libvips-cpp.so.8.17.3"):path.join(addonDir,"libvips-42.dll");
  for(const file of [addon,libvips]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,header(platform,arch));}
  fs.writeFileSync(path.join(sharp,"package.json"),JSON.stringify({name:"sharp",version:"0.34.5"}));
  fs.writeFileSync(manifest,JSON.stringify({platform:"darwin",arch:"arm64",packages:[{name:"@huggingface/transformers",version:"4.2.0",path:"node_modules/@huggingface/transformers"},{name:"onnxruntime-node",version:"1.24.3",path:runtimePath},{name:"sharp",version:"0.34.5",path:sharpPath}]}));
  const names=["onnxruntime_binding.node",...(platform==="darwin"?["libonnxruntime.1.24.3.dylib"]:platform==="linux"?["libonnxruntime.so.1"]:["onnxruntime.dll","DirectML.dll","dxcompiler.dll","dxil.dll"])];
  for(const name of names)fs.writeFileSync(path.join(native,name),header(platform,arch));
  return {root,manifest,native,names,addon,libvips};
}

it("records the actual target and validated native files while retaining the distinct staging host",async()=>{
  for(const [platform,arch,value] of [["darwin","arm64",3],["darwin","x64",1],["linux","x64",1],["win32","x64",1]]){
    const f=fixture(platform,arch),result=await validatePackagedMemoryRuntime(f.root,platform,value);
    expect(result).toMatchObject({platform,arch,stagingHost:{platform:"darwin",arch:"arm64"},nativeBackendAvailable:true});
    expect(result.nativeBackend.files).toHaveLength(f.names.length);
    expect(result.thumbnailBackend).toEqual({package:"sharp",version:"0.34.5",files:[f.addon,f.libvips].map(file=>path.relative(path.join(f.root,"server"),file).split(path.sep).join("/"))});expect(result.nativeBackend.missingFiles).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f.manifest,"utf8"))).toEqual(result);
    expect((await validatePackagedMemoryRuntime(f.root,platform,value)).stagingHost).toEqual({platform:"darwin",arch:"arm64"});
  }
});

it("fails required native targets when their binding or runtime library is missing",async()=>{
  for(const [platform,arch] of [["darwin","arm64"],["linux","x64"],["win32","x64"]]){
    const f=fixture(platform,arch);fs.unlinkSync(path.join(f.native,f.names[1]));
    await expect(validatePackagedMemoryRuntime(f.root,platform,arch)).rejects.toThrow("native runtime is missing");
    expect(JSON.parse(fs.readFileSync(f.manifest,"utf8"))).not.toHaveProperty("nativeBackendAvailable");
  }
});

it("records unavailable Intel native payload without relabeling an ARM binary as Intel",async()=>{
  const f=fixture("darwin","x64");for(const name of f.names)fs.unlinkSync(path.join(f.native,name));
  const unavailable=await validatePackagedMemoryRuntime(f.root,"darwin",1);
  expect(unavailable).toMatchObject({platform:"darwin",arch:"x64",nativeBackendAvailable:false,stagingHost:{platform:"darwin",arch:"arm64"}});
  expect(unavailable.nativeBackend.files).toEqual([]);expect(unavailable.nativeBackend.missingFiles).toHaveLength(2);
  fs.writeFileSync(path.join(f.native,"onnxruntime_binding.node"),header("darwin","arm64"));
  await expect(validatePackagedMemoryRuntime(f.root,"darwin",1)).rejects.toThrow("architecture mismatch");
});

it("requires worker and manifests in real packages but preserves legacy memory-free fixture behavior",async()=>{
  const f=fixture("darwin","arm64");fs.unlinkSync(path.join(f.root,"server/memory/worker.js"));
  await expect(validatePackagedMemoryRuntime(f.root,"darwin",3)).rejects.toThrow();
  fs.unlinkSync(f.manifest);
  expect(await validatePackagedMemoryRuntime(f.root,"darwin",undefined,false)).toBeUndefined();
  await expect(validatePackagedMemoryRuntime(f.root,"darwin",3,true)).rejects.toThrow();
});

it("refuses a package whose thumbnail runtime (sharp and its native addon and libvips) did not ship for the target",async()=>{
  for(const [platform,arch] of [["darwin","arm64"],["darwin","x64"],["linux","x64"],["win32","x64"]]){
    const missingAddon=fixture(platform,arch);fs.unlinkSync(missingAddon.addon);
    await expect(validatePackagedMemoryRuntime(missingAddon.root,platform,arch)).rejects.toThrow("thumbnail runtime is missing");
    const missingLibvips=fixture(platform,arch);fs.unlinkSync(missingLibvips.libvips);
    await expect(validatePackagedMemoryRuntime(missingLibvips.root,platform,arch)).rejects.toThrow("missing libvips");
  }
  const unlisted=fixture("linux","x64"),manifest=JSON.parse(fs.readFileSync(unlisted.manifest,"utf8"));
  manifest.packages=manifest.packages.filter(entry=>entry.name!=="sharp");fs.writeFileSync(unlisted.manifest,JSON.stringify(manifest));
  await expect(validatePackagedMemoryRuntime(unlisted.root,"linux","x64")).rejects.toThrow("sharp");
  const wrongArch=fixture("darwin","x64");fs.writeFileSync(wrongArch.addon,header("darwin","arm64"));
  await expect(validatePackagedMemoryRuntime(wrongArch.root,"darwin","x64")).rejects.toThrow("thumbnail architecture mismatch");
  expect(JSON.parse(fs.readFileSync(wrongArch.manifest,"utf8"))).not.toHaveProperty("thumbnailBackend");
});
