// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner release consumer: c3-nl-b. Owner checker: wipe-fable.
import {afterEach,expect,it} from 'vitest';
import {inspectReleaseWipes,installReleaseContextReader,releaseGuard} from './release-guard.ts';
import {installWipeContextReader} from '../wipe/context.ts';
import {linuxContext} from '../wipe/corpus/v3-context.fixture.ts';
import {extractInspectedOperation,issuedOperationHash} from '../no-limits-operation.ts';
import type {ExecEnv} from '../../shared/mount-identity.ts';
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const off of cleanups.splice(0))off();});
const command='rm -rf "$BUILD_DIR"/*';
const operation={kind:'exec',text:command,dialect:'sh',cwd:'/work/project/pkg',cwdInvalid:false} as const;
const engine=(env:Record<string,string>,absent:string[]=[]):ExecEnv=>({env,absent,cwd:operation.cwd,shell:['sh','-c'],capture:'session'});
it('release resolves the same engine variable as decision time',()=>{
 cleanups.push(installWipeContextReader(()=>linuxContext()));
 expect(inspectReleaseWipes(operation,false,{threadId:'t',execEnv:engine({BUILD_DIR:'/work/project/pkg/build'})})).toEqual([]);
 expect(inspectReleaseWipes(operation,false,{threadId:'t',execEnv:engine({BUILD_DIR:'/home/u'})})[0]?.hit.rule).toBe('delete-home');
});
it('release keeps trusted engine absence over a caller value',()=>{
 cleanups.push(installWipeContextReader(()=>linuxContext({env:{BUILD_DIR:'/work/project/pkg/build'}})));
 expect(inspectReleaseWipes(operation,false,{threadId:'t',execEnv:engine({},['BUILD_DIR'])})[0]?.hit.rule).toBe('delete-root');
});
it('the final release guard carries its authenticated engine environment',()=>{
 cleanups.push(installWipeContextReader(()=>linuxContext()));
 const extracted=extractInspectedOperation({tool:'Bash',input:{command,cwd:operation.cwd}});
 if(extracted.kind==='incomplete')throw Error('fixture operation');
 const issued=extracted.exactOperation,operationHash=issuedOperationHash(issued)!;
 cleanups.push(installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash,execEnv:engine({BUILD_DIR:'/work/project/pkg/build'}),inspect:()=>({decisions:[]}),approved:()=>undefined})));
 expect(releaseGuard({requestKey:'r',threadId:'t',generation:'g',exactOperation:issued,operationHash,releaseKind:'native'})).toEqual({kind:'release'});
});
