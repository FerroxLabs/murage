// SPDX-License-Identifier: AGPL-3.0-or-later
// One option grammar for every program that carries a command line, a command string or source text:
// shells, PowerShell and cmd hosts, su / sudo and the program wrappers, and the script interpreters.
// A row says what each option's value is for; `readHost` reads any argv against a row; `inspectHost`
// acts on the result. No reader outside this file decides which argv word is source.
import {known,type ProcOpts,type Script,type ShellState,type Value,type Word} from './types.ts';
export type Lang='sh'|'fish'|'csh'|'pwsh'|'cmd'|'py'|'js'|'perl'|'ruby'|'php';
export type Role='flag'|'inert'|'source'|'code'|'file'|'program'|'cwd'|'env-unset'|'env-split'|'shell'|'user'|'noexec'|'set-opt'|'clear-opt';
export interface Opt{short?:string;long?:string[];arity:0|1|'optional';role:Role;lang?:Lang;ends?:boolean;sets?:Partial<ProcOpts>;pat?:RegExp}
export interface Host{
 family:string;names:string[];kind:'shell'|'wrapper'|'strings'|'cmdlet'|'interp';
 style:'gnu'|'posix-sh'|'pwsh'|'cmd'|'interp';permute:boolean;prefix:'gnu-long'|'pwsh-any'|'none';bundle:boolean;
 opts:Opt[];aliases?:Record<string,string[]>;
 positional:'program'|'source-in-mode'|'sources-then-file'|'file'|'command'|'user-then-shell-args'|'joined-source'|'lock-then-program'|'none';
 lang:Lang;
 /** Any single letter / any long name is an option of this host (zsh option names, sh single letters). */
 anyShort?:boolean;anyLong?:boolean;
 /** `-<digits>` is an option (nice -5). */
 numeric?:boolean;
 /** Leading operands before the program (timeout DURATION, chrt PRIORITY, taskset MASK), unless one of these options is given. */
 lead?:number;leadUnless?:string[];
 /** After one of these options the first operand ends option reading (runuser -u). */
 stopAfter?:string[];
 /** An option this row does not list takes the next word (Start-Process), or is a plain flag (man, rg). */
 unknownTakesValue?:boolean;lenient?:boolean;
 /** A first operand that selects a mode whose next operand is source (deno eval). */
 subcommands?:Record<string,'code'>;
}
const F=(letters:string,role:Role='flag',extra:Partial<Opt>={}):Opt[]=>[...letters].map(short=>({short,arity:0 as const,role,...extra}));
const V=(letters:string,role:Role='inert',extra:Partial<Opt>={}):Opt[]=>[...letters].map(short=>({short,arity:1 as const,role,...extra}));
const L=(names:string,arity:Opt['arity']=0,role:Role='flag',extra:Partial<Opt>={}):Opt[]=>names.split(' ').filter(Boolean).map(name=>({long:[name],arity,role,...extra}));
const P=(names:string,arity:Opt['arity']=0,role:Role='flag',extra:Partial<Opt>={}):Opt=>({long:names.split(' '),arity,role,...extra});
const noexec=L('help version',0,'noexec');
/** A GNU-style program wrapper: option letters and names as in its manual, plus the role of the ones that matter. */
function wrapper(names:string,shortFlags='',shortWithValue='',longFlags='',longWithValue='',roles:Record<string,Role>={},extra:Partial<Host>={}):Host {
 const role=(name:string,fallback:Role)=>roles[name]??fallback;
 const opts:Opt[]=[...[...shortFlags].map((short):Opt=>({short,arity:0,role:role(short,'flag')})),...[...shortWithValue].map((short):Opt=>({short,arity:1,role:role(short,'inert')})),
  ...longFlags.split(' ').filter(Boolean).map((name):Opt=>({long:[name],arity:0,role:role(name,'flag')})),...longWithValue.split(' ').filter(Boolean).map((name):Opt=>({long:[name],arity:1,role:role(name,'inert')}))];
 for(const o of noexec)if(!opts.some(have=>have.long?.includes(o.long![0]!)))opts.push(o);
 return {family:names.split(' ')[0]!,names:names.split(' '),kind:'wrapper',style:'gnu',permute:false,prefix:'gnu-long',bundle:true,opts,positional:'program',lang:'sh',...extra};
}
const shOpts:Opt[]=[
 {short:'c',arity:0,role:'source'},{short:'n',arity:0,role:'noexec'},
 {short:'u',arity:0,role:'set-opt',sets:{nounset:true}},{short:'e',arity:0,role:'set-opt',sets:{errexit:true}},{short:'a',arity:0,role:'set-opt',sets:{allexport:true}},
 {short:'o',arity:1,role:'set-opt'},{short:'O',arity:1,role:'inert'},
 // The earlier reader accepted these spellings; they stay readable.
 P('command commands','optional','source'),
 ...L('rcfile init-file',1,'inert'),...L('login norc noprofile posix restricted verbose debugger noediting dump-strings dump-po-strings pretty-print'),...noexec,
];
const sh=(names:string,extra:Partial<Host>={}):Host=>({family:'sh',names:names.split(' '),kind:'shell',style:'posix-sh',permute:false,prefix:'none',bundle:true,opts:shOpts,positional:'source-in-mode',lang:'sh',anyShort:true,...extra});
const pwshOpts:Opt[]=[
 P('command c',1,'source',{ends:true}),P('commandwithargs cwa',1,'source',{ends:true}),P('encodedcommand e ec enc',1,'source',{ends:true}),P('file f',1,'file',{ends:true}),
 P('workingdirectory wd',1,'cwd'),P('executionpolicy ep ex',1,'inert'),P('windowstyle w',1,'inert'),P('inputformat inp if',1,'inert'),P('outputformat o of',1,'inert'),
 P('configurationname config',1,'inert'),P('configurationfile',1,'inert'),P('custompipename',1,'inert'),P('settingsfile settings',1,'inert'),P('psconsolefile',1,'inert'),P('version v',1,'inert'),
 P('noprofile nop'),P('noninteractive noni'),P('nologo nol'),P('noexit noe'),P('noprofileloadtime'),P('interactive i'),P('login l'),P('sta'),P('mta'),P('help h ?',0,'noexec'),
];
const python:Opt[]=[...F('bBdEiIOPqRsSuvx'),...F('hV?','noexec'),...V('WX'),{short:'c',arity:1,role:'code',ends:true},{short:'m',arity:1,role:'file',ends:true},...L('help help-all help-env help-xoptions version',0,'noexec'),...L('check-hash-based-pycs',1,'inert')];
const perl:Opt[]=[...F('acfnpsStTuUwWX'),...F('hv','noexec'),...V('eE','code'),...V('IF'),
 {short:'0',arity:'optional',role:'inert',pat:/^[0-9a-fA-Fx]+/},{short:'l',arity:'optional',role:'inert',pat:/^[0-7]+/},{short:'C',arity:'optional',role:'inert',pat:/^[0-9A-Za-z]+/},
 ...[...'MmidDx'].map((short):Opt=>({short,arity:'optional',role:'inert'})),{short:'V',arity:'optional',role:'noexec'},...L('help version',0,'noexec')];
