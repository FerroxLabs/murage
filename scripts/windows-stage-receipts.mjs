// Plans, receipt consumers and producer adapters owner: win-sac-sign; authenticated controller handoff owner: MAIN.
import { canonicalWindowsPePath, normalizeWindowsPeSources, peSha256, readWindowsPeSnapshot, WINDOWS_PE_BUILD_OUTPUTS } from "./windows-pe-signing.mjs";
import { resolveWindowsSigningFrozenInput } from "./windows-signing-receipt.mjs";
const digest = value => /^[a-f0-9]{64}$/.test(value ?? "");
const identityMatches = (data, identity) => data.target === identity.target && data.sourceRevision === identity.sourceRevision
  && data.version === identity.version && data.runId === identity.runId && data.runAttempt === identity.runAttempt;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function freezePlan(value){
  if(value && typeof value==="object"){for(const row of Object.values(value))freezePlan(row);Object.freeze(value);}
  return value;
}

/** Only CI's authenticated channel selects digests. Never discover a digest
 * beside mutable build output, and never construct provenance by scanning it. */
export async function readWindowsBuildPlan(file, expected, identity) {
  if (!file || !digest(expected) || !/^[a-f0-9]{40}$/.test(identity.sourceRevision ?? "") || !identity.runId || !identity.version
    || !/^[1-9][0-9]*$/.test(identity.runAttempt ?? "")) throw Error("WINDOWS_BUILD_PLAN_REQUIRED");
  const bytes = (await readWindowsPeSnapshot(file)).bytes;
  if (peSha256(bytes) !== expected) throw Error("WINDOWS_BUILD_PLAN_HASH_MISMATCH");
  const data = JSON.parse(bytes), seen = new Set();
  if (![2,3].includes(data.schema) || !identityMatches(data, identity) || !Array.isArray(data.outputs) || !data.outputs.length) throw Error("WINDOWS_BUILD_PLAN_IDENTITY_INVALID");
  for (const plan of data.outputs) {
    const name = canonicalWindowsPePath(plan.path);
    const component = WINDOWS_PE_BUILD_OUTPUTS[name] ?? (/^artifacts\/[^/]+\.exe$/.test(name) && ["installer", "uninstaller"].includes(plan.component) ? plan.component : undefined)
      ?? (/^transient\/[^/]+\.exe$/.test(name) && plan.component === "nsis-helper" ? plan.component : undefined);
    if (!component || component !== plan.component || seen.has(name.toLowerCase()) || !plan.stage || !plan.producer
      || Object.hasOwn(plan, "sourceSha256") || !Array.isArray(plan.inputs) || !plan.inputs.length
      || plan.inputs.some(input => !validInput(input,data.schema,name)) || !Array.isArray(plan.tools) || !plan.tools.length
      || plan.tools.some(tool => !tool.component || !digest(tool.sha256)) || !Array.isArray(plan.transformations)
      || !plan.transformations.length || plan.transformations.some(value => typeof value !== "string" || !value.trim())
      || !Array.isArray(plan.publishers) || plan.publishers.some(value => typeof value !== "string" || !value.trim())) throw Error("WINDOWS_BUILD_PLAN_OUTPUT_INVALID");
    seen.add(name.toLowerCase());
  }
  return freezePlan({ ...data, sha256: expected });
}

function validInput(input,schema,name){
  if(!input || typeof input.component!=="string" || !input.component)return false;
  if(same(Object.keys(input).sort(),["component","sha256"]))return digest(input.sha256);
  if(schema!==3 || !same(Object.keys(input).sort(),["component","fromEvent"]))return false;
  const ref=input.fromEvent;
  if(!ref || !same(Object.keys(ref).sort(),["event","path","scope"]) || !["freeze","freeze-input"].includes(ref.event)
    || !["gepa","app","uninstaller","transient"].includes(ref.scope) || ref.path===name)return false;
  try{canonicalWindowsPePath(ref.path);return true;}catch{return false;}
}

