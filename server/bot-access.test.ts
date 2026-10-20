import { mkdirSync,readFileSync } from "node:fs";
import { beforeEach,expect,it,vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { accessOwnerView,assertConnectedAppCall,assertStoredConnectedAppAccess,requestBotAccess,reviewBotAccess,restrictedConnectorTools,connectedAppsListScope } from "./bot-access.ts";
import { botAccessPolicy } from "./bot-access-role.ts";
import { permissionStatus } from "./permission-status.ts";
import { ACCESS_REQUEST_TTL_MS, accessRequestExpiresAt } from "../shared/bot-access.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
const account={toolkit:"gmail",accountId:"ca_fixture_owned"};
const grant={...account,tools:["GMAIL_SEND_EMAIL","GMAIL_FETCH_EMAILS"]};
function setup(){const store=new Store(()=>({instanceId:"fixture",model:"fixture"}));const chief=store.createBot({name:"Chief",section:"Leadership"});const lead=store.createBot({name:"Lead",section:"Studio"});const bot=store.createBot({name:"Specialist",section:"Studio"});const other=store.createBot({name:"Other",section:"Elsewhere"});store.setChiefOfStaff(chief.id,undefined,"workspace");store.setChiefOfStaff(lead.id,undefined,"section");store.patchBot(bot.id,{composio:false});return{store,chief,lead,bot,other};}
function call(tool="GMAIL_SEND_EMAIL",selected="ca_fixture_owned",args:object={to:"fake@example.invalid",body:"fixture"}){return{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"COMPOSIO_MULTI_EXECUTE_TOOL",arguments:{tools:[{tool_slug:tool,account:selected,arguments:args}],sync_response_to_workbench:false}}};}
function enable(f:ReturnType<typeof setup>,writes=true){const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:botAccessPolicy(f.bot).revision,grants:[grant],allowWrites:writes});return reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account]);}
it("queues a durable bundle without self-granting or enabling apps",()=>{const f=setup();const response=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant],allowWrites:true});expect(response.status).toBe("Waiting for owner review");expect(f.bot.composio).toBe(false);expect(()=>assertConnectedAppCall(f.bot,call())).toThrow("disabled");const restored=new Store(()=>f.bot.modelSelection);expect(botAccessPolicy(restored.bot(f.bot.id)!).requests).toHaveLength(1);});
it("rejects spoofed grants and cross-team manager requests",()=>{const f=setup();expect(()=>requestBotAccess(f.store,f.bot,{botId:f.bot.id,revision:0,grants:[grant]})).toThrow("responsible manager");expect(()=>requestBotAccess(f.store,f.lead,{botId:f.other.id,revision:0,grants:[grant]})).toThrow("responsible manager");expect(()=>requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant],approve:true})).toThrow("Invalid");});
it("rejects stale owner decisions and non-owned accounts",()=>{const f=setup();const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant]});expect(()=>reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:request.requestId,revision:0},[account])).toThrow("changed");expect(()=>reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[])).toThrow("no longer connected");expect(f.bot.composio).toBe(false);});
it("allows an explicitly owner-approved fake write only after the policy gate",async()=>{const f=setup();enable(f);const relay=vi.fn(async(_request:unknown)=>({ok:true}));assertConnectedAppCall(f.bot,call());await relay(call());expect(relay).toHaveBeenCalledOnce();expect(f.bot.composio).toBe(true);expect(botAccessPolicy(f.bot).mode).toBe("restricted");});
it("applies write restrictions even with autoapproval enabled",()=>{const f=setup();enable(f,false);f.store.patchBot(f.bot.id,{autoApprove:true,alwaysAllow:["COMPOSIO_MULTI_EXECUTE_TOOL"]});expect(()=>assertConnectedAppCall(f.bot,call())).toThrow("blocked connected-app writes");expect(()=>assertConnectedAppCall(f.bot,call("GMAIL_FETCH_EMAILS","ca_fixture_owned",{user_id:"me"}))).not.toThrow();});
it("rejects another account, missing account, alias and credential overrides",()=>{const f=setup();enable(f);for(const id of ["ca_other","Work",""])expect(()=>assertConnectedAppCall(f.bot,call("GMAIL_SEND_EMAIL",id))).toThrow("not been approved");expect(()=>assertConnectedAppCall(f.bot,call("GMAIL_FETCH_EMAILS","ca_fixture_owned",{user_id:"other@example.invalid"}))).toThrow("override");expect(()=>assertConnectedAppCall(f.bot,call("GMAIL_SEND_EMAIL","ca_fixture_owned",{nested:{custom_auth_params:{key:"fake"}}}))).toThrow("override");});
it("fails closed for unknown and dynamic execution, batch smuggling and workbench",()=>{const f=setup();enable(f);expect(()=>assertConnectedAppCall(f.bot,call("GMAIL_UNKNOWN"))).toThrow("not supported");for(const name of ["COMPOSIO_REMOTE_WORKBENCH","COMPOSIO_SEARCH_TOOLS","COMPOSIO_PROXY_EXECUTE"])expect(()=>assertConnectedAppCall(f.bot,{method:"tools/call",params:{name,arguments:{}}})).toThrow("Dynamic");expect(()=>assertConnectedAppCall(f.bot,[call()])).toThrow("one explicit");const batch=call();batch.params.arguments.tools.push({tool_slug:"GMAIL_SEND_EMAIL",account:"ca_other",arguments:{}} as any);expect(()=>assertConnectedAppCall(f.bot,batch)).toThrow("not been approved");const offload=call();offload.params.arguments.sync_response_to_workbench=true;expect(()=>assertConnectedAppCall(f.bot,offload)).toThrow("Workbench");});
it("revokes grants durably on role change even when the original role returns",()=>{const f=setup();enable(f);f.store.patchBot(f.bot.id,{title:"Different role"});f.store.patchBot(f.bot.id,{title:""});expect(botAccessPolicy(f.bot).grants).toEqual([]);const restored=new Store(()=>f.bot.modelSelection);expect(()=>assertConnectedAppCall(restored.bot(f.bot.id)!,call())).toThrow("blocked connected-app writes");});
it("revokes grants on team moves and disabling apps",()=>{const f=setup();enable(f);f.store.setBotsSection([f.bot.id],"Other");f.store.setBotsSection([f.bot.id],"Studio");expect(botAccessPolicy(f.bot).grants).toEqual([]);enable(f);f.store.patchBot(f.bot.id,{composio:false});f.store.patchBot(f.bot.id,{composio:true});expect(()=>assertConnectedAppCall(f.bot,call())).toThrow("blocked connected-app writes");});
it("rejects pending approvals after manager role changes",()=>{const f=setup();const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant]});f.store.setChiefOfStaff(null,"Studio");expect(()=>reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account])).toThrow("stale");expect(permissionStatus(f.store,f.chief,f.bot.id,[]).pending[0]?.blockedReason).toBe("Access request is stale");});
it("owner revocation changes revision and immediately fences the next dispatch",()=>{const f=setup();enable(f);const before=accessOwnerView(f.bot);reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:before.policy.revision,mode:"restricted",allowWrites:false,grants:[]},[]);expect(()=>assertConnectedAppCall(f.bot,call())).toThrow("blocked connected-app writes");expect(()=>reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:before.policy.revision,mode:"unrestricted",allowWrites:true,grants:[]},[])).toThrow("changed");});
it("manager status strips commands, secrets, IDs and approval rights",()=>{const f=setup();const pending=[{kind:"tool" as const,createdAt:1000,command:"SECRET COMMAND",requestId:"SECRET_ID",token:"SECRET_TOKEN"}];const result=permissionStatus(f.store,f.lead,f.bot.id,pending,61000);expect(result.pending).toEqual([{kind:"tool",ageSeconds:60,blockedReason:"Waiting for owner review"}]);expect(result.canApprove).toBe(false);expect(JSON.stringify(result)).not.toContain("SECRET");expect(()=>permissionStatus(f.store,f.lead,f.other.id,pending)).toThrow("not visible");});
it("preserves unconfigured existing access and fails closed on corrupted policy",()=>{const f=setup();expect(()=>assertConnectedAppCall(f.other,{method:"arbitrary-legacy-method"})).not.toThrow();f.other.connectedAppAccess={invalid:true} as any;expect(()=>assertConnectedAppCall(f.other,call())).toThrow("blocked connected-app writes");});
it("restricted tool listing exposes only approved concrete accounts and actions",()=>{const f=setup();enable(f,false);const result=restrictedConnectorTools(f.bot,7)!;expect(result.id).toBe(7);const schema=JSON.stringify(result);expect(schema).toContain("ca_fixture_owned");expect(schema).not.toContain("COMPOSIO_SEARCH_TOOLS");expect(result.result.tools[0]?.inputSchema.properties.tools.items.properties.tool_slug.enum).toEqual(["GMAIL_FETCH_EMAILS"]);});

