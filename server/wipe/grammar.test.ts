// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { wipeBreaker,nativeEffectsWipe,nativeWipeBreaker } from '../wipe-breaker.ts';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { wipeEnvironment } from './context.ts';
import { RootRegistry } from './registry.ts';
import { parseSh } from './sh.ts';
import { MountInventory } from './mounts.ts';
const ctx={cwd:'/work/project',project:'/work/project',home:'/home/u',dataDir:'/home/u/.murage',env:{HOME:'/home/u',UNSET:undefined},mountInventory:new MountInventory(()=>[])};
// MAIN RULING WIPE-V3 A2/A16: a resolved root loop cards; dotfile-only project cleanup runs.
it.each([
 ['(cd /tmp); rm -rf .',true],['(cd / && rm -rf .)',true],// MAIN RULING v2 DELTA4 S10 and review High 4: a failed cd retains caller cwd.
 ['{ cd /tmp; }; rm -rf .',true],
 ['case x in x) rm -rf /;; esac',true],['for v in /; do rm -rf "$v"; done',true],
 ['rm -rf "${UNSET:-/}"',true],['echo "${UNSET:-$(rm -rf /)}"',true],['echo "${HOME:-$(rm -rf /)}"',false],['rm -rf "${HOME:?}/"',true],['rm -rf "${UNSET?}/"',false],
 ['HOME=/tmp; rm -rf ~',false],['X=~; rm -rf "${X:?}"',true],['export X=~; rm -rf "${X:?}"',true],['time -p rm -rf /',true],['taskset -c 0 rm -rf /',true],['taskset -c0 rm -rf /',true],['chrt -r 1 rm -rf /',true],
 ['bash -c "echo ok" >/dev/sda',true],['eval "echo ok" >/dev/sda',true],
 ["HOME=/tmp bash -c 'rm -rf ~'",false],['rm -rf /work/project/{*,.*}',true],['rm -rf /work/project/.*',false],
 ['rm -rf /work/project/*.log',false],['rm -rf /work/project/**/',true],
 ['cat <(rm -rf /)',true],['echo `rm -rf /`',true],['cat <<-EOF\n\trm -rf /\n\tEOF',false],
 ['diskutil list eraseDisk',false],['rm -rf "/work/project',true],['env -S "rm -rf /"',true],['sudo -g fixture rm -rf /',true],['sudo -D/tmp rm -rf .',false],
 ['rsync -a --delete ./src/ host:/home/u',false],['rsync -a --delete ./src/ /tmp/safe --log-file /home/u',false],
] as const)('%s', (text,card)=>expect(!!wipeBreaker(text,ctx)).toBe(card));
it('parsers retain redirects, balanced substitutions and incomplete tails as syntax',()=>{
 const script=parseSh('>log A=x rm -rf "$(echo /)"');const node=script.nodes[0]!;expect(node.k).toBe('cmd');
 if(node.k!=='cmd')throw Error('command');expect(node.c.redirects).toHaveLength(1);expect(node.c.assigns[0]?.name).toBe('A');expect(node.c.words[2]?.parts[0]?.k).toBe('subst');
 expect(parseSh('rm -rf "').incompleteTail).toBe(true);expect(parseSh('bash <<EOF\nrm -rf /').incompleteTail).toBe(true);
});
it('all native effect kinds stay direct, preserving sources and unknown recursion',()=>{
 expect(nativeEffectsWipe([{op:'delete',operandId:'native:0:remove-source',path:'/etc',followFinal:false}],ctx)).toBeTruthy();
 expect(nativeEffectsWipe([{op:'write',operandId:'native:grant-root',path:'/',followFinal:false}],ctx)).toBeNull();
 expect(nativeWipeBreaker('remove_directories',{entries:[{path:'/etc'}]},ctx)).toBeTruthy();
 expect(nativeWipeBreaker('delete_files',{paths:['/etc'],recursive:false},ctx)).toBeNull();
});

it('an explicitly unknown cwd never borrows the project for a relative operand',()=>{
 const unknown={...ctx,cwdOpaque:true};
 expect(wipeBreaker('rm -rf .',unknown)).toBeNull();
 expect(wipeBreaker('rm -rf /work/project',unknown)).toBeTruthy();
 expect(nativeWipeBreaker('delete_directory',{path:'.'},unknown)).toBeNull();
 expect(nativeWipeBreaker('delete_directory',{path:'/work/project'},unknown)).toBeTruthy();
});

