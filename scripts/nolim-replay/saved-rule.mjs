// A label cannot stand in for a saved matching permission rule.
export const storedRuleLabel = label => ['deny','owner-deny','permission-rule'].includes(label?.kind);
export function matchingSavedRule(row) {
 const source=row.label?.denySource;
 const evidence=row.denySnapshot?.evidence;
 if(typeof source!=='string'||!source||!Array.isArray(evidence))throw Error('Matching saved permission rule evidence required');
 const matches=evidence.filter(e=>e.kind==='deny'&&e.ruleId===source&&typeof e.class==='string'&&typeof e.span==='string');
 if(matches.length!==1)throw Error('One matching saved permission rule required');
 return structuredClone(matches[0]);
}
export function savedRuleProven(row,got) {
 const saved=matchingSavedRule(row),w=got.permissionRuleWitness;
 return w?.ruleInstalled===true&&w.source===saved.ruleId&&w.actionExecuted===true;
}
