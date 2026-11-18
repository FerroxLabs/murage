// SPDX-License-Identifier: AGPL-3.0-or-later
// Named mutation witnesses for the shared layers of classes 1, 2 and 5 (mutants.mjs rows MU-C1-*, MU-C2-*, MU-C5-*).
// Each test is the smallest hand-written row set that a regression of one invariant turns red.
import {expect,it} from 'vitest';
import {row,runMatrix,type Row} from './matrix.fixture.ts';
import {wipeBreaker} from '../wipe-breaker.ts';
import {cleanText} from './expand.ts';
import {hostFor,readHost} from './hosts.ts';
import {parsePwsh} from './pwsh.ts';
import {parseCmd} from './cmd.ts';
import {parseSh} from './sh.ts';
import {parse,walk} from './invocation.ts';
import {canonicalPath} from './roots.ts';
import {known} from './types.ts';
import {linuxContext,corpusContext} from './corpus/v3-context.fixture.ts';
const witness=(name:string,rows:Row[])=>it(name,()=>expect(runMatrix(name,rows)).toEqual([]));
witness('MU-C1-1 su reads its command wherever the user name stands',[row('C',"su root -c 'rm -rf /etc'"),row('C',"su -c 'rm -rf /etc' root"),row('R',"su root -c 'rm -rf ./build'")]);
witness('MU-C1-2 source options are read inside a bundle',[row('C',`python3 -uc 'import shutil; shutil.rmtree("/home/u")'`),row('C',`perl -we 'system("rm -rf /etc")'`),row('R',`python3 -uc 'import shutil; shutil.rmtree("dist")'`)]);
witness('MU-C1-3 a host option outside the table does not end the reading',[row('C',"zsh --no-rcs -c 'rm -rf ~'"),row('R',"zsh --no-rcs -c 'rm -rf ./build'")]);
witness('MU-C1-4 an unknown wrapper option may take the next word',[row('C','sudo --frob x rm -rf /etc'),row('C','sudo --frob rm -rf /etc'),row('R','sudo --frob x rm -rf ./build')]);
witness('MU-C2-1 a new process does not inherit nounset',[row('C',`set -u; bash -c 'rm -rf "$BUILD_DIR"/*'`),row('R',`set -u; rm -rf "$BUILD_DIR"/*`)]);
witness('MU-C2-2 a host applies its own argv options',[row('R',`bash -o nounset -c 'rm -rf "$BUILD_DIR"/*'`),row('R',`bash -u -c 'rm -rf "$BUILD_DIR"/*'`),row('C',`bash -c 'rm -rf "$BUILD_DIR"/*'`)]);
witness('MU-C2-3 a function that was not exported does not shadow the program in a child',[row('C',"rm(){ :; }; bash -c 'rm -rf ~'"),row('R','rm(){ :; }; rm -rf ~')]);
witness('MU-C2-4 a variable that was not exported is unset in a child',[row('C',`D=/tmp/b; bash -c 'rm -rf "$D"/*'`),row('R',`export D=/tmp/b; bash -c 'rm -rf "$D"/*'`)]);
witness('MU-C5-1 a cmd for list is read to its last item',[row('C','for %d in (b1 b2 b3 b4 b5 b6 b7 b8 C:\\Users) do rd /s /q %d','cmd','win32'),row('R','for %d in (b1 b2 b3 b4 b5 b6 b7 b8 b9) do rd /s /q %d','cmd','win32')]);
witness('MU-C5-2 a chain of directory changes keeps a protected directory',[row('C','cd /tmp/w0 || cd /tmp/w1 || cd /tmp/w2 || cd /tmp/w3 || cd /home/u || cd /tmp/w5 || cd /tmp/w6 || cd /tmp/w7; rm -rf ./*'),row('R','cd /tmp/w0 || cd /tmp/w1 || cd /tmp/w2 || cd /tmp/w3 || cd /tmp/w4 || cd /tmp/w5 || cd /tmp/w6 || cd /tmp/w7; rm -rf ./*')]);
witness('MU-C5-3 a nest past the depth limit is still read',[row('C','cmd /c '.repeat(40)+'rd /s /q C:\\Users','cmd','win32'),row('R','cmd /c '.repeat(40)+'rd /s /q build','cmd','win32')]);
witness('MU-C5-4 an argv past the depth limit is still read',[row('C','echo /etc | '+'xargs '.repeat(40)+'rm -rf'),row('R','echo ./build | '+'xargs '.repeat(40)+'rm -rf')]);
witness('MU-C5-5 a literal loop list is never capped',[row('C','for d in /tmp /scratch /cache /build /home/other /output; do rm -rf "$d"; done'),row('C','for d in a b c d etc f g; do rm -rf "/$d"; done'),row('R','for d in a b c d e f; do rm -rf "/tmp/$d"; done')]);

// Owner focused findings: wipe-found-r1; policy owner: MAIN 1114-WIPE-FOUND-R1.
// All four tests retain their test-first names, scenarios and assertions; only placement changes to use this existing gate row.
const win=corpusContext({platform:'win32',dialect:'pwsh',cwd:'C:\\work\\project'});