it('a failed registry update cannot silently leave an unprotected new root',()=>{
 let fault=true;
 const fixturePort={realpath:(p:string)=>p,lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),isBlockDevice:()=>null};
 const registry=new RootRegistry({...fixturePort,realpath(p){if(fault)throw Error('fixture-root-fault');return p;}});
 // MAIN RULING 2026-11-14 AUDIT-WIPE-FABLE item 2: failed realpath retains lexical registration without throwing.
 expect(()=>registry.replace('task:fixture:task:cwd',['/work/new'])).not.toThrow();
 expect(wipeBreaker('rm -rf /work/new',{...ctx,registry,pathPort:fixturePort})).toBeTruthy();
 // MAIN RULING 23:15Z(d): registry failure alone is not wipe evidence.
 expect(wipeBreaker('rm -rf /tmp/x',{...ctx,registry,pathPort:fixturePort})).toBeNull();
 fault=false;registry.replace('task:fixture:task:cwd',['/work/new']);
 expect(wipeBreaker('rm -rf /work/new',{...ctx,registry,pathPort:{realpath:p=>p,isBlockDevice:()=>null}})).toBeTruthy();
 expect(wipeBreaker('rm -rf /tmp/x',{...ctx,registry,pathPort:fixturePort})).toBeNull();
 // MAIN RULING 2026-11-14 AUDIT-WIPE-FABLE item 2: owner-local failures preserve the updated lexical root.
 fault=true;expect(()=>registry.replace('task:fixture:task:cwd',['/work/next'])).not.toThrow();
 expect(wipeBreaker('rm -rf /work/next',{...ctx,registry,pathPort:fixturePort})).toBeTruthy();
 registry.dropBot('fixture');expect(wipeBreaker('rm -rf /tmp/x',{...ctx,registry,pathPort:fixturePort})).toBeNull();
});

it('exact native projection preserves path-as-source moves and directory recursion',()=>{
 const move=extractInspectedOperation({tool:'move_file',input:{path:'/work/project',destination:'/tmp/away'}});
 expect(move.kind).not.toBe('incomplete');if(move.kind==='incomplete')throw Error('exact move');
 expect(move.exactOperation.kind).toBe('native');
 if(move.exactOperation.kind==='native')expect(nativeEffectsWipe(move.exactOperation.effects,ctx)).toBeTruthy();
 const removed=extractInspectedOperation({tool:'rm_files',input:{path:'/etc'}});
 expect(removed.kind).not.toBe('incomplete');if(removed.kind==='incomplete')throw Error('exact rm');
 if(removed.exactOperation.kind==='native')expect(nativeEffectsWipe(removed.exactOperation.effects,ctx)).toBeTruthy();
 const deletion=extractInspectedOperation({tool:'delete_directory',input:{path:'/etc',recursive:false}});
 expect(deletion.kind).not.toBe('incomplete');if(deletion.kind==='incomplete')throw Error('exact delete');
 // MAIN RULING binding v2 DELTA6 X14: explicit recursive:false survives extraction.
 if(deletion.exactOperation.kind==='native')expect(nativeEffectsWipe(deletion.exactOperation.effects,ctx)).toBeNull();
});

it('case-insensitive variables retain caller precedence and later assignments',()=>{
 const windows={...ctx,home:'C:\\Users\\u',cwd:'C:\\Users\\u\\proj',project:'C:\\Users\\u\\proj',platform:'win32' as const,env:{userprofile:'C:\\safe',target:'C:\\safe'}};
 expect(wipeBreaker('Remove-Item -Recurse $env:USERPROFILE',{...windows,dialect:'pwsh'})).toBeNull();
 expect(wipeBreaker('rd /s %USERPROFILE%',{...windows,dialect:'cmd'})).toBeNull();
 expect(wipeBreaker("$env:TARGET='C:\\Users\\u'; Remove-Item -Recurse $env:target",{...windows,dialect:'pwsh'})).toBeTruthy();
});

it('ancestors of macOS physical OS aliases retain whole-root protection',()=>{
 expect(wipeBreaker('rm -rf /private',{...ctx,platform:'darwin'})?.rule).toBe('delete-system-folder');
 expect(wipeBreaker('rm -rf /private/var/nginx',{...ctx,platform:'darwin'})).toBeNull();
 expect(wipeBreaker('rm -rf /private',{...ctx,platform:'linux'})).toBeNull();
});

it('environment overlays preserve every legal variable name',()=>{
 const env=wipeEnvironment(undefined,{['__proto__']:'/etc'});
 expect(wipeBreaker('rm -rf "$__proto__"',{...ctx,env})).toBeTruthy();
});

it('opaque loop variables do not consume an executable nesting level',()=>{
 let text='for v in /; do echo ok; done';
 for(let i=0;i<8;i++)text="bash -c '"+text.replaceAll("'","'\\''")+"'";
 expect(wipeBreaker(text,ctx)).toBeNull();
});
