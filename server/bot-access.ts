import type { AppAccessDenial } from "./decision/index.ts";
import { forbiddenAuthArguments } from "../shared/connected-app-aliases.ts";
import { ProducerApprovalQueue, producerBase, type ServiceAuthority } from "./narrow-denials.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ACCESS_REQUEST_TTL_MS, accessRequestExpired, CONNECTED_APP_TOOLS, accessGrantSchema, connectedAppAccessSchema, type AccessGrant } from "../shared/bot-access.ts";
import { connectedAppToolId, isConnectedAppStatusTool } from "../shared/connected-app-calls.ts";
import { classifyConnectedAppCall } from "../shared/connected-app-readonly.ts";
import { accessRoleBinding, botAccessPolicy as baseBotAccessPolicy } from "./bot-access-role.ts";
import { explicitPermission, inheritedPermissions, type PermissionSetting } from "./permission-inheritance.ts";
import { isWorkspaceChief, sectionKey, type BotRecord, type Store } from "./store.ts";
import { admission, admittedKnownSlugs, appAccessFor, assertLevelsCall, assertLevelsStored, commitAccess, fullyOpen, levelsOf } from "./bot-access-levels.ts";
import type { InventoryServices } from "./connected-inventory.ts";
/** Refusals outlive role-binding changes; only a matching later owner grant
 * clears them. The existing role checker still determines all positive grants. */
export function readAppAccessDenials(bot:BotRecord) {
 const parsed=connectedAppAccessSchema.safeParse(bot.connectedAppAccess);
 return parsed.success?parsed.data.denials:[];
}
function botAccessPolicy(bot:BotRecord){return {...baseBotAccessPolicy(bot),denials:readAppAccessDenials(bot)};}
function clearGrantedDenials(denials:ReturnType<typeof readAppAccessDenials>,grants:readonly AccessGrant[],allowWrites:boolean){
 return denials.filter(denial=>!grants.some(grant=>grant.toolkit===denial.toolkit&&(!denial.accountId||grant.accountId===denial.accountId)&&denial.tools.length>0&&denial.tools.every(tool=>grant.tools.includes(tool)&&(!denial.ops.includes('write')||allowWrites))));
}
function fail(message:string,status=403):never {throw Object.assign(new Error(message),{status});}
const rev=z.number().int().nonnegative();
const grants=z.array(accessGrantSchema).max(30);
const ownerAction=z.discriminatedUnion("action",[
 z.object({action:z.literal("configure"),revision:rev,mode:z.enum(["unrestricted","restricted"]),allowWrites:z.boolean(),grants}).strict(),
 z.object({action:z.enum(["approve","deny"]),revision:rev,requestId:z.string()}).strict(),
 // 1.0.23 D25-V3: the owner gives this bot its creator's connected apps as the preview showed them. Nothing else rides in the body.
 z.object({action:z.literal("copy-from-creator"),revision:rev,sourceDigest:z.string().min(1).max(128)}).strict(),
]);
const managerRequest=z.object({botId:z.string(),revision:rev,grants:grants.min(1).max(12),allowWrites:z.boolean().default(false)}).strict();
export function mayReviewAccessStatus(sender:BotRecord,target:BotRecord):boolean {
 return !sender.hidden && !sender.staged && !target.staged && (sender.id===target.id || isWorkspaceChief(sender) || sender.chiefOfStaff===true && sectionKey(sender.section)===sectionKey(target.section));
}
function validateTools(values:AccessGrant[]) {
 for(const grant of values) for(const tool of grant.tools) {
  if(!CONNECTED_APP_TOOLS.some(known=>known.tool===tool&&known.toolkit===grant.toolkit))fail("This tool is not supported by restricted connected-app access.",400);
 }
}
/** D25-V3: the bot, or any of its chats, is on No limits (recorded or inherited). The relay skips the policy per turn (index.ts serviceNoLimits), so a copied list
 * is not what such a bot can reach; the preview and the digest both say so. */
