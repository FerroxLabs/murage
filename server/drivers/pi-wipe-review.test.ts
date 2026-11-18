// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner Pi gate: c3-drivers; owner review regression: c3-nl-b.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTempDirSync} from '../testing/cleanup.ts';
import piPermissionGate from './pi-permission-gate.ts';
// Owners: inventory producer fixture and offline consumer — pi-roots-b.
let dir:string;
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'pi-review-'));const inventoryPath=join(dir,'inventory'),descriptor=join(dir,'context');
 writeFileSync(inventoryPath,'MURAGE-PI-ROOTS 1 R 00000000-0000-4000-8000-000000000001\n[]');
 writeFileSync(descriptor,JSON.stringify({context:{},inventoryPath}));vi.stubEnv('MURAGE_PI_WIPE_CONTEXT_FILE',descriptor);
});
afterEach(()=>{removeTempDirSync(dir);
 vi.unstubAllEnvs();
 delete (globalThis as Record<symbol,unknown>)[Symbol.for('murage.piGate')];
});

it.each([false,true])('BLOCK-PI home contents block through the disconnected hook, missing secret=%s',async missing=>{
 vi.stubEnv('MURAGE_PI_GATE',missing?'':'fixture-gate');
 vi.stubEnv('MURAGE_PI_NO_LIMITS','1');
 const handlers=new Map<string,(event:any,context:any)=>unknown>();
 piPermissionGate({on:(name:string,handler:any)=>handlers.set(name,handler)} as never);
 const call=handlers.get('tool_call')!;
 const context={cwd:'/work/project/pkg',hasUI:false,ui:{}};
 expect(await call({toolName:'bash',input:{command:'rm -rf ~/*'}},context)).toMatchObject({block:true});
 expect(await call({toolName:'bash',input:{command:'rm -rf /usr/*'}},context)).toMatchObject({block:true});
 expect(await call({toolName:'bash',input:{command:'rm -rf /*'}},context)).toMatchObject({block:true});
 expect(await call({toolName:'bash',input:{command:'rm -rf /work/project/pkg/build/*'}},context)).toBeUndefined();
 expect(await call({toolName:'bash',input:{command:'printf "rm -rf ~/*"'}},context)).toBeUndefined();
});
