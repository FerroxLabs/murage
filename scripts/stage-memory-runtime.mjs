// Package the exact installed dependency graph, including native files/licenses.
// No network, install scripts, global environment or user profile mutations.
import { copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname,join,relative,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { createHoistedStager,lookupStaged,packageRoot,STAGE_MARKER_FILE } from "./stage-hoisted.mjs";
import { ORT_WASM_DIRECTORY,ORT_WASM_FILES,ORT_WEB_VERSION } from "../server/memory/embedding-runtime.ts";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
// Shares the hoisted tree under dist-server/node_modules with stage-whatsapp-runtime.mjs (which resets it).
// Dependencies already staged at the same name@version are reused, not copied again.
const destination=join(root,"dist-server","node_modules","@huggingface","transformers");
if(existsSync(destination)){
  if(!existsSync(join(destination,STAGE_MARKER_FILE)))throw Error("refusing unowned runtime staging directory");
  safeWipeSync(destination,{within:root});
}
const stager=createHoistedStager({distRoot:join(root,"dist-server")});
stager.stage("@huggingface/transformers",root);
// Transformers 4.2.0's published Node ESM bundle imports onnxruntime-common
// directly, although its package.json only declares the node/web wrappers.
// pnpm's installed hoist satisfies that import in development; the isolated
// package must provide the SAME installed package beside those wrappers.
// Resolve from Transformers itself, not from a potentially different root copy.
const transformersSource=packageRoot("@huggingface/transformers",root);
const commonSource=packageRoot("onnxruntime-common",transformersSource);
const commonPackage=JSON.parse(readFileSync(join(commonSource,"package.json"),"utf8"));
const nodePackage=JSON.parse(readFileSync(join(packageRoot("onnxruntime-node",transformersSource),"package.json"),"utf8"));
if(commonPackage.version!==nodePackage.dependencies["onnxruntime-common"])throw Error("installed ONNX common/node versions differ; runtime staging refused");
stager.stage("onnxruntime-common",transformersSource,destination);
const records=stager.records();
// ONNX Runtime WebAssembly for machines without the native binding (Intel macOS) or where it fails to load
// (server/memory/embedding-runtime.ts). Only the Node build, its loader and its one binary ship, beside the worker,
// from the onnxruntime-web release that matches the pinned onnxruntime-node. Its "onnxruntime-common" import must
// resolve to the SAME staged copy Transformers.js uses, at the version onnxruntime-web was built against.
const wasmBackend=stageWasmBackend(join(root,"dist-server"),nodePackage.version);
writeFileSync(join(root,"dist-server","memory-runtime-manifest.json"),JSON.stringify({platform:process.platform,arch:process.arch,packages:records,wasmBackend},null,2)+"\n");
console.log(`Staged memory runtime: ${records.length} packages (${process.platform}/${process.arch}); WebAssembly backend onnxruntime-web ${wasmBackend.version}`);

function stageWasmBackend(distRoot,nativeVersion){
  const source=packageRoot("onnxruntime-web",root),pkg=JSON.parse(readFileSync(join(source,"package.json"),"utf8"));
  if(pkg.version!==ORT_WEB_VERSION||pkg.version!==nativeVersion)throw Error(`onnxruntime-web ${pkg.version} does not match the pinned ONNX Runtime ${ORT_WEB_VERSION} (native ${nativeVersion}); runtime staging refused`);
  const target=join(distRoot,"memory",ORT_WASM_DIRECTORY);
  if(existsSync(target))safeWipeSync(target,{within:root});
  mkdirSync(target,{recursive:true});
  const files=[];
  for(const name of [...ORT_WASM_FILES,"README.md"]){
    const from=join(source,name==="README.md"?"":"dist",name),to=join(target,name);
    copyFileSync(from,to);
    const bytes=readFileSync(to);
    files.push({path:relative(distRoot,to).split("\\").join("/"),bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
  }
  const common=lookupStaged("onnxruntime-common",target,join(distRoot,"node_modules"));
  const commonVersion=common&&JSON.parse(readFileSync(join(common,"package.json"),"utf8")).version;
  const transformersCommon=lookupStaged("onnxruntime-common",destination,join(distRoot,"node_modules"));
  if(!common||common!==transformersCommon||commonVersion!==pkg.dependencies["onnxruntime-common"])throw Error(`onnxruntime-web would resolve onnxruntime-common ${commonVersion??"(none)"} at ${common??"(nowhere)"}, not the copy Transformers.js uses at ${pkg.dependencies["onnxruntime-common"]}; runtime staging refused`);
  return {package:"onnxruntime-web",version:pkg.version,license:pkg.license??null,common:{version:commonVersion,path:relative(distRoot,common).split("\\").join("/")},files};
}