it("does not revive a queued request when its manager returns to the old role",()=>{const f=setup();const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant]});f.store.setChiefOfStaff(null,"Studio");f.store.setChiefOfStaff(f.lead.id,undefined,"section");expect(()=>reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account])).toThrow("stale");const restored=new Store(()=>f.bot.modelSelection);expect(()=>reviewBotAccess(restored,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account])).toThrow("stale");});

it("binds a server-chosen expiry and allows owner review only before its deadline",()=>{
 const f=setup(),now=1_700_000_000_000;
 const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant],allowWrites:true},now);
 expect(request.expiresAt).toBe(now+ACCESS_REQUEST_TTL_MS);
 expect(botAccessPolicy(f.bot).requests[0]?.expiresAt).toBe(request.expiresAt);
 reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account],request.expiresAt-1);
 expect(()=>assertConnectedAppCall(f.bot,call())).not.toThrow();
});
it("rejects expired requests after restart and reports only redacted expiry status",()=>{
 const f=setup(),now=1_700_000_000_000;
 const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant],allowWrites:true},now);
 const restored=new Store(()=>f.bot.modelSelection);
 expect(()=>reviewBotAccess(restored,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account],request.expiresAt)).toThrow("expired");
 expect(restored.bot(f.bot.id)?.composio).toBe(false);
 const status=permissionStatus(restored,restored.bot(f.chief.id)!,f.bot.id,[],request.expiresAt);
 expect(status.pending).toEqual([{kind:"access",ageSeconds:ACCESS_REQUEST_TTL_MS/1000,blockedReason:"Access request expired"}]);
 expect(status.canApprove).toBe(false);
 expect(JSON.stringify(status)).not.toContain(account.accountId);
});
it("bounds legacy request expiry and rejects attempts to supply a longer review window",()=>{
 const f=setup(),now=1_700_000_000_000;
 expect(()=>requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant],expiresAt:now+2*ACCESS_REQUEST_TTL_MS},now)).toThrow("Invalid");
 const request=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:0,grants:[grant]},now);
 const policy=botAccessPolicy(f.bot);delete policy.requests[0]!.expiresAt;
 f.store.patchBot(f.bot.id,{connectedAppAccess:policy});
 const restored=new Store(()=>f.bot.modelSelection);
 expect(()=>reviewBotAccess(restored,f.bot.id,{action:"approve",requestId:request.requestId,revision:request.revision},[account],now+ACCESS_REQUEST_TTL_MS)).toThrow("expired");
 expect(accessRequestExpiresAt({createdAt:now,expiresAt:now+2*ACCESS_REQUEST_TTL_MS})).toBe(now+ACCESS_REQUEST_TTL_MS);
});
it("the list revision also moves when connected accounts were removed (disconnect or sign-out)",()=>{
 const f=setup();
 enable(f,false);
 const before=connectedAppsListScope(f.bot,0);
 expect(connectedAppsListScope(f.bot,0).revision).toBe(before.revision);
 expect(connectedAppsListScope(f.bot,1).revision).not.toBe(before.revision);
});
it("a restricted bot's description repeats no tool, so a policy listing the same tool many times stays small",()=>{
 const f=setup();
 enable(f,false);
 const policy=botAccessPolicy(f.bot);
 const one=policy.grants[0]!;
 const grants=Array.from({length:30},()=>({...one,tools:Array.from({length:30},()=>"GMAIL_FETCH_EMAILS")}));
 f.bot.connectedAppAccess={...policy,grants};
 const raw=JSON.stringify(botAccessPolicy(f.bot).grants).length;
 const listed=connectedAppsListScope(f.bot).initialTools as {description:string}[];
 expect(listed[0]!.description.length).toBeLessThan(raw/3);
 expect(listed[0]!.description).toContain("ca_fixture_owned");
});
it("replaces expired queue entries without reviving them or consuming the request limit",()=>{
 const f=setup(),now=1_700_000_000_000;let first="";
 for(let index=0;index<12;index++){const queued=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:botAccessPolicy(f.bot).revision,grants:[grant]},now);if(!index)first=queued.requestId;}
 const fresh=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:botAccessPolicy(f.bot).revision,grants:[grant]},now+ACCESS_REQUEST_TTL_MS);
 expect(botAccessPolicy(f.bot).requests.map(item=>item.id)).toEqual([fresh.requestId]);
 expect(()=>reviewBotAccess(f.store,f.bot.id,{action:"approve",requestId:first,revision:fresh.revision},[account],now+ACCESS_REQUEST_TTL_MS)).toThrow("no longer pending");
});

