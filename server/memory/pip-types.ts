/** Minimal shared types and the toggle validator for PIP P2 (B1). Later batches
 * (reflection, lived writes, shadow mode) add the machinery behind these
 * fields; B1 only stores and validates them. No imports: store.ts, index.ts and
 * the memory modules all read this. */

export interface ContinuityShadow { modelSelection:Record<string,unknown>; since:number; dailyCap:number }
export interface ContinuityOptions {
  reflect?:true; inner?:true; between?:true; innerState?:true;
  /** An owner choice restricted to a model on the speaking route's own connection (design §3.3). */
  reflectModel?:string;
  shadow?:ContinuityShadow;
  selfCutover?:true;
}
const FLAGS=["reflect","inner","between","innerState","selfCutover"] as const;
const KEYS=new Set<string>([...FLAGS,"reflectModel","shadow"]);
const plain=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

/** Strict parse. `null` and `{}` clear the options. Flags are on only when exactly `true`;
 * an unknown key, a `false` flag or a malformed value is an error (PATCH answers 400). */
export function parseContinuityOptions(value:unknown):{ok:true;value:ContinuityOptions|undefined}|{ok:false;error:string} {
  if(value===null||value===undefined)return {ok:true,value:undefined};
  if(!plain(value))return {ok:false,error:"continuityOptions must be an object"};
  const out:ContinuityOptions={};
  for(const key of Object.keys(value)){
    if(!KEYS.has(key))return {ok:false,error:`continuityOptions.${key} is not a setting`};
  }
  for(const flag of FLAGS){
    if(value[flag]===undefined)continue;
    if(value[flag]!==true)return {ok:false,error:`continuityOptions.${flag} must be true`};
    out[flag]=true;
  }
  if(value.reflectModel!==undefined){
    if(typeof value.reflectModel!=="string"||!value.reflectModel.trim()||value.reflectModel.length>200||/[\u0000-\u001f]/.test(value.reflectModel))return {ok:false,error:"continuityOptions.reflectModel must be a model id"};
    out.reflectModel=value.reflectModel.trim();
  }
  if(value.shadow!==undefined){
    const shadow=value.shadow;
    if(!plain(shadow)||!plain(shadow.modelSelection)||typeof shadow.since!=="number"||!Number.isFinite(shadow.since)||!Number.isInteger(shadow.dailyCap)||(shadow.dailyCap as number)<1||(shadow.dailyCap as number)>40)return {ok:false,error:"continuityOptions.shadow is not valid"};
    out.shadow={modelSelection:shadow.modelSelection,since:shadow.since,dailyCap:shadow.dailyCap as number};
  }
  return {ok:true,value:Object.keys(out).length?out:undefined};
}

/** The pseudo thread id of one reflection attempt: `pip-reflect:<botId>:<runId>:<family>:<attempt>`. */
export const PIP_REFLECT_PREFIX = "pip-reflect:";
export const isPipReflectThread = (threadId: unknown): boolean => typeof threadId === "string" && threadId.startsWith(PIP_REFLECT_PREFIX);
