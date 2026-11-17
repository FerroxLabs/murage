// Final receipt/ZIP/ASAR witness owner: win-sac-sign; real Windows extractor and SAC proof owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
import { windowsExtractionFixture } from "./fixtures/windows-extraction.mjs";
import { windowsPackageTree, verifyNoPackedWindowsPe } from "./windows-package-tree.mjs";
import { finalizeWindowsBuild } from "./windows-build-finalize.mjs";
import { peSha256 } from "./windows-pe-signing.mjs";
import { verifyWindowsSigningReceipt } from "./windows-signing-receipt.mjs";
const builder=createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
const asar=createRequire(builder.resolve("app-builder-lib/package.json"))("@electron/asar"),roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
async function fixture(){
  const f=receiptFixture(roots);await f.prepare("gepa");
  await f.writer.package("app",async()=>{await f.prepare("app");await f.prepare("uninstaller");await f.prepare("transient");await f.writer.package("installer",async()=>f.prepare("installer"));});
  const appOutDir=path.join(f.root,"app"),asarSource=path.join(f.root,"asar-source"),vmRoot=path.join(f.root,"extractor");
  fs.mkdirSync(appOutDir);fs.mkdirSync(asarSource);fs.mkdirSync(vmRoot);
  fs.writeFileSync(path.join(asarSource,"package.json"),JSON.stringify({name:"fixture",version:"1.0.19"}));
  fs.mkdirSync(path.join(appOutDir,"resources"));await asar.createPackage(asarSource,path.join(appOutDir,"resources/app.asar"));
  for(const scope of ["app","gepa"]){const file=path.join(appOutDir,f.pins.get(scope).path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(f.file(scope),file);}
  const manifest=Buffer.from("fixture manifest\n");fs.writeFileSync(path.join(appOutDir,"resources/windows-sac-signing.json"),manifest);
  const state={frozen:true,appOutDir,tree:await windowsPackageTree(appOutDir),target:f.configuration.identity.target,sourceRevision:f.configuration.identity.sourceRevision,
    sources:[f.pins.get("app"),f.pins.get("gepa")],records:[f.records.get("app"),f.records.get("gepa")],
    artifactSources:[f.pins.get("uninstaller"),f.pins.get("installer")],artifactRecords:[f.records.get("uninstaller"),f.records.get("installer")],
    manifestSha256:peSha256(manifest),trust:f.trust};
  const retained=new Map(["uninstaller","transient"].map(scope=>[scope,{file:f.file(scope),pin:f.pins.get(scope),record:f.records.get(scope)}]));
  const session={state,adapters:{retained,transientImages:new Map([[f.pins.get("transient").path,retained.get("transient")]])},graph:f.writer,
    gepa:{sources:[f.pins.get("gepa")],records:[f.records.get("gepa")]},metadata:{fixture:true}};
  const extractor=windowsExtractionFixture(vmRoot);fs.copyFileSync(extractor.bundleFile,path.join(vmRoot,"bundle.json"));
  const keys=JSON.parse(fs.readFileSync(extractor.bundleFile)).controllerKeys;
  const launch={schema:2,runAuthorization:f.configuration.identity,signingAuthority:{enrolled:true,controllerKeys:keys,
    trees:[{component:"extractor",root:vmRoot,files:[{relativePath:"bundle.json",sha256:extractor.bundleSha256}]}]}};
  const zipFile=path.join(f.root,"artifacts/Murage-1.0.19-win.zip"),zip=new ZipFile(),chunks=[],done=new Promise(resolve=>{zip.outputStream.on("data",chunk=>chunks.push(chunk));zip.outputStream.on("end",resolve);});
  for(const row of state.tree)zip.addBuffer(fs.readFileSync(path.join(appOutDir,row.path)),row.path);zip.end();await done;fs.writeFileSync(zipFile,Buffer.concat(chunks));
  const extract=vi.fn(async options=>{
    fs.cpSync(appOutDir,options.output,{recursive:true,errorOnExist:true,force:false});fs.copyFileSync(f.file("uninstaller"),path.join(options.output,"Uninstall Murage.exe"));
    const temporary=path.join(`${options.output}.transients`,f.pins.get("transient").path);fs.mkdirSync(path.dirname(temporary),{recursive:true});fs.copyFileSync(f.file("transient"),temporary);
    return {sha256:"d".repeat(64),files:await windowsPackageTree(options.output),transientFiles:[{path:f.pins.get("transient").path,sha256:f.records.get("transient").finalSha256}]};
  });
  return {...f,session,launch,zipFile,extract,options:{session,launch,artifacts:[f.file("installer"),zipFile],receiptFile:f.receiptFile}};
}
it("commits the complete driver receipt only after exact ZIP, installed uninstaller, ASAR and unchanged-tree checks",async()=>{
  const f=await fixture(),result=await finalizeWindowsBuild(f.options,{extract:f.extract});
  expect(verifyWindowsSigningReceipt(fs.readFileSync(f.receiptFile),f.configuration,f.coverage)).toEqual(result.receipt);
  expect(result.receipt.result.zipSha256).toBe(peSha256(fs.readFileSync(f.zipFile)));expect(f.extract).toHaveBeenCalledOnce();f.writer.assertComplete();
  expect(fs.readdirSync(f.root).some(name=>name.startsWith("verify-package-"))).toBe(false);
});
it.each(["changed app","changed retained uninstaller","wrong ZIP","changed ZIP during extraction","wrong installed uninstaller","unknown transient","changed transient bytes","failed extraction","missing receipt directory"])("does not commit a receipt with %s",async mode=>{
  const f=await fixture();
  if(mode==="changed app")fs.writeFileSync(path.join(f.session.state.appOutDir,"injected.js"),"fixture");
  if(mode==="changed retained uninstaller")fs.appendFileSync(f.file("uninstaller"),"changed");
  if(mode==="wrong ZIP")fs.writeFileSync(f.zipFile,"invalid zip");
  if(mode==="failed extraction")f.extract.mockRejectedValue(Error("fixture extraction failed"));
  if(mode==="missing receipt directory")f.options.receiptFile=path.join(f.root,"missing/receipt.json");
  const base=f.extract.getMockImplementation();
  if(["changed ZIP during extraction","wrong installed uninstaller","unknown transient","changed transient bytes"].includes(mode))f.extract.mockImplementation(async options=>{
    const result=await base(options);
    if(mode==="changed ZIP during extraction")fs.appendFileSync(f.zipFile,"changed");
    else if(mode==="wrong installed uninstaller"){fs.appendFileSync(path.join(options.output,"Uninstall Murage.exe"),"changed");result.files=await windowsPackageTree(options.output);}
    else if(mode==="unknown transient")result.transientFiles[0].path="unknown.exe";
    else fs.appendFileSync(path.join(`${options.output}.transients`,f.pins.get("transient").path),"changed");
    return result;
  });
  await expect(finalizeWindowsBuild(f.options,{extract:f.extract})).rejects.toThrow();expect(fs.existsSync(f.receiptFile)).toBe(false);
  expect(fs.readdirSync(f.root).some(name=>name.startsWith("verify-package-"))).toBe(false);
});
it.each(["plugin.dll","renamed.data"])("rejects packed ASAR PE %s",async name=>{
  const f=await fixture(),source=path.join(f.root,"bad-asar"),archive=path.join(f.root,"bad.asar");fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,name),Buffer.from("MZ fixture"));await asar.createPackage(source,archive);
  expect(()=>verifyNoPackedWindowsPe(archive)).toThrow("WINDOWS_PACKAGE_TREE_REJECTED");
});
