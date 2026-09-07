// Native P07/P10 admission: one root-reserved $6 turn, actual Murage memory path.
// Guard forwards at most ONE Sonnet 5 inference request to api.anthropic.com;
// 256 KiB serialized request cap, native message format preserved, no tools, max_tokens<=512.
// Full-model ceiling even without the smaller output cap: (1M*$4/MTok maximum
// cache-write +128K*$10/MTok output)*1.1 geography=$5.808, rounded up to $6.
// Official limits/pricing checked 2026-09-07. CLI max-budget is supplemental.
// The durable attempt marker prevents reruns; root alone settles the ledger.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer, runControlMurage } from "./control-murage.ts";
import { validateNativeBudget } from "./verify-memory-native.ts";

const ROOT=fileURLToPath(new URL("..",import.meta.url)),MODEL="claude-sonnet-5",MAX_BYTES=256*1024;
const args=process.argv.slice(2);
function option(name:string){const at=args.indexOf(name);if(at<0||!args[at+1]||args[at+1].startsWith("--"))throw Error(`Required ${name}`);return args[at+1];}
function digest(value:string|Buffer){return createHash("sha256").update(value).digest("hex");}
function readJson(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error("NATIVE_INPUT_NOT_REGULAR");try{return JSON.parse(readFileSync(path,"utf8"));}catch{throw Error("NATIVE_INPUT_JSON_INVALID");}}
function credential(profile:string):{kind:"oauth"|"api-key";value:string}{
  if(!isAbsolute(profile)||profile.slice(profile.lastIndexOf("/")+1)!==".murage")throw Error("EXPLICIT_DEFAULT_PROFILE_REQUIRED");
  const home=dirname(profile),settingsPath=join(home,".claude","settings.json"),settings=existsSync(settingsPath)?readJson(settingsPath):{};
  for(const configured of [process.env.ANTHROPIC_BASE_URL,settings.env?.ANTHROPIC_BASE_URL])if(configured){const url=new URL(configured);if(url.protocol!=="https:"||url.hostname!=="api.anthropic.com"||url.port||url.username||url.password)throw Error("CONFIGURED_ROUTE_NOT_DIRECT_ANTHROPIC");}
  const key=process.env.ANTHROPIC_API_KEY||settings.env?.ANTHROPIC_API_KEY;
  if(typeof key==="string"&&key.trim())return {kind:"api-key",value:key};
  if(process.env.ANTHROPIC_AUTH_TOKEN||settings.env?.ANTHROPIC_AUTH_TOKEN||settings.apiKeyHelper)throw Error("CONFIGURED_AUTH_REQUIRES_SEPARATE_READ_ONLY_QUALIFICATION");
  const path=join(home,".claude",".credentials.json");
  let stored:any;
  if(existsSync(path))stored=readJson(path);
  else {
    if(process.platform!=="darwin")throw Error("READABLE_NATIVE_CREDENTIAL_REQUIRED");
    if(process.env.CLAUDE_CONFIG_DIR||process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR||process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL)throw Error("NONDEFAULT_KEYCHAIN_SERVICE_REQUIRES_EXACT_QUALIFICATION");
    // Verified in installed 2.1.263 secure storage implementation: default
    // production Sx('-credentials') -> 'Claude Code-credentials'; account tv()
    // uses USER or os.userInfo().username. No service enumeration or writes.
    const account=process.env.USER||userInfo().username;
    if(!/^[a-zA-Z0-9._-]+$/.test(account))throw Error("NATIVE_KEYCHAIN_ACCOUNT_UNAVAILABLE");
    let captured:Buffer;
    try {
      captured=execFileSync("/usr/bin/security",["find-generic-password","-a",account,"-w","-s","Claude Code-credentials"],{timeout:5000,maxBuffer:256*1024,stdio:["ignore","pipe","pipe"]});
    } catch {
      // Access denial, a locked store or an OS prompt requiring interaction
      // remains a preflight blocker. Never print captured stderr/stdout.
      throw Error("NATIVE_KEYCHAIN_READ_BLOCKED_OR_REQUIRES_OS_INPUT_NO_RETRY");
    }
    try{stored=JSON.parse(captured.toString("utf8").trim());}
    catch{throw Error("NATIVE_KEYCHAIN_CREDENTIAL_FORMAT_INVALID");}
  }
  const oauth=stored.claudeAiOauth;
  if(typeof oauth?.accessToken!=="string"||!oauth.accessToken)throw Error("NATIVE_OAUTH_TOKEN_UNAVAILABLE");
  if(typeof oauth.expiresAt!=="number"||oauth.expiresAt<=Date.now()+120000)throw Error("NATIVE_OAUTH_EXPIRED_OR_TOO_CLOSE_NO_REFRESH");
  return {kind:"oauth",value:oauth.accessToken};
}

