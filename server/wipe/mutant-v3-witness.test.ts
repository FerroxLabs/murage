// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER mutation witness: wipe-v3. OWNER shared context fixture: wipe-v3-tests.
import {afterEach,expect,it,vi} from 'vitest';
import {wipeBreaker} from '../wipe-breaker.ts';
import {linuxContext} from './corpus/v3-context.fixture.ts';
import * as invocation from './invocation.ts';
import {MountInventory,readMountPaths} from './mounts.ts';
import {parseSh} from './sh.ts';
import {parsePwsh} from './pwsh.ts';
import {parseCmd} from './cmd.ts';
import type {Node,Script} from './types.ts';
afterEach(()=>vi.restoreAllMocks());
it('V3-MU-cap retains the protected starting cwd when relative cd states overflow',()=>{
 const command='cd a; cd b; cd c; cd d; cd e; rm -rf .';
 expect(wipeBreaker(command,linuxContext({cwd:'/work/project'}))?.rule).toBe('delete-system-folder');
});
it('V3-G4-proof weak variable alternatives retain a protected original past capacity',()=>{
 const command='D=/home; if test ready; then D=/scratch/a; D=/scratch/b; D=/scratch/c; D=/scratch/d; D=/scratch/e; fi; rm -rf "$D"';
 expect(wipeBreaker(command,linuxContext())?.rule).toBe('delete-home');
});
it('V3-G4-functions-proof conditional definition overflow retains the newest executable body',()=>{
 const command=`f(){ echo ready; }; if test ready; then f(){ echo 'rm -rf /home'; }; f(){ echo 'rm -rf /usr'; }; f(){ echo 'rm -rf /etc'; }; f(){ rm -rf "$1"; }; fi; f /home`;
 expect(wipeBreaker(command,linuxContext())?.rule).toBe('delete-home');
});
it('V3-PREMISE-proof unresolved options and every recursive positional path retain root protection',()=>{
 for(const command of ['rm $flags /home','Remove-Item $flags /home','Remove-Item -c x -Recurse /home'])expect(wipeBreaker(command,linuxContext({dialect:command.startsWith('Remove')?'pwsh':'sh'}))?.rule).toBe('delete-home');
 for(const command of ['flags=; rm $flags /home','unset flags; rm $flags /home','rm -- $flags /home','rm $flags /scratch/cache'])expect(wipeBreaker(command,linuxContext())).toBeNull();
});
it('V3-F3-proof cygdrive paths join the Windows drive family',()=>{
 const context={...linuxContext(),platform:'win32' as const,home:'C:\\Users\\u',cwd:'C:\\work\\project\\pkg',project:'C:\\work\\project'};
 expect(wipeBreaker('rm -rf /cygdrive/c/Users',context)?.rule).toBe('delete-home');
});
it('V3-G1-proof parser and walker faults preserve executable positions and operand roles',()=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('fixture-parse');});
 vi.spyOn(invocation,'walk').mockImplementation(()=>{throw Error('fixture-walk');});
 for(const text of ['echo "rm -rf /"','rm /','mv ./a /work/project'])expect(wipeBreaker(text,linuxContext())).toBeNull();
 expect(wipeBreaker('rm -rf /',linuxContext())?.rule).toBe('delete-root');
});
it('V3-G3-proof mount adapters exclude virtual filesystems and retain persistent mounts',()=>{
 const table='10 1 0:1 / / rw - ext4 fixture rw\n11 10 0:2 / /tmp rw - tmpfs fixture rw\n12 10 0:3 / /scratch/data rw - ext4 fixture rw\n';
 const inventory=new MountInventory(()=>readMountPaths('linux',()=>table,()=>''));inventory.refresh();
 const context=linuxContext({mountInventory:inventory});
 expect(wipeBreaker('rm -rf /tmp',context)).toBeNull();
 expect(wipeBreaker('rm -rf /scratch/data',context)?.rule).toBe('delete-root');
});
it('V3-S1-proof parser nodes retain normalized statement spans including compounds',()=>{
 const samples=[parseSh('echo ready | cat; cleanup(){ echo done; }; (echo nested)'),parsePwsh('Write-Output ready | Sort-Object; function cleanup { Write-Output done }; { Write-Output data }'),parseCmd('echo ready & echo done')];
 const scripts:Script[]=samples.slice();
 while(scripts.length){const script=scripts.pop()!;for(const node of script.nodes){
  expect(node.span).toHaveLength(2);expect(node.span[0]).toBeGreaterThanOrEqual(0);expect(node.span[1]).toBeGreaterThanOrEqual(node.span[0]);
  if(script.source!==undefined)expect(node.span[1]).toBeLessThanOrEqual(script.source.length);
  if('body'in node)scripts.push(node.body);
  if(node.k==='pipe'||node.k==='list')scripts.push({nodes:(node.k==='pipe'?node.stages:node.items) as Node[],incompleteTail:false,source:script.source});
 }}
});
it('V3-S9-fields-proof recovery retains option uncertainty, glob quoting and executed assignments',()=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('fixture-parse');});
 vi.spyOn(invocation,'walk').mockImplementation(()=>{throw Error('fixture-walk');});
 for(const command of ['echo "rm -rf /home"','rm -rf "/home/*"','rm -- $flags /home','rm $flags /scratch/cache','echo \" > /dev/sda\"','printf x > /scratch/file','rm -rf /scratch/cache > /home','rm -rf /scratch/cache < /home','bash -n -c \"rm -rf /home\"','command -v rm -rf /home','sudo --help rm -rf /home','find --help /home -delete'])expect(wipeBreaker(command,linuxContext()),command).toBeNull();
 for(const command of ['rm $flags /home','rm -rf /home/*'])expect(wipeBreaker(command,linuxContext())?.rule).toBe('delete-home');
 expect(wipeBreaker('printf x > /dev/sda',linuxContext())?.rule).toBe('disk-erase');
 expect(wipeBreaker('rm -rf *',linuxContext({cwd:'/work/project'}))?.rule).toBe('delete-system-folder');
 expect(wipeBreaker("[object]$x.Value = Remove-Item -Recurse /home",linuxContext({dialect:'pwsh'}))?.rule).toBe('delete-home');
 expect(wipeBreaker("$x = Write-Output 'Remove-Item -Recurse /home'",linuxContext({dialect:'pwsh'}))).toBeNull();
});
it('V3-S7-home-glob-proof direct home-child patterns retain the home-root family',()=>{
 for(const command of ['rm -rf /home/user-*','rm -rf /Users/dev?*'])expect(wipeBreaker(command,linuxContext())?.rule).toBe('delete-home');
 for(const command of ['rm -rf /home/u/cache-*','rm -rf /home/u/project-*/cache'])expect(wipeBreaker(command,linuxContext())).toBeNull();
});
it('V3-S6-stdin-proof interpreter source follows command mode and script-file boundaries',()=>{
 const cases=[['python3','import shutil; shutil.rmtree("/home")','./reader.py'],['node','require("fs").rmSync("/home",{recursive:true})','./reader.js'],['ruby','FileUtils.rm_rf("/home")','./reader.rb']];
 for(const [program,source,file]of cases){
  const prefix=`printf %s '${source}' | `;
  expect(wipeBreaker(prefix+program,linuxContext())?.rule).toBe('delete-home');
  expect(wipeBreaker(prefix+program+' '+file,linuxContext())).toBeNull();
  expect(wipeBreaker(prefix+program+' '+file+` -e '${source}'`,linuxContext())).toBeNull();
 }
 expect(wipeBreaker(`printf %s 'require("fs").rmSync("/home",{recursive:true})' | node --check`,linuxContext())).toBeNull();
 expect(wipeBreaker(`python3 --help -c 'import shutil; shutil.rmtree("/home")'`,linuxContext())).toBeNull();
 expect(wipeBreaker(`printf %s 'import shutil; shutil.rmtree("/home")' | python3 -m fixture_module`,linuxContext())).toBeNull();
});