const ruby:Opt[]=[...F('acdlnpsSvwy'),...F('h','noexec'),...V('e','code'),...V('rICEF'),{short:'0',arity:'optional',role:'inert',pat:/^[0-7]+/},...[...'KTWxi'].map((short):Opt=>({short,arity:'optional',role:'inert'})),
 ...L('help version copyright',0,'noexec'),...L('verbose debug yydebug jit yjit rjit',0),...L('disable enable encoding external-encoding internal-encoding dump backtrace-limit parser',1,'inert')];
const node:Opt[]=[P('eval',1,'code'),{short:'e',arity:1,role:'code'},P('print',1,'code'),{short:'p',arity:1,role:'code'},...F('i'),...F('cvhV','noexec'),...V('rC'),
 ...L('check version help',0,'noexec'),...L('interactive'),...L('require import loader experimental-loader input-type conditions env-file title inspect-port encoding',1,'inert'),P('run',1,'file',{ends:true})];
const php:Opt[]=[{short:'r',arity:1,role:'code'},P('run',1,'code'),{short:'f',arity:1,role:'file',ends:true},P('file',1,'file',{ends:true}),...F('aCnqHsew'),...F('vhim','noexec'),...V('cdzBRFEStg'),
 ...L('version help info modules',0,'noexec'),...L('define php-ini',1,'inert'),...L('no-php-ini interactive')];
