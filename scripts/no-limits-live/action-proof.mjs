import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readNativeEvents,operationCompleted} from './native-operation-evidence.mjs';
// Public SSE intentionally omits executable input. Bind a private native
// start/result pair to the exact command and an independently read effect.
export function shellActionProven(obs,command,cwd,dataDir) {
 let completed=false,effect=false;
 try { completed=operationCompleted({tool:'Bash',input:{command}},readNativeEvents(dataDir,obs.threadIds,obs.events),cwd); } catch {}
 try { effect=readFileSync(join(cwd,'action.done'),'utf8').trim()==='fixture'; } catch {}
 return completed && effect;
}
