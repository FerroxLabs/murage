// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { d,fixture,baseRun,snapshotRegistration } from './fixture.ts';
import { hash } from './bounds.ts';
import { protectedEvidence,wipeEvidence } from './action.ts';
import { r2Rows,physicalFullAccessRows } from '../testing/no-limits-r2-cases.ts';
import { segmentDesignRows } from '../testing/no-limits-segment-design-cases.ts';
import { y3bRows } from '../testing/no-limits-y3b-cases.ts';
import { writeFileSync,mkdirSync } from 'node:fs';
import type { Registration } from './types.ts';
// MAIN r2.1: these bytes are captured on int-A's own 3b6e50f868 baseline.
const rows=[...r2Rows,...physicalFullAccessRows,...segmentDesignRows.map(row=>({...row,cwd:'/work'})),...y3bRows];
for(const posture of ['full','unproven','service'] as const)for(const row of rows)it(`X2 H1 ${posture} ${row.id}`,()=>{
 const f=fixture(posture==='unproven'?'unlimited':'full');
 // MAIN RULING 2026-11-13 authenticated owner turn: missing provenance stays Ask even when the thread's live owner settings say No limits.
 if(posture==='unproven')d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
 const denyArguments:unknown[]=[];d.installDenySources({revision:()=>['1'],resolve:(...args)=>{denyArguments.push(args);return [];}});
 let registration:Registration|undefined;
 d.installEngineApprovalBuilder(r=>{registration=r;return {options:['Allow','Deny']};});
 const base=(r:Registration)=>{registration=r;return baseRun();};
 const input={command:row.command,cwd:row.cwd};const tool='tool' in row?row.tool??'Bash':'Bash';const call={tool,input};
 const handle=posture==='service'?d.openRequest({kind:'service',service:'email',claim:f.claim,call}):f.open('r',input,{tool,toolCall:{name:tool,input}});
 const verdict=d.decide(handle,base),action=d.describeAction(call);
 const captured={action,codeIdentity:action.codeIdentity,targets:action.targets,deletes:action.deletes,denyArguments,registration:snapshotRegistration(registration)??null,protected:protectedEvidence(action),wipe:wipeEvidence(action),verdict:verdict.kind};
 if(process.env.X2_FA_CAPTURE){mkdirSync(process.env.X2_FA_CAPTURE,{recursive:true});writeFileSync(`${process.env.X2_FA_CAPTURE}/${posture}-${row.id}.json`,JSON.stringify(captured));}
 if(posture==='unproven')expect(registration).toMatchObject({actor:'unproven',level:'ask'});
 expect(hash(captured)).toMatchSnapshot();f.dispose();
},30000);
