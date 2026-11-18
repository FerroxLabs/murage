// Receipts and builder adapters owner: win-sac-sign; authenticated candidate envelope and Windows deployment owner: MAIN.
import { createHash } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalWindowsPePath, peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";

const fail = () => { throw Error("WINDOWS_SIGNING_RECEIPT_REJECTED"); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash("sha256").update(encode(value)).digest("hex");
export const windowsSigningRecordSha256 = hash;
const encode = value => JSON.stringify(value, (_key, row) => row && typeof row === "object" && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key,row[key]])) : row);
const equal = (a,b) => encode(a) === encode(b);
const exact = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !equal(Object.keys(value).sort(), [...keys].sort())) fail();
};
const scopes = ["gepa","app","uninstaller","installer","transient"];
const sessions = new WeakMap();
const identityKeys = ["repositoryId","workflowSha","sourceRevision","version","target","runId","runAttempt"];
const authorityKeys = ["staticLaunchSha256","runAuthorizationSha256","inputArtifactId","inputArtifactDigest","buildPlanSha256","checkerSha256","providerReceiptSha256","builderTreeSha256"];
function header(value) {
  exact(value,["identity","authority"]); exact(value.identity,identityKeys); exact(value.authority,authorityKeys);
  const id=value.identity;
  if (identityKeys.some(key=>typeof id[key]!=="string") || !["repositoryId","runId","runAttempt"].every(key=>/^[1-9][0-9]*$/.test(id[key] ?? ""))
    || !["workflowSha","sourceRevision"].every(key=>/^[a-f0-9]{40}$/.test(id[key] ?? ""))
    || !/^\d+\.\d+\.\d+$/.test(id.version ?? "") || id.target !== "win32-x64"
    || typeof value.authority.inputArtifactId!=="string" || !/^[1-9][0-9]*$/.test(value.authority.inputArtifactId ?? "")
    || authorityKeys.filter(key=>key!=="inputArtifactId").some(key=>!digest(value.authority[key]))) fail();
  return {schema:1,kind:"windows-signing-driver",...structuredClone(value)};
}
function graph(coverage) {
  if (!Array.isArray(coverage) || !coverage.length) fail();
  const expected = new Map(), signed=new Map(), produced=new Map(), frozen=new Set(), begun=new Set(), frozenInputs=new Set();
  let packaged=false,verified=false;
  for (const row of coverage) {
    exact(row,["scope","path","producerRequired"]);
    canonicalWindowsPePath(row.path);
    if (!scopes.includes(row.scope) || typeof row.producerRequired !== "boolean" || expected.has(row.path.toLowerCase())) fail();
    expected.set(row.path.toLowerCase(),structuredClone(row));
  }
  if (scopes.some(scope=>![...expected.values()].some(row=>row.scope===scope))) fail();
  function gate(event,scope,name) {
    if (verified) fail();
    if (["producer-complete","sign","preserve"].includes(event)) {
      const row=expected.get(name?.toLowerCase());
      if (!row || row.path!==name || row.scope!==scope || frozen.has(scope)
        || (scope!=="gepa" && !begun.has("app")) || (scope==="installer" && !begun.has("installer"))) fail();
      if (event==="producer-complete" ? !row.producerRequired || produced.has(name) : signed.has(name) || row.producerRequired && !produced.has(name)) fail();
    } else if (event==="freeze-input") {
      const row=expected.get(name?.toLowerCase());
      if(!row || row.path!==name || row.scope!==scope || !signed.has(name) || frozen.has(scope) || frozenInputs.has(name))fail();
    } else if (event==="freeze") {
      if (!scopes.includes(scope) || name!==undefined || frozen.has(scope)
        || [...expected.values()].filter(row=>row.scope===scope).some(row=>!signed.has(row.path))) fail();
    } else if (event==="package-begin") {
      if (!["app","installer"].includes(scope) || name!==undefined || begun.has(scope)
        || (scope==="app" ? !frozen.has("gepa") : !frozen.has("app") || !frozen.has("uninstaller") || !frozen.has("transient"))) fail();
    } else if (event==="package-complete") {
      if (scope!=="package" || name!==undefined || packaged || !begun.has("installer") || scopes.some(value=>!frozen.has(value))) fail();
    } else if (event==="verify") {
      if (scope!=="package" || name!==undefined || !packaged) fail();
    } else fail();
  }
  function apply(row) {
    const {event,scope,path:name,inputDigests,outputDigests,recordSha256}=row;
    gate(event,scope,name);
    for (const values of [inputDigests,outputDigests]) {
      if (!values || typeof values!=="object" || Array.isArray(values) || Object.values(values).some(value=>!digest(value))) fail();
    }
    if (["producer-complete","sign","preserve"].includes(event)) {
      if (!equal(Object.keys(outputDigests),[name]) || !Object.keys(inputDigests).length) fail();
      if (event==="producer-complete") { if (recordSha256!==undefined) fail(); produced.set(name,outputDigests[name]); }
      else {
        if (!digest(recordSha256) || !equal(Object.keys(inputDigests),[name])
          || produced.has(name) && inputDigests[name]!==produced.get(name)
          || event==="preserve" && inputDigests[name]!==outputDigests[name]) fail();
        signed.set(name,{sha256:outputDigests[name],recordSha256});
      }
    } else {
      if (recordSha256!==undefined || Object.keys(inputDigests).length) fail();
      if (event==="freeze-input") {
        if(!equal(outputDigests,{[name]:signed.get(name).sha256}))fail();
        frozenInputs.add(name);
      } else if (event==="freeze") {
        const files=Object.fromEntries([...expected.values()].filter(row=>row.scope===scope).map(row=>[row.path,signed.get(row.path).sha256]));
        if (!equal(files,outputDigests)) fail();
        frozen.add(scope);
      } else {
        if (Object.keys(outputDigests).length) fail();
        if (event==="package-begin") begun.add(scope);
        if (event==="package-complete") packaged=true;
        if (event==="verify") verified=true;
      }
    }
  }
  return {gate,apply,signed,produced,expected,complete:()=>verified};
}
function resultMatches(result,state) {
  exact(result,["gepaProjectionSha256","appManifestSha256","installerName","installerSha256","uninstallerRecordSha256","zipSha256","extractionResultSha256"]);
  if (Object.entries(result).some(([key,value])=>key!=="installerName" && !digest(value))
    || typeof result.installerName!=="string" || path.posix.basename(result.installerName)!==result.installerName
    || !result.installerName.endsWith(".exe")
    || ![...state.expected.values()].some(row=>row.scope==="installer" && row.path===`artifacts/${result.installerName}` && state.signed.get(row.path)?.sha256===result.installerSha256)
    || ![...state.expected.values()].some(row=>row.scope==="uninstaller" && state.signed.get(row.path)?.recordSha256===result.uninstallerRecordSha256)) fail();
}