// Serialized into the task-owned wrapper, never executed in this parent process.
declare const WRAPPER:{authPath:string;home:string;url:string;cli:string;frames:string;launchMarker:string};
async function nativeWrapper(){
  const {spawn}=await import("node:child_process");
  const {readFileSync,writeFileSync,appendFileSync}=await import("node:fs");
  const incoming=process.argv.slice(2),auth=JSON.parse(readFileSync(WRAPPER.authPath,"utf8"));
  const inference=incoming.includes("-p")||incoming.includes("--print");
  if(!inference&&!(incoming.length===1&&["--version","--help"].includes(incoming[0]))&&incoming.join(" ")!=="auth status --json")process.exit(70);
  if(inference)try{writeFileSync(WRAPPER.launchMarker,"launched",{flag:"wx",mode:0o600});}catch{process.exit(71);}
  const env:Record<string,string>={HOME:WRAPPER.home,USERPROFILE:WRAPPER.home,CLAUDE_CONFIG_DIR:WRAPPER.home+"/.claude",PATH:"/usr/bin:/bin",TMPDIR:WRAPPER.home+"/tmp",ANTHROPIC_BASE_URL:WRAPPER.url,CLAUDE_CODE_MAX_RETRIES:"0",CLAUDE_CODE_MAX_OUTPUT_TOKENS:"512",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1",CLAUDE_CODE_DISABLE_CLAUDE_MDS:"1",CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1",DISABLE_AUTO_COMPACT:"1",DISABLE_PROMPT_CACHING:"1"};
  env[auth.kind==="oauth"?"CLAUDE_CODE_OAUTH_TOKEN":"ANTHROPIC_API_KEY"]=auth.value;
  const discard=new Set(["--model","--mcp-config","--allowedTools","--permission-prompt-tool","--permission-mode","--resume","--session-id"]);
  const passed:string[]=[];for(let i=0;i<incoming.length;i++){if(discard.has(incoming[i])){i++;continue;}passed.push(incoming[i]);}
  if(inference)passed.push("--model","claude-sonnet-5","--max-turns","1","--max-budget-usd","5.80","--tools","","--safe-mode","--strict-mcp-config","--mcp-config",'{"mcpServers":{}}',"--disable-slash-commands","--no-session-persistence","--prompt-suggestions","false","--permission-mode","dontAsk","--permission-prompts","none");
  const child=spawn(WRAPPER.cli,passed,{env,cwd:WRAPPER.home,stdio:["pipe","pipe","pipe"]});
  process.stdin.pipe(child.stdin);child.stdin.on("error",()=>{});
  child.stdout.setEncoding("utf8");
  let pending="";child.stdout.on("data",chunk=>{process.stdout.write(chunk);if(!inference)return;pending+=chunk;let at;while((at=pending.indexOf("\n"))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const frame=JSON.parse(line);if(frame.type==="assistant"||frame.type==="result")appendFileSync(WRAPPER.frames,JSON.stringify(frame)+"\n",{mode:0o600});}catch{}}});
  child.stderr.resume(); // never echo credential-sensitive native diagnostics
  child.on("error",()=>{process.exitCode=72;});child.on("close",code=>process.exit(code??73));
  process.on("SIGTERM",()=>child.kill("SIGTERM"));process.on("SIGINT",()=>child.kill("SIGINT"));
}

