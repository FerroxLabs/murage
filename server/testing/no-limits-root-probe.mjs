// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only inspection of the container root; the rsync input is never executed.
import { inspectOwnerOperation } from '../../server/no-limits-inspection.ts';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from '../../server/testing/cleanup.ts';
const ordinary=process.argv[2]==='ordinary';
let root;
try{
 if(ordinary){root=mkdtempSync(join(tmpdir(),'nlsym-cost-'));for(let i=0;i<64;i++)writeFileSync(join(root,'file-'+i),'fake fixture');}
 const start=performance.now();
 const result=inspectOwnerOperation({kind:'exec',dialect:'sh',text:`rsync -a ${root??'/'} /tmp/nlsym-cost-out`,cwd:'/tmp',cwdInvalid:false});
 console.log(JSON.stringify({verdict:result.verdict,effects:result.effects.length,decisions:result.decisions.length,hazards:result.hazards.length,milliseconds:performance.now()-start,maxRSS:process.resourceUsage().maxRSS}));
}finally{if(root)removeTempDirSync(root);}