export function windowsSigningReceipt(configuration,coverage) {
  const base=header(configuration),state=graph(coverage),events=[];
  const pending=new Set(); let poisoned=false,finished=false,packagePending=0;
  const alive=()=>{if(poisoned||finished)fail();};
  const reject=()=>{poisoned=true;fail();};
  const guard=(event,scope,name)=>{try{alive();state.gate(event,scope,name);}catch(error){poisoned=true;throw error;}};
  const append=(event,scope,name,details={inputDigests:{},outputDigests:{}})=>{
    exact(details,["inputDigests","outputDigests",...(Object.hasOwn(details,"recordSha256")?["recordSha256"]:[])]);
    const row={seq:events.length+1,event,scope,...(name===undefined?{}:{path:name}),...details,
      previousEventSha256:events.length?hash(events.at(-1)):hash(base)};
    state.apply(row);events.push(structuredClone(row));
  };
  const perform=async(event,scope,name,operation,eventFor=()=>event)=>{
    guard(event,scope,name);
    const key=`${scope}/${name??""}`;
    if(pending.has(key)||name===undefined&&pending.size)reject();
    pending.add(key);
    try { const details=await operation();alive();append(eventFor(),scope,name,details);return details; }
    catch(error){poisoned=true;throw error;}
    finally{pending.delete(key);}
  };
  const session=Object.freeze({
    scopeFor(name){const row=state.expected.get(name?.toLowerCase());if(!row || row.path!==name)fail();return row.scope;},
    assertComplete(){if(poisoned || !finished || !state.complete() || pending.size || packagePending)fail();},
    producer(scope,name,operation){return perform("producer-complete",scope,name,operation);},
    async sign(scope,name,sourceSha256,operation){
      guard("sign",scope,name);
      if(!digest(sourceSha256)||state.produced.has(name)&&state.produced.get(name)!==sourceSha256)reject();
      let disposition;
      return perform("sign",scope,name,async()=>{
        const record=await operation();
        if(record?.path!==name||!["signed","preserved"].includes(record.disposition)||record.sourceSha256!==sourceSha256||!digest(record.finalSha256)
          ||!digest(record.nativeVerdictSha256)||!digest(record.leafCertificateSha256))fail();
        disposition=record.disposition;
        if(record.disposition==="preserved"){
          state.gate("preserve",scope,name);
          if(record.sourceSha256!==record.finalSha256)fail();
        }
        return {inputDigests:{[name]:record.sourceSha256},outputDigests:{[name]:record.finalSha256},recordSha256:hash(record)};
      },()=>disposition==="preserved"?"preserve":"sign");
    },
    freeze(scope,operation){return perform("freeze",scope,undefined,async()=>({inputDigests:{},outputDigests:await operation()}));},
    freezeInput(scope,name,operation){return perform("freeze-input",scope,name,async()=>({inputDigests:{},outputDigests:await operation()}));},
    async package(scope,operation){
      guard("package-begin",scope);if(pending.size)reject();append("package-begin",scope);packagePending++;
      try{return await operation();}catch(error){poisoned=true;throw error;}finally{packagePending--;}
    },
    packageComplete(operation){if(packagePending)reject();return perform("package-complete","package",undefined,async()=>{await operation();return {inputDigests:{},outputDigests:{}};});},
    async complete(file,result,verifyFinal){
      alive();if(!path.isAbsolute(file??"")||pending.size||packagePending)reject();
      let finalResult;
      try{finalResult=structuredClone(result);resultMatches(finalResult,state);}catch(error){poisoned=true;throw error;}
      await perform("verify","package",undefined,async()=>{await verifyFinal();return {inputDigests:{},outputDigests:{}};});
      const receipt={...base,events:structuredClone(events),complete:true,result:finalResult};
      const bytes=Buffer.from(encode(receipt)+"\n"),temporary=`${file}.partial`;
      let owned=false;
      try{
        try{await lstat(file);fail();}catch(error){if(error.code!=="ENOENT")throw error;}
        const handle=await open(temporary,"wx",0o600);owned=true;
        try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
        await rename(temporary,file);owned=false;finished=true;
        return {sha256:createHash("sha256").update(bytes).digest("hex"),receipt};
      }catch(error){poisoned=true;throw error;}
      finally{if(owned)await rm(temporary,{force:true});}
    },
  });
  sessions.set(session,reference=>{
    alive();exact(reference,["scope","path","event"]);
    if(reference.event!=="freeze"&&reference.event!=="freeze-input")fail();
    const row=events.find(row=>row.event===reference.event&&row.scope===reference.scope&&Object.hasOwn(row.outputDigests,reference.path));
    if(!row)fail();
    return Object.freeze({identity:structuredClone(base.identity),buildPlanSha256:base.authority.buildPlanSha256,
      sha256:row.outputDigests[reference.path],eventSha256:hash(row)});
  });
  return session;
}

