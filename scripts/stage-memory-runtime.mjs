// Package the exact installed dependency graph, including native files/licenses.
// No network, install scripts, global environment or user profile mutations.
import { cpSync,existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname,join,relative,resolve,sep } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const records=[];
function packageRoot(name,from){
  const require=createRequire(join(from,"package.json"));
  for(const base of require.resolve.paths(name)??[]){
    const candidate=join(base,name,"package.json");
    if(existsSync(candidate)&&JSON.parse(readFileSync(candidate,"utf8")).name===name)return dirname(realpathSync(candidate));
  }
  let file;
  try {file=require.resolve(`${name}/package.json`);}catch{file=require.resolve(name);}
  let dir=dirname(realpathSync(file));
  for(;;){const path=join(dir,"package.json");if(existsSync(path)&&JSON.parse(readFileSync(path,"utf8")).name===name)return dir;const parent=dirname(dir);if(parent===dir)throw Error(`package root unavailable: ${name}`);dir=parent;}
}
function stage(name,from,destination,ancestors=new Set()){
  const source=packageRoot(name,from),pkg=JSON.parse(readFileSync(join(source,"package.json"),"utf8"));
  const identity=`${name}@${pkg.version}`;
  if(ancestors.has(identity))return;
  cpSync(source,destination,{recursive:true,dereference:true,filter:path=>!relative(source,path).split(sep).includes("node_modules")});
  records.push({name,version:pkg.version,license:pkg.license??null,path:relative(join(root,"dist-server"),destination)});
  const seen=new Set(ancestors);seen.add(identity);
  for(const dependency of Object.keys({...pkg.dependencies,...pkg.optionalDependencies})){
    try{packageRoot(dependency,source);}catch(error){if(pkg.optionalDependencies?.[dependency])continue;throw error;}
    stage(dependency,source,join(destination,"node_modules",dependency),seen);
  }
}
const destination=join(root,"dist-server","node_modules","@huggingface","transformers");
const marker=join(destination,".murage-runtime-stage");
if(existsSync(destination)){
  if(!existsSync(marker)||readFileSync(marker,"utf8")!=="murage-memory-runtime")throw Error("refusing unowned runtime staging directory");
  safeWipeSync(destination,{within:root});
}
mkdirSync(destination,{recursive:true});writeFileSync(marker,"murage-memory-runtime");
stage("@huggingface/transformers",root,destination);
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
stage("onnxruntime-common",transformersSource,join(destination,"node_modules","onnxruntime-common"));
writeFileSync(join(root,"dist-server","memory-runtime-manifest.json"),JSON.stringify({platform:process.platform,arch:process.arch,packages:records},null,2)+"\n");
console.log(`Staged memory runtime: ${records.length} packages (${process.platform}/${process.arch})`);
