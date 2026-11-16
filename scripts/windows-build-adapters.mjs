// Resource/backup/NSIS adapters owner: win-sac-sign; authenticated bindings and sealed tools owner: MAIN.
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWindowsBuildProducer } from "./windows-build-producers.mjs";
import { peSha256, readWindowsPeSnapshot, readWindowsPeSourceReceipt, signPinnedWindowsPe, verifyFrozenWindowsPe } from "./windows-pe-signing.mjs";
import { windowsPeFiles } from "./windows-sac-inventory.mjs";
import { windowsPackageTree } from "./windows-package-tree.mjs";

const fail = () => { throw Error("WINDOWS_BUILD_ADAPTER_REJECTED"); };
const resourceWorker = fileURLToPath(new URL("./windows-resource-edit.mjs", import.meta.url));
const helperWorker = fileURLToPath(new URL("./windows-nsis-helper.mjs", import.meta.url));
const late = new Set(["murage-app", "backup-transport", "nsis-helper", "uninstaller", "installer"]);

export async function windowsBuildAdapters(launch, plan, producers, receipts, graph, trust, sign, execution = {}) {
  const pin = launch.runAuthorization.files.find(row => row.path === "producer-bindings.json");
  if (!pin) fail();
  const bytes = (await readWindowsPeSnapshot(path.join(launch.runRoot, pin.path))).bytes;
  if (peSha256(bytes) !== pin.sha256) fail();
  const data = JSON.parse(bytes), outputs = plan.outputs.filter(row => late.has(row.component));
  if (data.schema !== 1 || !Array.isArray(data.bindings) || data.bindings.length !== outputs.length
    || new Set(data.bindings.map(row => row.path)).size !== outputs.length
    || data.bindings.some(row => !outputs.some(output => output.path === row.path)
      || !path.isAbsolute(row.output ?? "") || !path.isAbsolute(row.cwd ?? "") || !row.env
      || !Array.isArray(row.inputs) || !Array.isArray(row.tools))
    || [resourceWorker, helperWorker].some(file => !launch.files.some(row => row.path === file))) fail();
  const binding = name => { const row=data.bindings.find(row=>row.path===name);if(!row)fail();return row; };
  const outputFor = component => { const rows=outputs.filter(row=>row.component===component);if(rows.length!==1)fail();return rows[0]; };
  const retained = new Map(),transientImages=new Map(), directory = path.join(launch.driverSettings.environment.MURAGE_WINDOWS_BUILD_RECEIPTS, "retained");
  await mkdir(directory);
  const resourceTree=launch.signingAuthority?.trees?.find(row=>row.component==="nsis-resources");
  if(launch.signingAuthority?.enrolled===true && !data.nsisResources)fail();
  if(data.nsisResources && (!resourceTree||data.nsisResources.root!==resourceTree.root))fail();
  const pluginRoot=path.join(directory,"transient/nsis");let pluginSnapshot;
  let builderLibrary;
  const verifyResources=async()=>{
    if(data.nsisResources && (!pluginSnapshot||JSON.stringify(await windowsPackageTree(pluginRoot))!==JSON.stringify(pluginSnapshot)))fail();
    for(const selected of transientImages.values())await verifyFrozenWindowsPe(selected.file,selected.pin,selected.record,trust);
  };
  const command = async (name, observed, run) => {
    const row=binding(name);
    if (observed.output!==row.output || observed.cwd!==row.cwd) fail();
    const invocation = { ...observed, inputs:row.inputs, tools:row.tools, env:row.env };
    await runWindowsBuildProducer(producers,name,invocation,run ? {run} : execution);
    return row.output;
  };
  const signArtifact = async (scope, output, file) => {
    const source=await receipts.consume(output.path,output.stage);
    const record=await signPinnedWindowsPe(file,source,trust,sign,{...plan,path:output.path});
    const retainedFile=path.join(directory,output.path);await mkdir(path.dirname(retainedFile),{recursive:true});
    await copyFile(file,retainedFile,constants.COPYFILE_EXCL);
    await verifyFrozenWindowsPe(retainedFile,source,record,trust);
    retained.set(scope,{file:retainedFile,pin:source,record,original:file});
    if(scope==="transient")transientImages.set(output.path,retained.get(scope));
    await graph.freeze(scope,async()=>{await verifyResources();await verifyFrozenWindowsPe(retainedFile,source,record,trust);
      return scope==="transient"?Object.fromEntries([...transientImages.values()].map(row=>[row.record.path,row.record.finalSha256])):{[output.path]:record.finalSha256};});
  };
  return Object.freeze({
    retained,
    transientImages,
    async prepareAppResources(context,state){
      for(const target of context.targets??[]){
        if(target.name!=="nsis"||!target.packager.info.framework.isCopyElevateHelper||target.options.packElevateHelper===false&&target.options.perMachine!==true)continue;
        const helper=target.packageHelper.elevateHelper;
        if(helper.copied.has(context.appOutDir))fail();
        const file=await builderLibrary("./out/toolsets/windows.js").getNsisElevatePath(target.packager.config.toolsets?.nsis,target.options.customNsisBinary);
        const source=state.sources.find(row=>row.path==="resources/elevate.exe");
        if(!source||source.kind!=="upstream"||!launch.files.some(row=>row.path===file&&row.sha256===source.sourceSha256)
          ||peSha256((await readWindowsPeSnapshot(file)).bytes)!==source.sourceSha256)fail();
        await copyFile(file,path.join(context.appOutDir,"resources/elevate.exe"),constants.COPYFILE_EXCL);
        // afterPack's common policy signs this copy before the app freeze.
        helper.copied.set(context.appOutDir,Promise.resolve());
      }
    },
    async prepareTransientResources(){
      if(!data.nsisResources)return;
      if(pluginSnapshot)fail();
      const raw=await windowsPackageTree(resourceTree.root);
      if(JSON.stringify([...raw].sort((a,b)=>a.path.localeCompare(b.path)))!==JSON.stringify(resourceTree.files.map(row=>({path:row.relativePath,sha256:row.sha256})).sort((a,b)=>a.path.localeCompare(b.path))))fail();
      const environment=launch.driverSettings.environment;
      const sources=(await readWindowsPeSourceReceipt(environment.MURAGE_WINDOWS_PE_SOURCE_RECEIPT,environment.MURAGE_WINDOWS_PE_SOURCE_RECEIPT_SHA256,plan))
        .filter(row=>row.path.startsWith("transient/nsis/"));
      await mkdir(pluginRoot,{recursive:true});
      for(const row of raw){const destination=path.join(pluginRoot,row.path);await mkdir(path.dirname(destination),{recursive:true});await copyFile(path.join(resourceTree.root,row.path),destination,constants.COPYFILE_EXCL);}
      const images=await windowsPeFiles(pluginRoot);
      if(images.length!==sources.length)fail();
      for(const file of images){const name=`transient/nsis/${path.relative(pluginRoot,file).split(path.sep).join("/")}`,source=sources.find(row=>row.path===name);
        if(!source||source.kind!=="upstream"||peSha256((await readWindowsPeSnapshot(file)).bytes)!==source.sourceSha256)fail();}
      for(const file of images){const name=`transient/nsis/${path.relative(pluginRoot,file).split(path.sep).join("/")}`,pin=sources.find(row=>row.path===name);
        const record=await signPinnedWindowsPe(file,pin,trust,sign,{...plan,path:name});transientImages.set(name,{file,pin,record});}
      pluginSnapshot=await windowsPackageTree(pluginRoot);
    },
    async resource(options) {
      const output=outputFor("murage-app");
      return command(output.path,{output:options.file,cwd:binding(output.path).cwd,command:launch.node,
        args:[resourceWorker,JSON.stringify(options)]});
    },
    async backup({ageDigest}) {
      if(!/^[a-f0-9]{64}$/.test(ageDigest??""))fail();
      const output=outputFor("backup-transport"),row=binding(output.path),source=row.inputs.find(row=>row.component==="source");
      const age=row.inputs.find(row=>row.component==="age");
      if(!source || !age || peSha256((await readWindowsPeSnapshot(age.file)).bytes)!==ageDigest)fail();
      return command(output.path,{output:row.output,cwd:row.cwd,command:row.tools[0]?.file,args:["/nologo","/std:c++20","/EHsc","/W4","/D_WIN32_WINNT=0x0602",
        `/DMURAGE_AGE_DIGEST="${ageDigest}"`,source.file,`/Fo${row.output}.obj`,`/Fe${row.output}`,"/link","Advapi32.lib","Bcrypt.lib"]});
    },
    backupReceipt() { const output=outputFor("backup-transport");return receipts.consume(output.path,output.stage); },
    install(library) {
      builderLibrary=library;
      const context=new AsyncLocalStorage(),resEdit=library("./out/util/resEdit.js"),{NsisTarget}=library("./out/targets/nsis/NsisTarget.js");
      const {WineVmManager}=library("./out/vm/WineVm.js"),util=library("builder-util"),windows=library("./out/toolsets/windows.js");
      const original={resource:resEdit.editWindowsResources,makensis:NsisTarget.prototype.executeMakensis,
        uninstaller:NsisTarget.prototype.computeScriptAndSignUninstaller,exec:WineVmManager.prototype.exec,spawn:util.spawnAndWriteWithOutput,plugins:windows.getNsisPluginsPath};
      const adapters=this;
      if(data.nsisResources)windows.getNsisPluginsPath=async()=>{await verifyResources();return pluginRoot;};
      resEdit.editWindowsResources=options=>adapters.resource(options);
      NsisTarget.prototype.computeScriptAndSignUninstaller=function(...args){
        return context.run({...context.getStore(),helper:args[2]},()=>original.uninstaller.apply(this,args));
      };
      NsisTarget.prototype.executeMakensis=async function(defines,commands,...args){
        const transient=Object.hasOwn(defines,"BUILD_UNINSTALLER"),output=outputFor(transient?"nsis-helper":"installer");
        const file=commands.OutFile.replace(/^"|"$/g,"");
        if(transient && defines.UNINSTALLER_OUT_FILE!==binding(outputFor("uninstaller").path).output)fail();
        const compile=async()=>{await verifyResources();return context.run({...context.getStore(),compiler:{name:output.path,output:file}},()=>original.makensis.call(this,defines,commands,...args));};
        if(transient){await compile();await signArtifact("transient",output,file);}
        else await graph.package("installer",async()=>{
          const helper=retained.get("transient");if(!helper || helper.original!==file)fail();
          await verifyFrozenWindowsPe(file,helper.pin,helper.record,trust);
          await unlink(file);await compile();
        });
      };
      util.spawnAndWriteWithOutput=async(commandFile,args,stdin,options)=>{
        const selected=context.getStore()?.compiler;if(!selected)fail();
        let result;
        await command(selected.name,{...selected,command:commandFile,args,stdin,cwd:options.cwd},async(file,argv,execution)=>{
          result=await original.spawn(file,argv,stdin,{...options,env:execution.env});
        });
        return result;
      };
      WineVmManager.prototype.exec=async function(file,args){
        const selected=context.getStore(),helper=retained.get("transient"),output=outputFor("uninstaller"),row=binding(output.path);
        if(file!==selected?.helper || args.length || file!==helper?.original)fail();
        await verifyFrozenWindowsPe(file,helper.pin,helper.record,trust);
        await command(output.path,{output:row.output,cwd:row.cwd,command:launch.node,args:[helperWorker,JSON.stringify({...helper,launchContract:execution.launchContract})]});
      };
      return ()=>{
        resEdit.editWindowsResources=original.resource;NsisTarget.prototype.executeMakensis=original.makensis;
        NsisTarget.prototype.computeScriptAndSignUninstaller=original.uninstaller;WineVmManager.prototype.exec=original.exec;util.spawnAndWriteWithOutput=original.spawn;windows.getNsisPluginsPath=original.plugins;
      };
    },
    async retainUninstaller(name,file,source,record) {
      const output=outputFor("uninstaller");if(name!==output.path)fail();
      const retainedFile=path.join(directory,name);await mkdir(path.dirname(retainedFile),{recursive:true});await copyFile(file,retainedFile,constants.COPYFILE_EXCL);
      await verifyFrozenWindowsPe(retainedFile,source,record,trust);retained.set("uninstaller",{file:retainedFile,pin:source,record,original:file});
      await graph.freeze("uninstaller",async()=>({[name]:record.finalSha256}));
    },
  });
}