function childOnNoLimits(bot:BotRecord){
 // The owner's No limits default is inherited by a record with no recorded level (inheritedPermissions), the same read the relay and chat projection use.
 const on=(level:PermissionSetting)=>{const eff=inheritedPermissions(level);return level.noLimits===true||eff.autoApprove===true&&eff.fullAccess===true&&eff.noLimits===true;};
 // A chat follows its bot's explicit level, as projectBotForTask does.
 return on(bot)||(bot.tasks??[]).some(task=>on({...task,draftOnly:bot.draftOnly,permissionExplicit:explicitPermission(task)||explicitPermission(bot)}));
}
/** Why this creator cannot share its apps right now; undefined = eligible. A corrupt or role-stale record reads as restricted-empty. */
function sourceRefusal(source:BotRecord|null|undefined):"unavailable"|"nothing"|undefined {
 if(!source||source.hidden||source.staged||source.composio===false||source.draftOnly)return "unavailable";
 const eff=botAccessPolicy(source);
 if(source.connectedAppAccess!==undefined&&eff.mode==="restricted"&&eff.grants.length===0)return "nothing";
 return undefined;
}
/** F2: everything the owner saw. The creator's role binding, its apps switch, its RETURNED effective policy (never the raw field), denials,
 * and the child's No limits level all change the digest; a plain rename changes no reach and is not in it. */
