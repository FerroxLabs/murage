// SPDX-License-Identifier: AGPL-3.0-or-later
// The unset-variable rule depends on the caller passing the engine's real environment.
import {expect,it} from 'vitest';
import {wipeBreaker} from '../wipe-breaker.ts';
import {wipeEnvironment} from './context.ts';
import {corpusContext} from './corpus/v3-context.fixture.ts';
const row={platform:'linux',dialect:'sh',cwd:'/work/project/pkg'} as const;
const check=(command:string,env?:Record<string,string|undefined>)=>wipeBreaker(command,corpusContext(row,env?{env}:{}));
it('ENV-1 a variable set in the engine environment resolves and the cleanup runs',()=>{
 expect(check('rm -rf $WIPE_FABLE_BUILD_DIR/*',{WIPE_FABLE_BUILD_DIR:'/work/project/pkg/build'})).toBeNull();
 expect(check('rm -rf "$WIPE_FABLE_DIR"/',{WIPE_FABLE_DIR:'/work/project/pkg/dist'})).toBeNull();
});
it('ENV-2 a variable absent from the engine environment and not assigned in the command cards as a root delete',()=>{
 expect(check('rm -rf $WIPE_FABLE_BUILD_DIR/*',{})?.rule).toBe('delete-root');
 expect(check('rm -rf "$WIPE_FABLE_DIR"/')?.rule).toBe('delete-root');
});
it('ENV-3 a name the engine reports absent stays unset over a caller value',()=>{
 const env=wipeEnvironment({WIPE_FABLE_BUILD_DIR:'/work/project/pkg/build'},{},['WIPE_FABLE_BUILD_DIR']);
 expect(check('rm -rf $WIPE_FABLE_BUILD_DIR/*',env)?.rule).toBe('delete-root');
});
it('ENV-4 a variable set in the engine environment to a listed root still cards',()=>{
 expect(check('rm -rf $WIPE_FABLE_BUILD_DIR/*',{WIPE_FABLE_BUILD_DIR:'/home/u'})?.rule).toBe('delete-home');
});
it('ENV-5 nounset aborts the expansion, so the guarded cleanup runs; without it the same text cards',()=>{
 for(const command of ['set -u; rm -rf "$WIPE_FABLE_BUILD_DIR"/*','set -euo pipefail; rm -rf "$WIPE_FABLE_BUILD_DIR"/*',`bash -u -c 'rm -rf "$WIPE_FABLE_BUILD_DIR"/*'`])expect(check(command,{}),command).toBeNull();
 expect(check('set -u; set +u; rm -rf "$WIPE_FABLE_BUILD_DIR"/*',{})?.rule).toBe('delete-root');
 expect(check('set -u; rm -rf ~',{})?.rule).toBe('delete-home');
});
it('AREV1-8 malformed loop text returns at once',()=>{
 const started=Date.now();
 for(const command of ['for d in (','for d in ( ; do rm -rf build; done','select d in (','for d in <(ls); do echo $d; done'])expect(check(command)).toBeNull();
 expect(Date.now()-started).toBeLessThan(1000);
});
it('ENV-6 a value only the server process holds is never a variable value (MAIN 1114-WIPE-FIXTURE-DIRECTION item 5)',()=>{
 const name='WIPE_R1114_SERVER_ONLY',before=process.env[name];process.env[name]='/work/project/pkg/out';
 try{
  // The engine never received it: `"$VAR"/*` is `/*`. With no env from the caller at all the answer is the same.
  expect(check('rm -rf "$'+name+'"/*',{HOME:'/home/u'})).not.toBeNull();
  expect(wipeBreaker('rm -rf "$'+name+'"/*',{...corpusContext(row),env:undefined})).not.toBeNull();
  expect(check('rm -rf "$'+name+'"/*',{HOME:'/home/u',[name]:'/work/project/pkg/out'})).toBeNull();
 }finally{if(before===undefined)delete process.env[name];else process.env[name]=before;}
});
