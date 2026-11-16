// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner fallback consumer: c3-nl-b. Owner corpus/checker: wipe-fable.
import {afterEach,expect,it,vi} from 'vitest';
import {visibleWipe,visibleDeleteTarget} from './no-limits-visible-wipe.ts';
import * as checker from '../server/wipe-breaker.ts';
import {readFileSync} from 'node:fs';
import {corpusContext,linuxContext,type CorpusRow} from '../server/wipe/corpus/v3-context.fixture.ts';
const rows=JSON.parse(readFileSync(new URL('../server/wipe/corpus/wipe-corpus-v3.json',import.meta.url),'utf8')) as CorpusRow[];
afterEach(()=>vi.restoreAllMocks());
const visible=(text:string,context:ReturnType<typeof linuxContext>)=>visibleWipe(text,context.home!,0,context.dialect==='pwsh'?'powershell':context.dialect==='cmd'?'cmd':'posix',context.cwd,context);
// All rows are visible command text, including the reported disguised tier.
// The fallback receives exactly the same host context and injected path facts.
it.each(rows as CorpusRow[])('v3 fallback parity $id',row=>{
 const context=corpusContext(row);
 expect(visible(row.cmd,context)).toBe(checker.wipeBreaker(row.cmd,context)?.rule??null);
});
it('fallback retains engine values, trusted absence and nounset semantics',()=>{
 const command='rm -rf "$BUILD_DIR"/*';
 expect(visible(command,linuxContext({env:{BUILD_DIR:'/work/project/pkg/build'}}))).toBeNull();
 expect(visible(command,linuxContext({env:{BUILD_DIR:undefined}}))).toBe('delete-root');
 expect(visible('set -u; '+command,linuxContext({env:{BUILD_DIR:undefined}}))).toBeNull();
});
it('an unavailable checker fails to a card for shell and native fallback',()=>{
 vi.spyOn(checker,'wipeBreaker').mockImplementation(()=>{throw Error('fixture fault');});
 vi.spyOn(checker,'nativeWipeBreaker').mockImplementation(()=>{throw Error('fixture fault');});
 expect(visible('rm -rf ~',linuxContext())).toBe('wipe-check-fault');
 expect(visibleDeleteTarget('/home/u','/home/u','/work/project/pkg',linuxContext())).toBe('wipe-check-fault');
});

it.each(['/','/home/u','/work/project','/work/project/pkg/cache','~','/tmp'])('native fallback preserves v3 target semantics: %s',path=>{
 const context=linuxContext();
 expect(visibleDeleteTarget(path,context)).toBe(checker.nativeWipeBreaker('delete_file',{path},context)?.rule??null);
});
it('an unsupported future card rule stays a card',()=>{
 vi.spyOn(checker,'wipeBreaker').mockReturnValue({rule:'fixture-future-card' as never,what:'Fixture'});
 expect(visibleWipe('rm -rf ~',linuxContext())).toBe('wipe-check-fault');
});
