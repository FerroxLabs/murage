// SPDX-License-Identifier: AGPL-3.0-or-later
// Class 5: no bound drops a target. A protected path named anywhere in a literal list, a product of lists, a
// chain of directory changes or a deep nest must still be seen; an all-harmless twin of the same shape must run.
// Lists and expected verdicts are written by hand (shell semantics: every listed item is visited); nothing here
// is derived from the checker's caps.
import {describe,expect,it} from 'vitest';
import {row,runMatrix,type Row} from './matrix.fixture.ts';
const rows:Row[]=[];
/** Where each group of rows starts. Every row still runs with its own per-row budget (Row.ms); the groups only keep
 * one Vitest test from carrying the sum of ~2400 independent checks under the 45 s per-test cap. */
const groups:Array<[string,number]>=[];
const group=(label:string)=>{groups.push([label,rows.length]);};
const lengths=[1,4,5,8,9,64,1000];
/** Harmless fill item i, in the list's own path style. */
const posix=(i:number)=>i%3===0?`/tmp/w${i}`:i%3===1?`b${i}`:`./c${i}`;
const win=(i:number)=>i%2===0?`C:\\tmp\\w${i}`:`b${i}`;
/** Positions to place the protected item at: first, middle, last, and just past the old caps (index 4 and 8). */
const positions=(n:number)=>[...new Set([0,Math.floor(n/2),n-1,4,8].filter(i=>i<n))];
const list=(n:number,fill:(i:number)=>string,at=-1,bad='')=>Array.from({length:n},(_,i)=>i===at?bad:fill(i));
type Source={name:string;d:Row['d'];p:Row['p'];fill:(i:number)=>string;bad:string[];make:(items:string[])=>string;min?:number;max?:number};
const sq=(items:string[])=>items.map(s=>`'${s}'`).join(',');
const posixBad=['/home/u','/etc','/home/other','/work/project','/'];
const winBad=['C:\\Users','C:\\Windows','C:\\work\\project'];
const sources:Source[]=[
 {name:'for',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`for d in ${i.join(' ')}; do rm -rf "$d"; done`},
 {name:'for-newlines',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`for d in ${i.join(' ')}\ndo\n rm -rf -- "$d"\ndone`},
 {name:'for-unquoted',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`for d in ${i.join(' ')}; do echo "$d"; rm -rf $d; done`},
 {name:'array-all',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`A=(${i.join(' ')}); rm -rf "\${A[@]}"`},
 {name:'array-loop',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`A=(${i.join(' ')}); for d in "\${A[@]}"; do rm -rf "$d"; done`},
 {name:'while-read',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`printf '%s\\n' ${i.join(' ')} | while read d; do rm -rf "$d"; done`},
 {name:'while-read-r',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`printf '%s\\n' ${i.join(' ')} | while IFS= read -r d; do rm -rf -- "$d"; done`},
 {name:'xargs',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`printf '%s\\n' ${i.join(' ')} | xargs rm -rf`},
 {name:'xargs-n1',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`echo ${i.join(' ')} | xargs -n1 rm -rf`},
 {name:'xargs-I',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`printf '%s\\n' ${i.join(' ')} | xargs -I{} rm -rf {}`},
 {name:'braces',d:'sh',p:'linux',fill:posix,bad:posixBad,min:2,make:i=>`rm -rf {${i.join(',')}}`},
 {name:'operands',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`rm -rf ${i.join(' ')}`},
 {name:'find-starts',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`find ${i.join(' ')} -delete`},
 {name:'find-print-xargs',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`find ${i.join(' ')} -maxdepth 0 -print0 | xargs -0 rm -rf`},
 {name:'nested-substitutions',d:'sh',p:'linux',fill:posix,bad:posixBad,max:64,make:i=>`: \${X:-${i.map(s=>`$(rm -rf ${s})`).join('')}}`},
 {name:'substitution-list',d:'sh',p:'linux',fill:posix,bad:posixBad,make:i=>`for d in $(echo ${i.join(' ')}); do rm -rf "$d"; done`},
 {name:'cd-chain',d:'sh',p:'linux',fill:i=>`/tmp/w${i}`,bad:['/home/u','/etc','/'],max:64,make:i=>`${i.map(s=>`cd ${s}`).join(' || ')}; rm -rf ./*`},
 {name:'if-chain',d:'sh',p:'linux',fill:i=>`/tmp/w${i}`,bad:['/home/u','/etc','/home/other'],max:64,make:i=>`${i.map((s,k)=>`${k?'elif':'if'} test "$1" = ${k}; then D=${s}; `).join('')}fi; rm -rf "$D"`},
 {name:'case',d:'sh',p:'linux',fill:i=>`/tmp/w${i}`,bad:['/home/u','/etc'],max:64,make:i=>`case "$1" in ${i.map((s,k)=>`${k}) D=${s};; `).join('')}esac; rm -rf "$D"`},
 {name:'cmd-for',d:'cmd',p:'win32',fill:win,bad:winBad,make:i=>`for %d in (${i.join(' ')}) do rd /s /q %d`},
 {name:'cmd-for-batch',d:'cmd',p:'win32',fill:win,bad:winBad,make:i=>`for %%d in (${i.join(' ')}) do @rd /s /q "%%d"`},
 {name:'pwsh-foreach',d:'pwsh',p:'win32',fill:win,bad:winBad,make:i=>`foreach ($d in ${sq(i)}) { Remove-Item -Recurse -Force $d }`},
 {name:'pwsh-percent',d:'pwsh',p:'win32',fill:win,bad:winBad,make:i=>`${sq(i)} | % { Remove-Item -Recurse -Force $_ }`},
 {name:'pwsh-foreach-object',d:'pwsh',p:'win32',fill:win,bad:winBad,make:i=>`${sq(i)} | ForEach-Object { Remove-Item -Recurse -Force $_ }`},
 {name:'pwsh-array-variable',d:'pwsh',p:'win32',fill:win,bad:winBad,make:i=>`$dirs = ${sq(i)}; foreach ($d in $dirs) { Remove-Item -Recurse -Force $d }`},
 {name:'pwsh-operand-list',d:'pwsh',p:'win32',fill:win,bad:winBad,make:i=>`Remove-Item -Recurse -Force ${sq(i)}`},
];
for(const s of sources){group(`source ${s.name}`);for(const n of lengths){
 if(n<(s.min??1)||n>(s.max??1000))continue;
 rows.push({...row('R',s.make(list(n,s.fill)),s.d,s.p),ms:n>=1000?4000:1500});
 for(const at of positions(n))for(const bad of n>64?s.bad.slice(0,2):s.bad)rows.push({...row('C',s.make(list(n,s.fill,at,bad)),s.d,s.p),ms:n>=1000?4000:1500});
}}
// Products of two lists: every pair is visited.
group('products');
for(const [na,nb] of [[2,2],[3,3],[5,5],[9,9],[20,20],[70,70]] as const){
 const a=(bad?:string)=>list(na,i=>`/tmp/a${i}`,bad?na-1:-1,bad).join(' '),b=(bad?:string)=>list(nb,i=>`b${i}`,bad?Math.floor(nb/2):-1,bad).join(' ');
 const nest=(x:string,y:string,body:string)=>`for a in ${x}; do for b in ${y}; do ${body}; done; done`;
 rows.push({...row('R',nest(a(),b(),'rm -rf "$a/$b"')),ms:4000},{...row('C',nest(a('/home'),b('u'),'rm -rf "$a/$b"')),ms:4000},{...row('C',nest(a('/home/u'),b(),'rm -rf "$a" "$b"')),ms:4000},{...row('C',nest(a(),b('/etc'),'rm -rf "$a" "$b"')),ms:4000},{...row('R',nest(a(),b(),'rm -rf "$a" "$b"')),ms:4000},{...row('C',nest(a('/home/u'),b(),'rm -rf "$a/$b" "$a"')),ms:4000});
 rows.push({...row('C',`rm -rf {${list(na,i=>`/tmp/a${i}`,na-1,'/home').join(',')}}/{${list(nb,i=>`b${i}`,Math.floor(nb/2),'u').join(',')}}`),ms:4000},{...row('R',`rm -rf {${list(na,i=>`/tmp/a${i}`).join(',')}}/{${list(nb,i=>`b${i}`).join(',')}}`),ms:4000});
}
// Numeric ranges: the endpoints stand for the range.
group('ranges');
rows.push(row('R','rm -rf /tmp/w{1..9}'),row('R','rm -rf /tmp/w{1..500}'),row('R','for i in {1..200}; do rm -rf "/tmp/w$i"; done'),row('C','rm -rf /tmp/w{1..500} /etc'),row('C','for i in {1..200}; do rm -rf /tmp/w$i /home/u; done'),row('C','rm -rf /{etc,tmp/w{1..100}}'));
// Depth: a nest deeper than any internal limit is still read (or carded on its evidence), never dropped.
group('depth');
const fn=(n:number,body:string)=>Array.from({length:n},(_,i)=>`f${i}(){ ${i===n-1?body:`f${i+1}`}; }`).join('; ')+'; f0';
for(const n of [2,8,9,10,17,40]){rows.push(row('C',fn(n,'rm -rf /etc')),row('C',fn(n,'rm -rf ~')),row('R',fn(n,'rm -rf ./build')));}
rows.push(row('R','f(){ f; }; f'),row('C','f(){ rm -rf /etc; f; }; f'),row('R','f(){ g; }; g(){ f; }; f'),row('C','f(){ g; }; g(){ rm -rf ~; f; }; f'));
for(const n of [2,8,16,17,18,40]){
 rows.push(row('C','cmd /c '.repeat(n)+'rd /s /q C:\\Users','cmd','win32'),row('R','cmd /c '.repeat(n)+'rd /s /q build','cmd','win32'));
 rows.push(row('C','echo /etc | '+'xargs '.repeat(n)+'rm -rf'),row('R','echo ./build | '+'xargs '.repeat(n)+'rm -rf'));
 rows.push(row('C','sudo -s '.repeat(n)+'rm -rf /etc'),row('R','sudo -s '.repeat(n)+'rm -rf ./build'));
 rows.push(row('C','watch '.repeat(n)+'rm -rf /etc'),row('R','watch '.repeat(n)+'rm -rf ./build'));
 rows.push(row('C','env '.repeat(n)+'rm -rf /etc'),row('C','eval '.repeat(n)+'rm -rf /etc'),row('R','eval '.repeat(n)+'rm -rf ./build'));
}
// PowerShell script-block variants: every assigned block may be the one invoked.
group('pwsh script blocks');
for(const n of [2,4,5,9]){const blocks=(bad:boolean)=>Array.from({length:n},(_,i)=>`if ($a -eq ${i}) { $b = { Remove-Item -Recurse -Force ${bad&&i===0?'C:\\Users':`C:\\tmp\\w${i}`} } }`).join('; ')+'; & $b';rows.push(row('C',blocks(true),'pwsh','win32'),row('R',blocks(false),'pwsh','win32'));}
// A very long literal list stays within the time budget.
group('long literal list');
const big=list(10000,i=>`/tmp/w${i}`);
rows.push({...row('R',`for d in ${big.join(' ')}; do rm -rf "$d"; done`),ms:5000},{...row('C',`for d in ${[...big.slice(0,7000),'/etc',...big.slice(7001,9000)].join(' ')}; do rm -rf "$d"; done`),ms:5000});
describe('class 5: bounds never drop a target',()=>{
 it('covers every row exactly once',()=>{
  expect(rows.length).toBeGreaterThan(900);
  expect(groups[0]?.[1]).toBe(0);
 });
 groups.forEach(([label,start],k)=>{
  const part=rows.slice(start,groups[k+1]?.[1]??rows.length);
  it(label,()=>{expect(part.length).toBeGreaterThan(0);expect(runMatrix(`class5 ${label}`,part)).toEqual([]);});
 });
});