function sourceDigest(source:BotRecord,child:BotRecord){
 const eff=botAccessPolicy(source);
 return createHash("sha256").update(JSON.stringify([source.id,accessRoleBinding(source),source.composio!==false,eff.revision,eff.mode,eff.allowWrites,eff.grants,eff.denials??[],childOnNoLimits(child),child.draftOnly===true])).digest("hex");
}
/** The owner's offer: absent when this bot has no creator on record, the creator is gone, or this bot is hidden or staged. */
function copyFromView(store:Store,bot:BotRecord) {
 if(!bot.appsSourceBotId||bot.hidden||bot.staged)return undefined;
 const source=store.bot(bot.appsSourceBotId);if(!source)return undefined;
 const base={creatorId:source.id,creatorName:source.name,replaces:bot.composio!==false||bot.connectedAppAccess!==undefined};
 const refusal=sourceRefusal(source);
 if(refusal)return {...base,available:false as const,reason:refusal};
 const eff=botAccessPolicy(source);
 return {...base,available:true as const,sourceDigest:sourceDigest(source,bot),
  unrestricted:eff.mode==="unrestricted",allowWrites:eff.mode==="unrestricted"?true:eff.allowWrites,grants:eff.mode==="unrestricted"?[]:structuredClone(eff.grants),
  noLimits:childOnNoLimits(bot),draftOnly:bot.draftOnly===true};
}
export function accessOwnerView(store:Store,bot:BotRecord) {
 const copyFrom=copyFromView(store,bot);
 return {enabled:bot.composio!==false,policy:botAccessPolicy(bot),catalog:CONNECTED_APP_TOOLS,...(copyFrom?{copyFrom}:{})};
}
/** A denial's content, without its id, time or revision: the same refusal copied twice is one refusal. */
const denialKey=(denial:{toolkit:string;accountId?:string;tools:string[];ops:string[];source:string})=>JSON.stringify([denial.toolkit,denial.accountId??"",[...denial.tools].sort(),[...denial.ops].sort(),denial.source]);
/** Agent identity comes from the server turn claim. This only queues owner review. */
export function requestBotAccess(store:Store,sender:BotRecord,input:unknown,now=Date.now(),execution?:{authority?:ServiceAuthority;threadId:string;accounts:ReadonlyArray<{toolkit:string;accountId:string}>}) {
 const parsed=managerRequest.safeParse(input);if(!parsed.success)fail("Invalid connected-app access request.",400);
 const request=parsed.data!;const target=store.bot(request.botId);
 if(!target||!sender.chiefOfStaff||!mayReviewAccessStatus(sender,target))fail("Only the responsible manager can request this bot’s access.");
 const policy=botAccessPolicy(target!);if(policy.revision!==request.revision)fail("Access changed. Read the current status and request again.",409);
 validateTools(request.grants);
 const liveRequests=policy.requests.filter(item=>!accessRequestExpired(item,now));
 if(liveRequests.length>=12)fail("Review existing access requests before adding another.",409);
 const pending={id:randomUUID(),requestedBy:sender.id,requesterBinding:accessRoleBinding(sender),targetBinding:accessRoleBinding(target!),createdAt:now,expiresAt:now+ACCESS_REQUEST_TTL_MS,grants:request.grants,allowWrites:request.allowWrites};
 const approvals=botAccessApprovalQueue(store);
 const opened=approvals.open({authority:execution?.authority,ref:pending.id,tool:'request_bot_access',input:{...request,requestedBy:sender.id,requesterBinding:pending.requesterBinding,targetBinding:pending.targetBinding,proposal:pending},
  action:{requestId:pending.id,tool:'request_bot_access',options:['Allow','Deny']},view:{title:'Connected-app access',subtitle:target!.name},base:producerBase(true)});
 const result=approvals.executeNow(opened,(call)=>{
  if(!execution)fail('Connected account inventory is unavailable.',409);
  const frozen=call.input as typeof request;
  for(const grant of frozen.grants)if(!execution!.accounts.some(account=>account.toolkit===grant.toolkit&&account.accountId===grant.accountId))fail('A selected account is no longer connected.',409);
  const current=botAccessPolicy(target!);
  if(current.revision!==frozen.revision)fail('Access changed. Read the current status and request again.',409);
  const next={...current,revision:current.revision+1,mode:'restricted' as const,allowWrites:frozen.allowWrites,grants:frozen.grants,denials:clearGrantedDenials(current.denials,frozen.grants,frozen.allowWrites),requests:[]};
  next.roleBinding=accessRoleBinding({...target!,composio:true,accessRoleEpoch:(target!.accessRoleEpoch??0)+(target!.composio===false?1:0)});
  commitAccess(store,target!,next,null,{requestId:pending.id,behavior:'allow',revision:next.revision},{composio:true});return next.revision;
 });
 if(result.kind==='executed')return {requestId:'',expiresAt:now,status:'Applied',revision:result.value};
 if(result.kind==='refuse')fail(result.message,409);
 approvals.stage(opened,result.ref);
 // Both the durable source call and the original proposal retain exact ids.
 commitAccess(store,target!,{...policy,revision:policy.revision+1,requests:[...liveRequests,pending]},"carry");
 approvals.presentNow(opened,result.ref);
 return {requestId:pending.id,expiresAt:pending.expiresAt,status:'Waiting for owner review',revision:botAccessPolicy(target!).revision};
}
const accessQueues=new WeakMap<Store,ProducerApprovalQueue>();
type AccessAccounts = ReadonlyArray<{toolkit:string;accountId:string}>;
type AccessAccountsReader = ()=>AccessAccounts|Promise<AccessAccounts>;
const accessAccounts=new WeakMap<Store,AccessAccountsReader>();
export function installBotAccessApprovalAccounts(store:Store,reader:AccessAccountsReader):()=>void {
 const previous=accessAccounts.get(store);
 accessAccounts.set(store,reader);return ()=>{if(accessAccounts.get(store)===reader){if(previous)accessAccounts.set(store,previous);else accessAccounts.delete(store);}};
}
export function botAccessApprovalQueue(store:Store):ProducerApprovalQueue {
 let queue=accessQueues.get(store);if(queue)return queue;
 const apply=(item:import('./decision/index.ts').PendingQueueApproval,answer:import('./decision/index.ts').ApprovalAnswer,accounts:AccessAccounts|undefined)=>{
  const call=item.call.input as {botId:string;revision:number;requestedBy:string;requesterBinding:string;targetBinding:string;grants:AccessGrant[];allowWrites:boolean;proposal?:ReturnType<typeof botAccessPolicy>["requests"][number]};
  const target=store.bot(call.botId),sender=store.bot(call.requestedBy);
  if(!target||!sender||accessRoleBinding(target)!==call.targetBinding||accessRoleBinding(sender)!==call.requesterBinding)fail('This access request is stale because the bot or manager changed.',409);
  let policy=botAccessPolicy(target);
  // The fsynced queue is the proposal source across the queue-first crash gap.
  // Rebuild only at the original revision with the original ids and lifetime.
  if(!policy.requests.some(request=>request.id===item.ref)&&policy.revision===call.revision&&call.proposal?.id===item.ref){
   commitAccess(store,target,{...policy,revision:policy.revision+1,requests:[...policy.requests,call.proposal]},"carry");
   policy=botAccessPolicy(target);
  }
  const request=policy.requests.find(request=>request.id===item.ref);
  // The policy and its revision commit together. If the process lost the
  // queue acknowledgement after that commit, accept only this exact effect
  // at the expected revision; never patch or increment the policy twice.
  if(!request&&policy.revision===call.revision+2){
   const applied=answer.behavior==='allow'
    ? policy.mode==='restricted'&&policy.allowWrites===call.allowWrites&&JSON.stringify(policy.grants)===JSON.stringify(call.grants)
    : deniedGrants(call.grants,'request-denied',0,policy.revision,call.allowWrites).every(expected=>policy.denials.some(denial=>denial.source===expected.source&&denial.revision===expected.revision&&denial.toolkit===expected.toolkit&&denial.accountId===expected.accountId&&JSON.stringify(denial.tools)===JSON.stringify(expected.tools)&&JSON.stringify(denial.ops)===JSON.stringify(expected.ops)));
   if(applied)return;
  }
  if(!request||JSON.stringify(request.grants)!==JSON.stringify(call.grants)||request.allowWrites!==call.allowWrites)fail('This access request is no longer pending.',409);
  if(answer.behavior==='allow'&&!accounts)fail('Connected account inventory is unavailable.',409);
  applyBotAccessReview(store,target.id,{action:answer.behavior==='allow'?'approve':'deny',revision:policy.revision,requestId:item.ref},accounts??[]);

 };
 const accept=async(item:import('./decision/index.ts').PendingQueueApproval,answer:import('./decision/index.ts').ApprovalAnswer)=>{
  // Generic card answers and restart recovery fetch the current inventory.
  const accounts=answer.behavior==='allow'?await accessAccounts.get(store)?.():undefined;
  apply(item,answer,accounts);
 };
 const acceptNow=(item:import('./decision/index.ts').PendingQueueApproval,answer:import('./decision/index.ts').ApprovalAnswer)=>{
  const accounts=answer.behavior==='allow'?accessAccounts.get(store)?.():undefined;
  if(accounts&&'then' in accounts){void accounts.catch(()=>{});fail('Connected account inventory is unavailable.',409);}
  apply(item,answer,accounts);
 };
 queue=new ProducerApprovalQueue('bot-access',undefined,accept,acceptNow);
 accessQueues.set(store,queue);return queue;
}
export function pendingBotAccessApprovals(store:Store){return botAccessApprovalQueue(store).pendingApprovals();}
/** Only desktop owner routes may call this. Accounts must be current server inventory. */
export function reviewBotAccess(store:Store,botId:string,input:unknown,accounts:ReadonlyArray<{toolkit:string;accountId:string}>,now=Date.now()) {
 const action=ownerAction.safeParse(input);
 if(action.success&&(action.data.action==='approve'||action.data.action==='deny')){
  const requestId=action.data.requestId;
  const item=botAccessApprovalQueue(store).pendingApprovals().find(item=>item.ref===requestId);
  if(item){
   const policy=store.bot(botId);if(!policy||botAccessPolicy(policy).revision!==action.data.revision)fail('Access changed. Review the latest settings before saving.',409);
   if((item.call.input as {botId:string}).botId!==botId)fail('Bot not found.',404);
   // Validate the owner's current proposal before the delivery boundary turns
   // an executor error into a generic failed acknowledgement. Invalid reviews
   // leave the approval open and keep their actionable expiry/role/account error.
   prepareBotAccessReview(store,botId,input,accounts,now);
   // The PUT route already fetched fresh accounts. Scope that snapshot to this
   // synchronous answer so future generic answers keep their live reader.
   const restore=installBotAccessApprovalAccounts(store,()=>accounts);
   let delivered:import('./contracts.ts').RequestDelivery;
   try { delivered=botAccessApprovalQueue(store).answerNow(item.approvalId,{behavior:action.data.action==='approve'?'allow':'deny'}); }
   finally { restore(); }
   if(delivered.state==='failed')fail('This access request is no longer pending.',409);
   return accessOwnerView(store,store.bot(botId)!);
  }
 }
 return applyBotAccessReview(store,botId,input,accounts,now);
}
function prepareBotAccessReview(store:Store,botId:string,input:unknown,accounts:ReadonlyArray<{toolkit:string;accountId:string}>,now=Date.now()) {
 const parsed=ownerAction.safeParse(input);if(!parsed.success)fail("Invalid owner access decision.",400);
 const action=parsed.data!;const bot=store.bot(botId);if(!bot)fail("Bot not found.",404);
 const policy=botAccessPolicy(bot!);if(action.revision!==policy.revision)fail("Access changed. Review the latest settings before saving.",409);
 let next={...policy,revision:policy.revision+1};let enable=false;
 if(action.action==="configure") {
  const revoked=policy.grants.map(grant=>({...grant,tools:grant.tools.filter(tool=>{
   const known=CONNECTED_APP_TOOLS.find(entry=>entry.tool===tool&&entry.toolkit===grant.toolkit);
   return !action.grants.some(value=>value.toolkit===grant.toolkit&&value.accountId===grant.accountId&&value.tools.includes(tool)) || !!known?.writes&&policy.allowWrites&&!action.allowWrites;
  })})).filter(grant=>grant.tools.length);
  next={...next,mode:action.mode,allowWrites:action.allowWrites,grants:action.grants,requests:[],denials:[...(policy.denials??[]),...deniedGrants(revoked,"grant-revoked",now,next.revision,policy.allowWrites)]};
 }
 else if(action.action==="copy-from-creator") {
  if(bot!.hidden||bot!.staged)fail("This bot can't take connected apps right now.",409);
  const source=bot!.appsSourceBotId?store.bot(bot!.appsSourceBotId):undefined;
  const refusal=sourceRefusal(source);
  if(refusal==="unavailable")fail(`${source?.name??"The creator"} can't share apps right now (apps off, drafts only, hidden or removed).`,409);
  if(refusal==="nothing")fail(`${source!.name} has no connected apps to give.`,409);
  if(action.sourceDigest!==sourceDigest(source!,bot!))fail(`${source!.name}'s apps changed. Review the new list before giving them.`,409);
  // Only the creator's effective policy is copied, never a request field, and never its requests, revision or role binding.
  const eff=botAccessPolicy(source!);
  const own=policy.denials??[];const known=new Set(own.map(denialKey));
  const carried=(eff.denials??[]).filter(denial=>{const key=denialKey(denial);if(known.has(key))return false;known.add(key);return true;}).map(denial=>({...structuredClone(denial),id:randomUUID()}));
  next=eff.mode==="unrestricted"
   ?{...next,mode:"unrestricted",allowWrites:true,grants:[],requests:[],denials:[...own,...carried]}
   :{...next,mode:"restricted",allowWrites:eff.allowWrites,grants:structuredClone(eff.grants),requests:[],denials:[...own,...carried]};
  enable=true;
 }
 else {
  const request=policy.requests.find(item=>item.id===action.requestId);if(!request)fail("This access request is no longer pending.",409);
  if(action.action==="approve"){
   if(accessRequestExpired(request!,now))fail("This access request expired. Ask the manager to submit a fresh request.",409);
   const requester=store.bot(request!.requestedBy);
   if(!requester||!requester.chiefOfStaff||!mayReviewAccessStatus(requester,bot!)||accessRoleBinding(requester)!==request!.requesterBinding||accessRoleBinding(bot!)!==request!.targetBinding)fail("This access request is stale because the bot or manager changed.",409);
   next={...next,mode:"restricted",allowWrites:request!.allowWrites,grants:request!.grants,requests:[]};enable=true;
  }else {
   next.requests=next.requests.filter(item=>item.id!==action.requestId);
   next.denials=[...(policy.denials??[]),...deniedGrants(request!.grants,"request-denied",now,next.revision,request!.allowWrites)];
  }
 }
 if(action.action!=="deny") {
  validateTools(next.grants);
  next.denials=(next.denials??[]).filter(denial=>!next.grants.some(grant=>grant.toolkit===denial.toolkit&&(!denial.accountId||grant.accountId===denial.accountId)&&denial.tools.length>0&&denial.tools.every(tool=>grant.tools.includes(tool)&&(!denial.ops.includes("write")||next.allowWrites))));
 }
 // Never silently forget an explicit refusal to make room for a new one.
 if((next.denials?.length??0)>64)fail("Review existing connected-app refusals before adding more.",409);
 for(const grant of action.action==="deny"?[]:next.grants)if(!accounts.some(account=>account.toolkit===grant.toolkit&&account.accountId===grant.accountId))fail("A selected account is no longer connected. Refresh and review again.",409);
 next.roleBinding=accessRoleBinding({...bot!,...(enable?{composio:true,accessRoleEpoch:(bot!.accessRoleEpoch??0)+(bot!.composio===false?1:0)}:{})});
 return {bot:bot!,next,enable};
}
function applyBotAccessReview(store:Store,botId:string,input:unknown,accounts:ReadonlyArray<{toolkit:string;accountId:string}>,now=Date.now()) {
 const {bot,next,enable}=prepareBotAccessReview(store,botId,input,accounts,now);
 // configure, copy-from-creator and approve replace the bot's choices (levels off); deny keeps them (AG0 4.5).
 const action=ownerAction.parse(input);
 commitAccess(store,bot,next,action.action==="deny"?"carry":null,action.action==="configure"||action.action==="copy-from-creator"?undefined:{requestId:action.requestId,behavior:action.action==="approve"?"allow":"deny",revision:next.revision},enable?{composio:true}:{});
 return accessOwnerView(store,bot);
}
/** One denial per catalog operation and exact account. A write toggle never
 * turns a read refusal into a write refusal (r3.1 A6a). */
