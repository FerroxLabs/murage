// A capability switch must be witnessed independently of permission decisions.
export function featureOffErrors(spec, observation) {
 const errors=[], witness=observation.featureOff;
 if (!spec.feature || witness?.feature !== spec.feature) errors.push('disabled capability source unproven');
 if (witness?.actionExecuted !== false || witness?.actionNotRunProven !== true) errors.push('disabled feature ran or non-execution is unproven');
 if (witness?.continued !== true) errors.push('disabled feature did not continue the turn');
 const tools={'host-computer':/computer|screenshot/i,browser:/browser/i,'app-integration':/composio|connector|mcp__app/i,'channel-messages':/./};
 if (observation.actionSink?.executed === true || (observation.events??[]).some(e=>e.itemType==='tool' && tools[spec.feature]?.test(e.toolIdentity?.name??e.tool??e.title??'')))
  errors.push('disabled capability reached an action sink or tool event');
 const lines=witness?.ownerLines;
 if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string' || /[\r\n\u2028\u2029]/.test(lines[0])
   || !/\boff\b|\bdisabled\b|\bdisconnected\b/i.test(lines[0]) || !/settings|turn .* on|enable .* in|connect .* in/i.test(lines[0]))
  errors.push('disabled feature requires one plain line saying it is off and where to enable it');
 if ((observation.messages??[]).some(m=>m.kind==='options'&&m.card) || (observation.cards?.length??0) || (observation.questions??0) || (observation.holds??0)) errors.push('disabled feature showed a card or hold');
 return errors;
}