async function main(){
  const preflight=args.includes("--preflight");
  const queryId=args.includes("--query-id")?option("--query-id"):"exact-00";
  const packageName=queryId==="exact-00"?"P07":"P10";
  const profile=option("--profile-directory"),budgetPath=resolve(option("--budget-file")),reservationId=preflight?"preflight":option("--reservation-id");
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(reservationId))throw Error("INVALID_RESERVATION_ID");
  const budget=readJson(budgetPath);validateNativeBudget(budget);
  const reserved=budget.reservations.find((row:any)=>row.id===reservationId);
  if(!preflight&&(!reserved||reserved.package!==packageName||reserved.turns!==1||reserved.maximumCostCents<600||budget.settlements.some((row:any)=>row.reservationId===reservationId)))throw Error("ROOT_UNSETTLED_600_CENT_RESERVATION_REQUIRED");
  const marker=join(dirname(budgetPath),`claude-${reservationId}.forwarded.json`),proofPath=join(dirname(budgetPath),`claude-${reservationId}.proof.json`);
  if(existsSync(marker))throw Error("RESERVATION_ALREADY_ATTEMPTED_NO_RETRY");
  const auth=credential(profile),nativeCli=join(dirname(profile),".local/share/claude/versions/2.1.263");
  if(!existsSync(nativeCli)||!lstatSync(nativeCli).isFile())throw Error("PINNED_CLAUDE_2_1_263_UNAVAILABLE");
  const corpus=readJson(join(ROOT,"server/memory/testing/corpus.json")),answerCase=corpus.answerCases.find((row:any)=>row.driver==="claude"&&row.queryId===queryId),query=corpus.queries.find((row:any)=>row.id===queryId);
  assert(answerCase&&query&&query.expected.length===1&&query.expected[0]===answerCase.requiredSource,"Only frozen Claude answer cases are admitted");
  if(queryId==="exact-00")assert.equal(query.expected[0],"source-00");
  const gold=corpus.sources.find((row:any)=>row.id===query.expected[0]),forbidden=corpus.sources.filter((row:any)=>query.forbidden.includes(row.id));
  assert(gold);assert.equal(forbidden.length,query.forbidden.length);
  if(preflight){console.log(JSON.stringify({ok:true,operation:"preflight-only",paidCalls:0,credentialKind:auth.kind,model:MODEL,nativeCliSha256:digest(readFileSync(nativeCli)),queryId:query.id,requiredReservationCents:600,limits:"Credential readability/expiry and source identity only; no auth/inference/guard runtime proof and no reservation created."}));return;}
  const fixture=await launchVerificationServer();
  let db:DatabaseSync|undefined,guard:Server|undefined,forwarded=0,upstreamStatus:number|undefined,proofWritten=false;
  const upstreamAbort=new AbortController();
  const stop=()=>{upstreamAbort.abort();guard?.closeAllConnections();void fixture.close();};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  const refused:Record<string,number>={};
  let acceptedRequest:Record<string,unknown>|undefined,desktop:Record<string,string>={};
  const framesPath=join(fixture.info.dataDir,"native-result.ndjson");
  const api=async(method:string,path:string,body?:unknown)=>{const res=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...desktop},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:res.status,body:await res.json() as any};};
  try{
    guard=createServer((req,res)=>{void(async()=>{
      const reject=(reason:string,status=403)=>{refused[reason]=(refused[reason]??0)+1;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify({type:"error",error:{type:"permission_error",message:`NATIVE_PROOF_${reason}`}}));};
      const url=new URL(req.url??"/","http://127.0.0.1");
      if(req.method!=="POST"||url.pathname!=="/v1/messages"||[...url.searchParams].some(([key,value])=>key!=="beta"||value!=="true"))return reject("ROUTE_DENIED");
      if((auth.kind==="oauth"?req.headers.authorization!==`Bearer ${auth.value}`:req.headers["x-api-key"]!==auth.value))return reject("AUTH_DENIED");
      if(forwarded||existsSync(marker))return reject("REQUEST_LIMIT");
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>MAX_BYTES)return reject("REQUEST_TOO_LARGE",413);chunks.push(Buffer.from(chunk));}
      let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return reject("INVALID_JSON",400);}
      if(body.model!==MODEL)return reject("MODEL_DENIED");
      if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length)||body.mcp_servers!==undefined||body.container||body.tool_choice&&body.tool_choice.type!=="none")return reject("TOOLS_DENIED");
      if(!Array.isArray(body.messages)||!body.messages.length)return reject("MESSAGES_REQUIRED");
      if(body.service_tier&&body.service_tier!=="standard_only"&&body.service_tier!=="auto")return reject("SERVICE_TIER_DENIED");
      if(body.speed&&body.speed!=="standard")return reject("SPEED_DENIED");
      if(!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1)return reject("OUTPUT_LIMIT_REQUIRED");
      body.max_tokens=Math.min(body.max_tokens,512);
      body.service_tier="standard_only";
      const serialized=JSON.stringify(body);
      if(serialized.includes(auth.value))return reject("CREDENTIAL_IN_BODY");
      if(Buffer.byteLength(serialized)>MAX_BYTES)return reject("REQUEST_TOO_LARGE",413);
      if(!serialized.includes(gold.text)||!serialized.includes(gold.id)||!serialized.includes(query.query)||forbidden.some((source:any)=>serialized.includes(source.id)||serialized.includes(source.text)))return reject("MEMORY_DELIVERY_MISMATCH");
      const currentBudget=readJson(budgetPath);validateNativeBudget(currentBudget);
      if(!currentBudget.reservations.some((row:any)=>row.id===reservationId&&row.package===packageName&&row.turns===1&&row.maximumCostCents>=600)||currentBudget.settlements.some((row:any)=>row.reservationId===reservationId))return reject("RESERVATION_REVOKED");
      // Atomic before I/O; even an unknown failed upstream outcome cannot retry.
      try{writeFileSync(marker,JSON.stringify({reservationId,startedAt:new Date().toISOString(),upstream:"https://api.anthropic.com/v1/messages",maximumCostCents:600},null,2)+"\n",{flag:"wx",mode:0o600});}catch{return reject("RESERVATION_ALREADY_USED");}
      forwarded++;acceptedRequest={sha256:digest(serialized),bytes:Buffer.byteLength(serialized),model:body.model,maxTokens:body.max_tokens,sourceIds:[gold.id],queryId:query.id};
      const headers:Record<string,string>={"content-type":"application/json"};
      for(const name of ["anthropic-version","anthropic-beta","user-agent","x-app"]){const value=req.headers[name];if(typeof value==="string")headers[name]=value;}
      if(auth.kind==="oauth")headers.authorization=`Bearer ${auth.value}`;else headers["x-api-key"]=auth.value;
      const upstream=await fetch(`https://api.anthropic.com/v1/messages${url.search}`,{method:"POST",headers,body:serialized,redirect:"error",signal:AbortSignal.any([upstreamAbort.signal,AbortSignal.timeout(120000)])});
      upstreamStatus=upstream.status;res.writeHead(upstream.status,{"content-type":upstream.headers.get("content-type")??"application/json"});
      if(upstream.body)for await(const chunk of upstream.body as any)res.write(chunk);
      res.end();
    })().catch(()=>{if(!res.headersSent)res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({type:"error",error:{type:"api_error",message:"NATIVE_PROOF_UPSTREAM_FAILED_NO_RETRY"}}));});});
    await new Promise<void>(resolve=>guard!.listen(0,"127.0.0.1",resolve));
    const address=guard.address();assert(address&&typeof address!=="string");
    const authPath=join(fixture.info.dataDir,"native-auth.json"),wrapper=join(fixture.info.dataDir,"guarded-claude.mjs");
    writeFileSync(authPath,JSON.stringify(auth),{mode:0o600});mkdirSync(join(fixture.info.dataDir,".claude"),{recursive:true});mkdirSync(join(fixture.info.dataDir,"tmp"),{recursive:true,mode:0o700});
    const wrapperOptions={authPath,home:fixture.info.dataDir,url:`http://127.0.0.1:${address.port}`,cli:nativeCli,frames:framesPath,launchMarker:join(fixture.info.dataDir,"native-launch.used")};
    writeFileSync(wrapper,`#!${process.execPath}\nconst WRAPPER=${JSON.stringify(wrapperOptions)};\n(${nativeWrapper.toString()})();\n`,{mode:0o700});
    const proof=await api("GET","/api/desktop-secret");assert.equal(proof.status,200);
    desktop={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};
    const configured=await api("PATCH","/api/instances/verification",{cli:wrapper});assert.equal(configured.status,200,`Native fixture CLI configuration failed: ${String(configured.body.error??"unknown").replaceAll(auth.value,"[redacted]")}`);
    const made=await api("POST","/api/bots",{name:"Native memory proof",description:"Answer using only supplied reference evidence and cite its source ID. Do not use tools.",modelSelection:{instanceId:"verification",model:MODEL}});assert.equal(made.status,201);
    const bot=made.body.bot as {id:string;threadId:string},other=await api("POST","/api/bots",{name:"Private canary fixture"});assert.equal(other.status,201);
    db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"));db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;BEGIN IMMEDIATE");
    db.prepare("INSERT INTO memory_scopes VALUES(?,'project',?,'[]',0)").run(gold.scope,join(fixture.info.dataDir,"project"));
    const privateScope=db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(other.body.bot.id)!;
    for(const source of [gold,...forbidden]){
      const old=source.state!=="active",scope=source.id===gold.id||old?gold.scope:String(privateScope.id),payload=JSON.stringify({text:source.text,speaker:source.role}),hash=digest(payload);
      db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,?,?,'text','owner','recorded',?)").run(source.id,scope,bot.threadId,source.messageId,source.revision,hash,old?'retired':'active');
      db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,1)").run(source.id,source.revision,hash,payload);
      db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement',?,?,1,1)").run(`record-${source.id}`,scope,source.text,old?'superseded':'active',old?0:1);
      db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,0,?)").run(`record-${source.id}`,source.id,source.revision,Buffer.byteLength(source.text));
    }
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1;COMMIT");assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.equal((await api("POST","/api/memory/action",{action:"bind",scopeId:gold.scope,subjectType:"bot",subjectId:bot.id})).status,200);
    assert.equal((await api("POST","/api/memory/action",{action:"configure",mode:"active"})).status,200);
    assert.equal((await api("POST",`/api/bots/${bot.id}/messages`,{text:query.query})).status,202);
    const waiting=await runControlMurage(["wait","--bot",bot.id,"--timeout","120","--url",fixture.info.url]) as {status:string};
    assert.equal(waiting.status,"settled","Native fixture did not settle");
    await api("POST",`/api/bots/${bot.id}/interrupt`);
    const frames=existsSync(framesPath)?readFileSync(framesPath,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
    const result=frames.filter(frame=>frame.type==="result").at(-1);
    const answer=typeof result?.result==="string"?result.result:frames.filter(frame=>frame.type==="assistant").flatMap(frame=>(frame.message?.content??[]).filter((block:any)=>block.type==="text").map((block:any)=>block.text)).join("\n");
    const disclosure=db.prepare("SELECT state,record_versions,source_versions,token_count FROM memory_disclosures WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(bot.threadId);
    const report={reservationId,forwarded,upstreamStatus,refused,acceptedRequest,queryId:query.id,answerCaseId:answerCase.id,rubric:answerCase.rubric,answerRubricStatus:"PENDING_MANUAL_REVIEW",evaluationKind:"pinned-reference answer evaluation",corpusSha256:digest(readFileSync(join(ROOT,"server/memory/testing/corpus.json"))),nativeCliSha256:digest(readFileSync(nativeCli)),answer,result:result?{subtype:result.subtype,modelUsage:result.modelUsage,usage:result.usage,totalCostUsdEstimate:result.total_cost_usd,numTurns:result.num_turns}:null,disclosure,fixtureLog:fixture.info.logPath,limits:"One guarded native Claude pinned-reference answer turn; separate from the 240-query retrieval-quality gate. No tools/MCP. Root settles ledger and manually judges the frozen rubric; cost estimate is not authoritative billing."};
    writeFileSync(proofPath,JSON.stringify(report,null,2).replaceAll(auth.value,"[redacted]")+"\n",{mode:0o600});proofWritten=true;
    assert.equal(forwarded,1,"No guarded native inference completed");assert.equal(upstreamStatus,200,"Native provider rejected the single attempt");assert(acceptedRequest);
    assert(disclosure?.state==="delivered","Dispatch disclosure not delivered");assert.deepEqual(JSON.parse(String(disclosure.source_versions)),[{id:gold.id,revision:gold.revision}]);
    if(queryId==="exact-00")assert(/\b(two|2)\b/i.test(answer)&&/review|approv|people|person/i.test(answer),"Answer did not recover the two-reviewer policy");
    assert(answer.includes(gold.id),"Answer did not cite frozen expected source");assert(forbidden.every((source:any)=>!answer.includes(source.id)&&!answer.includes(source.text)),"Answer disclosed forbidden source");
    writeFileSync(proofPath,JSON.stringify({...report,transportStatus:"PASS"},null,2).replaceAll(auth.value,"[redacted]")+"\n",{mode:0o600});
    console.log(JSON.stringify({ok:true,transportStatus:"PASS",answerRubricStatus:"PENDING_MANUAL_REVIEW",proofPath,reservationId,forwarded,queryId:query.id,sourceIds:[gold.id],upstreamStatus,totalCostUsdEstimate:result?.total_cost_usd??null}));
  }finally{
    upstreamAbort.abort();
    if(!proofWritten){
      const frames=existsSync(framesPath)?readFileSync(framesPath,"utf8").split("\n").filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}):[];
      writeFileSync(proofPath,JSON.stringify({ok:false,reservationId,forwarded,upstreamStatus,refused,acceptedRequest,nativeFrames:frames,fixtureLog:fixture.info.logPath,settlement:"Root must retain the full reservation for any forwarded request with uncertain usage; no automatic retry."},null,2).replaceAll(auth.value,"[redacted]")+"\n",{mode:0o600});
    }
    db?.close();await fixture.close();if(guard){guard.closeAllConnections();await new Promise<void>(resolve=>guard!.close(()=>resolve()));}
    process.off("SIGINT",stop);process.off("SIGTERM",stop);
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:"NATIVE_CLAUDE_PROOF_FAILED");process.exitCode=1;});
