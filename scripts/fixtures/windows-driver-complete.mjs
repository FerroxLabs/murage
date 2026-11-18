// Complete portable driver witness owner: win-sac-sign; real native signing, VM and SAC witnesses owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ZipFile } from "yazl";
import { windowsSigningSession } from "../windows-signing-session.mjs";
import { peSha256, signPinnedWindowsPe, verifyFrozenWindowsPe } from "../windows-pe-signing.mjs";
import { windowsPackageTree } from "../windows-package-tree.mjs";
import { fixturePeSource } from "./windows-pe-provenance.mjs";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./windows-pe-signing.mjs";
import { windowsExtractionFixture, windowsExtractionFixtureHelper } from "./windows-extraction.mjs";

export function completeDriverFixture(root,launch) {
  const pins=new Map(),records=new Map(),files=new Map(),appOutDir=path.join(root,"app"),retained=new Map(),transientImages=new Map();
  const trust={authenticode:async file=>fs.readFileSync(file).readUInt32LE(232)?{status:"Valid",embedded:true,publisher:"Ferrox Labs, LLC",timestamp:true,leafCertificateSha256:"e".repeat(64)}:{status:"NotSigned"}};
  const adapters={retained,transientImages,install:()=>()=>{},async prepareTransientResources(){}};
  const session=()=>windowsSigningSession({});
  const make=async(scope,bytes=unsignedPeFixture())=>{
    const row=globalThis.configWitnessCoverage.find(row=>row.scope===scope),file=path.join(root,row.path);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);files.set(scope,file);
    const pin=fixturePeSource(row.path,bytes);pins.set(scope,pin);
    if(row.producerRequired)await session().graph.producer(scope,row.path,async()=>({inputDigests:{tool:"d".repeat(64)},outputDigests:{[row.path]:peSha256(bytes)}}));
    const record=await signPinnedWindowsPe(file,pin,trust,session().sign);records.set(scope,record);
    if(["uninstaller","transient"].includes(scope))retained.set(scope,{file,pin,record});
    if(scope==="transient")transientImages.set(row.path,retained.get(scope));
    return {file,pin,record};
  };
  const freeze=async scope=>session().graph.freeze(scope,async()=>{
    await verifyFrozenWindowsPe(files.get(scope),pins.get(scope),records.get(scope),trust);
    return {[pins.get(scope).path]:records.get(scope).finalSha256};
  });
  const extractorRoot=path.join(root,"extractor");fs.mkdirSync(extractorRoot);
  const extractor=windowsExtractionFixture(extractorRoot);fs.copyFileSync(extractor.bundleFile,path.join(extractorRoot,"bundle.json"));
  launch.signingAuthority.controllerKeys=JSON.parse(fs.readFileSync(extractor.bundleFile)).controllerKeys;
  launch.signingAuthority.trees.push({component:"extractor",root:extractorRoot,files:[{relativePath:"bundle.json",sha256:extractor.bundleSha256}]});
  return {trust,adapters,
    async gepa(context){
      const row=await make("gepa");
      context.packager.config.extraMetadata.murageGepaManifests["win32-x64"]="d".repeat(64);
      context.packager.config.extraMetadata.murageWindowsPeGepa={sources:[row.pin],records:[row.record]};
      return {directory:path.dirname(row.file),sources:[row.pin],records:[row.record]};
    },
    async build(){
      await make("app");await freeze("app");await make("uninstaller");await freeze("uninstaller");
      await make("transient",windowsExtractionFixtureHelper());await freeze("transient");
      fs.mkdirSync(path.join(appOutDir,"resources"),{recursive:true});
      for(const scope of ["app","gepa"]){const file=path.join(appOutDir,pins.get(scope).path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(files.get(scope),file);}
      const source=path.join(root,"asar-source");fs.mkdirSync(source);fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({name:"fixture",version:"1.0.19"}));
      const builder=createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
      const asar=createRequire(builder.resolve("app-builder-lib/package.json"))("@electron/asar");
      await asar.createPackage(source,path.join(appOutDir,"resources/app.asar"));
      const manifest=Buffer.from("fixture manifest\n");fs.writeFileSync(path.join(appOutDir,"resources/windows-sac-signing.json"),manifest);
      const tree=await windowsPackageTree(appOutDir),payload=Object.fromEntries(tree.map(row=>[row.path,fs.readFileSync(path.join(appOutDir,row.path)).toString("base64")]));
      payload["Uninstall Murage.exe"]=fs.readFileSync(files.get("uninstaller")).toString("base64");
      await session().graph.package("installer",async()=>{
        await make("installer",Buffer.concat([unsignedPeFixture(),Buffer.from("\nFIXTURE_PAYLOAD\n"+JSON.stringify(payload)+"\nEND_FIXTURE_PAYLOAD\n")]));await freeze("installer");
      });
      session().state={frozen:true,appOutDir,tree,target:"win32-x64",sourceRevision:launch.runAuthorization.sourceRevision,
        sources:[pins.get("app"),pins.get("gepa")],records:[records.get("app"),records.get("gepa")],
        artifactSources:[pins.get("uninstaller"),pins.get("installer")],artifactRecords:[records.get("uninstaller"),records.get("installer")],manifestSha256:peSha256(manifest),trust};
      const zipFile=path.join(root,"artifacts/Murage-1.0.19-win.zip"),zip=new ZipFile(),chunks=[],done=new Promise(resolve=>{zip.outputStream.on("data",chunk=>chunks.push(chunk));zip.outputStream.on("end",resolve);});
      for(const row of tree)zip.addBuffer(fs.readFileSync(path.join(appOutDir,row.path)),row.path);zip.end();await done;fs.writeFileSync(zipFile,Buffer.concat(chunks));
      return [files.get("installer"),zipFile];
    },
    sign:async file=>{globalThis.signingConfigWitness.providerRuns++;fs.writeFileSync(file,appendPeFixtureCertificate(fs.readFileSync(file)));return true;},
  };
}