it("a stored connected-app result is handed back only while the bot's CURRENT grants still cover what the action used",()=>{
 const f=setup();enable(f);
 const used=[{tool:"GMAIL_SEND_EMAIL",account:"ca_fixture_owned"}];
 expect(()=>assertStoredConnectedAppAccess(f.bot,{requirements:used,complete:true})).not.toThrow();
 const before=accessOwnerView(f.bot);
 reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:before.policy.revision,mode:"restricted",allowWrites:true,grants:[{toolkit:"gmail",accountId:"ca_fixture_owned",tools:["GMAIL_FETCH_EMAILS"]}]},[account]);
 expect(()=>assertStoredConnectedAppAccess(f.bot,{requirements:used,complete:true})).toThrow("not been approved");
 expect(()=>assertStoredConnectedAppAccess(f.bot,{requirements:[{tool:"GMAIL_FETCH_EMAILS",account:"ca_fixture_owned"}],complete:true})).not.toThrow();
 f.store.patchBot(f.bot.id,{composio:false});
 expect(()=>assertStoredConnectedAppAccess(f.bot,{requirements:[{tool:"GMAIL_FETCH_EMAILS",account:"ca_fixture_owned"}],complete:true})).toThrow("disabled");
});
it("a restricted bot is denied a stored result whose tools or accounts are unknown",()=>{
 const f=setup();enable(f);
 // unrestricted bots are unaffected
 f.store.patchBot(f.bot.id,{connectedAppAccess:{...botAccessPolicy(f.bot),mode:"unrestricted"}});
 expect(()=>assertStoredConnectedAppAccess(f.bot,{requirements:[],complete:false})).not.toThrow();
 const f2=setup();enable(f2);
 // no recognised tool slug: empty requirements
 expect(()=>assertStoredConnectedAppAccess(f2.bot,{requirements:[],complete:false})).toThrow("cannot be matched");
 expect(()=>assertStoredConnectedAppAccess(f2.bot,{requirements:[],complete:true})).toThrow("cannot be matched");
 // a requirement list that is only part of what ran
 expect(()=>assertStoredConnectedAppAccess(f2.bot,{requirements:[{tool:"GMAIL_FETCH_EMAILS",account:"ca_fixture_owned"}],complete:false})).toThrow("cannot be matched");
 // a tool outside the reviewed catalog
 expect(()=>assertStoredConnectedAppAccess(f2.bot,{requirements:[{tool:"ACME_DO_THING",account:"ca_fixture_owned"}],complete:true})).toThrow("not supported");
 // a known tool with no account recorded
 expect(()=>assertStoredConnectedAppAccess(f2.bot,{requirements:[{tool:"GMAIL_FETCH_EMAILS"}],complete:true})).toThrow("not been approved");
});
it("a migrated legacy journal row is incomplete, so a restricted CHECK / run_again is denied",async()=>{
 const {mkdtempSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const {DatabaseSync}=await import("node:sqlite");
 const {SqliteOperationJournal}=await import("./connected-app-journal.ts");const {ConnectedAppOperations}=await import("./connected-app-operations.ts");
 const dir=mkdtempSync(join(tmpdir(),"legacy-"));
 let journal:InstanceType<typeof SqliteOperationJournal>|undefined;
 try{
  const file=join(dir,"ledger.db");const old=new DatabaseSync(file);
  old.exec("CREATE TABLE connected_app_ops (handle TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, label TEXT, started_at INTEGER NOT NULL, state TEXT NOT NULL, cause TEXT, delivered_at INTEGER, requirements TEXT NOT NULL)");
  old.prepare("INSERT INTO connected_app_ops VALUES ('h-old','s','k',NULL,1,'unknown','no-answer',NULL,?)").run(JSON.stringify([{tool:"GMAIL_SEND_EMAIL",account:"ca_fixture_owned"}]));
  old.close();
  const op=new ConnectedAppOperations(Date.now,journal=new SqliteOperationJournal(file)).byHandle("s","h-old")!;
  expect(op.requirementsComplete).toBe(false);
  const f=setup();enable(f);
  expect(()=>assertStoredConnectedAppAccess(f.bot,{requirements:op.requirements,complete:op.requirementsComplete})).toThrow("cannot be matched");
 }finally{journal?.close();removeTempDirSync(dir);}
});
it("the bridge's list scope: a restricted bot's initial list holds only approved accounts, and the revision moves with access",()=>{
 const f=setup();
 const open=connectedAppsListScope(f.bot);
 expect(open.initialTools).toBeUndefined();
 enable(f,false);
 const restricted=connectedAppsListScope(f.bot);
 expect(restricted.revision).not.toBe(open.revision);
 expect(JSON.stringify(restricted.initialTools)).toContain("ca_fixture_owned");
 expect(JSON.stringify(restricted.initialTools)).not.toContain("COMPOSIO_SEARCH_TOOLS");
 expect(connectedAppsListScope(f.bot).revision).toBe(restricted.revision);
 reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:botAccessPolicy(f.bot).revision,mode:"restricted",allowWrites:false,grants:[]},[]);
 const revoked=connectedAppsListScope(f.bot);
 expect(revoked.revision).not.toBe(restricted.revision);
 expect(JSON.stringify(revoked.initialTools)).not.toContain("ca_fixture_owned");
});
it("the list revision follows EFFECTIVE access only: requests, denials, unchanged saves and grant ordering never move it",()=>{
 const f=setup();
 enable(f,false);
 const base=connectedAppsListScope(f.bot,3).revision;
 // A new request (revision counter moves, pending list changes): same effective access.
 const q=requestBotAccess(f.store,f.lead,{botId:f.bot.id,revision:botAccessPolicy(f.bot).revision,grants:[{...grant,tools:["GMAIL_SEND_EMAIL"]}],allowWrites:true});
 expect(botAccessPolicy(f.bot).requests.length).toBe(1);
 expect(connectedAppsListScope(f.bot,3).revision).toBe(base);
 // Denying it: same.
 reviewBotAccess(f.store,f.bot.id,{action:"deny",requestId:q.requestId,revision:q.revision},[account]);
 expect(connectedAppsListScope(f.bot,3).revision).toBe(base);
 // Saving exactly what is already configured (counter moves): same.
 const p=botAccessPolicy(f.bot);
 reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:p.revision,mode:"restricted",allowWrites:p.allowWrites,grants:p.grants},[account]);
 expect(connectedAppsListScope(f.bot,3).revision).toBe(base);
 // Tool order and duplicates carry no meaning.
 reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:botAccessPolicy(f.bot).revision,mode:"restricted",allowWrites:false,grants:[{...grant,tools:[...grant.tools].reverse().concat(grant.tools[0]!)}]},[account]);
 expect(connectedAppsListScope(f.bot,3).revision).toBe(base);
 // A real change in effective access moves it.
 reviewBotAccess(f.store,f.bot.id,{action:"configure",revision:botAccessPolicy(f.bot).revision,mode:"restricted",allowWrites:true,grants:[grant]},[account]);
 expect(connectedAppsListScope(f.bot,3).revision).not.toBe(base);
});

