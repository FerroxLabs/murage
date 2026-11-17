// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {wipeBreaker,nativeWipeBreaker} from '../wipe-breaker.ts';
const context={cwd:'/work/project',project:'/work/project',home:'/home/u',pathPort:{realpath:(p:string)=>p,isBlockDevice:()=>null}};
it.each([
 'rm --help -rf /','mv --help /work/project /tmp/away','rsync --version --delete ./src /work/project',
 'sudo -V rm -rf /','sudo -l rm -rf /','env --help rm -rf /','command -v rm -rf /','bash --help -c "rm -rf /"','bash -n -c "rm -rf /"',
])('H5 nonexecuting mode runs: %s',text=>expect(wipeBreaker(text,context)).toBeNull());
it.each(['rm --help -rf / >/dev/sda','sudo -V >/dev/sda','bash -n -c "rm -rf /" >/dev/sda'])('H5 nonexecuting programs retain shell redirect writes: %s',text=>expect(wipeBreaker(text,context)?.rule).toBe('disk-erase'));
it.each(['/tmp/safe','/home/u'])('X22 readable native depth is not an approval policy: %s',path=>{
 let input:unknown={path};for(let i=0;i<64;i++)input={entries:[input]};
 expect(nativeWipeBreaker('delete_files',input,context)?.rule??null).toBe(path==='/home/u'?'delete-home':null);
});
it.each(['rm -rf -- --help /','bash -c "rm -rf /" --help'])('H5 data operands do not select help mode: %s',text=>expect(wipeBreaker(text,context)?.rule).toBe('delete-root'));
it('H5 a login-shell option still executes its command',()=>expect(wipeBreaker('bash -login -c "rm -rf /"',context)?.rule).toBe('delete-root'));
