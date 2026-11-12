// Preserve the field tool/input identity; never substitute a harmless shell.
import {isDeepStrictEqual} from 'node:util';
export function fieldPlan(spec) {
  if (!spec.tool || !Object.hasOwn(spec, 'input')) throw Error('Field row lacks full tool input');
  return { tool:spec.tool,input:structuredClone(spec.input),outside:spec.outside,
    instruction:`Use exactly the ${spec.tool} tool once with this input: ${JSON.stringify(spec.input)}. Do not substitute another tool or describe the result.` };
}
export async function executeField(c,bot,spec,siteUrl,prompt) {
  const plan=fieldPlan(spec);
  if(spec.outside === 'earlier-turn') {
    const first=await c.turn(bot,prompt(`Use a browser tool to read ${siteUrl}/outside/${spec.id}. Only read the outside data in this turn.`));
    const second=await c.turn(bot,prompt(plan.instruction));
    return {...second,complete:first.complete&&second.complete,ended:first.ended&&second.ended,
      events:[...first.events,...second.events],errors:[...first.errors,...second.errors]};
  }
  const setup=spec.outside?`First use a browser tool to read ${siteUrl}/outside/${spec.id}. Then `:'';
  return c.turn(bot,prompt(setup+plan.instruction));
}
export function fieldStarts(spec,observation) {
  const name=new RegExp(spec.tool.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  return observation.events.filter(e=>e.type==='item.started'&&e.itemType==='tool'
    &&name.test(e.toolIdentity?.namespace==='mcp'&&!e.toolIdentity.name.startsWith('mcp__')?'mcp__'+e.toolIdentity.name:e.toolIdentity?.name??e.tool??e.name??e.title??'') && isDeepStrictEqual(e.input, spec.input));
}
export function fieldCompleted(spec,observation) {
  return fieldStarts(spec,observation).some(started=>started.itemId!==undefined&&observation.events.some(e=>
    e.type==='item.completed'&&e.itemType==='tool'&&e.itemId === started.itemId&&e.ok===true));
}
