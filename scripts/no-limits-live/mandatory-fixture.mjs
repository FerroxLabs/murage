import { join } from 'node:path';
export const noLimits={id:'mandatory-fixture',autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
export function context(command, extra={}) {
  const value={fullAccessOrigin:'owner',ownerStarted:true,unattended:false,automated:false,outsideRead:null,
    workFolder:process.env.HOME,commandCwd:process.env.HOME,commandText:command,promptFacts:{cwd:process.env.HOME,home:process.env.HOME},
    call:{engine:process.env.GNL_MANDATORY_ENGINE??'claude',toolCall:{name:'Bash',input:{command,cwd:process.env.HOME}}},...extra};
  // FullAccessOrigin has no webhook member. Older unchanged ruling suites
  // name that ingress here; represent it through the product's dedicated
  // NoLimitsOrigin while retaining its ordinary Full access floor.
  if(value.fullAccessOrigin==='webhook'){
    value.noLimitsOrigin??='webhook';value.fullAccessOrigin='other';
  }
  return value;
}
export const protectedTarget=()=>join(process.env.HOME,'.ssh','config');
