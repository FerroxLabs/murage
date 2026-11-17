// Locked caller/receipt witness owner: win-sac-sign; real Windows tools/SAC witness owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./fixtures/windows-pe-signing.mjs";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
import { buildProducerFixture } from "./fixtures/windows-build-producer.mjs";
import { fixturePeSource } from "./fixtures/windows-pe-provenance.mjs";
import { peSha256, verifyFrozenWindowsPe } from "./windows-pe-signing.mjs";
import { readWindowsBuildPlan, windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
import { registerWindowsBuildProducers } from "./windows-build-producers.mjs";
import { windowsBuildAdapters } from "./windows-build-adapters.mjs";
import { beginWindowsSigningSession } from "./windows-signing-session.mjs";
import { windowsBuilderSigning, dispatchWindowsBuilderSigning } from "./windows-builder-signing.mjs";
import { verifyWindowsSigningReceipt } from "./windows-signing-receipt.mjs";
const fromBuilder=createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
const library=createRequire(fromBuilder.resolve("app-builder-lib/package.json")),roots=[];
library("./out/index.js");
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
const encode=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
async function fixture(change=()=>{},resources=false){
  const f=receiptFixture(roots,(_config,coverage)=>{
    coverage.find(row=>row.scope==="transient").path="transient/Murage-1.0.19-setup.exe";
    coverage.find(row=>row.scope==="transient").producerRequired=true;
    coverage.find(row=>row.scope==="uninstaller").path="artifacts/Murage-1.0.19-setup.__uninstaller.exe";
    if(resources)coverage.push({scope:"transient",path:"transient/nsis/x86-unicode/plugin.dll",producerRequired:false});
  });
  const appOutDir=path.join(f.root,"app"),outDir=path.join(f.root,"out");fs.mkdirSync(appOutDir);fs.mkdirSync(outDir);
  const node=path.join(f.root,"node.exe"),compiler=path.join(f.root,"makensis.exe"),input=path.join(f.root,"source.cpp");
  fs.writeFileSync(node,"fixture node");fs.writeFileSync(compiler,"fixture compiler");fs.writeFileSync(input,"fixture source");
  const resourceWorker=fileURLToPath(new URL("./windows-resource-edit.mjs",import.meta.url));
  const helperWorker=fileURLToPath(new URL("./windows-nsis-helper.mjs",import.meta.url));
  const app=path.join(appOutDir,"Murage.exe"),installer=path.join(outDir,"Murage-1.0.19-setup.exe"),uninstaller=path.join(outDir,"Murage-1.0.19-setup.__uninstaller.exe");
  fs.writeFileSync(app,unsignedPeFixture());
  const bindings=f.coverage.filter(row=>row.producerRequired).map(row=>({path:row.path,
    cwd:["transient","installer"].includes(row.scope)?library("./out/targets/nsis/nsisUtil.js").nsisTemplatesDir:f.root,env:{FIXTURE:"1"},
    output:row.scope==="app"?app:row.scope==="uninstaller"?uninstaller:installer,
    inputs:[{component:"source",file:row.scope==="app"?app:input}],
    tools:[{component:"tool",file:["app","uninstaller"].includes(row.scope)?node:compiler}]}));
  const data={schema:2,...f.configuration.identity,outputs:bindings.map(row=>{
    const scope=f.coverage.find(item=>item.path===row.path).scope;
    return {path:row.path,component:{app:"murage-app",uninstaller:"uninstaller",transient:"nsis-helper",installer:"installer"}[scope],
      stage:scope==="app"?"resource-edited":"nsis-compiled",producer:{app:"electron-resource-edit",uninstaller:"nsis-uninstaller",transient:"nsis-helper",installer:"nsis-installer"}[scope],
      inputs:row.inputs.map(row=>({component:row.component,sha256:peSha256(fs.readFileSync(row.file))})),
      tools:row.tools.map(row=>({component:row.component,sha256:peSha256(fs.readFileSync(row.file))})),
      transformations:[scope==="app"?"resource-edit":"compile"],publishers:["Ferrox Labs, LLC"]};
  })};
  const planFile=path.join(f.root,"plan.json");fs.writeFileSync(planFile,JSON.stringify(data));
  const plan=await readWindowsBuildPlan(planFile,peSha256(fs.readFileSync(planFile)),f.configuration.identity);
  change(bindings);
  const bindingFile=path.join(f.root,"producer-bindings.json"),bindingData={schema:1,bindings};
  const resourceRoot=path.join(f.root,"nsis-resources");
  if(resources){fs.mkdirSync(path.join(resourceRoot,"x86-unicode"),{recursive:true});fs.writeFileSync(path.join(resourceRoot,"x86-unicode/plugin.dll"),unsignedPeFixture());bindingData.nsisResources={root:resourceRoot};}
  fs.writeFileSync(bindingFile,JSON.stringify(bindingData));
  const launch={node,runRoot:f.root,runAuthorization:{files:[{path:"producer-bindings.json",sha256:peSha256(fs.readFileSync(bindingFile))}]},
    files:[node,compiler,resourceWorker,helperWorker].map(file=>({path:file,sha256:peSha256(fs.readFileSync(file))})),
    driverSettings:{environment:{MURAGE_WINDOWS_BUILD_RECEIPTS:path.join(f.root,"receipts")}}};
  if(resources){
    const pin=fixturePeSource("transient/nsis/x86-unicode/plugin.dll",unsignedPeFixture(),{component:"nsis-plugin"});
    const sourceFile=path.join(f.root,"sources.json");fs.writeFileSync(sourceFile,JSON.stringify({schema:2,...f.configuration.identity,sources:[pin]}));
    Object.assign(launch.driverSettings.environment,{MURAGE_WINDOWS_PE_SOURCE_RECEIPT:sourceFile,MURAGE_WINDOWS_PE_SOURCE_RECEIPT_SHA256:peSha256(fs.readFileSync(sourceFile))});
    launch.signingAuthority={enrolled:true,trees:[{component:"nsis-resources",root:resourceRoot,files:[{relativePath:"x86-unicode/plugin.dll",sha256:peSha256(unsignedPeFixture())}]}]};
  }
  const producers=await registerWindowsBuildProducers(plan,{directory:launch.driverSettings.environment.MURAGE_WINDOWS_BUILD_RECEIPTS,toolFiles:launch.files,session:f.writer});
  const receipts=windowsStageReceiptConsumer(plan,producers,f.writer);
  const provider=vi.fn(async file=>{fs.writeFileSync(file,appendPeFixtureCertificate(fs.readFileSync(file)));return true;});
  const run=vi.fn(async(command,args,options)=>{
    expect(command).toBe(node);expect(options.env).toEqual({FIXTURE:"1"});expect(options.shell).toBe(false);
    const optionsData=JSON.parse(args[1]);
    if(args[0]===resourceWorker){const bytes=unsignedPeFixture();bytes[512]^=1;fs.writeFileSync(optionsData.file,bytes);}
    else {expect(args[0]).toBe(helperWorker);await verifyFrozenWindowsPe(optionsData.file,optionsData.pin,optionsData.record,f.trust);fs.writeFileSync(uninstaller,unsignedPeFixture());}
  });
  const adapters=await windowsBuildAdapters(launch,plan,producers,receipts,f.writer,f.trust,provider,{run});
  return {...f,launch,plan,producers,receipts,adapters,provider,run,appOutDir,outDir,app,installer,uninstaller,compiler,node,bindings};
}
it.each([false,true])("the locked resource editor and NSIS callers produce, sign, retain and freeze before embed, then emit a complete graph (plugins=%s)",async resources=>{
  const f=await fixture(()=>{},resources);await f.prepare("gepa");
  const session={graph:f.writer,receipts:f.receipts,adapters:f.adapters,sign:f.provider,trust:f.trust};
  const end=beginWindowsSigningSession(session),util=library("builder-util"),windows=library("./out/toolsets/windows.js");
  const {WinPackager}=library("./out/winPackager.js"),{NsisTarget}=library("./out/targets/nsis/NsisTarget.js");
  const originalPlatform=Object.getOwnPropertyDescriptor(process,"platform");let restore;
  try{
    Object.defineProperty(process,"platform",{value:"win32",configurable:true});
    vi.spyOn(windows,"getMakeNsisPath").mockResolvedValue({path:f.compiler,env:{}});
    const compile=vi.spyOn(util,"spawnAndWriteWithOutput").mockImplementation(async(command,args,stdin,options)=>{
      expect(command).toBe(f.compiler);expect(options.env).toEqual({FIXTURE:"1"});expect(stdin).toContain("fixture NSIS");
      fs.writeFileSync(f.installer,unsignedPeFixture());return {stdout:"",stderr:""};
    });
    restore=f.adapters.install(library);
    await f.writer.package("app",async()=>{
      await f.adapters.prepareTransientResources();
      if(resources)expect(await windows.getNsisPluginsPath()).toContain("retained/transient/nsis");
      const packager={config:{extraMetadata:{},electronDist:f.root},projectDir:f.root,appInfo:{productName:"Murage",copyright:"Fixture",
        shortVersion:"1.0.19",buildVersion:"1.0.19",shortVersionWindows:"1.0.19"},platformSpecificBuildOptions:{requestedExecutionLevel:"asInvoker"},
        getIconPath:async()=>null,getResource:async()=>null,debugLogger:{isEnabled:false}};
      packager.signIf=file=>dispatchWindowsBuilderSigning(packager,file);
      const state=await windowsBuilderSigning({packager,appOutDir:f.appOutDir,arch:"x64",windowsPeSources:[],windowsPeSourceRevision:f.plan.sourceRevision});
      await WinPackager.prototype.signAndEditResources.call(packager,f.app,"x64",f.appOutDir,"Murage","asInvoker");
      expect(state.records).toHaveLength(1);expect(f.run).toHaveBeenCalledOnce();
      await f.writer.freeze("app",async()=>({"Murage.exe":state.records[0].finalSha256}));
      const target=Object.create(NsisTarget.prototype);
      Object.assign(target,{packager,outDir:f.outDir,options:{},computeFinalScript:async()=>"; fixture NSIS"});
      const defines={},commands={OutFile:`"${f.installer}"`};
      await target.computeScriptAndSignUninstaller(defines,commands,f.installer,"",new Map());
      expect(f.adapters.retained.has("transient")).toBe(true);expect(f.adapters.retained.has("uninstaller")).toBe(true);
      fs.unlinkSync(f.uninstaller);
      await target.executeMakensis(defines,commands,"; fixture NSIS",{skipSizeVerification:true});
      await packager.signIf(f.installer);
      expect(compile).toHaveBeenCalledTimes(2);f.receipts.assertComplete();
    });
    await f.writer.packageComplete(async()=>{});
    const uninstaller=f.adapters.retained.get("uninstaller"),installer=session.state.artifactRecords.find(row=>row.component==="installer");
    const result={gepaProjectionSha256:"f".repeat(64),appManifestSha256:"a".repeat(64),installerName:path.basename(f.installer),installerSha256:installer.finalSha256,
      uninstallerRecordSha256:peSha256(encode(uninstaller.record)),zipSha256:"b".repeat(64),extractionResultSha256:"c".repeat(64)};
    const complete=await f.writer.complete(f.receiptFile,result,async()=>{
      for(const selected of f.adapters.retained.values())await verifyFrozenWindowsPe(selected.file,selected.pin,selected.record,f.trust);
    });
    expect(verifyWindowsSigningReceipt(fs.readFileSync(f.receiptFile),f.configuration,f.coverage)).toEqual(complete.receipt);
    expect(f.provider).toHaveBeenCalledTimes(resources?5:4);
  }finally{restore?.();end();Object.defineProperty(process,"platform",originalPlatform);}
});
it("authenticates adapter bindings before installing a caller or executing a command",async()=>{
  const f=await fixture();fs.appendFileSync(path.join(f.root,"producer-bindings.json")," ");
  await expect(windowsBuildAdapters(f.launch,f.plan,f.producers,f.receipts,f.writer,f.trust,f.provider,{run:f.run})).rejects.toThrow("WINDOWS_BUILD_ADAPTER_REJECTED");
  expect(f.run).not.toHaveBeenCalled();expect(f.provider).not.toHaveBeenCalled();
});
it.each(["wrong output","changed input","changed tool","Azure environment","preload environment"])("refuses a resource edit with %s before native work",async mode=>{
  const f=await fixture(bindings=>{
    if(mode==="Azure environment")bindings.find(row=>row.path==="Murage.exe").env.AZURE_CLIENT_SECRET="fixture";
    if(mode==="preload environment")bindings.find(row=>row.path==="Murage.exe").env.NODE_OPTIONS="fixture";
  });
  if(mode==="changed input")fs.appendFileSync(f.app,"changed");
  if(mode==="changed tool")fs.appendFileSync(f.node,"changed");
  await f.prepare("gepa");
  await f.writer.package("app",async()=>{
    await expect(f.adapters.resource({file:mode==="wrong output"?path.join(f.root,"other.exe"):f.app,requestedExecutionLevel:"asInvoker"})).rejects.toThrow();
  });
  expect(f.run).not.toHaveBeenCalled();expect(f.provider).not.toHaveBeenCalled();
});
it("compiles the backup helper against the exact frozen age digest and consumes its compiler receipt",async()=>{
  const f=await buildProducerFixture(roots),age=path.join(f.root,"age.exe"),outputFile=path.join(f.root,"backup.exe");
  fs.writeFileSync(age,unsignedPeFixture());const ageDigest=peSha256(fs.readFileSync(age));
  const output={...f.output,path:"resources/backup-tools/x64/murage-backup-age.exe",component:"backup-transport",producer:"backup-transport-final",
    inputs:[...f.output.inputs,{component:"age",sha256:ageDigest}]};
  const file=path.join(f.root,"backup-plan.json");fs.writeFileSync(file,JSON.stringify({...f.plan,outputs:[output]}));
  const plan=await readWindowsBuildPlan(file,peSha256(fs.readFileSync(file)),f.plan);
  const bindings=[{path:output.path,output:outputFile,cwd:f.root,env:{FIXTURE:"1"},tools:f.invocation.tools,
    inputs:[...f.invocation.inputs,{component:"age",file:age}]}];
  const bindingFile=path.join(f.root,"producer-bindings.json");fs.writeFileSync(bindingFile,JSON.stringify({schema:1,bindings}));
  const launch={runRoot:f.root,runAuthorization:{files:[{path:"producer-bindings.json",sha256:peSha256(fs.readFileSync(bindingFile))}]},
    files:[...f.options.toolFiles,...["windows-resource-edit.mjs","windows-nsis-helper.mjs"].map(name=>({path:fileURLToPath(new URL(name,import.meta.url))}))],
    driverSettings:{environment:{MURAGE_WINDOWS_BUILD_RECEIPTS:f.options.directory}}};
  const producers=await registerWindowsBuildProducers(plan,f.options),consumer=windowsStageReceiptConsumer(plan,producers);
  f.run.mockImplementation(async()=>fs.writeFileSync(outputFile,unsignedPeFixture()));
  const adapters=await windowsBuildAdapters(launch,plan,producers,consumer,{},null,null,f);
  await expect(adapters.backup({ageDigest:"f".repeat(64)})).rejects.toThrow("WINDOWS_BUILD_ADAPTER_REJECTED");expect(f.run).not.toHaveBeenCalled();
  expect(await adapters.backup({ageDigest})).toBe(outputFile);
  expect(f.run.mock.calls[0][1]).toContain(`/DMURAGE_AGE_DIGEST="${ageDigest}"`);
  const pin=await adapters.backupReceipt();expect(pin.inputs).toContainEqual({component:"age",sha256:ageDigest});
  expect(pin.sourceSha256).toBe(peSha256(fs.readFileSync(outputFile)));consumer.assertComplete();
});
it("copies the enrolled elevation helper before app preflight and prevents the builder's later copy/sign mutation",async()=>{
  const f=await fixture(),windows=library("./out/toolsets/windows.js"),{CopyElevateHelper}=library("./out/targets/nsis/nsisUtil.js");
  const sourceFile=path.join(f.root,"elevate.exe");fs.writeFileSync(sourceFile,unsignedPeFixture());fs.mkdirSync(path.join(f.appOutDir,"resources"));
  f.launch.files.push({path:sourceFile,sha256:peSha256(unsignedPeFixture())});
  vi.spyOn(windows,"getNsisElevatePath").mockResolvedValue(sourceFile);
  const signIf=vi.fn(),packager={config:{},info:{framework:{isCopyElevateHelper:true}},platformSpecificBuildOptions:{},signIf};
  const helper=new CopyElevateHelper(),target={name:"nsis",packager,options:{perMachine:false},packageHelper:{elevateHelper:helper}};
  const context={appOutDir:f.appOutDir,targets:[target]},state={sources:[fixturePeSource("resources/elevate.exe",unsignedPeFixture())]};
  const restore=f.adapters.install(library);
  try{
    await f.adapters.prepareAppResources(context,state);expect(fs.readFileSync(path.join(f.appOutDir,"resources/elevate.exe"))).toEqual(unsignedPeFixture());
    await helper.copy(f.appOutDir,target);expect(signIf).not.toHaveBeenCalled();
  }finally{restore();}
});