// Generated by RMCP 3.2.0 call_tool against an offline duplex peer, not by
// hand-adding metadata to a model-visible tool input. Only synthetic account IDs.
function rmcpRequest() {
 return JSON.parse(readFileSync(new URL("./testing/fixtures/rmcp-3.2.0-tools-call.json",import.meta.url),"utf8"));
}
it("accepts the actual RMCP progress envelope for an owner-approved read without changing it",()=>{
 const f=setup();enable(f,false);const request=rmcpRequest();const before=JSON.stringify(request);
 expect(request.params._meta).toEqual({progressToken:0});
 expect(()=>assertConnectedAppCall(f.bot,request)).not.toThrow();
 expect(JSON.stringify(request)).toBe(before);
 expect(botAccessPolicy(f.bot).allowWrites).toBe(false);
});
it.each([{}, {progressToken:0}, {progressToken:-1}, {progressToken:"read-1"}, {progressToken:""}])("accepts protocol progress metadata %j",meta=>{
 const f=setup();enable(f,false);const request=rmcpRequest();request.params._meta=meta;
 expect(()=>assertConnectedAppCall(f.bot,request)).not.toThrow();
});
it.each([null,[],"progress",true,{progressToken:null},{progressToken:true},{progressToken:[]},{progressToken:{}},{progressToken:1.5},{progressToken:Infinity},{progressToken:Number.MAX_SAFE_INTEGER+1},{progressToken:0,account:"ca_other"},{authorization:"Bearer fixture"},{progressToken:0,allowWrites:true},{progressToken:0,extra:{}}])("rejects malformed or unreviewed protocol metadata %j",meta=>{
 const f=setup();enable(f,false);const request=rmcpRequest();request.params._meta=meta;
 expect(()=>assertConnectedAppCall(f.bot,request)).toThrow("Unsupported connected-app request fields");
});
it("does not let valid RMCP metadata change account, tool or write authorization",()=>{
 const f=setup();enable(f,false);
 for(const accountId of ["ca_other","Work",""]){const request=rmcpRequest();request.params.arguments.tools[0].account=accountId;expect(()=>assertConnectedAppCall(f.bot,request)).toThrow("not been approved");}
 const missing=rmcpRequest();delete missing.params.arguments.tools[0].account;
 expect(()=>assertConnectedAppCall(f.bot,missing)).toThrow("exact connected-account ID");
 const write=rmcpRequest();write.params.arguments.tools[0].tool_slug="GMAIL_SEND_EMAIL";
 expect(()=>assertConnectedAppCall(f.bot,write)).toThrow("blocked connected-app writes");
 const ungranted=rmcpRequest();ungranted.params.arguments.tools[0].tool_slug="GMAIL_GET_PROFILE";
 expect(()=>assertConnectedAppCall(f.bot,ungranted)).toThrow("not been approved");
 const unknown=rmcpRequest();unknown.params.arguments.tools[0].tool_slug="GMAIL_UNKNOWN";
 expect(()=>assertConnectedAppCall(f.bot,unknown)).toThrow("not supported");
 const batch=rmcpRequest();batch.params.arguments.tools.push({...batch.params.arguments.tools[0],account:"ca_other"});
 expect(()=>assertConnectedAppCall(f.bot,batch)).toThrow("not been approved");
 for(const name of ["COMPOSIO_REMOTE_WORKBENCH","COMPOSIO_SEARCH_TOOLS","COMPOSIO_PROXY_EXECUTE"]){const request=rmcpRequest();request.params.name=name;expect(()=>assertConnectedAppCall(f.bot,request)).toThrow("Dynamic");}
});
it.each(["account","account_id","connected_account_id","connectedAccountId","custom_auth_params","customAuthParams","auth_config_id","authentication","authorization","api_key"])("rejects nested %s auth overrides even with valid progress metadata",key=>{
 const f=setup();enable(f,false);const request=rmcpRequest();request.params.arguments.tools[0].arguments={nested:[{[key]:"fixture-override"}]};
 expect(()=>assertConnectedAppCall(f.bot,request)).toThrow("override the approved connected account");
});
it("keeps unknown execution fields, offload and disabled-app checks with metadata",()=>{
 const f=setup();enable(f,false);
 const user=rmcpRequest();user.params.arguments.tools[0].arguments.user_id="other@example.invalid";
 expect(()=>assertConnectedAppCall(f.bot,user)).toThrow("override");
 const params=rmcpRequest();params.params.account="ca_other";
 expect(()=>assertConnectedAppCall(f.bot,params)).toThrow("Unsupported connected-app request fields");
 const execution=rmcpRequest();execution.params.arguments.allowWrites=true;
 expect(()=>assertConnectedAppCall(f.bot,execution)).toThrow("Unsupported connected-app execution fields");
 const item=rmcpRequest();item.params.arguments.tools[0].authorization="fixture-override";
 expect(()=>assertConnectedAppCall(f.bot,item)).toThrow("Unsupported connected-app tool fields");
 const offload=rmcpRequest();offload.params.arguments.sync_response_to_workbench=true;
 expect(()=>assertConnectedAppCall(f.bot,offload)).toThrow("Workbench");
 f.store.patchBot(f.bot.id,{composio:false});
 expect(()=>assertConnectedAppCall(f.bot,rmcpRequest())).toThrow("disabled");
});