const interp=(names:string,opts:Opt[],lang:Lang,extra:Partial<Host>={}):Host=>({family:names.split(' ')[0]!,names:names.split(' '),kind:'interp',style:'interp',permute:false,prefix:'none',bundle:true,opts,positional:'file',lang,...extra});
const strings=(names:string,opts:Opt[]):Host=>({family:names,names:[names],kind:'strings',style:'gnu',permute:true,prefix:'gnu-long',bundle:true,opts,positional:'none',lang:'sh',lenient:true});
export const hosts:Host[]=[
 // POSIX-family shells: -c makes the first operand the command string; a later operand is $0.
 sh('sh dash ash hush yash posh osh nu elvish xonsh'),
 // Known short flags keep completed -c boundaries; unknown letters use inspectHost's source fallback.
 sh('bash rbash',{anyShort:false,opts:[...shOpts,...F('bdfhiklmprstvxBCEHPT')]}),
 sh('ksh ksh93 mksh lksh oksh pdksh',{anyShort:false,opts:[...shOpts,...F('bdfhiklmprstvxBCDEX')]}),
 // zsh takes any option name as --name, and --emulate takes a value.
 sh('zsh',{family:'zsh',opts:[...shOpts,...L('emulate',1,'inert')],anyLong:true}),
 // fish runs every -c and -C; -n only parses.
 {family:'fish',names:['fish'],kind:'shell',style:'gnu',permute:true,prefix:'none',bundle:true,positional:'sources-then-file',lang:'fish',
  opts:[{short:'c',arity:1,role:'source'},P('command',1,'source'),{short:'C',arity:1,role:'source'},P('init-command',1,'source'),{short:'n',arity:0,role:'noexec'},P('no-execute',0,'noexec'),
   ...V('dDfop'),...L('debug debug-stack-frames features debug-output profile profile-startup',1,'inert'),...F('ilNPv'),...F('h','noexec'),...L('interactive login no-config private print-rusage-self print-debug-categories'),...noexec]},
 // csh / tcsh: -c takes the next word; reading continues, so every -c is kept.
 {family:'csh',names:['csh','tcsh'],kind:'shell',style:'posix-sh',permute:false,prefix:'none',bundle:true,positional:'sources-then-file',lang:'csh',anyShort:true,
  opts:[{short:'c',arity:1,role:'source'},{short:'n',arity:0,role:'noexec'},{short:'D',arity:'optional',role:'inert'},...noexec]},
 // Windows PowerShell 5.1 reads a bare first word as a command; pwsh reads it as a script file.
 {family:'powershell',names:['powershell','powershell_ise'],kind:'shell',style:'pwsh',permute:false,prefix:'pwsh-any',bundle:false,opts:pwshOpts,positional:'command',lang:'pwsh'},
 {family:'pwsh',names:['pwsh'],kind:'shell',style:'pwsh',permute:false,prefix:'pwsh-any',bundle:false,opts:pwshOpts,positional:'file',lang:'pwsh'},
 // cmd: /c and /k take the rest of the line, attached or not; switches may share a word (/d/c).
 {family:'cmd',names:['cmd'],kind:'shell',style:'cmd',permute:false,prefix:'none',bundle:false,opts:[],positional:'command',lang:'cmd'},
 // su / runuser hand the command string to the target user's shell wherever the user name stands.
 {...wrapper('su','lmfpP','csgGw','login preserve-environment pty','command session-command shell group supp-group whitelist-environment',{c:'source',command:'source','session-command':'source',s:'shell',shell:'shell'}),permute:true,positional:'user-then-shell-args'},
 {...wrapper('runuser','lmfpP','csugGw','login preserve-environment pty','command session-command shell user group supp-group whitelist-environment',{c:'source',command:'source','session-command':'source',s:'shell',shell:'shell',u:'user',user:'user'}),permute:true,positional:'user-then-shell-args',stopAfter:['u','user']},
 wrapper('sudo','AbEHiklnPSsVvKBN','ughpCTrtUDR','askpass background edit set-home preserve-env reset-timestamp non-interactive stdin shell login validate remove-timestamp list bell no-update','user group host prompt close-from command-timeout role type other-user chdir chroot',
  {s:'shell',shell:'shell',i:'shell',login:'shell',D:'cwd',chdir:'cwd',V:'noexec',l:'noexec',list:'noexec',v:'noexec'}),
 wrapper('doas','nLs','uC'),wrapper('run0','','uD','','user chdir'),wrapper('pkexec','','u','','user'),
 wrapper('systemd-run','','p','scope user wait collect pty pipe quiet','unit description property working-directory uid gid setenv'),wrapper('chronic'),wrapper('unbuffer','p'),
 {...wrapper('env','i0v','uCSP','ignore-environment null debug','unset chdir split-string path argv0 block-signal default-signal ignore-signal',{u:'env-unset',unset:'env-unset',C:'cwd',chdir:'cwd',S:'env-split','split-string':'env-split'}),family:'env'},
 wrapper('nice','','n','','adjustment',{},{numeric:true}),wrapper('ionice','it','cnpPut','','class classdata pid pgid uid'),
 wrapper('timeout','v','ks','foreground preserve-status verbose','kill-after signal',{},{lead:1}),
 wrapper('stdbuf','','ioe','','input output error'),wrapper('taskset','ap','c','all-tasks pid','cpu-list',{},{lead:1,leadUnless:['c','cpu-list']}),
 wrapper('chrt','afmobprRvdi','PTD','all-tasks fifo max other batch pid reset-on-fork rr verbose deadline idle','sched-runtime sched-period sched-deadline',{},{lead:1}),
 wrapper('flock','enouxsvF','wEc','exclusive nonblock unlock shared verbose no-fork close','timeout wait conflict-exit-code command',{c:'source',command:'source'},{positional:'lock-then-program'}),
 wrapper('caffeinate','dimsu','tw'),wrapper('setsid','cfw','','ctty fork wait'),wrapper('nohup'),wrapper('time','apv','fo','append portability verbose','format output'),
 wrapper('winpty'),wrapper('fakeroot'),wrapper('eatmydata'),wrapper('command','pvV','','','',{v:'noexec',V:'noexec'}),wrapper('builtin'),wrapper('exec','cl','a'),wrapper('busybox'),wrapper('toybox'),
 // watch joins its operands into one sh command line.
 {...wrapper('watch','dtxbecgprw','nq','differences no-title exec beep errexit color chgexit precise no-rerun no-wrap','interval equexit'),positional:'joined-source'},
 // Programs with an option whose value is a shell command line.
 strings('man',[...V('PH','source'),...L('pager html',1,'source')]),strings('ag',L('pager',1,'source')),strings('rg',L('pre',1,'source')),strings('sort',L('compress-program',1,'source')),strings('script',[{short:'c',arity:1,role:'source'},P('command',1,'source')]),
 // PowerShell cmdlets that run text or start a program.
 {family:'iex',names:['iex','invoke-expression'],kind:'cmdlet',style:'pwsh',permute:true,prefix:'pwsh-any',bundle:false,opts:[P('command',1,'source')],positional:'joined-source',lang:'pwsh'},
 {family:'start-process',names:['start-process','saps','start'],kind:'cmdlet',style:'pwsh',permute:true,prefix:'pwsh-any',bundle:false,unknownTakesValue:true,positional:'program',lang:'pwsh',
  opts:[P('filepath f',1,'program'),P('argumentlist a args',1,'inert'),P('wait'),P('nonewwindow nnw'),P('passthru'),P('usenewenvironment'),P('loaduserprofile lup')]},
 // Interpreters: which option carries source, in any legal bundle.
 interp('python py',python,'py'),interp('perl',perl,'perl'),interp('ruby',ruby,'ruby'),interp('node nodejs bun',node,'js',{aliases:{'-pe':['-p']}}),interp('deno',[],'js',{subcommands:{eval:'code'},lenient:true}),interp('php',php,'php'),
];
const byName=new Map<string,Host>();for(const host of hosts)for(const name of host.names)byName.set(name,host);
/** The row for a program name (already reduced to its base name), if it is a host. */
export function hostFor(program:string,dialect:ShellState['dialect']='sh'):Host|undefined {
 const host=byName.get(program)??(/^python\d+(?:\.\d+)*$/.test(program)?byName.get('python'):undefined);
 return host?.kind==='cmdlet'&&dialect!=='pwsh'?undefined:host;
}
const str=(v:Value|undefined)=>v?.k==='known'?v.s:undefined;
export interface HostRead{
 argv:Value[];flags:Set<string>;values:Map<string,Value[]>;consumed:Value[];positionals:Value[];restAt:number;
 sources:{text:Value;lang:Lang;code:boolean;name:string}[];sourceFlag:boolean;fileMode:boolean;cwd:Value[];shell?:Value;shellFlag:boolean;user?:Value;
 setOpts:ProcOpts;noexec:boolean;
 /** Index of the first option this row does not know, and the words after it. */
 unknownAt:number;uncertain:Value[];
 /** The option that ended reading (PowerShell -Command / -File / -EncodedCommand, python -c / -m). */
 end?:{name:string;at:number};
 /** cmd /c or /k: the word it stood in and any text attached to it. */
 cmd?:{at:number;attached:string};
}
const optionByName=(opts:ProcOpts,name:string,on:boolean)=>{
 const key=name.toLowerCase().replace(/[-_]/g,'');
 if(key==='nounset')opts.nounset=on;else if(key==='unset')opts.nounset=!on;else if(key==='errexit')opts.errexit=on;else if(key==='noerrexit')opts.errexit=!on;else if(key==='allexport')opts.allexport=on;else if(key==='noallexport')opts.allexport=!on;
};
/** Reads argv (without the program word) against one row. */
export function readHost(input:readonly Value[],host:Host,raw:readonly Word[]=[]):HostRead {
 let argv=[...input];
 const r:HostRead={argv,flags:new Set(),values:new Map(),consumed:[],positionals:[],restAt:argv.length,sources:[],sourceFlag:false,fileMode:false,cwd:[],shellFlag:false,setOpts:{},noexec:false,unknownAt:-1,uncertain:[]};
 const unknown=(i:number)=>{if(r.unknownAt<0&&!host.lenient)r.unknownAt=i;};
 const apply=(opt:Opt,name:string,value:Value|undefined,on=true)=>{
  r.flags.add(name);if(value){r.values.set(name,[...(r.values.get(name)??[]),value]);r.consumed.push(value);}
  if(opt.role==='noexec'){if(on)r.noexec=true;}
  else if(opt.role==='source'){if(value===undefined)r.sourceFlag=true;else r.sources.push({text:value,lang:opt.lang??host.lang,code:false,name});}
  else if(opt.role==='code'){if(value)r.sources.push({text:value,lang:opt.lang??host.lang,code:true,name});}
  else if(opt.role==='file')r.fileMode=true;
  else if(opt.role==='cwd'){if(value)r.cwd.push(value);}
  else if(opt.role==='shell'){if(value)r.shell=value;else r.shellFlag=true;}
  else if(opt.role==='user')r.user=value;
  else if(opt.role==='set-opt'||opt.role==='clear-opt'){const set=(opt.role==='set-opt')===on;if(opt.sets)for(const key of Object.keys(opt.sets) as (keyof ProcOpts)[])r.setOpts[key]=set;else if(value?.k==='known')optionByName(r.setOpts,value.s,set);}
 };
 const finish=()=>{if(!host.permute)r.positionals=argv.slice(r.restAt);r.argv=argv;r.uncertain=r.unknownAt<0?[]:argv.slice(r.unknownAt+1);return r;};
 if(host.style==='cmd'){
  for(let i=0;i<argv.length;i++){
   const s=str(argv[i])?.replace(/^\/\/(?=[a-z?])/i,'/');
   if(s===undefined||!s.startsWith('/')){r.restAt=i;break;}
   let at=0,taken=false;
   while(at<s.length&&s[at]==='/'){
    const letter=(s[at+1]??'').toLowerCase();
    if(letter==='c'||letter==='k'||letter==='r'){r.cmd={at:i,attached:s.slice(at+2)};taken=true;break;}
    if(letter==='?')r.noexec=true;
    let end=s.indexOf('/',at+2);if(end<0)end=s.length;
    const body=s.slice(at+1,end);if(/^v(?::|$)/i.test(body))r.setOpts.delayed=/on$/i.test(body);
    at=end;
   }
   if(taken){r.restAt=i+1;break;}
  }
  return finish();
 }
 if(host.style==='pwsh'){
  for(let i=0;i<argv.length;i++){
   const s=str(argv[i]);
   // A quoted string is a value, never a parameter name.
   if(s===undefined||!s.startsWith('-')||s==='-'||/^['"]/.test(raw[i]?.raw??'')){if(host.permute){r.positionals.push(argv[i]!);continue;}r.restAt=i;break;}
   const [head,...tail]=s.slice(1).split(':'),name=head!.toLowerCase();
   let opt=host.opts.find(o=>o.long!.includes(name));
   // PowerShell takes the first parameter (in its own order) that the typed prefix begins.
   if(!opt&&name)opt=host.opts.find(o=>o.long!.some(n=>n.startsWith(name)));
   if(!opt){if(host.unknownTakesValue)i++;else unknown(i);continue;}
   const value=opt.arity===1?(tail.length?known(tail.join(':')):argv[i+1]):undefined;
   if(opt.ends){r.end={name:opt.long![0]!,at:i};apply(opt,opt.long![0]!,value);r.restAt=i+1;break;}
   if(opt.arity===1&&!tail.length)i++;
   apply(opt,opt.long![0]!,value);
  }
  if(host.permute)r.restAt=argv.length;
  return finish();
 }
 const signs=host.style==='posix-sh'?'-+':'-';
 scan:for(let i=0;i<argv.length;i++){
  const v=argv[i]!,s=str(v);
  if(s!==undefined&&host.numeric&&/^-\d+$/.test(s))continue;
  if(s===undefined||s.length<2||!signs.includes(s[0]!)){
   if(!host.permute||host.stopAfter?.some(name=>r.flags.has(name))){r.restAt=i;if(host.permute)r.positionals.push(...argv.slice(i));break;}
   r.positionals.push(v);continue;
  }
  if(s==='--'){if(host.permute)r.positionals.push(...argv.slice(i+1));else r.restAt=i+1;break;}
  const alias=host.aliases?.[s];if(alias){argv=[...argv.slice(0,i),...alias.map(known),...argv.slice(i+1)];i--;continue;}
  // bash also takes its long options with one dash (-login, -norc).
  const single=host.style==='posix-sh'&&s[0]==='-'&&s[1]!=='-'&&host.opts.some(o=>o.long?.includes(s.slice(1)));
  if(s.startsWith('--')||single){
   const eq=single?-1:s.indexOf('='),name=single?s.slice(1):s.slice(2,eq<0?undefined:eq);
   let opt=host.opts.find(o=>o.long?.includes(name));
   if(!opt&&host.prefix==='gnu-long'){const hits=host.opts.filter(o=>o.long?.some(n=>n.startsWith(name)));if(hits.length===1)opt=hits[0];}
   if(!opt){if(host.anyLong){r.flags.add(name);optionByName(r.setOpts,name,true);}else unknown(i);continue;}
   const canonical=opt.long!.includes(name)?name:opt.long!.find(n=>n.startsWith(name))!;
   let value:Value|undefined;
   if(opt.arity===1)value=eq>=0?known(s.slice(eq+1)):argv[++i]??known('');
   else if(eq>=0){if(opt.arity==='optional')value=known(s.slice(eq+1));else unknown(i);}
   apply(opt,canonical,value);
   if(opt.ends){r.end={name:canonical,at:i};r.restAt=i+1;break;}
   continue;
  }
  const on=s[0]==='-';
  for(let j=1;j<s.length;j++){
   const ch=s[j]!,opt=host.opts.find(o=>o.short===ch);
   if(!opt){r.flags.add(ch);if(!host.anyShort)unknown(i);continue;}
   if(opt.arity===1){
    const rest=s.slice(j+1),attached=host.style!=='posix-sh'&&rest!=='';
    const value=attached?known(rest):argv[++i]??known('');
    apply(opt,ch,value,on);
    if(opt.ends){r.end={name:ch,at:i};r.restAt=i+1;break scan;}
    if(attached)break;
    continue;
   }
   if(opt.arity==='optional'){const m=(opt.pat??/^[\s\S]+/).exec(s.slice(j+1));apply(opt,ch,m?known(m[0]):undefined,on);if(m)j+=m[0].length;continue;}
   apply(opt,ch,undefined,on);
  }
 }
 return finish();
}
/** What `inspectHost` needs from the walker. Every state it is handed is already a fresh copy. */
export interface HostCtx{
 program:string;raw:Word[];st:ShellState;child:ShellState;
 /** Walks `source` as a new process of `host` started from `from`, with the options its argv set. */
 run(source:string,host:Host,from:ShellState,opts?:ProcOpts,positional?:Value[],cwd?:Value):void;
 /** Walks a parsed PowerShell script block as that new process. */
 runBlock(block:Script,host:Host,from:ShellState,cwd?:Value):void;
 /** Reads an argv as a command of its own (the walker peels it). */
 peel(argv:Value[],from:ShellState):void;
 /** The text on this command's standard input, when the command line shows it. */
 stdin():string|undefined;
 /** Changes a state's working directory. */
 chdir(state:ShellState,path:Value):void;
 /** env -S: the words of a split string, expanded in the caller. */
 split(text:string):{argv:Value[];raw:Word[]};
 /** Script blocks held by a PowerShell variable. */
 blocks(name:string):Script[]|undefined;
 setEnv(state:ShellState,name:string,value:string|undefined):void;
}
const shHost=hosts[0]!;
const quoteSh=(word:string)=>/^[\w@%+=:,./-]+$/.test(word)?word:"'"+word.replaceAll("'","'\\''")+"'";
/**
 * Acts on one host invocation. Returns the argv (program word first) that the wrapper goes on to run, or
 * undefined when the host has been fully read (its sources walked, or nothing to run).
 */
export function inspectHost(host:Host,input:Value[],x:HostCtx):{argv:Value[];raw:Word[];self?:boolean}|undefined {
 const read=readHost(input,host,x.raw),argv=read.argv,{child}=x;let raw=x.raw;
 const stop={argv:[] as Value[],raw:[] as Word[]};
 if(read.noexec)return host.kind==='wrapper'?stop:undefined;
 // Fail direction: an option this row does not know. Every word after it is read once as source in the host's
 // language (a harmless word yields nothing), and a wrapper is also read as if that option took the next word.
 if(read.unknownAt>=0){
  if(host.kind==='shell')for(const word of read.uncertain){const s=str(word);if(s&&!/^[-+]/.test(s))x.run(s,host,child,read.setOpts);}
  else if(host.kind==='wrapper'){
   if(host.opts.some(o=>o.role==='source'))for(const word of read.uncertain){const s=str(word);if(s&&!s.startsWith('-'))x.run(s,shHost,child);}
   if(read.uncertain.length>1&&host.positional==='program')x.peel([known(x.program),...argv.slice(0,read.unknownAt),...argv.slice(read.unknownAt+2)],child);
  }
 }
 const rest=argv.slice(read.restAt);
 if(host.kind==='strings'){
  for(const source of read.sources){const s=str(source.text);if(s!==undefined)x.run(s,shHost,child);}
  return host.family==='sort'?{argv:input,raw,self:true}:undefined;
 }
 if(host.kind==='cmdlet'){
  if(host.family==='iex'){
   const words=[...read.sources.map(s=>s.text),...read.positionals],values=words.length?words.map(str):[x.st.pipeFrom?.program==='\0values'?str(x.st.pipeFrom.argv[0]):undefined];
   if(values.every(v=>v!==undefined))x.run(values.join(' '),host,child);
   return undefined;
  }
  const positional=[...read.positionals],file=read.values.get('filepath')?.[0]??positional.shift(),list=read.values.get('argumentlist')?.[0]??positional.shift(),name=str(file),args=list?str(list):'';
  if(name!==undefined&&args!==undefined)x.run((/\s/.test(name)?"& '"+name.replaceAll("'","''")+"' ":name+' ')+args.replaceAll('\u0000,',' '),host,child);
  return undefined;
 }
 if(host.kind==='shell'){
  const stdin=()=>{const source=x.stdin();if(source!==undefined)x.run(source,host,child,read.setOpts,undefined,cwd);};
  let cwd:Value|undefined;for(const path of read.cwd)cwd=path;
  if(host.style==='cmd'){
   if(!read.cmd)return stdin(),undefined;
   const i=read.cmd.at;
   let source=argv.slice(i+1).map((value,j)=>{const s=x.st.dialect==='sh'?(str(value)??'').replace(/^\/\/(?=[a-z?]+(?::.*)?$)/i,'/'):str(value)??'';return j>0&&/[\s;&|<>]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join(' ');
   const quoted=raw[i+1]?.raw;if(argv.length===i+2&&child.platform==='win32'&&quoted?.startsWith('"')&&quoted.endsWith('"'))source=[quoted.slice(1,-1),...argv.slice(i+2).map(str)].join(' ');
   const attached=read.cmd.attached;if(attached)source=attached+(source?' '+source:'');
   if(source.startsWith('"')&&source.endsWith('"'))source=source.slice(1,-1);
   x.run(source,host,child,read.setOpts);return undefined;
  }
  if(host.style==='pwsh'){
   const command=(i:number,single=false)=>{
    // Host switches may still follow -Command; they are not part of the command text.
    const hostFlag=(word:string|undefined)=>!!word&&word.startsWith('-')&&host.opts.some(o=>o.arity===0&&o.role==='flag'&&o.long!.includes(word.slice(1).toLowerCase()));
    while(argv.length>i+2&&hostFlag(str(argv[i+1]))){argv.splice(i+1,1);raw=[...raw.slice(0,i+1),...raw.slice(i+2)];}
    const block=raw[i+1]?.parts.find(p=>p.k==='block');if(block?.k==='block'){x.runBlock(block.body,host,child,cwd);return;}
    const variable=raw[i+1]?.parts.find(p=>p.k==='var'),held=variable?.k==='var'?x.blocks(variable.name.toLowerCase()):undefined;if(held){for(const body of held)x.runBlock(body,host,child,cwd);return;}
    const source=(single?argv.slice(i+1,i+2):argv.slice(i+1)).map((value,j)=>{const s=str(value);if(s===undefined)return s;if(j>0&&/[\s;&|<>]/.test(s))return "'"+s.replaceAll("'","''")+"'";return s;});
    // The host's own argument reader turns backslash-quote into a quote (cmd, CreateProcess and Git Bash callers alike).
    const quoted=raw[i+1]?.raw;if(argv.length===i+2&&quoted&&quoted.length>1&&(child.platform==='win32'||x.st.dialect==='cmd')&&quoted.includes('\\"')&&quoted.startsWith('"')&&quoted.endsWith('"'))source[0]=quoted.slice(1,-1).replace(/(\\+)"/g,(_,slashes:string)=>'\\'.repeat(slashes.length>>1)+'"');
    if(source[0]==='-'){stdin();return;}
    if(source.length&&source.every(v=>v!==undefined))x.run(source.join(' '),host,child,read.setOpts,undefined,cwd);
   };
   if(read.end?.name==='encodedcommand'){const value=str(argv[read.end.at+1]);if(value!==undefined)x.run(Buffer.from(value,'base64').toString('utf16le'),host,child,read.setOpts,undefined,cwd);return undefined;}
   if(read.end?.name==='file')return undefined;
   if(read.end)return command(read.end.at,read.end.name==='commandwithargs'),undefined;
   if(rest.length)return host.positional==='command'?(command(read.restAt-1),undefined):undefined;
   return stdin(),undefined;
  }
  if(host.positional==='sources-then-file'){
   if(read.sources.length){for(const source of read.sources){const s=str(source.text);if(s)x.run(s,host,child,read.setOpts);}return undefined;}
   if(read.positionals.length)return undefined;
   return stdin(),undefined;
  }
  // POSIX-family shells.
  if(read.sources.length){for(const source of read.sources){const s=str(source.text);if(s)x.run(s,host,child,read.setOpts);}return undefined;}
  const words=str(rest[0])==='-'?rest.slice(1):rest,readsStdin=str(rest[0])==='-'||read.flags.has('s');
  if(read.sourceFlag){const source=str(words[0]);if(source)x.run(source,host,child,read.setOpts,[words[1]??known(x.program),...words.slice(2)]);return undefined;}
  if(words.length&&!readsStdin)return undefined;
  return stdin(),undefined;
 }
 // Program wrappers.
 for(const path of read.cwd)x.chdir(child,path);
 if(host.positional==='joined-source'){const source=rest.map(str);if(source.length&&source.every(v=>v!==undefined))x.run(source.join(' '),shHost,child);return undefined;}
 if(host.positional==='user-then-shell-args'){
  if(read.user!==undefined&&host.stopAfter&&!read.sources.length){const at=read.restAt<argv.length?read.restAt:argv.length-read.positionals.length;return read.positionals.length?{argv:read.positionals,raw:raw.slice(at)}:undefined;}
  const operands=read.positionals.filter(v=>str(v)!=='-'),shell=read.shell&&hostFor((str(read.shell)??'').split('/').at(-1)!)?.kind==='shell'?read.shell:known('bash');
  for(const source of read.sources)x.peel([shell,known('-c'),source.text,...operands.slice(1)],child);
  return undefined;
 }
 if(host.positional==='lock-then-program'){
  for(const source of read.sources){const s=str(source.text);if(s!==undefined)x.run(s,shHost,child);}
  if(read.sources.length)return undefined;
  if(['-c','--command'].includes(str(rest[1])??'')){const s=str(rest[2]);if(s!==undefined)x.run(s,shHost,child);return undefined;}
  return rest.length>1?{argv:rest.slice(1),raw:raw.slice(read.restAt+1)}:stop;
 }
 if(host.family==='sudo'&&read.shellFlag){
  // sudo -s / -i hand the words to the shell as one command line (escaped, so each word stays a word). The plain
  // joined reading is kept as well: a word that is itself a command line still cards.
  const words=rest.map(str);
  if(words.length&&words.every((v):v is string=>v!==undefined)){x.run(words.join(' '),shHost,child);const exact=words.map(quoteSh).join(' ');if(exact!==words.join(' '))x.run(exact,shHost,child);}
  return undefined;
 }
 if(host.family==='env'){
  if(read.flags.has('i')||read.flags.has('ignore-environment')){child.env.clear();child.vars?.clear();child.arrays?.clear();}
  for(const name of [...(read.values.get('u')??[]),...(read.values.get('unset')??[])])x.setEnv(child,str(name)??'',undefined);
  const split=[...(read.values.get('S')??[]),...(read.values.get('split-string')??[])].at(-1);
  let next=rest,nextRaw=raw.slice(read.restAt);
  if(split?.k==='known'){const words=x.split(split.s);next=[...words.argv,...rest];nextRaw=[...words.raw,...nextRaw];}
  while(/^[\w]+=/.test(str(next[0])??'')){const s=str(next[0])!,at=s.indexOf('=');x.setEnv(child,s.slice(0,at),s.slice(at+1));next=next.slice(1);nextRaw=nextRaw.slice(1);}
  return {argv:next,raw:nextRaw};
 }
 const lead=host.lead&&!host.leadUnless?.some(name=>read.flags.has(name))?host.lead:0;
 return {argv:rest.slice(lead),raw:raw.slice(read.restAt+lead)};
}