function deniedGrants(values: readonly AccessGrant[], source: AppAccessDenial["source"], at: number, revision: number, allowWrites: boolean): Array<{id:string;toolkit:string;accountId?:string;tools:string[];ops:("read"|"write")[];source:AppAccessDenial["source"];at:number;revision:number}> {
 return values.flatMap(grant=>grant.tools.flatMap(tool=>{
  const known=CONNECTED_APP_TOOLS.find(entry=>entry.tool===tool&&entry.toolkit===grant.toolkit);
  if(!known || known.writes&&!allowWrites)return [];
  return [{id:randomUUID(),toolkit:grant.toolkit,accountId:grant.accountId,tools:[tool],ops:[known.writes?"write" as const:"read" as const],source,at,revision}];
 }));
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
// RMCP adds protocol progress metadata outside tool arguments. It grants no
// authority: admit only the supported token shape, then check every app call.
const requestMeta=z.object({progressToken:z.union([z.string().max(256),z.number().int().safe()]).optional()}).strict();
/** Enforce synchronously at the actual harness relay, before any auto-approval
 * or upstream request. No model-supplied safety classifications are trusted.
 * Discovery/workbench/proxy meta-tools can reveal other accounts or execute
 * dynamic code, so restricted mode exposes only the finite approved path.
 */
export function assertConnectedAppCall(bot:BotRecord,input:unknown,options:{noLimits?:boolean;inventory?:InventoryServices|null}={}):void {
 if(bot.hidden||bot.staged||bot.composio===false)fail("Connected apps are off for this bot; enable them in Settings → Connections → Connected apps.");
 if(options.noLimits)return;
 if(bot.draftOnly)assertDraftOnlyCall(input);
 const levels=levelsOf(bot);
 if(levels)return assertLevelsCall(bot,levels,input,options.inventory,(args,toolkit)=>forbiddenAuthArguments(args)||toolkit==="gmail"&&args.user_id!==undefined&&args.user_id!=="me");
 const policy=botAccessPolicy(bot);
 if(policy.mode==="unrestricted")return;
 if(!object(input))fail("Restricted connected-app access requires one explicit tool request.");
 const message=input as Record<string,unknown>;
 if(["initialize","notifications/initialized","initialized","tools/list","ping"].includes(String(message.method)))return;
 if(message.method!=="tools/call"||!object(message.params))fail("This connected-app operation is not allowed by the owner’s restrictions.");
 const params=message.params as Record<string,unknown>;
 if(Object.keys(params).some(key=>!["name","arguments","_meta"].includes(key))||(params._meta!==undefined&&!requestMeta.safeParse(params._meta).success))fail("Unsupported connected-app request fields.");
 // Collecting the outcome of this bot's own earlier action runs nothing new.
 if(isConnectedAppStatusTool(String(params.name??"")))return;
 if(params.name!=="COMPOSIO_MULTI_EXECUTE_TOOL"||!object(params.arguments))fail("Restricted access only permits approved tools with an explicit account. Dynamic and discovery tools are blocked.");
 const args=params.arguments as Record<string,unknown>;
 if(Object.keys(args).some(key=>!["tools","thought","sync_response_to_workbench","current_step","current_step_metric","session_id"].includes(key)))fail("Unsupported connected-app execution fields.");
 if(args.sync_response_to_workbench!==undefined&&args.sync_response_to_workbench!==false)fail("Workbench execution is unavailable under restricted access.");
 if(!Array.isArray(args.tools)||!args.tools.length||args.tools.length>50)fail("Choose at least one approved connected-app tool.");
 for(const item of args.tools as unknown[]) {
  if(!object(item)||typeof item.tool_slug!=="string"||typeof item.account!=="string"||!object(item.arguments))fail("Each tool needs its approved name, exact connected-account ID and arguments.");
  if(Object.keys(item as Record<string,unknown>).some(key=>!["tool_slug","account","arguments"].includes(key)))fail("Unsupported connected-app tool fields.");
  const call=item as {tool_slug:string;account:string;arguments:Record<string,unknown>};
  const known=CONNECTED_APP_TOOLS.find(tool=>tool.tool===call.tool_slug);
  if(!known)fail("This tool is not supported under restricted connected-app access.");
  if(known!.writes&&!policy.allowWrites)fail("The owner has blocked connected-app writes for this bot.");
  if(!policy.grants.some(grant=>grant.toolkit===known!.toolkit&&grant.accountId===call.account&&grant.tools.includes(call.tool_slug)))fail("This tool or connected account has not been approved for this bot.");
  if(forbiddenAuthArguments(call.arguments)||(known!.toolkit==="gmail"&&call.arguments.user_id!==undefined&&call.arguments.user_id!=="me"))fail("Tool arguments cannot override the approved connected account.");
 }
}

export const DRAFT_ONLY_REFUSAL="This bot prepares drafts and does not send. It can read your connected apps; give the owner the draft to review and send.";
/** Tool discovery a draft-only bot may use: finding a tool and reading its
 * schema. Connection management and the workbench are not discovery. */
const DRAFT_ONLY_DISCOVERY=/^COMPOSIO_(SEARCH_TOOLS|GET_TOOL_SCHEMAS)$/;
/** A draft-only bot (store.ts draftOnly) reads and drafts. Whatever its access
 * level, grants or write switch, the relay runs for it only a verified read
 * (shared/connected-app-read-tools.ts), tool discovery, or the status of its own
 * earlier call. Everything else, unknown tools included, is refused here before
 * any approval or upstream request: the block is the relay, not the prompt. */
export function assertDraftOnlyCall(input:unknown):void {
 for(const message of Array.isArray(input)?input:[input]) {
  if(!object(message))fail(DRAFT_ONLY_REFUSAL);
  // Only tools/call runs anything in an app; the handshake and listings do not.
  if(message.method!=="tools/call")continue;
  const params=object(message.params)?message.params as Record<string,unknown>:{};
  const name=String(params.name??"");
  if(isConnectedAppStatusTool(name)||DRAFT_ONLY_DISCOVERY.test(connectedAppToolId(name)))continue;
  if(classifyConnectedAppCall(name,params.arguments)!=="read")fail(DRAFT_ONLY_REFUSAL);
 }
}

/** The bot's grants as they are NOW, against what an earlier action used. A
 * handle proves which bot asked; it does not outlive the owner removing the
 * account or tool from that bot, so a stored result is only handed back while
 * every tool and account the action used is still granted. A restricted bot is
 * never handed a stored result whose provenance is incomplete or empty: when
 * nothing says what the action needed, nothing says the bot may see it. */
export function assertStoredConnectedAppAccess(bot:BotRecord,used:{requirements:ReadonlyArray<{tool:string;account?:string}>;complete:boolean},options:{noLimits?:boolean;inventory?:InventoryServices|null}={}):void {
 if(bot.hidden||bot.staged||bot.composio===false)fail("Connected apps are off for this bot; enable them in Settings → Connections → Connected apps.");
 if(options.noLimits)return;
 const levels=levelsOf(bot);
 if(levels)return assertLevelsStored(levels,used,options.inventory);
 const policy=botAccessPolicy(bot);
 if(policy.mode==="unrestricted")return;
 if(!used.complete||!used.requirements.length)fail("This stored result cannot be matched to approved tools for this bot.");
 for(const call of used.requirements) {
  const known=CONNECTED_APP_TOOLS.find(tool=>tool.tool===call.tool);
  if(!known)fail("This tool is not supported under restricted connected-app access.");
  if(known!.writes&&!policy.allowWrites)fail("The owner has blocked connected-app writes for this bot.");
  if(!policy.grants.some(grant=>grant.toolkit===known!.toolkit&&grant.accountId===call.account&&grant.tools.includes(call.tool)))fail("This tool or connected account has not been approved for this bot.");
 }
}

/** Restricted bots receive only the concrete execution shape and approved IDs.
 * Do not relay tools/list to an upstream catalog that may describe other accounts. */
export function restrictedConnectorTools(bot:BotRecord,id:unknown,noLimits=false,inventory?:InventoryServices|null) {
 if(noLimits)return null;
 const levels=levelsOf(bot);
 if(levels)return fullyOpen(levels)?null:levelsConnectorTools(levels,id,inventory);
 const stored=botAccessPolicy(bot);if(stored.mode!=="restricted")return null;
 const policy=stored;
 const approved=policy.grants.flatMap(grant=>grant.tools.filter(name=>CONNECTED_APP_TOOLS.some(tool=>tool.tool===name&&(!tool.writes||policy.allowWrites))));
 return {jsonrpc:"2.0",id,result:{tools:approved.length?[{name:"COMPOSIO_MULTI_EXECUTE_TOOL",description:"Run only owner-approved connected-app tools. Each tool must include its exact approved connected-account ID. Approved scopes: "+JSON.stringify(policy.grants.map(grant=>({...grant,tools:[...new Set(grant.tools)]}))),inputSchema:{type:"object",properties:{tools:{type:"array",minItems:1,maxItems:50,items:{type:"object",properties:{tool_slug:{type:"string",enum:[...new Set(approved)]},account:{type:"string",enum:[...new Set(policy.grants.map(grant=>grant.accountId))]},arguments:{type:"object"}},required:["tool_slug","account","arguments"],additionalProperties:false}},sync_response_to_workbench:{type:"boolean",const:false}},required:["tools"],additionalProperties:false}}]:[]}};
}

/** What the connector bridge needs to remember a tool list for this bot: a
 * revision of its connected-app access (anything that changes what it may see
 * changes it, including an account being disconnected or signed out, which
 * arrives as `connectionEpoch`; pending requests do not), and for a restricted bot the list it is
 * first shown, so a slow mount never offers it unapproved accounts. */
export function connectedAppsListScope(bot:BotRecord,connectionEpoch=0,noLimits=false,inventory?:InventoryServices|null):{revision:string;initialTools?:unknown[]} {
 const levels=noLimits?null:levelsOf(bot);
 if(levels){
  // AG0 6.4: levels bots hash the rule, switches, entries, floors and the admitted ACTIVE IDs.
  const access=appAccessFor(bot);
  const entries=[...levels.accounts].map(entry=>JSON.stringify(entry)).sort();
  const admitted=inventory?admittedAccounts(levels,inventory).map(item=>item.toolkit+"\0"+item.accountId).sort():"loading";
  const effective={rule:"levels",kind:access.kind,enabled:bot.composio!==false,hidden:!!bot.hidden,newAccounts:levels.newAccounts,allowWrites:levels.allowWrites,entries,floors:levels.newAccountFloors??[],admitted,connectionEpoch};
  const initial=restrictedConnectorTools(bot,null,false,inventory);
  return {revision:createHash("sha256").update(JSON.stringify(effective)).digest("hex").slice(0,32),...(initial?{initialTools:initial.result.tools as unknown[]}:{})};
 }
 const saved=botAccessPolicy(bot);
 const policy=noLimits?{...saved,mode:"unrestricted" as const}:saved;
 // EFFECTIVE access only: what this bot may see and call, normalized (order and
 // duplicates carry no meaning). The review/request counter, pending requests,
 // denials and saves that change nothing are NOT part of it, so they never
 // recycle a warm process or lose a remembered list. An unrestricted bot's
 // leftover grants and write switch have no effect and are left out too.
 const restricted=!noLimits&&policy.mode==="restricted";
 const grantsNormalized=restricted?policy.grants.map(grant=>({toolkit:grant.toolkit,accountId:grant.accountId,tools:[...new Set(grant.tools)].sort()})).sort((a,b)=>(a.toolkit+"\0"+a.accountId).localeCompare(b.toolkit+"\0"+b.accountId)):[];
 const effective={enabled:bot.composio!==false,hidden:!!bot.hidden,mode:noLimits?"unrestricted":policy.mode,allowWrites:restricted?policy.allowWrites:null,grants:grantsNormalized,connectionEpoch};
 const revision=createHash("sha256").update(JSON.stringify(effective)).digest("hex").slice(0,32);
 const initial=restrictedConnectorTools(bot,null,noLimits);
 return {revision,...(initial?{initialTools:initial.result.tools as unknown[]}:{})};
}

/** ACTIVE accounts a limited levels bot is admitted to (anything at all), each filed under one app. */
function admittedAccounts(levels:NonNullable<ReturnType<typeof levelsOf>>,inventory:InventoryServices){
 return Object.entries(inventory).flatMap(([toolkit,service])=>service.accounts.filter(account=>account.status.toUpperCase()==="ACTIVE"&&Object.values(inventory).filter(other=>other.accounts.some(item=>item.id===account.id)).length===1).map(account=>({toolkit,accountId:account.id,granted:admission(levels,toolkit,account.id)}))).filter(item=>item.granted.change||item.granted.tools==="any"||item.granted.tools.size>0);
}
/** AG0 6.2: a limited levels bot sees the execute tool naming admitted account IDs only. */
function levelsConnectorTools(levels:NonNullable<ReturnType<typeof levelsOf>>,id:unknown,inventory:InventoryServices|null|undefined){
 const accounts=inventory?admittedAccounts(levels,inventory):[];
 const scopes=accounts.map(item=>({toolkit:item.toolkit,account:item.accountId,level:item.granted.change?"full":"read",...(item.granted.tools==="any"?{}:{tools:[...item.granted.tools].sort()})}));
 const description=!inventory?"Connected apps are still loading.":"Run only the app operations the owner chose. Every row names its account ID. Accounts: "+JSON.stringify(scopes);
 return {jsonrpc:"2.0",id,result:{tools:accounts.length||!inventory?[{name:"COMPOSIO_MULTI_EXECUTE_TOOL",description,inputSchema:{type:"object",properties:{tools:{type:"array",minItems:1,maxItems:50,items:{type:"object",properties:{tool_slug:{type:"string",enum:[...new Set(accounts.flatMap(item=>admittedKnownSlugs(levels,item.toolkit,item.accountId)))].sort()},account:{type:"string",enum:[...new Set(accounts.map(item=>item.accountId))]},arguments:{type:"object"}},required:["tool_slug","account","arguments"],additionalProperties:false}},sync_response_to_workbench:{type:"boolean",const:false}},required:["tools"],additionalProperties:false}}]:[]}};
}
