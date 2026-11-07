// Print the runtime registry only after the Mac release gate has supplied all evidence.
// Review and package this output as electron/mac-native-contract.json on the release rig.
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
if(process.argv[2]==='--kill-cases'){
 const {qualifyKillCases}=await import('./kill-cases.mjs');
 await qualifyKillCases(process.argv[3]??'.');
 process.exit(0);
}
const bytes=readFileSync(process.argv[2]),evidence=JSON.parse(bytes);
if(process.platform!=="darwin")throw Error("Native qualification requires the Mac release rig");
for(const name of ["electronVersion","appVersion","arch","electronRevision","squirrelRevision","helperRevision"])
 if(typeof evidence[name]!=="string"||!evidence[name])throw Error("Missing pin: "+name);
const claims=["P6a","P6c","P6d","P6e","P6f","completeOutput"];
for(const key of claims)if(!evidence[key]?.source||evidence[key].faultPassed!==true)throw Error("Missing native source and fault evidence: "+key);
for(let gate=1;gate<=7;gate++)if(evidence.gates?.[gate]!=="passed")throw Error("Mac release gate has not passed: "+gate);
console.log(JSON.stringify({version:1,qualified:[{electronVersion:evidence.electronVersion,appVersion:evidence.appVersion,arch:evidence.arch,evidenceSha256:createHash("sha256").update(bytes).digest("hex"),...Object.fromEntries(claims.map(key=>[key,true]))}]},null,2));
