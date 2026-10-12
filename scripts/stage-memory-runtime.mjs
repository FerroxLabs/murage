// Package the exact installed dependency graph, including native files/licenses.
// No network, install scripts, global environment or user profile mutations.
import { existsSync,readFileSync,writeFileSync } from "node:fs";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { createHoistedStager,packageRoot,STAGE_MARKER_FILE } from "./stage-hoisted.mjs";
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
writeFileSync(join(root,"dist-server","memory-runtime-manifest.json"),JSON.stringify({platform:process.platform,arch:process.arch,packages:records},null,2)+"\n");
console.log(`Staged memory runtime: ${records.length} packages (${process.platform}/${process.arch})`);