it("validates metadata before the existing stored-action status path",()=>{
 const f=setup();enable(f,false);const request=rmcpRequest();
 request.params.name="CHECK_CONNECTED_APP_ACTION";request.params.arguments={handle:"fixture-handle"};
 expect(()=>assertConnectedAppCall(f.bot,request)).not.toThrow();
 request.params._meta={progressToken:0,account:"ca_other"};
 expect(()=>assertConnectedAppCall(f.bot,request)).toThrow("Unsupported connected-app request fields");
 request.params._meta={progressToken:0};request.params.account="ca_other";
 expect(()=>assertConnectedAppCall(f.bot,request)).toThrow("Unsupported connected-app request fields");
});
it("rejects metadata on other methods, a write tool and a foreign account with a valid progressToken",()=>{
 const f=setup();enable(f,false);
 for(const method of ["tools/list","ping","initialize"]){expect(()=>assertConnectedAppCall(f.bot,{jsonrpc:"2.0",id:1,method,params:{_meta:{progressToken:0}}})).not.toThrow();}
 const other=rmcpRequest();other.method="resources/read";expect(()=>assertConnectedAppCall(f.bot,other)).toThrow("not allowed");
 const write=rmcpRequest();write.params.arguments.tools[0].tool_slug="GMAIL_SEND_EMAIL";expect(()=>assertConnectedAppCall(f.bot,write)).toThrow("blocked connected-app writes");
 const foreign=rmcpRequest();foreign.params.arguments.tools[0].account="ca_other";expect(()=>assertConnectedAppCall(f.bot,foreign)).toThrow("not been approved");
 const long=rmcpRequest();long.params._meta={progressToken:"x".repeat(257)};expect(()=>assertConnectedAppCall(f.bot,long)).toThrow("Unsupported connected-app request fields");
 const nested=rmcpRequest();nested.params._meta={progressToken:0,_meta:{progressToken:1}};expect(()=>assertConnectedAppCall(f.bot,nested)).toThrow("Unsupported connected-app request fields");
 const batch=[rmcpRequest()];expect(()=>assertConnectedAppCall(f.bot,batch)).toThrow();
});