export function resolveWindowsBuildPlanStage(plan,name,session){
  const output=plan.outputs.find(row=>row.path===name);
  if(plan.schema!==3 || !digest(plan.sha256) || !output)throw Error("WINDOWS_BUILD_PLAN_RESOLUTION_INVALID");
  const predecessors=[];
  const inputs=output.inputs.map(input=>{
    if(Object.hasOwn(input,"sha256"))return {...input};
    const frozen=resolveWindowsSigningFrozenInput(session,input.fromEvent);
    if(frozen.buildPlanSha256!==plan.sha256)throw Error("WINDOWS_BUILD_PLAN_PREDECESSOR_BINDING_INVALID");
    if(!identityMatches(frozen.identity,plan))throw Error("WINDOWS_BUILD_PLAN_PREDECESSOR_IDENTITY_INVALID");
    predecessors.push({...input.fromEvent,sha256:frozen.sha256,eventSha256:frozen.eventSha256});
    return {component:input.component,sha256:frozen.sha256};
  });
  const resolved={schema:2,target:plan.target,sourceRevision:plan.sourceRevision,version:plan.version,runId:plan.runId,runAttempt:plan.runAttempt,
    parentPlanSha256:plan.sha256,predecessors,outputs:[{...output,inputs}]};
  return freezePlan({...resolved,sha256:peSha256(JSON.stringify(resolved))});
}

/** Register a producer before packing. Its closure runs only at its declared
 * compiler/resource-editor/NSIS boundary and returns the authenticated receipt
 * location/digest. The signer cannot supply a digest of arbitrary current bytes. */
export function windowsStageReceiptConsumer(plan, producers, session) {
  const consumed = new Set(), completed = new Set();
  if (!(producers instanceof Map) || plan.outputs.some(output => typeof producers.get(output.producer) !== "function")) throw Error("WINDOWS_BUILD_PRODUCER_REQUIRED");
  return Object.freeze({
    outputs: plan.outputs.map(output => ({ path: output.path, stage: output.stage })),
    async consume(name, stage) {
      let output = plan.outputs.find(output => output.path === name);
      if (!output || output.stage !== stage || consumed.has(name)) throw Error("WINDOWS_BUILD_RECEIPT_STAGE_INVALID");
      // Mark in flight before awaiting: duplicate/reentrant callbacks fail too.
      consumed.add(name);
      const resolved=plan.schema===3?resolveWindowsBuildPlanStage(plan,name,session):plan;
      if(plan.schema===3)output=resolved.outputs[0];
      const selected = await producers.get(output.producer)({ path: name, stage, planSha256: resolved.sha256 });
      if (!selected || !digest(selected.sha256) || !selected.file) throw Error("WINDOWS_BUILD_RECEIPT_REQUIRED");
      const bytes = (await readWindowsPeSnapshot(selected.file)).bytes;
      if (peSha256(bytes) !== selected.sha256) throw Error("WINDOWS_BUILD_RECEIPT_HASH_MISMATCH");
      const receipt = JSON.parse(bytes);
      if (receipt.schema !== 2 || !identityMatches(receipt, resolved) || receipt.planSha256 !== resolved.sha256
        || plan.schema===3 && (receipt.parentPlanSha256!==resolved.parentPlanSha256 || !same(receipt.predecessors,resolved.predecessors))
        || receipt.path !== name || receipt.stage !== stage || receipt.producer !== output.producer
        || !digest(receipt.preSignSha256) || !same(receipt.inputs, output.inputs) || !same(receipt.tools, output.tools)
        || !same(receipt.transformations, output.transformations)) throw Error("WINDOWS_BUILD_RECEIPT_IDENTITY_INVALID");
      const pin = normalizeWindowsPeSources([{ ...output, kind: "build", target: plan.target, sourceRevision: plan.sourceRevision,
        version: plan.version, sourceSha256: receipt.preSignSha256, sourceReceiptSha256: selected.sha256 }], plan)[0];
      completed.add(name);
      return pin;
    },
    assertComplete() {
      if (plan.outputs.some(output => !completed.has(output.path))) throw Error("WINDOWS_BUILD_RECEIPTS_INCOMPLETE");
    },
  });
}
