// SPDX-License-Identifier: AGPL-3.0-or-later
// Assertion RED / restored GREEN proof in a disposable, network-disabled source copy.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Run through the isolated test container');
const source=process.cwd(),out=resolve(process.argv[2]??'evidence/nolim-rows/mutants');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-rows-mutants-'));
for(const entry of readdirSync(source))if(!/^(?:node_modules|\.git|\.nolim|evidence$|dist|build$|\.cache$)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
const core='server/decision/no-limits-uncovered-rows.test.ts',service='server/service-no-limits-routes-api.test.ts',native='server/drivers/acp/no-limits-uncovered-native.test.ts';
const impl='server/decision/implementation.ts';
const replace=(from,to)=>text=>{if(!text.includes(from))throw Error('Mutation anchor missing: '+from);return text.replace(from,to);};
const specs=[
 ['A21',impl,text=>replace("if(e.fault==='identity'&&!owner(e))","if(e.fault==='identity')")(replace("if(ownerNl&&fault==='identity')fault=undefined;","if(false&&fault==='identity')fault=undefined;")(text)),[core],'^A21'],
 ['A30',impl,replace("if(why!=='wipe'||!owner(e))return {kind:'refuse',message:REFUSAL};","if(true)return {kind:'refuse',message:REFUSAL};"),[core],'^A30'],
 ['A31',impl,replace('count>=8&&!(e&&owner(e))','count>=8'),[core],'^A31'],
 ['A20-queue',impl,replace("if(noLimitsInFlight>=512||(noLimitsThreads.get(e.threadId)??0)>=32)","if(false)"),[core],'^A20 delivery capacity'],
 ['X3','server/index.ts',replace("!serviceNoLimits(internalClaim.generation, internalClaim.threadId, internalClaim.botId) && (isUnattended(internalClaim.threadId) || internalClaim.notOwnerAudience)) return json(res, 403, { error: ASK_USER_REFUSED }","(isUnattended(internalClaim.threadId) || internalClaim.notOwnerAudience)) return json(res, 403, { error: ASK_USER_REFUSED }"),[service],'^X3'],
 ['X4','server/bot-calls-policy.ts',text=>text.replace(/const noLimits=world\.noLimits\?\.\(intent\)\?\?serviceThreadNoLimits\(intent.threadId,intent.botId\);/,'const noLimits=false;'),['server/bot-calls-policy.test.ts'],'^X4'],
 ['S16','server/memory/automatic-learning.ts',text=>text.replace(/const noLimits=typeof sourceThread[^;]+;/,'const noLimits=false;'),['server/memory/automatic-learning.test.ts'],'^S16'],
 ['B4-Grok','server/drivers/acp/grok.ts',replace('turn.integrations?.agents && !(turn.permissionNow?.() ?? turn).noLimits','turn.integrations?.agents'),[native],'B4 B10 Grok'],
 ['B10-Copilot','server/drivers/acp/copilot.ts',replace('turn.integrations?.agents && !(turn.permissionNow?.() ?? turn).noLimits','turn.integrations?.agents'),[native],'B4 B10 Copilot'],
 ['B10-Droid','server/drivers/acp/droid.ts',replace('turn.integrations?.agents && !(turn.permissionNow?.() ?? turn).noLimits','turn.integrations?.agents'),[native],'B4 B10 Droid'],
 ['B10-Qwen','server/drivers/acp/qwen.ts',replace('...(noLimits ? [] : ["--exclude-tools=web_fetch"])','...["--exclude-tools=web_fetch"]'),[native],'B4 B10 Qwen'],
 ['B10-OpenCode','server/drivers/acp/opencode-go.ts',replace('webfetch: noLimits ? "ask" : "deny"','webfetch: "deny"'),[native],'B10 OpenCode'],
 ['B8','server/drivers/pi-permission-gate.ts',text=>text.replace(/const noLimits=process.env.MURAGE_PI_NO_LIMITS[^;]+;/,'const noLimits=false;'),['server/drivers/pi-permission-gate.test.ts'],'^B8'],
 ['B11','server/drivers/boxagent.ts',replace('const sendTurn = async (turn: SendTurnInput) => {','const sendTurn = async (turn: SendTurnInput) => { if(turn.noLimits)throw new Error("fixture native permission hold");'),['server/drivers/boxagent.test.ts'],'^B11'],
 ['C7',impl,replace("const recovered=!live||!p||p.initiator.k==='other-human'?","const recovered=!live||!p?"),['server/decision/no-limits-merge-rulings.test.ts'],'^H1 queued phone'],
 ['C13',impl,replace('canonical({level:a.level,actor:a.actor,initiator:a.provenance.initiator','canonical({actor:a.actor,initiator:a.provenance.initiator'),[core],'^C13'],
 ['D2','server/host-power.ts',replace('noLimitsSession ? NO_LIMITS_SEATBELT_POWER_PROFILE : SEATBELT_POWER_PROFILE','SEATBELT_POWER_PROFILE'),['server/no-limits-uncovered-power.test.ts'],'^D2'],
 ['D5-shares','server/room-shares.ts',replace('if (live >= SHARE_DRAFTS && !serviceThreadNoLimits(input.threadId,input.botId))','if (live >= SHARE_DRAFTS)'),['server/no-limits-uncovered-shares.test.ts'],'^D5'],
 ['D5-proposals','server/index.ts',replace('if (serviceThreadNoLimits(threadId,botId)) {','if (false) {'),[service],'^D5'],
 ['outside-store','server/index.ts',text=>text.replace(/(function continueWithoutOutsideStore\([\s\S]*?)return true;/,'$1return false;'),['server/no-limits-uncovered-outside-api.test.ts'],'outside-store failure'],
 ['R1-explicit','server/no-limits-origin.ts',replace('if (guest && (bot.permissionExplicit !== true || bot.fullAccessChannelMessages === false)) return false;','if (guest) return false;'),[core],'^R1'],
 ['R1-webhook-ask',impl,replace("e.authority.noLimitsOrigin==='webhook'||e.authority.noLimitsOrigin==='other-human'","e.authority.noLimitsOrigin==='other-human'"),[core],'Ask webhook keeps'],
 ['R1-legacy','server/no-limits-origin.ts',replace('if (guest && (bot.permissionExplicit !== true || bot.fullAccessChannelMessages === false)) return false;','if (guest && bot.fullAccessChannelMessages === false) return false;'),[core],'^R1'],
 ['0805-stored',impl,replace("else if(isQuestion(r))outcome=approval(e,'question',[]);","else if(r.deny.length)outcome={kind:'refuse',message:'fixture saved deny'};\n  else if(isQuestion(r))outcome=approval(e,'question',[]);"),[core],'^08:05 stored'],
 ['0805-highlevel','server/highlevel/host.ts',replace('if (serviceNoLimits(claim.generation, claim.threadId, claim.botId)) return false;','if (false) return false;'),['server/highlevel/grants-management.test.ts'],'^08:05 a saved'],
 ['0805-app-rule','server/bot-access.ts',replace('if(policy.mode==="unrestricted"||highlevel.noLimits===true)return;','if(policy.mode==="unrestricted")return;'),['server/bot-access.test.ts'],'^08:05 connected-app stored'],
 ['0805-folder-rule','server/service-no-limits.ts',replace("  return { ...gate, rejects: [], decision: 'trust'","  if(gate.decision==='reject'||gate.storedNoPick||gate.rejects?.length)return gate;\n  return { ...gate, rejects: [], decision: 'trust'"),['server/service-no-limits.test.ts'],'08:05 N7|S3 folder permission'],
 ['0805-auto-log','server/index.ts',replace("if (outcome.kind === 'run') autoAnsweredAsks.add(automaticLogKey);","if (false) autoAnsweredAsks.add(automaticLogKey);"),['server/nolimits-owner-started-api.test.ts'],"the owner's new line"],
 ['0805-app-list','server/bot-access.ts',replace('if(noLimits)return null;','if(false)return null;'),['server/bot-access.test.ts'],'^08:05 connected-app stored'],
 ['0805-app-off','server/bot-access.ts',replace('if(bot.hidden||bot.staged||bot.composio===false)fail("Connected apps','if(false)fail("Connected apps'),['server/bot-access.test.ts'],'^08:05 connected-app feature'],
 ['0805-browser-off','server/index.ts',replace('if (!builtInBrowserEnabled(cfg) || bot.browser === false) return json(res, 403, { error: "Browser control is off. Turn it on in the bot’s Settings." });','if (false) return json(res, 403, { error: "Browser control is off. Turn it on in the bot’s Settings." });'),['server/no-limits-browser-off-api.test.ts'],'08:05 browser feature off'],
 ['0805-off-line','server/bot-access.ts',replace('fail("Connected apps are off for this bot. Turn them on in the bot’s Settings.")','fail(highlevel.noLimits ? "Connected apps are off for this bot. Turn them on in the bot’s Settings." : "Connected apps are disabled for this bot.")'),['server/bot-access.test.ts'],'^08:05 connected-app feature'],
 ['0805-host-off','server/host-computer-consent.ts',replace('if (bot.hostComputerConsent === "declined") return Promise.resolve("declined");','if (false) return Promise.resolve("declined");'),['server/no-limits-feature-off.test.ts'],'^08:05 declined'],
 ['0805-off-gate','scripts/no-limits-live/counts.mjs',replace("if (spec.expected === 'OFF_WITH_LINE')","if (false)"),['scripts/no-limits-live/release.test.mjs'],'^08:05 feature-off'],
 ['0805-channel-off',impl,replace("if(e.authority.fullAccessChannelMessages===false&&","if(false&&e.authority.fullAccessChannelMessages===false&&"),[core],'^08:05 channel'],
 ['R3-unknown','server/no-limits-wipe.ts',replace('let unread = options.unread === true;',"if(/\\brm\\b/.test(text))return {rule:'disk-erase',what:'fixture old word hold'};\n let unread = options.unread === true;"),['server/nolimits-cards-1010.test.ts'],'an unknown delete'],
 ['R4-question',impl,replace("else if(isQuestion(r))outcome=approval(e,'question',[]);","else if(false)outcome=approval(e,'question',[]);"),[core],'^A31'],
 ['R6-tail','server/no-limits-wipe.ts',replace('let unread = options.unread === true;','text=text.slice(0,65536);\n let unread = options.unread === true;'),['server/decision/no-limits-y3b.test.ts'],'CAP-LEN'],
 ['R6-symlink','server/no-limits-wipe.ts',replace('const physical=realpathSync(path);','return null;\n  const physical=realpathSync(path);'),['server/no-limits-symlink-r31.test.ts'],'^R6'],
 ['R6-provenance',impl,replace('ownerAuthority:e.registration.ownerAuthority,evidence:e.registration.deny','ownerAuthority:undefined,evidence:[]'),['server/decision/no-limits-y3b.test.ts'],'retain provenance|authority survives'],
];
const manifest=Object.fromEntries([...new Set(specs.flatMap(row=>[row[1],...row[3]]))].sort().map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]));
writeFileSync(join(out,'source-manifest.json'),JSON.stringify(manifest,null,2));
const proof={sourceDigest:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),rows:[],verdict:'FAIL'};
function run(id,files,pattern){
 const json=join(out,id+'.json');
 const p=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1','--reporter=json','--outputFile='+json,'-t',pattern],{cwd:root,env:process.env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:240000});
 writeFileSync(join(out,id+'.log'),(p.stdout??'')+(p.stderr??''));
 const j=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 const failures=j?.testResults.flatMap(file=>file.assertionResults.filter(row=>row.status==='failed').map(row=>row.fullName))??[];
 return {code:p.status,passed:j?.numPassedTests??0,failures,json};
}
try{
 for(const [id,file,mutate,files,pattern]of specs.filter(row=>!process.env.ROWS_MUTANTS_ONLY||new RegExp(process.env.ROWS_MUTANTS_ONLY).test(row[0]))){
  const path=join(root,file),original=readFileSync(path,'utf8'),changed=mutate(original);if(changed===original)throw Error('No mutation: '+id);
  const baseline=run(id+'-baseline',files,pattern);if(baseline.code!==0||baseline.passed<1)throw Error('Baseline is not GREEN: '+id);
  let red;try{writeFileSync(path,changed);red=run(id+'-red',files,pattern);}finally{writeFileSync(path,original);}
  const restored=run(id+'-restored',files,pattern);
  const killed=red.code===1&&red.failures.length>0&&restored.code===0&&restored.passed>0;
  proof.rows.push({id,file,killed,baseline,red,restored});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2));
  process.stdout.write(`${id}: ${killed?'KILLED; restored GREEN':'INVALID'}\n`);if(!killed)throw Error('Invalid mutation proof: '+id);
 }
 proof.verdict='PASS';
}finally{writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2));safeWipeSync(root,{reason:'disposable No limits row mutation fixture'});}
