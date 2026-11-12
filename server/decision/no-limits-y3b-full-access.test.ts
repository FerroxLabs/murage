// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { d, fixture, baseRun } from './fixture.ts';
import { hash } from './bounds.ts';
import { protectedEvidence, wipeEvidence } from './action.ts';
import { y3bRows } from '../testing/no-limits-y3b-cases.ts';
import type { Registration } from './types.ts';
// Captured from the requested RC base be6823cf1d, never from the candidate.
// Replaces the pre-RC fixture whose 93 stale reader-target rows also failed on base.
for(const posture of ['full','unproven','service'] as const) for(const row of y3bRows) it(`H1 ${posture} ${row.id}`,async()=>{
 const f=fixture(posture==='unproven'?'unlimited':'full');
 if(posture==='unproven')d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
 const denyArguments:unknown[]=[];
 d.installDenySources({revision:()=>['1'],resolve:(...args)=>{denyArguments.push(args);return [];}});
 const input={command:row.command,cwd:row.cwd};
 let registration:Registration|undefined;
 d.installEngineApprovalBuilder(r=>{registration=r;return {options:['Allow','Deny']};});
 const base=(r:Registration)=>{registration=r;return baseRun();};
 const call={tool:'Bash',input};
 const handle=posture==='service'?d.openRequest({kind:'service',service:'email',claim:f.claim,call}):f.open('r',input);
 const verdict=d.decide(handle,base);
 // Full/unproven snapshots include all action bytes and real deny source calls.
 const action=d.describeAction(call);
 const captured={action,codeIdentity:action.codeIdentity,targets:action.targets,deletes:action.deletes,denyArguments,
  registration:registration??null,protected:protectedEvidence(action),wipe:wipeEvidence(action),verdict:verdict.kind};
 expect({bytes:JSON.stringify(captured),sha256:hash(captured)}).toMatchSnapshot();
 f.dispose();
});
