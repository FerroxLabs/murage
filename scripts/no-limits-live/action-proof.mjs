import {readFileSync} from 'node:fs';
import {join} from 'node:path';
// The command is the complete requested executable input. Pair the actual
// start/completion IDs and inspect a fixture effect outside the engine stream.
export function shellActionProven(obs,command,cwd) {
 const completed=obs.events.some(s=>s.type==='item.started'&&s.itemType==='tool'&&s.itemId!==undefined
  && /^(?:Bash|PowerShell|shell|shell_command|exec|exec_command|run_shell_command|run_command|terminal)$/i.test(s.toolIdentity?.name??s.tool??s.title??'')
  && (s.input?.command??s.input?.CommandLine??s.input?.cmd)===command
  && obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.itemId===s.itemId&&e.ok===true));
 let effect=false;try{effect=readFileSync(join(cwd,'action.done'),'utf8').trim()==='fixture';}catch{}
 return completed && effect;
}
