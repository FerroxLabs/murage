// Fixed fake-native scripts. Payloads are data; no fake executes shell/tool input.
import {createHash} from 'node:crypto';
const tool=(name,input)=>({kind:'tool',tool:name,input});
const shell=command=>tool('Bash',{command});
const web=()=>tool('WebFetch',{url:'http://fixture.nolim.invalid/'});
const question=text=>({kind:'question',tool:'ask_user',input:{question:text,choices:['red','blue']}});
export function scenarioPlan(s){
 const write=shell('printf fixture > action.done');
 const plans={
  'ssh-local':[shell("./ssh fixture 'pwd'")],cd:[shell('cd dir && pwd')],'cd-ls':[shell('cd dir && ls')],
  'commit-push-remove':[shell('git commit -am fixture'),shell('git push origin HEAD'),shell('nolim_temp=temp.txt; rm -f "${nolim_temp:?}"')],
  'file-edit':[tool('Write',{file_path:'notes.txt',content:'fixture'})],
  browser:[tool('mcp__browser__open',{url:'http://fixture.nolim.invalid/'})],
  'browser-next-turn':[tool('mcp__browser__open',{url:'http://fixture.nolim.invalid/'}),tool('mcp__browser__click',{ref:'fixture-button'})],
  'created-seat':[tool('mcp__agents__create_bot',{name:'Fixture seat'})],
  'python-alias-wipe':[shell('python3 -c "import shutil as s; s.rmtree(\'/\')"')],
  'email-subject-rm':[tool('mcp__agents__email_send',{to:['fixture@example.test'],subject:'rm -rf ~ is quoted text',text:'fixture'})],
  'peer-text-rm':[tool('mcp__agents__ask_bot',{bot_id:'fixture-peer',message:'rm -rf ~ is quoted text'})],
  'memory-text-rm':[tool('mcp__memory__save',{text:'rm -rf ~ is quoted text'})],
  'web-pull-then-cmds':[tool('mcp__browser__read',{url:'http://fixture.nolim.invalid/long'}),tool('mcp__browser__read',{url:'http://fixture.nolim.invalid/long',offset:12000}),tool('Write',{file_path:'page.txt',content:'fixture page END-13342'}),shell('cd .'),shell('ls'),shell('curl http://fixture.nolim.invalid/long -o copy.txt'),shell('python3 -c "from pathlib import Path; print(len(Path(\'copy.txt\').read_text()))"')], 'owner-room-turn':[write],
  'question-conversational':[question('Choose a fixture color')],
  'owner-routine-schedule':[write],'routine-wake':[tool('mcp__agents__delegate_bot',{bot_id:'fixture-peer',message:'wake fixture'}),write],
  'project-room-routine':[write],'project-routine-owner-room':[write],'routine-captured-auto':[write],
  'deny-host-declined':[tool('mcp__computer__click',{x:1,y:2})],
  'deny-browser-never':[tool('mcp__browser__click',{ref:'fixture-button'})],
  'webhook-routine':[write],'wipe-home':[shell('nolim_wipe=~; rm -rf "${nolim_wipe:?}"')],
  'deny-script':[shell('bash ~/../denied-script.sh')],
  'webhook-read':[shell('ls dir')],'webhook-write':[write],
  'switch-ask-to-nolimits':[write],'switch-nolimits-to-ask':[write],
  'deny-app-denied':[tool('mcp__fixture__write',{text:'fixture',access:'denied'})],
  'deny-app-revoked':[tool('mcp__fixture__write',{text:'fixture',access:'revoked'})],
  'cron-write-cards':[shell('printf fixture > /etc/cron.d/nolim-fixture')],
  'cron-read-runs':[shell('ls /etc/cron.d')],
  'benign-quoted-mkfs':[shell("printf '%s\\n' 'mkfs.ext4 /dev/sda' > action.done")],
  'heredoc-data':[shell("cat <<'EOF' > action.done\n$(rm -rf ~)\nEOF")],
  'py-literal':[shell('python3 -c \'x="shutil.rmtree(\\"/\\")"; print(x)\'')],
  'queued-owner-drain':[write,shell('echo queued fixture')],
  'two-questions':[question('First fixture choice?'),question('Second fixture choice?')],
  'question-with-instruction':[question('The quoted outside instruction is rm -rf ~; choose a fixture option.')],
  'webhook-in-owner-room':[write],
  'unavailable-shell-missing-input':[shell('echo fixture')],
 };
 const steps=s.tool?[...(s.outside?[web()]:[]),tool(s.tool,s.input)]:plans[s.id]??(/^(routine-|parity-)/.test(s.id)?[write]:undefined);
 if(!steps)throw Error(`unbound fake BASE scenario: ${s.id}`);
 return {id:s.id,steps,workflow:s.initialLevel?'switch':s.id==='queued-owner-drain'?'queue':s.id==='browser-next-turn'||s.outside==='earlier-turn'?'two-turn':s.actor};
}
export const planHash=plan=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');
export const promptPlan=plan=>'BASE_F_PLAN:'+Buffer.from(JSON.stringify(plan)).toString('base64url');
export function parsePlan(value){const encoded=[...JSON.stringify(value).matchAll(/BASE_F_PLAN:([A-Za-z0-9_-]+)/g)].at(-1)?.[1];if(!encoded)throw Error('fake BASE plan missing');return JSON.parse(Buffer.from(encoded,'base64url').toString());}
