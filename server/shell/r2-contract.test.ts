// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import * as lexer from './segments.ts';
import { commandRoles,writeSlots } from './roles.ts';
import { r2Rows } from '../testing/no-limits-r2-cases.ts';
import { archiveWrites } from '../no-limits-archives.ts';
import { posix } from 'node:path';
// MAIN 2026-11-11 23:30Z and GNU tar manual §6.10.1:
// https://www.gnu.org/software/tar/manual/html_node/directory.html
// Relative -C is cumulative, including an unused preceding chdir-read slot.
it.each(['tar','gtar','bsdtar'])('X3 %s cumulative relative extraction roots',program=>{
 const writes=(args:string[])=>archiveWrites(program,args,args.map(path=>[{kind:'literal' as const,text:path,path}]),'/work')!.map(path=>posix.normalize(path));
 expect(writes(['-xf','/tmp/a','-C','/etc','-C','./w'])).toEqual(['/etc/w']);
 expect(writes(['-xf','/tmp/a','-C','/tmp','-C','./w'])).toEqual(['/tmp/w']);
 expect(writes(['-xf','/tmp/a','-C','/etc','m','-C','./w'])).toEqual(['/etc','/etc/m']);
});
it('H3 streams every segment without retaining an array',()=>{
 expect(lexer).toHaveProperty('forEachSegment');
 let seen=0,last='';
 (lexer as any).forEachSegment('true;'.repeat(5000)+'touch ~/.ssh/config',(segment:lexer.Segment)=>{seen++;if(segment.words.length)last=segment.words[0]!.text??'';});
 expect(seen).toBeGreaterThan(5000);expect(last).toBe('touch');
});
it('H3 flat depth preserves inner executable operators',()=>{
 const result=lexer.segments('echo '+'$(echo '.repeat(10)+'$(touch ~/.ssh/config)'+')'.repeat(10));
 expect(result.segments.some(s=>s.words[0]?.text==='touch')).toBe(true);
 expect(Math.max(...result.segments.map(s=>s.depth))).toBe(8);
});
it('H3 oversized words are unknown locally and later operands survive',()=>{
 const result=lexer.segments("echo '"+'x'.repeat(300*1024)+"'; touch ~/.ssh/config");
 expect(result.segments[0]?.words[1]?.origin).toBe('unknown');
 expect(result.segments.some(s=>s.words[0]?.text==='touch')).toBe(true);
});
for(const row of r2Rows.filter(row=>/^(E-|P-)/.test(row.id)&&!row.id.startsWith('E-RAW-')))it(`H4/H5 slots ${row.id}`,()=>{
 const commands=lexer.segments(row.command).segments.filter(s=>s.words.length);
 const s=commands.at(-1)!;const roles=commandRoles(s.words.map(w=>w.text));
 if(row.id.startsWith('E-')&&!row.id.startsWith('E-FIND-RUN')&&!row.id.startsWith('E-RAW-')){expect(roles.nested?.length??0,row.id).toBeGreaterThan(0);expect(roles.slots.some(slot=>slot.role==='command'),row.id).toBe(true);}
 if(row.id.startsWith('P-')&&!row.id.startsWith('P-REF'))expect(writeSlots(roles).some(slot=>slot.value===(row.protect?'~/.ssh/config':row.id.startsWith('P-c-')?'./d':'./notes')||slot.value==='~/.ssh')).toBe(true);
});
it('H5 an invalid mode is a write, never greedily consumed',()=>{
 expect(writeSlots(commandRoles(['chmod','~/.ssh/config'])).map(s=>s.value)).toEqual(['~/.ssh/config']);
 expect(commandRoles(['chmod','--reference=~/.ssh/config','./notes']).slots.find(s=>s.key==='--reference')?.role).toBe('read');
});
it('RE-ENTRY-PARITY all walker forms have a shared role entry',()=>{
 for(const words of [['bash','-c','touch ./n'],['eval','touch ./n'],['trap','touch ./n','EXIT'],['su','me','-c','touch ./n'],['env','-S','touch ./n'],['find','.','-exec','touch','./n',';'],['xargs','touch','./n'],['pwsh','-c','touch ./n'],['cmd','/c','touch ./n']]){
 const roles=commandRoles(words);expect(roles.nested?.length||roles.wrappers.includes('xargs'),words.join(' ')).toBeTruthy();
 }
});
it('H4 plus terminates find execution only after {}',()=>{
 const r=commandRoles(['find','.','-exec','touch','+','~/.ssh/config',';']);
 expect(r.nested?.[0]?.words?.map(w=>w.text)).toEqual(['touch','+','~/.ssh/config']);
});
it('L5 fd and shell argument precedence select code stdin',()=>{
 for(const row of r2Rows.filter(row=>row.id.startsWith('L5-'))){
 const result=lexer.segments(row.command,{command:commandRoles});
 expect(result.segments.some(s=>s.via==='heredoc-code'||s.via==='heredoc-subst'),row.id).toBe(row.protect||/L5-(?:STDIN|QUEUE|FD0-LAST)/.test(row.id));
 }
});
it('H4 nested argv retains exact raw words and expansion provenance',()=>{
 const segment=lexer.segments('find . -execdir tee "$prefix/hosts" \\;').segments[0]!;
 const r=commandRoles(segment.words.map(w=>w.text),'posix',segment.words);
 expect(r.nested?.[0]?.words?.[1]).toEqual(segment.words[4]);
 expect(r.nested?.[0]?.words?.[1]).toMatchObject({raw:'"$prefix/hosts"',origin:'expansion',text:undefined});
});