it('host option tables expose unknown bash/ksh letters without crossing completed source boundaries',()=>{
 for(const [host,args] of [['bash',['-cR','x','rm -rf /']],['ksh',['-T','x','-c','rm -rf /']]] as const){
  expect(readHost(args.map(known),hostFor(host)!).unknownAt).toBe(0);
  expect(wipeBreaker(`${host} ${args.slice(0,-1).join(' ')} '${args.at(-1)}'`,linuxContext())?.rule).toBe('delete-root');
 }
 expect(readHost(['-lc','echo ok','rm -rf /'].map(known),hostFor('bash')!).unknownAt).toBe(-1);
 expect(wipeBreaker("bash -lc 'echo ok' 'rm -rf /'",linuxContext())).toBeNull();
 expect(wipeBreaker("bash -c 'echo ok' -R 'rm -rf /'",linuxContext())).toBeNull();
 expect(wipeBreaker("ksh -c 'echo ok' -T x 'rm -rf /'",linuxContext())).toBeNull();
 expect(wipeBreaker("bash ./script.sh -R 'rm -rf /'",linuxContext())).toBeNull();
});
it('heredoc cleaning preserves a carriage return before a POSIX delimiter',()=>{
 const source='cat <<EOF\nEOF\r\n# $(rm -rf /)\nEOF\n';
 expect(cleanText(source)).toBe(source);
 expect(wipeBreaker(source,linuxContext())?.rule).toBe('delete-root');
 // Preserve the approved corpus's backslash-CRLF continuation while keeping delimiter bytes exact.
 expect(wipeBreaker('rm -rf \\\r\n/',linuxContext())?.rule).toBe('delete-root');
 expect(wipeBreaker('cat <<EOF\nEOF\n# $(rm -rf /)\n',linuxContext())).toBeNull();
 expect(wipeBreaker("cat <<'EOF'\nEOF\r\n# $(rm -rf /)\nEOF\n",linuxContext())).toBeNull();
});
it('PowerShell here-string delimiters leave a quoted operand and preserve quote semantics',()=>{
 for(const newline of ['\n','\r','\r\n']){
  const source=`Remove-Item -Recurse -Force @"${newline}C:\\Win\`${newline}dows${newline}"@`;
  expect(wipeBreaker(source,win)?.rule).toBe('delete-system-folder');
 }
 const parsed=parsePwsh("Write-Output @'\n$HOME\n'@").nodes[0];
 expect(parsed?.k).toBe('cmd');
 if(parsed?.k==='cmd')expect(parsed.c.words[1]?.parts).toEqual([{k:'lit',s:'$HOME',quoted:true}]);
 expect(wipeBreaker('Write-Output @"\nRemove-Item -Recurse C:\\Windows\n"@',win)).toBeNull();
 expect(wipeBreaker('Remove-Item -Recurse @"\nC:\\work\\project\\build\n"@',win)).toBeNull();
});
it('PowerShell FF and VT remain separators between a protected operand and a flag',()=>{
 for(const separator of ['\f','\v'])for(const newline of ['\n','\r\n']){
  const source=`Get-Date${newline}Remove-Item -Recurse -Force C:\\Windows${separator}-Force`;
  // MAIN RULING 1114-WIPE-FOUND-R1: FF/VT retain a word boundary rather than being deleted.
  expect(cleanText(source)).toContain('C:\\Windows -Force');
  expect(wipeBreaker(source,win)?.rule).toBe('delete-system-folder');
  expect(wipeBreaker(source.replace('C:\\Windows','C:\\work\\project\\build'),win)).toBeNull();
 }
});

// H1 owner: wipe-found-r2; MAIN 1114-WIPE-FOUND-R1 preserves existing cmd continuations.
it('cmd caret CRLF continuations retain protected paths and ordinary target controls',()=>{
 const cmd=corpusContext({platform:'win32',dialect:'cmd',cwd:'C:\\work\\project'});
 for(const newline of ['\n','\r\n'])for(const quoted of [false,true]){
  const target=`C:\\Win^${newline}dows`;
  const source=`rd /s /q ${quoted?'"'+target+'"':target}`;
  expect(wipeBreaker(source,cmd)?.rule).toBe('delete-system-folder');
  expect(wipeBreaker(source.replace('Win^','work\\project\\bui^').replace('dows','ld'),cmd)).toBeNull();
 }
 // MAIN RULING 1114-WIPE-FOUND-R1; DESIGN-WIPE-FOUND-CR dialect boundary.
 const source='rd /s /q C:\\Win^\r\ndows';
 expect(cleanText(source)).toBe(source);
 const parsed=parseCmd(source).nodes[0];
 expect(parsed?.k).toBe('cmd');
 if(parsed?.k==='cmd'){
  expect(parsed.c.words.at(-1)?.raw).toBe('C:\\Win^\r\ndows');
  expect(parsed.c.words.at(-1)?.parts).toEqual([{k:'lit',s:'C:\\Windows',quoted:false}]);
 }
});

