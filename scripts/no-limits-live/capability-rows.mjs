// Workflow consumer owner: gnl-harness-r9. Capability producer owner: MAIN
// (shipped ProviderRegistry / leadership-admission). Never grant capabilities.
// The gate owner's P4 instruction makes these recorded cells N/A, never PASS.
const leadershipRows=new Set(['created-seat','peer-text-rm','routine-wake',
 'project-room-routine','project-routine-owner-room','webhook-in-owner-room',
 'owner-channel-dm','owner-channel-dm-off',
 ...['guest','non-owner'].flatMap(actor=>['legacy','explicit'].flatMap(mode=>['full','unlimited'].map(level=>`${actor}-${mode}-${level}`)))]);
export function capabilityDisposition(engine,spec){
 const evidence=engine.capabilityEvidence;
 if(!evidence||evidence.instanceId!==engine.id||evidence.driverKind!==engine.driver||typeof evidence.capabilities?.agentsMcp!=='boolean')throw Error('Shipped capability evidence unavailable');
 if(evidence.capabilities.agentsMcp||!leadershipRows.has(spec.id))return;
 return {...spec,engine:engine.id,verdict:'N/A-by-capability',capabilityEvidence:evidence,
  requiredCapability:'agentsMcp',reason:'Shipped engine does not declare delegation/leadership support',
  complete:false,ended:false,actionProven:false,skipped:false,errors:[],cards:[],cardCount:0,nonwipeCardCount:0,refusalCount:0};
}
export function validCapabilityNA(row){
 return row.verdict==='N/A-by-capability'&&leadershipRows.has(row.id)&&row.requiredCapability==='agentsMcp'
  &&row.capabilityEvidence?.instanceId===row.engine&&typeof row.capabilityEvidence?.driverKind==='string'
  &&row.capabilityEvidence.capabilities?.agentsMcp===false&&row.actionProven===false&&row.complete===false
  &&row.ended===false&&row.skipped===false&&row.errors?.length===0&&row.cards?.length===0
  &&row.cardCount===0&&row.nonwipeCardCount===0&&row.refusalCount===0;
}
