// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: wipe-rd2 owns shell invocation parsing; c3-decision owns these inert
// admission and release controls. No shell command executes in this fixture.
import {expect,it} from 'vitest';
import {fixture,d,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';

it.each(['-euo pipefail','-euO extglob','-o pipefail -o errexit'])(
 'shell option values precede the command body: %s',options=>{
  const f=fixture();
  try{
   const safe=`bash ${options} -c 'echo fixture'`;
   const wipe=`bash ${options} -c 'rm -rf ~'`;
   expect(d.decide(f.open('safe',{command:safe}),baseRun).kind).toBe('run');
   expect(d.decide(f.open('wipe',{command:wipe}),baseRun).kind).toBe('card');
   expect(guardEngineRelease({threadId:'t',requestId:'safe',turnId:'turn',providerInstanceId:'p'},{command:wipe})).toBe(false);
   expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({requestId:'safe',why:'wipe'}));
   expect(f.respond).not.toHaveBeenCalled();
  }finally{f.dispose();}
 });

it.each([
 "bash -euo pipefail script.sh -c 'rm -rf ~'",
 "bash -euo pipefail -c 'echo fixture' ignored -c 'rm -rf ~'",
])('a later positional -c never supplies a new executable body: %s',command=>{
 const f=fixture();
 try{expect(d.decide(f.open('positional',{command}),baseRun).kind).toBe('run');}
 finally{f.dispose();}
});
