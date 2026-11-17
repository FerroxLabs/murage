// SPDX-License-Identifier: AGPL-3.0-or-later
// P2 owns the independent launcher discovery and descriptor-order assertions.
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import ts from "typescript";

type Launcher={site:string;mode:string;attach:string;descriptorFirst:string};
const roots=["electron","installer","deploy","server","scripts"];
function productFiles(root:string):string[]{
 return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
  const file=join(root,entry.name).replaceAll("\\","/");
  if(entry.isDirectory())return /^(?:testing|test|tests|test-support|fixtures|evidence|node_modules|dist|field-replay|probes)$/.test(entry.name)?[]:productFiles(file);
  return /\.(?:ts|mjs|cjs|service)$/.test(file)&&!/(?:\.test\.|\.node-test\.|\.fixture\.|mutant|bench|verify-|harness|workflow-)/.test(entry.name)?[file]:[];
 });
}
/** Discover entry launches independently of the census, including generated
 * schedule invocations and the installer library's command-line constructor. */
export function sentinelLauncherAudit(rows:readonly Launcher[]){
 const sites=new Map<string,{mode:string;offset:number}>();
 for(const file of roots.flatMap(productFiles)){
  const source=readFileSync(file,"utf8");
  if(file.endsWith(".service")){
   for(const match of source.matchAll(/^ExecStart=.*sentinel\/cli\.js.*$/gm))sites.set(`${file}:ExecStart`,{mode:match[0].includes("--watch")?"--watch":"--once",offset:match.index});
   continue;
  }
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),counts=new Map<string,number>();
  function hit(name:string,node:ts.Node,mode:string){const n=(counts.get(name)??0)+1;counts.set(name,n);sites.set(`${file}:${name}#${n}`,{mode,offset:node.getStart(tree)});}
  function visit(node:ts.Node){
   if(ts.isFunctionDeclaration(node)&&node.name?.text==="sentinelWatchSpec")hit("sentinelWatchSpec-definition",node,"--watch");
   if(ts.isCallExpression(node)){
    const name=node.expression.getText(tree),args=node.arguments.map(arg=>arg.getText(tree)).join(" ");
    if(name==="sentinelInvocation"||name==="sentinelWatchSpec")hit(name,node,args.includes("--watch")||name==="sentinelWatchSpec"?"--watch":"--once");
    // An enrolled probe can touch WAL shared memory or redirected stdout, so
    // it enters the same outer barrier even though it performs no scan.
    else if(file==="electron/sentinel-host.mjs"&&name==="execFile"&&args.includes("scannerEnvironment"))hit(name,node,"--check-install");
    else if(/(?:spawn|spawnSync|spawnProcess|execFile|execFileSync|exec|execSync)$/.test(name)
      &&!args.includes("--check-install")
      &&((file==="server/sentinel/supervisor.ts"&&args.includes("spec.execPath")&&args.includes("spec.args"))||/sentinel[\\/]cli\.(?:js|ts)/.test(args)||(/--(?:once|watch)/.test(args)&&/\b(?:entry|cli)\b/.test(args))))hit(name,node,args.includes("--watch")?"--watch":"--once");
   }
   ts.forEachChild(node,visit);
  }
  visit(tree);
 }
 const unmapped=[...sites.keys()].filter(site=>!rows.some(row=>row.site===site)).sort();
 const stale=rows.filter(row=>!sites.has(row.site)).map(row=>row.site);
 const descriptorErrors:string[]=[];
 for(const row of rows){
  const split=row.descriptorFirst?.indexOf(":")??-1;
  if(split<1){descriptorErrors.push(`${row.site}:no-descriptor-anchor`);continue;}
  const file=row.descriptorFirst.slice(0,split),anchor=row.descriptorFirst.slice(split+1);
  let source="";try{source=readFileSync(file,"utf8");}catch{/* assertion below */}
  const first=source.indexOf(anchor);
  if(first<0)descriptorErrors.push(`${row.site}:missing-descriptor-anchor`);
  if(row.mode!==sites.get(row.site)?.mode)descriptorErrors.push(`${row.site}:mode`);
  if(!["ipc-receipts","none"].includes(row.attach))descriptorErrors.push(`${row.site}:attach`);
  // Prove the descriptor precedes admission along the production call chain,
  // including helpers defined before the caller that writes the descriptor.
  const before=(file:string,earlier:string,later:string)=>{
   const text=readFileSync(file,"utf8"),a=text.indexOf(earlier),b=text.indexOf(later,a+1);
   return a>=0&&b>a;
  };
  let ordered=false;
  if(row.site.startsWith("deploy/"))ordered=file==="deploy/cloud-home/murage-sentinel.service"
   &&before(file,anchor,"ExecStart=");
  if(row.site.startsWith("installer/"))ordered=file==="installer/lib/sentinel.mjs"
   &&anchor==="const written = b.writeDescriptor(next, { platform });"
   &&before(file,anchor,"return { ok: true, descriptorPath")
   &&before("installer/bin/murage.mjs","const prepared = await (deps.prepare ?? prepareSentinel)","if (!prepared.ok)")
   &&before("installer/bin/murage.mjs","if (!prepared.ok)","const spec = sentinelWatchSpec(")
   &&before("installer/bin/murage.mjs","const spec = sentinelWatchSpec(","const child = (deps.spawn ?? spawn)(spec.command");
  if(row.site.startsWith("electron/")){
   ordered=file==="electron/sentinel-schedule.mjs"
    &&anchor==="if (!boundary.writeDescriptor(next, { platform }).ok)"
    &&before(file,anchor,"await probe(descriptorPath, staged.entry)")
    &&before(file,anchor,"await provider.install(next, descriptorPath)");
   if(row.site.startsWith("electron/sentinel-host")&&!row.site.includes(":execFile"))ordered=ordered
    &&before("electron/sentinel-host.mjs","let result = await reconcileSentinelRegistration(deps)","result = await host.fallback(result)")
    &&before("electron/sentinel-host.mjs","if (!loaded.ok) return result;","if (created && watcherPid === null) watcherPid = spawnWatcher(");
   if(row.site.startsWith("electron/sentinel-trampoline"))ordered=ordered
    &&before("electron/sentinel-trampoline.mjs","if (!trampolineDescriptorMatches(parsed,","result = spawn(");
  }
  if(row.site.startsWith("server/sentinel/supervisor.ts:"))ordered=file==="server/sentinel/cli.ts"
   &&before(file,anchor,"const spec = childSpec(args.descriptor, deps);")
   &&before(file,"const spec = childSpec(args.descriptor, deps);","const result=await runChildScan(spec,");
  if(!ordered)descriptorErrors.push(`${row.site}:descriptor-order`);
 }
 const families=[...new Set(rows.map(row=>row.site.startsWith("deploy/")?"cloud":row.site.startsWith("installer/")?"installer":row.site.startsWith("electron/sentinel-host")?"watcher":row.site.startsWith("server/sentinel/supervisor.ts")?"watcher":"scheduler"))].sort();
 return {unmapped,stale,descriptorErrors,families};
}
