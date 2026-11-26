import { candidatePaths, retiredEvidencePath } from './check-repository-custody.mjs';
import { archivedEvidencePath, assertExternalEvidencePath, evidencePath, writeNewEvidence } from './evidence-path.mjs';
// Run only inside the job's network-none test container. Every mutation lives
// in a disposable source copy; source and assertions in /work stay untouched.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const source=process.cwd(),out=assertExternalEvidencePath(resolve(process.argv[2]??evidencePath('evidence/gnl-prod/mutants')));
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-prod-mutants-'));
const files=candidatePaths(source).filter(file=>!retiredEvidencePath(file)&&existsSync(join(source,file)));
const results=[];
function run(name,tests,pattern){
 const result=spawnSync('pnpm',['exec','vitest','run',...tests,...(pattern?['--testNamePattern',pattern]:[]),'--maxWorkers=1'],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:20*1024*1024});
 const log=(result.stdout??'')+(result.stderr??'');writeNewEvidence(name+'.log',log,out);writeNewEvidence(name+'.rc',String(result.status)+'\n',out);
 if(result.error)throw result.error;
 return {status:result.status,log};
}
try{
 for(const file of files){mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(source,file),join(root,file));}
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const mutants=[
  {name:'P1-antigravity-input',file:'server/drivers/antigravity.ts',before:'...(payload.tool_info?.parameters !== undefined ? { input: payload.tool_info.parameters } : {})',after:'...{}',tests:['server/drivers/antigravity.test.ts'],pattern:'P1 retains exact native parameters'},
  {name:'P1-codex-search',file:'server/drivers/codex.ts',before:': item.type === "webSearch" ? item.action ?? (typeof item.query === "string" ? { query: item.query } : item.arguments)\n                    : item.arguments,',after:': item.arguments,',tests:['server/drivers/codex.test.ts'],pattern:'runs the handshake and normalizes a full turn'},
  {name:'P1-box-input',file:'server/drivers/boxagent.ts',before:'input: ev.input ?? ev.arguments ?? ev.parameters ?? ev.data?.input ?? ev.data?.arguments ?? ev.data?.parameters ?? (typeof ev.command === "string" ? { command: ev.command } : undefined),',after:'input: undefined,',tests:['server/drivers/boxagent.test.ts'],pattern:'P1 retains the actual native tool input'},
  {name:'P1-muse-command',file:'server/drivers/muse-code.ts',before:'...(args ? { input: args } : item.commandText !== undefined ? { input: { command: item.commandText } } : {})',after:'...(args ? { input: args } : {})',tests:['server/drivers/muse-code.test.ts'],pattern:'P1 retains the full native commandText'},
  {name:'P2-browser-mount',file:'server/drivers/mcp-mounts.ts',before:'if (turn.integrations?.browser) servers.browser = { ...turn.integrations.browser };',after:'// mutant drops browser',all:true,tests:['server/drivers/pi.test.ts'],pattern:'P2 mounts the built-in browser'},
  {name:'P2-browser-capability',file:'server/drivers/openai-chat.ts',before:'browserMcp: true, agentsMcp:',after:'browserMcp: false, agentsMcp:',tests:['server/drivers/openai-chat.test.ts'],pattern:'P2 advertises the browser'},
  {name:'P2-antigravity-browser',file:'server/drivers/antigravity.ts',before:'if (integrations?.browser) servers[ANTIGRAVITY_BROWSER_MCP_KEY] = { ...integrations.browser };',after:'// mutant drops browser',tests:['server/drivers/antigravity.test.ts'],pattern:'P2 mounts the real browser proxy'},
  {name:'P3-bot-wire',file:'server/index.ts',before:'...wirePermissionFlags(inheritedPermissions(bot))',after:'...{}',tests:['server/product-permission-wire-api.test.ts']},
  {name:'P3-task-wire',file:'server/index.ts',before:'...wireTaskPermissions(task.threadId)',after:'...{}',tests:['server/product-permission-wire-api.test.ts']},
  {name:'P3-routine-explicit',file:'server/routine-permissions.ts',before:'current === "unlimited" && routine.permissionExplicit !== true',after:'current === "unlimited"',tests:['server/no-limits-inheritance.test.ts'],pattern:'P3 No limits honors'},
  {name:'P3-conversation-choice',file:'server/routines.ts',before:'permissionExplicit: routine.permissionPending ? true : routine.permissionExplicit, ...(routine.permissionPending ?',after:'permissionExplicit: routine.permissionPending ? true : undefined, ...(routine.permissionPending ?',tests:['server/no-limits-inheritance.test.ts'],pattern:'P3 explicit lower routine conversations'},
  {name:'P4-guest-trigger',file:'server/decision/implementation.ts',before:"if(!p.roomOwnerOnly||kind==='guest'||kind==='other-human'){a.actor='other';a.noLimitsOrigin='other-human';return a;}",after:'// mutant lets an external trigger override the audience',tests:['server/decision/product-origin.test.ts'],pattern:'cannot lift a known guest audience'},
  {name:'P4-live-owner-fallback',file:'server/decision/implementation.ts',before:"actor:'unproven',level:'ask'",after:"actor:'unproven',level:live?.level??'ask'",tests:['server/decision/product-origin.test.ts']},

 ];
 for(const m of mutants){
  const file=join(root,m.file),original=readFileSync(file,'utf8');if(!original.includes(m.before))throw Error('Missing mutant seam '+m.name);
  const control=run(m.name+'-control',m.tests,m.pattern);if(control.status!==0)throw Error('Regression control failed: '+m.name);
  try{
   const mutated=m.all?original.replaceAll(m.before,m.after):original.replace(m.before,m.after);
   writeFileSync(file,mutated);const killed=run(m.name,m.tests,m.pattern);
   if(killed.status===0||!killed.log.includes('AssertionError'))throw Error('Mutant not killed by an assertion: '+m.name);
   results.push({name:m.name,control:control.status,mutant:killed.status,killed:true});
  }finally{writeFileSync(file,original);}
 }
 // Preserve baseline evidence for the historical faults suite without editing it.
 for(const file of ['server/decision/implementation.ts','server/no-limits-origin.ts','server/routine-permissions.ts'])cpSync(archivedEvidencePath('evidence/gnl-prod/baseline-source/'+file),join(root,file));
 const baseline=run('baseline-faults',['server/decision/faults.test.ts']);
 results.push({name:'baseline-faults',status:baseline.status,expectedPreexistingFailures:2});
}finally{
 // Results are created once, fresh, including the partial list when a mutant run stops early.
 try{writeNewEvidence('results.json',JSON.stringify(results,null,2)+'\n',out);}finally{
  if(!root.startsWith(join(tmpdir(),'gnl-prod-mutants-')))throw Error('Refuse unexpected cleanup');
  rmSync(root,{recursive:true,force:true});
 }
}
