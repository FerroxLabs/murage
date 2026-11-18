// Synthetic controller/VM fixture owner: win-sac-sign; real disposable Windows VM collector owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { peSha256 } from "../windows-pe-signing.mjs";
import { appendPeFixtureCertificate, unsignedPeFixture } from "./windows-pe-signing.mjs";
export const windowsExtractionFixtureHelper = () => appendPeFixtureCertificate(unsignedPeFixture());

/** Data-only installer and an ephemeral fixture result key; no Windows or SAC
 * behavior is simulated as a real qualification result. */
export function windowsExtractionFixture(root,observe=()=>{}) {
  const directory=path.join(root,"extraction-bundle");fs.mkdirSync(directory);
  const run=generateKeyPairSync("ed25519"),extraction=generateKeyPairSync("ed25519");
  const key=(id,pair)=>({id,publicKey:pair.publicKey.export({type:"spki",format:"pem"}).toString()});
  const recipe={imageVersionResourceId:"/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.Compute/galleries/fixture/images/extraction/versions/1.2.3",
    installDirectory:"C:\\Fixture\\Murage",freshOsDisk:true,standardUser:true,perUser:true,launchAfterInstall:false,generalGuestNetwork:false};
  fs.writeFileSync(path.join(directory,"recipe.json"),JSON.stringify(recipe));fs.writeFileSync(path.join(directory,"bootstrap.mjs"),"// Neutral bootstrap fixture\n");
  const verifier=fileURLToPath(new URL("../windows-extraction-contract.mjs",import.meta.url));fs.copyFileSync(verifier,path.join(directory,"verifier.mjs"));
  const client=path.join(directory,"client");
  const module=createRequire(import.meta.url).resolve("yazl");
  fs.writeFileSync(client,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{ZipFile}=require(${JSON.stringify(module)});
const arg=name=>process.argv[process.argv.indexOf(name)+1],hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
(async()=>{
 const request=JSON.parse(fs.readFileSync(arg('--request'))),input=fs.readFileSync(arg('--installer')),marker=Buffer.from('\\nFIXTURE_PAYLOAD\\n'),offset=input.indexOf(marker);
 const body=offset===-1?input:input.subarray(offset+marker.length),end=body.indexOf(Buffer.from('\\nEND_FIXTURE_PAYLOAD\\n'));
 const payload=JSON.parse(end===-1?body:body.subarray(0,end));
 const mode=process.env.FIXTURE_EXTRACT_MODE;
 if(mode==='change')payload['Murage.exe']=Buffer.from('changed fixture').toString('base64');
 if(mode==='extra')payload['extra.dll']=payload['Murage.exe'];
 if(mode==='omit-uninstaller')delete payload['Uninstall Murage.exe'];
 const zip=new ZipFile(),chunks=[],done=new Promise((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.on('end',resolve);zip.outputStream.on('error',reject);});
 const files=[];for(const [name,data]of Object.entries(payload)){const bytes=Buffer.from(data,'base64');zip.addBuffer(bytes,'installed/'+name);files.push({path:name,sha256:hash(bytes)});}
 const transient=Buffer.from(${JSON.stringify(windowsExtractionFixtureHelper().toString("base64"))},'base64'),transientFiles=[{path:'artifacts/helper.exe',sha256:hash(transient)}];zip.addBuffer(transient,'transient/artifacts/helper.exe');
 zip.end();await done;const archive=Buffer.concat(chunks);fs.writeFileSync(arg('--archive'),archive,{flag:'wx',mode:0o600});
 const result={...request,archiveSha256:hash(archive),files,transientFiles,vm:{...${JSON.stringify(recipe)},destroyed:true}};
 const bytes=Buffer.from(JSON.stringify(result)),signature=crypto.sign(null,bytes,${JSON.stringify(extraction.privateKey.export({type:"pkcs8",format:"pem"}).toString())});
 fs.writeFileSync(arg('--result'),JSON.stringify({keyId:'extraction',payload:bytes.toString('base64'),payloadSha256:hash(bytes),signature:signature.toString('base64')}),{flag:'wx',mode:0o600});
})().catch(()=>process.exit(1));
`,{mode:0o755});
  const bundle={schema:1,kind:"windows-install-vm",directory:path.basename(directory),client:"client",bootstrap:"bootstrap.mjs",config:"recipe.json",verifier:"verifier.mjs",
    controllerKeys:{runAuthorization:key("run",run),extractionResult:key("extraction",extraction)},
    oidc:{extractionAudience:"fixture:extraction",extractionSubject:"fixture:extraction-job",vmControlAudience:"fixture:control",vmControlSubject:"fixture:controller-job"},
    files:fs.readdirSync(directory).map(name=>({path:name,sha256:peSha256(fs.readFileSync(path.join(directory,name)))}))};
  const bundleFile=path.join(root,"extraction-lock.json");fs.writeFileSync(bundleFile,JSON.stringify(bundle));
  observe({bundle,recipe,runKey:run,extractionKey:extraction,directory});
  return {file:client,sha256:peSha256(fs.readFileSync(client)),bundleFile,bundleSha256:peSha256(fs.readFileSync(bundleFile))};
}