// Owners: dialect repair/tests wipe-found-r3; policy MAIN, DESIGN-WIPE-FOUND-CR.
const caretHeredoc='cat <<EOF^\nEOF^\r\n# $(rm -rf /)\nEOF^\n';
it('H1 POSIX caret CRLF heredoc retains executable body bytes through cleaning and nested sh dispatch',()=>{
 expect(cleanText(caretHeredoc)).toBe(caretHeredoc);
 const script=parseSh(cleanText(caretHeredoc)),command=script.nodes[0];
 expect(script.source).toBe(caretHeredoc);
 expect(command?.k).toBe('cmd');
 if(command?.k==='cmd'){
  expect(command.c.redirects[0]?.heredoc).toBe('EOF^\r\n# $(rm -rf /)');
  expect(command.c.redirects[0]?.expanding).toBe(true);
 }
 expect(wipeBreaker(caretHeredoc,linuxContext())?.rule).toBe('delete-root');
 expect(wipeBreaker(`sh -c '${caretHeredoc}'`,linuxContext())?.rule).toBe('delete-root');
 const state=()=>({env:new Map([['HOME','/home/u']]),cwd:known('/work/project/pkg'),home:'/home/u',dialect:'sh' as const,depth:0});
 expect(parse(caretHeredoc,'sh')).toEqual(parseSh(caretHeredoc));
 expect(walk(parse(caretHeredoc,'sh'),state()).some(inv=>inv.program==='rm'&&inv.argv.some(v=>v.k==='known'&&v.s==='/'))).toBe(true);
 expect(walk(parse(`sh -c '${caretHeredoc}'`,'sh'),state()).some(inv=>inv.program==='rm'&&inv.argv.some(v=>v.k==='known'&&v.s==='/'))).toBe(true);
});
it('H1 POSIX exact, quoted and ordinary heredoc controls retain their verdicts',()=>{
 for(const source of [caretHeredoc.replace('<<EOF^',"<<'EOF^'"),caretHeredoc.replace('EOF^\r\n','EOF^\n'),caretHeredoc.replace('rm -rf /','rm -rf ./build')]){
  expect(cleanText(source)).toBe(source);
  expect(wipeBreaker(source,linuxContext())).toBeNull();
 }
 // Only <<- strips tabs. Neither reader strips a delimiter CR or a caret.
 const source=caretHeredoc.replace('<<EOF^','<<-EOF^').replace('EOF^\r\n','\tEOF^\r\n');
 expect(wipeBreaker(source,linuxContext())?.rule).toBe('delete-root');
 const quoted=parseSh(caretHeredoc.replace('<<EOF^',"<<'EOF^'")).nodes[0];
 if(quoted?.k==='cmd')expect(quoted.c.redirects[0]?.expanding).toBe(false);
});
it('cmd caret continuations stay dialect local through direct and nested dispatch with original spans',()=>{
 const cmd=corpusContext({platform:'win32',dialect:'cmd',cwd:'C:\\work\\project'});
 for(const newline of ['\n','\r\n'])for(const quoted of [false,true]){
  const target=`C:\\Win^${newline}dows`,source=`rd /s /q ${quoted?'"'+target+'"':target}`;
  expect(cleanText(source)).toBe(source);
  const script=parseCmd(source),command=script.nodes[0];
  expect(parse(source,'cmd')).toEqual(script);
  expect(script.source).toBe(source);
  expect(command?.span).toEqual([0,source.length]);
  if(command?.k==='cmd'){
   expect(command.c.words.at(-1)?.raw).toBe(quoted?'"'+target+'"':target);
   expect(command.c.words.at(-1)?.parts).toEqual([{k:'lit',s:'C:\\Windows',quoted}]);
  }
  const nested='cmd /c '+source;
  expect(wipeBreaker(nested,cmd)?.rule).toBe('delete-system-folder');
  expect(wipeBreaker(nested.replace('Win^','work\\project\\bui^').replace('dows','ld'),cmd)).toBeNull();
  const inv=walk(parse(nested,'cmd'),{env:new Map(),cwd:known('C:\\work\\project'),home:'C:\\Users\\u',platform:'win32',dialect:'cmd',depth:0});
  expect(inv.some(i=>i.program==='rd'&&i.argv.some(v=>v.k==='known'&&v.s==='C:\\Windows'))).toBe(true);
 }
 // An escaped caret is consumed by generic caret escaping, not as a continuation.
 const escaped=parseCmd('echo A^^\r\nB').nodes[0];
 if(escaped?.k==='cmd')expect(escaped.c.words[1]?.parts).toEqual([{k:'lit',s:'A',quoted:false},{k:'lit',s:'^',quoted:true}]);
});
it('PowerShell caret CRLF remains literal while backtick continuation and roots keep their own bytes',()=>{
 const source='Write-Output "A^\r\nB"';
 expect(cleanText(source)).toBe(source);
 const parsed=parsePwsh(cleanText(source)).nodes[0];
 if(parsed?.k==='cmd')expect(parsed.c.words[1]?.parts).toEqual([{k:'lit',s:'A^\nB',quoted:true}]);
 expect(wipeBreaker(source,win)).toBeNull();
 expect(canonicalPath('C:\\work\\A^\r\nB','win32')).toBe('C:/work/a^\r\nb');
});
