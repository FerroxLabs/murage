import { join } from 'node:path';
export const noLimits={id:'mandatory-fixture',autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
export function context(command, extra={}) {
  return {fullAccessOrigin:'owner',ownerStarted:true,unattended:false,automated:false,outsideRead:null,
    workFolder:process.env.HOME,commandCwd:process.env.HOME,commandText:command,promptFacts:{cwd:process.env.HOME,home:process.env.HOME},
    call:{engine:'claude',toolCall:{name:'Bash',input:{command,cwd:process.env.HOME}}},...extra};
}
export const protectedTarget=()=>join(process.env.HOME,'.ssh','config');
