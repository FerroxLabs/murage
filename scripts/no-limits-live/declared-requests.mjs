import {releasePlan} from './fakes/release-plan.mjs';
import {resolve} from 'node:path';
import {hashInput} from './oracle-class.mjs';
export function declaredRequests(text,engine,spec,ownedCwd,savedPages=[]){
 const plan=releasePlan(text),requests=[],cwd=ownedCwd??/Work ONLY inside ([^\n]+?)\. Use the requested tools/.exec(text)?.[1];
 for(const original of plan.steps){
  const variants=original.savedRead?savedPages.filter(page=>page.url===plan.steps.find(s=>s.tool==='agent_browser_read'&&s.input.url)?.input.url&&page.next_offset===original.input.offset).map(page=>({...original,input:{handle:page.handle,...original.input}})):[original];
  for(const step of variants){
  if(!['tool','question'].includes(step.kind))continue;
  const cls=step.kind==='question'?'question':spec.expected==='CARD'?(spec.why??'base'):spec.permissionRule?'permission-rule':'run';
  // Known adapter spellings; the committed instruction fixes the input hash.
  const tools=step.tool==='Bash'?['Bash','shell','bash','run_command','mcp__fixture__shell']:step.tool==='Write'?['Write','write','write_file','write_to_file','edit','mcp__fixture__Write']:[step.tool];
  if(['grok','openai-compat','minimax'].includes(engine.driver)&&!['Bash','Write'].includes(step.tool))tools.push(`mcp__${step.tool.startsWith('agent_browser_')?'browser':step.tool==='memory_save'?'murage-memory':'agents'}__${step.tool}`);
  for(const tool of tools)requests.push({engine:engine.driver,tool,inputHash:hashInput(step.input),class:cls});
  if(step.tool==='GMAIL_SEND_EMAIL')requests.push({engine:engine.driver,tool:'mcp__gnl-app__GMAIL_SEND_EMAIL',inputHash:hashInput(step.input),class:cls});
  if(step.tool==='click')for(const server of ['computer','murage-computer'])requests.push({engine:engine.driver,tool:`mcp__${server}__click`,inputHash:hashInput(step.input),class:cls});
  // Native adapters may omit toolCall input for the empty shell form.
  // This alias is admitted only when the committed instruction has no command.
  if(step.tool==='Bash'&&!Object.hasOwn(step.input,'command'))for(const tool of tools)requests.push({engine:engine.driver,tool,inputHash:hashInput(null),class:cls});
  if(engine.driver==='antigravityAgent'&&step.tool==='Bash'&&!Object.hasOwn(step.input,'command')&&cwd)requests.push({engine:engine.driver,tool:'run_command',inputHash:hashInput({cwd}),class:cls});
  if(engine.driver==='antigravityAgent'&&step.tool==='Bash'){
   for(const input of [{command:step.input.command,cwdExplicit:false},...(cwd?[{command:step.input.command,cwdExplicit:false,cwd}]:[])])requests.push({engine:engine.driver,tool:'run_command',inputHash:hashInput(input),class:cls});
  }
  if(engine.driver==='museCode'&&step.tool==='Bash'&&cwd)requests.push({engine:engine.driver,tool:'shell',inputHash:hashInput({...step.input,cwd}),class:cls});
  if(step.kind==='question'){
   requests.push({engine:engine.driver,tool:'ask_user',inputHash:hashInput({questions:[{question:step.input.question,options:step.input.choices.map(label=>({label}))}]}),class:cls});
   if(['grok','openai-compat','minimax'].includes(engine.driver))requests.push({engine:engine.driver,tool:'mcp__agents__ask_user',inputHash:hashInput({questions:[{question:step.input.question,options:step.input.choices.map(label=>({label}))}]}),class:cls});
   for(const tool of ['elicitation','request_user_input'])requests.push({engine:engine.driver,tool,inputHash:hashInput(null),class:cls});
  }
  if(engine.driver==='museCode'&&step.tool==='Write'&&cwd)requests.push({engine:engine.driver,tool:'Write',inputHash:hashInput({...step.input,path:resolve(cwd,step.input.file_path),cwd}),class:cls});
  if(engine.driver==='antigravityAgent'&&!['Bash','Write'].includes(step.tool))requests.push({engine:engine.driver,tool:`mcp__${step.tool.startsWith('agent_browser_')?'murage-browser':'murage-agents'}__${step.tool}`,inputHash:hashInput(step.input),class:cls});
  if(engine.driver==='piAgent'&&step.tool==='Write')for(const tool of ['Write','write'])requests.push({engine:engine.driver,tool,inputHash:hashInput({path:step.input.file_path,content:step.input.content}),class:cls});
  if(['Bash','Write'].includes(step.tool)){
   if(cwd)requests.push({engine:engine.driver,tool:`mcp__gnl-fixture__${step.tool==='Bash'?'shell':'Write'}`,inputHash:hashInput({...step.input,cwd}),class:cls});
  }
 }
 }
 return [...new Map(requests.map(r=>[JSON.stringify(r),r])).values()];
}
