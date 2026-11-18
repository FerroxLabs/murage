// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {wipeBreaker,type WipeContext} from '../wipe-breaker.ts';
import {expandWords,ExpansionAbort} from './expand.ts';
import {parseSh} from './sh.ts';
import {known,opaque,type ShellState} from './types.ts';
import {literalSet,BUDGET} from './may.ts';
import {walk} from './invocation.ts';
const context:WipeContext={platform:'linux',cwd:'/work/project',project:'/work/project',home:'/home/owner',dataDir:'/fixture/data',pathPort:{realpath:p=>p,isBlockDevice:()=>false},mountInventory:{contains:()=>false}};
// MAIN RULING 2026-11-17T10:45Z: keep alternative positional-list lengths and read's executable input values.
it.each([
 'set -- /tmp/cache ignored; false || set -- /usr; /bin/rm -rf "$*"',
 'set -- a b; false || set -- /usr; /bin/rm -rf "$*"',
 'set -- /usr; condition && set -- a b; /bin/rm -rf "${*}"',
 'set -- tmp/cache ignored; condition && set -- usr; /bin/rm -rf "/$*"',
 'set -- /usr; condition && set --; /bin/rm -rf "$*"',
])('positional list lengths preserve the protected alternative: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'set -- /tmp/cache ignored; false || set -- /tmp/other; /bin/rm -rf "$*"',
 'set -- /usr ignored; set -- /tmp/cache; /bin/rm -rf "$*"',
 'set -- /usr ignored; condition && set -- /tmp/cache suffix; /bin/rm -rf "$*"',
 'set -- /usr; set --; /bin/rm -rf "$*"',
 'set -- /usr ignored; f(){ set -- /tmp/cache ignored; }; f; /bin/rm -rf "$*"',
 'set -- /usr; bash -c \'/bin/rm -rf "$*"\' sh /tmp/cache ignored',
])('positional list lengths keep harmless lists runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
it.each([
 'D=/usr; read D rest <<< "/usr ignored"; /bin/rm -rf "$D"',
 'D=/tmp/cache; read D rest <<< "/usr ignored"; /bin/rm -rf "$D"',
 'D=/usr; read -r D rest <<< "  /usr ignored  "; /bin/rm -rf "$D"',
 'D=/tmp/cache; read rest D <<< "ignored /usr"; /bin/rm -rf "$D"',
 'X=/usr; D=/usr; read D <<EOF\n$X\nEOF\n/bin/rm -rf "$D"',
 'X=/usr; D=/tmp/cache; read D <<EOF\n${X}\nEOF\n/bin/rm -rf "$D"',
 'X=/tmp/cache; condition && X=/usr; read D <<EOF\n$X\nEOF\n/bin/rm -rf "$D"',
 'X=/usr; D=/tmp/cache; read D rest <<EOF\n$X "ignored"\nEOF\n/bin/rm -rf "$D"',
 'D=/tmp/cache; read D rest <<EOF\n/usr "ignored"\nEOF\n/bin/rm -rf "$D"',
])('read assigns fields and expands unquoted heredocs: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'D=/usr; read D rest <<< "/tmp/cache ignored"; /bin/rm -rf "$D"',
 'D=/usr; read -r D rest <<< " /tmp/cache ignored "; /bin/rm -rf "$D"',
 'D=/usr; read rest D <<< "ignored /tmp/cache"; /bin/rm -rf "$D"',
 'D=/usr; IFS= read D rest <<< "/usr ignored"; /bin/rm -rf "$D"',
 'X=/tmp/cache; D=/usr; read D <<EOF\n$X\nEOF\n/bin/rm -rf "$D"',
 'X=/usr; D=/usr; read D <<\'EOF\'\n$X\nEOF\n/bin/rm -rf "$D"',
 'X=/tmp/cache; D=/usr; read D rest <<EOF\n$X "ignored"\nEOF\n/bin/rm -rf "$D"',
 'D=/usr; read D rest <<EOF\n/tmp/cache "ignored"\nEOF\n/bin/rm -rf "$D"',
])('read keeps harmless fields and quoted heredocs runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
const state=():ShellState=>({env:new Map(),vars:new Map(),cwd:literalSet(['/work/project']),home:'/home/owner',dialect:'sh',depth:0});
const word=(source:string)=>{const node=parseSh('x '+source).nodes[0];if(node?.k!=='cmd')throw new Error('expected command');return node.c.words[1]!;};
it('an expansion with only aborting alternatives throws ExpansionAbort',()=>{
 const st=state();st.vars!.set('D',{...literalSet(['']),maybeUnset:true});
 expect(()=>expandWords(word('"${D:?}"'),st)).toThrow(ExpansionAbort);
});
it.each(['"$*"','"/$@"'])('a positional product beyond enumeration retains uncertainty: %s',source=>{
 const st=state();st.positional=[known('sh'),...Array.from({length:13},()=>({...known('x'),candidates:['x','y']}))];
 const fields=expandWords(word(source),st);
 expect(fields.some(v=>v.k==='opaque'||v.mayOpaque===true)).toBe(true);
});
it('a positional product within enumeration stays exact',()=>{
 const st=state();st.positional=[known('sh'),...Array.from({length:12},()=>({...known('x'),candidates:['x','y']}))];
 expect(expandWords(word('"$*"'),st).every(v=>v.k==='known'&&!v.mayOpaque)).toBe(true);
});

it.each([
 ["D=/usr; IFS=; condition && IFS=' '; read D rest <<< '/usr ignored'; /bin/rm -rf \"$D\"",true],
 ["D=/tmp/cache; IFS=; condition && IFS=' '; read D rest <<< '/usr ignored'; /bin/rm -rf \"$D\"",true],
 ["D=/usr; IFS=; condition && IFS=' '; read D rest <<< '/tmp/cache ignored'; /bin/rm -rf \"$D\"",false],
])('read keeps every IFS alternative: %s',(command,card)=>{
 if(card)expect(wipeBreaker(command,context)).toBeTruthy();else expect(wipeBreaker(command,context)).toBeNull();
});

it.each([
 'set -- /tmp/cache ignored; condition && set -- /usr; D=\"$*\"; /bin/rm -rf \"$D\"',
 'set -- /tmp/cache ignored; condition && set -- /usr; read D <<< \"$*\"; /bin/rm -rf \"$D\"',
 'D=/tmp/cache; condition && D=/usr; set -- \"$D\"; /bin/rm -rf \"$*\"',
 'set -- /tmp/cache ignored; condition && set -- /usr; D="$@"; /bin/rm -rf "$D"',
 'set -- /tmp/cache ignored; condition && set -- /usr; read D <<< "$@"; /bin/rm -rf "$D"',
])('positional alternatives survive assignment consumers: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'set -- /tmp/cache ignored; condition && set -- /tmp/other; D=\"$*\"; /bin/rm -rf \"$D\"',
 'set -- /tmp/cache ignored; condition && set -- /tmp/other; read D <<< \"$*\"; /bin/rm -rf \"$D\"',
 'D=/tmp/cache; condition && D=/tmp/other; set -- \"$D\"; /bin/rm -rf \"$*\"',
 'set -- /tmp/cache ignored; condition && set -- /tmp/other; D="$@"; /bin/rm -rf "$D"',
 'set -- /tmp/cache ignored; condition && set -- /tmp/other; read D <<< "$@"; /bin/rm -rf "$D"',
])('positional assignment consumers keep harmless alternatives runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());

it.each([
 'set -- echo; condition && set -- /bin/rm; "$1" -rf /usr',
 'set -- echo; condition && set -- /bin/rm; "$*" -rf /usr',
 "set -- -n; condition && set -- -c; bash \"$1\" 'rm -rf /usr'",
])('positional alternatives remain separate program and option words: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'set -- echo; condition && set -- printf; "$1" -rf /usr',
 'set -- echo; condition && set -- /bin/rm; "$*" -rf /tmp/cache',
 "set -- -n; condition && set -- -c; bash \"$1\" 'rm -rf /tmp/cache'",
])('positional program and option alternatives keep harmless work runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());

it('an opaque positional alternative cannot hide a known protected value',()=>{
 const st=state();st.positionals=[[known('sh'),opaque('input')],[known('sh'),known('/usr')]];
 expect(expandWords(word('"$*"'),st)).toEqual([{...known('/usr'),candidates:['/usr'],mayOpaque:true}]);
});

// MAIN RULING 2026-11-17T12:20Z: the three review witnesses, each with harmless controls.
const many=(statement:(i:number)=>string)=>Array.from({length:13},(_,i)=>statement(i)).join(' ');
it.each([
 'set -- /tmp/cache ignored; false || set -- /usr; set -- "$@"; /bin/rm -rf "$*"',
 'set -- /tmp/cache ignored; condition && set -- /usr; set -- "$@"; /bin/rm -rf "$*"',
 'set -- /tmp/cache ignored; condition && set -- /usr; condition && set -- "$@"; /bin/rm -rf "$*"',
 'set -- /usr; condition && set -- a b; set -- "$@"; /bin/rm -rf "$*"',
 'set -- cache ignored; condition && set -- usr; set -- "/$1"; /bin/rm -rf "$*"',
])('copying the positional parameters keeps each list: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'set -- /tmp/cache ignored; false || set -- /tmp/other; set -- "$@"; /bin/rm -rf "$*"',
 'set -- /usr ignored; condition && set -- /tmp/cache suffix; set -- "$@"; /bin/rm -rf "$*"',
 'set -- / tmp/cache; condition && set -- /tmp/ usr; set -- "$@"; /bin/rm -rf "$1$2"',
 'set -- /usr; condition && set -- /tmp/cache; set -- /tmp/other; /bin/rm -rf "$*"',
 'set -- / tmp/cache; condition && set -- /tmp/ usr; '+many(()=>'condition && set -- "$@";')+' /bin/rm -rf "$1$2"',
])('copied positional lists keep harmless work runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
it('more positional lists than the enumeration budget retain uncertainty',()=>{
 const grow=many(i=>'condition && set -- "$@" k'+i+';');
 expect(wipeBreaker('set -- / usr; condition && set -- /tmp/ usr; '+grow+' /bin/rm -rf "$1$2"',context)).toBeTruthy();
 const st=state();walk(parseSh('set -- / tmp/cache; condition && set -- /tmp/ usr; '+grow),st);
 expect(st.positionals!.length).toBeLessThanOrEqual(BUDGET+1);
 expect(st.positionals!.some(list=>list.some(v=>v.k==='opaque'||v.mayOpaque===true))).toBe(true);
 expect(wipeBreaker('set -- /tmp/ cache; condition && set -- /tmp/ other; '+grow+' /bin/rm -rf "$1$2"',context)).toBeNull();
});
it.each([
 'REPLY=/tmp/cache; read -r <<< /usr; /bin/rm -rf "$REPLY"',
 'read -r <<< /usr; /bin/rm -rf "$REPLY"',
 'REPLY=/tmp/cache; read -r -- <<< /usr; /bin/rm -rf "$REPLY"',
 'REPLY=/tmp/cache; condition && read -r <<< /usr; /bin/rm -rf "$REPLY"',
 'REPLY=/usr; read -r -n 3 <<< /tmp/cache; /bin/rm -rf "$REPLY"',
])('read with options and no name assigns REPLY: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'REPLY=/usr; read -r <<< /tmp/cache; /bin/rm -rf "$REPLY"',
 'REPLY=/usr; read -r -- <<< /tmp/cache; /bin/rm -rf "$REPLY"',
 'read -r <<< "/usr ignored"; /bin/rm -rf "$REPLY"',
 'REPLY=/tmp/cache; read -r D <<< /usr; /bin/rm -rf "$REPLY"',
])('read into REPLY keeps harmless input runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
it.each([
 'IFS=,; false || IFS=; set -- / usr; /bin/rm -rf "$*"',
 'IFS=; condition && IFS=,; set -- / usr; /bin/rm -rf "$*"',
 "IFS=; false || IFS=/; set -- '' usr; /bin/rm -rf \"$*\"",
 'IFS=,; false || IFS=; set -- / usr; D="$*"; /bin/rm -rf "$D"',
 "D=/usr,x; IFS=' '; false || IFS=,; /bin/rm -rf $D",
])('every IFS alternative joins and splits expansions: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'IFS=,; false || IFS=; set -- / tmp/cache; /bin/rm -rf "$*"',
 'IFS=,; false || IFS=:; set -- / usr; /bin/rm -rf "$*"',
 'IFS=,; set -- / usr; /bin/rm -rf "$*"',
 "D=/tmp/cache,x; IFS=' '; false || IFS=,; /bin/rm -rf $D",
 "D=/usr,x; IFS=' '; false || IFS=:; /bin/rm -rf $D",
])('IFS alternatives keep harmless expansions runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());

// Review follow-up: `--` ends option parsing; IFS alternatives keep full argument lists.
it.each([
 'REPLY=/usr; read -- -r <<< /tmp/cache; /bin/rm -rf "$REPLY"',
 'REPLY=/usr; read -r -- -r <<< /tmp/cache; /bin/rm -rf "$REPLY"',
 'D=/usr; read -- -r D <<< /tmp/cache; /bin/rm -rf "$D"',
])('read does not treat destination words as options: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'REPLY=/tmp/cache; read -- -r <<< /usr; /bin/rm -rf "$REPLY"',
 'REPLY=/tmp/cache; read -r -- -r <<< /usr; /bin/rm -rf "$REPLY"',
 'D=/usr; read -- D <<< /tmp/cache; /bin/rm -rf "$D"',
 'D=/tmp/cache; read -- -r D <<< /usr; /bin/rm -rf "$D"',
])('read option terminators keep harmless work runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
it.each([
 "D='/usr x'; IFS=' '; false || IFS=' x'; set -- $D; IFS=' '; /bin/rm -rf \"$*\"",
 "D='/usr x'; IFS=' '; condition && IFS=' x'; set -- $D; set -- \"$@\"; IFS=' '; /bin/rm -rf \"$*\"",
 "D='/usr x'; IFS=' '; condition && IFS=' x'; set -- /tmp/cache; set -- $D; IFS=' '; /bin/rm -rf \"$*\"",
])('set preserves field counts across IFS alternatives: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 "D='/tmp/cache x'; IFS=' '; condition && IFS=' x'; set -- $D; IFS=' '; /bin/rm -rf \"$*\"",
 "D='/usr x'; IFS=' '; condition && IFS=' z'; set -- $D; IFS=' '; /bin/rm -rf \"$*\"",
 "D='/usr x'; IFS=' '; condition && IFS=' x'; set -- $D; set -- /tmp/cache; IFS=' '; /bin/rm -rf \"$*\"",
])('IFS-dependent field counts keep harmless lists runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());

it.each([
 'D=/tmp/cache; read -n 1 D <<< /usr; /bin/rm -rf "$D"',
 'REPLY=/tmp/cache; read -n1 <<< /usr; /bin/rm -rf "$REPLY"',
])('unsupported read options retain executable input evidence: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'D=/tmp/cache; read -n 1 D <<< cache; /bin/rm -rf "$D"',
 'REPLY=/tmp/cache; read -n1 <<< cache; /bin/rm -rf "$REPLY"',
])('unsupported read options keep harmless input runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());


it.each([
 ['/usr/*',false,true],['/usr/*',true,false],['/tmp/cache',false,false],['/tmp/cache',true,false],['',true,false],
] as const)('literal fields keep their quoting and glob provenance: %s %s',(literal,quoted,glob)=>{
 const fields=expandWords({raw:literal,parts:[{k:'lit',s:literal,quoted}]},state());
 expect(fields).toHaveLength(1);expect(Boolean(fields[0]!.k==='known'&&fields[0]!.wholeDirGlob)).toBe(glob);
 expect(fields[0]!.k==='known'&&fields[0]!.s).toBe(glob?'/usr/':literal);
});
it('literal fields still undergo brace expansion',()=>{
 expect(expandWords(word('/{usr,tmp/cache}'),state())).toEqual([known('/usr'),known('/tmp/cache')]);
});