/** Coverage producer: MAIN controller; consumer: win-sac-sign driver.
 * Only the verified controller run file set may select operation coverage. */
export async function windowsSigningDriverReceipt(launch, staticLaunchSha256, plan) {
  const run = launch.runAuthorization, lock = launch.signingAuthority;
  const pin = run?.files?.find(row => row.path === "signing-coverage.json");
  const tree = lock?.trees?.find(row => row.component === "builder");
  if (launch.schema !== 2 || !path.isAbsolute(launch.runRoot ?? "") || run?.launchSha256 !== staticLaunchSha256 || lock?.enrolled !== true || !pin || !digest(pin.sha256)
    || !tree || !Array.isArray(tree.files) || !tree.files.length || plan.sha256 !== run.planSha256) fail();
  const bytes = (await readWindowsPeSnapshot(path.join(launch.runRoot, pin.path))).bytes;
  if (peSha256(bytes) !== pin.sha256) fail();
  const coverage = JSON.parse(bytes);
  exact(coverage, ["schema", "identity", "files"]);
  const identity = Object.fromEntries(identityKeys.map(key => [key, run[key]]));
  if (coverage.schema !== 1 || !equal(coverage.identity, identity) || !Array.isArray(coverage.files)
    || ["target", "sourceRevision", "version", "runId", "runAttempt"].some(key => plan[key] !== run[key])
    || plan.outputs.some(output => !coverage.files.some(row => row.path === output.path && row.producerRequired === true
      && row.scope === (output.component === "gepa" ? "gepa" : output.component === "nsis-helper" ? "transient" : ["installer", "uninstaller"].includes(output.component) ? output.component : "app")))) fail();
  return windowsSigningReceipt({ identity, authority: { staticLaunchSha256, runAuthorizationSha256: run.sha256,
    inputArtifactId: run.artifactId, inputArtifactDigest: run.outerSha256, buildPlanSha256: plan.sha256,
    checkerSha256: lock.executables?.checker?.sha256, providerReceiptSha256: launch.providerReceiptSha256,
    builderTreeSha256: peSha256(encode(tree.files)) } }, coverage.files);
}

export function resolveWindowsSigningFrozenInput(session,reference){
  if(!sessions.has(session))fail();
  return sessions.get(session)(reference);
}

export function verifyWindowsSigningReceipt(bytes,configuration,coverage) {
  const data=JSON.parse(bytes),base=header(configuration),state=graph(coverage);
  exact(data,[...Object.keys(base),"events","complete","result"]);
  if(!equal(base,Object.fromEntries(Object.keys(base).map(key=>[key,data[key]])))||data.complete!==true||!Array.isArray(data.events)||!data.events.length)fail();
  let previous=hash(base);
  for(const [index,row] of data.events.entries()){
    exact(row,["seq","event","scope","inputDigests","outputDigests","previousEventSha256",...(Object.hasOwn(row,"path")?["path"]:[]),...(Object.hasOwn(row,"recordSha256")?["recordSha256"]:[])]);
    if(row.seq!==index+1||row.previousEventSha256!==previous)fail();
    state.apply(row);previous=hash(row);
  }
  if(!state.complete())fail();resultMatches(data.result,state);
  return data;
}
