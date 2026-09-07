// Native evaluation admission/preflight only. No process is spawned, credential
// copied, endpoint contacted or model call made. Root owns budget reservations.
// Usage: node --experimental-strip-types scripts/verify-memory-native.ts
//        --profile-directory /absolute/authoritative/profile
//        [--budget-file /absolute/native-budget.json]
// Actual dispatch remains denied until a verified transport can bound every
// provider request (including retries/tool loops) before it leaves the fixture.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INSTANCES } from "../server/default-instances.ts";

type Reservation = {id:string;package:"P07"|"P10";turns:number;maximumCostCents:number};
type Settlement = {reservationId:string;actualCostCents:number};
type Budget = {version:number;limitCents:number;maxTurns:number;reservationOwner:string;packages:Record<string,{maxTurns:number}>;reservations:Reservation[];settlements:Settlement[]};
const root=fileURLToPath(new URL("..",import.meta.url));
const args=process.argv.slice(2);
function option(name:string) {
  const at=args.indexOf(name);if(at<0)return undefined;
  const value=args[at+1];if(!value||value.startsWith("--"))throw Error(`Missing ${name} value`);return value;
}
function integer(value:unknown,label:string):asserts value is number {
  if(!Number.isSafeInteger(value)||Number(value)<0)throw Error(`Invalid ${label}`);
}
export function validateNativeBudget(budget:Budget) {
  if(budget.version!==1||budget.limitCents!==1000||budget.maxTurns!==64||budget.reservationOwner!=="root"||budget.packages.P07?.maxTurns!==4||budget.packages.P10?.maxTurns!==60)throw Error("Native budget differs from explicit authorization");
  if(!Array.isArray(budget.reservations)||!Array.isArray(budget.settlements))throw Error("Invalid native budget ledger");
  const byId=new Map<string,Reservation>();
  for(const entry of budget.reservations){
    if(typeof entry.id!=="string"||!entry.id||byId.has(entry.id)||!Object.hasOwn(budget.packages,entry.package))throw Error("Invalid or duplicate reservation");
    integer(entry.turns,"reserved turns");integer(entry.maximumCostCents,"maximum cost");
    if(entry.turns<1)throw Error("Empty reservation");byId.set(entry.id,entry);
  }
  const settled=new Map<string,number>();
  for(const entry of budget.settlements){
    const reservation=byId.get(entry.reservationId);
    integer(entry.actualCostCents,"settled cost");
    if(!reservation||settled.has(entry.reservationId)||entry.actualCostCents>reservation.maximumCostCents)throw Error("Invalid or over-budget settlement");
    settled.set(entry.reservationId,entry.actualCostCents);
  }
  const chargedCents=budget.reservations.reduce((sum,row)=>sum+(settled.get(row.id)??row.maximumCostCents),0);
  const turns=budget.reservations.reduce((sum,row)=>sum+row.turns,0);
  for(const [name,limit] of Object.entries(budget.packages))if(budget.reservations.filter(row=>row.package===name).reduce((sum,row)=>sum+row.turns,0)>limit.maxTurns)throw Error(`Package ${name} turn limit exceeded`);
  if(chargedCents>budget.limitCents||turns>budget.maxTurns)throw Error("Native budget exhausted or exceeded");
  return {remainingCents:budget.limitCents-chargedCents,remainingTurns:budget.maxTurns-turns,reservations:byId.size};
}
const sourcePaths=["server/default-instances.ts","server/drivers/claude.ts","server/drivers/codex.ts","server/drivers/acp/fuigo.ts","server/drivers/openai-compat.ts","server/drivers/openai-chat.ts","server/memory/dispatch.ts","server/memory/bundle.ts","server/memory/testing/corpus.json"];
const constraints:Record<string,{transport:string;price:string;cap:string;status:string;remedy:string}>={
  claudeAgent:{transport:"Claude CLI stream-json",price:"Not established for configured model/routing/account",cap:"Installed 2.1.263 help exposes --max-budget-usd for -p; current driver does not pass it. Per-request maximum/threshold overshoot not established.",status:"BLOCKED_UNBOUNDED_COST",remedy:"Verify selected model/routing rates and strict upper bound; add fixture-only enforced cap covering retries and any autonomous calls before admission."},
  codex:{transport:"Codex app-server",price:"Not established for configured model/routing/account",cap:"Installed app-server help exposes configuration overrides, not a monetary ceiling. Current thread/start and turn/start supply no output/cost maximum.",status:"BLOCKED_UNBOUNDED_COST",remedy:"Verify a supported enforced per-request cap and endpoint billing mode, or a bounded fixture transport for the existing configured account."},
  fuigoAgent:{transport:"Fuigo ACP agent stdio",price:"Not established for configured Flux model/routing",cap:"Installed agent/stdio help exposes no cost/output ceiling. Current ACP spawn/prompt has no monetary cap.",status:"BLOCKED_UNBOUNDED_COST",remedy:"Verify supported native or fixture-transport request/token/cost ceilings; routed aliases require a bound across every eligible backend."},
  "openai-compat":{transport:"OpenAI-compatible chat completions",price:"Not established for configured endpoint/model",cap:"Current request builder sends model/messages/stream without max_tokens or max_completion_tokens; timeout cannot bound charges.",status:"BLOCKED_UNBOUNDED_COST",remedy:"Verify selected provider rates/context limits and enforced output cap, then bound each request including retries in a fixture-only transport."},
};
function inventory(profile:string) {
  const raw=JSON.parse(readFileSync(join(profile,"config.json"),"utf8"));
  const explicit=raw.engineDiscovery==="explicit";
  const configured=raw.instances&&typeof raw.instances==="object"?raw.instances:{};
  const instances=explicit?configured:Object.keys(configured).length?configured:DEFAULT_INSTANCES;
  const selectedPath=join(profile,"bots.json");
  const bots=existsSync(selectedPath)?JSON.parse(readFileSync(selectedPath,"utf8")):[];
  const selectedModels=Array.isArray(bots)?[...new Map(bots.flatMap(row=>{
    const value=row?.modelSelection;
    if(typeof value?.instanceId!=="string"||typeof value?.model!=="string"||!/^[\w./:+-]{1,160}$/.test(value.model))return [];
    return [[JSON.stringify([value.instanceId,value.model]),{instanceId:value.instanceId,model:value.model}] as const];
  })).values()]:[];
  const result=Object.entries(instances).filter(([,value])=>value&&typeof value==="object"&&Object.hasOwn(constraints,String((value as any).driver))).map(([id,value])=>{
    const row=value&&typeof value==="object"?value as Record<string,any>:{};
    const config={...(row.driver==="openai-compat"?raw.openaiCompat??{}:{}),...(row.config&&typeof row.config==="object"?row.config:{})};
    const driver=typeof row.driver==="string"?row.driver:"unknown";
    let endpointHost:string|null=null;
    if(typeof config.url==="string"){try{endpointHost=new URL(config.url).hostname;}catch{/* no raw URL in output */}}
    const model=typeof config.model==="string"&&/^[\w./:+-]{1,160}$/.test(config.model)?config.model:null;
    return {instanceId:id,driver,enabled:row.enabled!==false,model,endpointHost,
      selectedModels:selectedModels.filter(selection=>selection.instanceId===id).map(selection=>selection.model),
      configuredCredentialField:Boolean(config.apiKey||config.key),cli:typeof config.cli==="string"?basename(config.cli):null,
      gate:constraints[driver]??{transport:"unclassified",price:"unknown",cap:"not qualified",status:"NOT_SELECTED_FOR_P07",remedy:"No paid admission from this preflight"}};
  });
  return {fleet:explicit?"explicit":Object.keys(configured).length?"configured":"default",instances:result,selectedModels,
    observedCredentialPresence:{workspaceFlux:Boolean(raw.flux?.apiKey),workspaceOpenAICompatible:Boolean(raw.openaiCompat?.key),parentOpenAICompatible:Boolean(process.env.OPENAI_COMPAT_API_KEY)},
    limitation:"Credential presence is not authentication or billing proof; no secret values emitted."};
}
function nativeSettings(profile:string) {
  // The authorized profile is ~/.murage. Only the three named native config
  // surfaces are read; auth contents, arbitrary settings and user text stay out.
  if(basename(profile)!==".murage")return {status:"not-inspected-nondefault-profile"};
  const home=dirname(profile),claudePath=join(home,".claude/settings.json"),codexPath=join(home,".codex/config.toml");
  let claude:{model:string|null;endpointHost:string|null;apiCredentialConfigured:boolean}|null=null;
  if(existsSync(claudePath)){
    const value=JSON.parse(readFileSync(claudePath,"utf8"));let endpointHost:string|null=null;
    try{endpointHost=new URL(value.env?.ANTHROPIC_BASE_URL).hostname;}catch{/* no URL contents emitted */}
    claude={model:typeof value.model==="string"&&/^[\w./:+\[\]-]{1,160}$/.test(value.model)?value.model:null,endpointHost,apiCredentialConfigured:Boolean(value.env?.ANTHROPIC_API_KEY||value.env?.ANTHROPIC_AUTH_TOKEN)};
  }
  const codex:Array<{section:string;key:string;value:string}>=[];
  if(existsSync(codexPath)){
    let section="";
    for(const line of readFileSync(codexPath,"utf8").split("\n")){
      if(/^\[/.test(line))section=line.trim();
      const match=line.match(/^\s*(model|model_provider|base_url)\s*=\s*"([^"\n]*)"/);if(!match)continue;
      let value=match[2];
      if(match[1]==="base_url"){try{value=new URL(value).hostname;}catch{value="invalid-url";}}
      else if(!/^[\w./:+-]{1,160}$/.test(value))continue;
      codex.push({section,key:match[1],value});
    }
  }
  return {claude,codex,credentialFilePresence:{claude:existsSync(join(home,".claude/.credentials.json")),codex:existsSync(join(home,".codex/auth.json")),fuigo:existsSync(join(home,".fuigo/auth.json"))},
    billing:"No subscription quota, extra-usage setting or zero-new-charge claim verified. Treat requests as potentially newly billed."};
}
export function nativePreflight(profileDirectory:string,budgetFile:string) {
  if(!isAbsolute(profileDirectory)||!isAbsolute(budgetFile))throw Error("Profile and budget paths must be absolute");
  const profile=realpathSync(profileDirectory);
  const budget=JSON.parse(readFileSync(budgetFile,"utf8")) as Budget;
  const counters=validateNativeBudget(budget);
  const sourceIdentity=sourcePaths.map(path=>({path,sha256:createHash("sha256").update(readFileSync(join(root,path))).digest("hex")}));
  const corpus=JSON.parse(readFileSync(join(root,"server/memory/testing/corpus.json"),"utf8"));
  const frozenCase=corpus.queries.find((query:any)=>query.id==="exact-00");
  if(!frozenCase)throw Error("Frozen native delivery case missing");
  const cases=[
    {engine:"claudeAgent",audience:"private",expect:"source-linked owner pin recalled; foreign bot and room private canaries absent"},
    {engine:"codex",audience:"private",expect:"same authoritative memory delivered through registered Codex adapter"},
    {engine:"fuigoAgent",audience:"room",expect:"room source-linked pin recalled; member private pin excluded"},
    {engine:"openai-compat",audience:"room",expect:"non-MCP host memory delivered; member private pin excluded"},
  ].map(row=>({...row,frozenQueryId:frozenCase.id,query:frozenCase.query,expectedSourceIds:frozenCase.expected,forbiddenSourceIds:frozenCase.forbidden}));
  return {ok:true,operation:"preflight-only",paidCalls:0,profileDirectory:profile,budgetFile,counters,sourceIdentity,inventory:inventory(profile),nativeSettings:nativeSettings(profile),cases,
    priceReferences:{checkedOn:"2026-09-07",ratesPerMillionTokens:{"claude-opus-5":{inputUSD:5,outputUSD:25},"claude-sonnet-5":{inputUSD:2,outputUSD:10},"gpt-6-astra":{inputUSD:10,outputUSD:50}},
      sources:["https://platform.claude.com/docs/en/about-claude/pricing","https://developers.openai.com/api/docs/models/gpt-6-astra","https://fluxrouter.ai/changelog"],
      caveat:"Standard direct API rates only; cache-write, fast mode, long-context/geography, routed pricing and autonomous extra calls must be bounded before admission. Flux pinned GLM5.3 price not established."},
    dispatchAllowed:false,reason:"No selected native route yet has a verified pre-call maximum-cost contract. Root reservation alone cannot create that guarantee.",
    limits:"Four initial P07 turns maximum; remaining P10 allocation60. No authentication validity, prices, model execution or delivery inferred from config presence."};
}
function main(){
  if(args.includes("--run")||args.includes("--execute")||args.includes("--reserve"))throw Error("Paid dispatch/reservation disabled: root must first approve verified cost enforcement; this runner is preflight-only");
  const profile=option("--profile-directory");if(!profile)throw Error("Explicit --profile-directory required; no default live profile discovery");
  const budget=option("--budget-file")??join(root,".planning/memory-evidence/native-budget.json");
  if(!existsSync(budget))throw Error("Root-coordinated native budget ledger missing");
  console.log(JSON.stringify(nativePreflight(resolve(profile),resolve(budget)),null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
