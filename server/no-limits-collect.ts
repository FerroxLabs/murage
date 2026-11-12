// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner-only syntax discovery. This collector never simulates filesystem changes.
import { literalText, type Word } from './shell/lex.ts';
import { parse, type Command, type Script, type Redirect } from './shell/parse.ts';
import { assignmentOf, candidatesOf, expandWord, fork, newContext, ownerStdinProvenance, ownerWrapperSpec, resolveFrom, resolveName, shellCScript, simpleCommand,
  type Candidate, type SimpleCommand, type WalkContext } from './shell/walk.ts';
import { collectWindowsSyntax, looksLikePowerShell } from './shell/pwsh.ts';

export type CollectorDialect = 'posix' | 'cmd' | 'pwsh';
export type ScopeKind = 'branch' | 'subshell' | 'substitution' | 'pipeline' | 'function' | 'nested';
export interface CollectorScope { id: string; context: WalkContext }
export interface CollectedCommand<Cwd = unknown> {
  syntaxId: string; scopeId: string; dialect: CollectorDialect;
  command: SimpleCommand; context: WalkContext; ownerCwd?: Cwd;
  /** Same source body can be inspected at definition and at an actual call.
   * Records stay once-only; each location retains its own cwd annotation. */
  locations: { scopeId: string; context: WalkContext; ownerCwd?: Cwd }[];
  /** Whether the next command in this list requires this one's success. */
  next: 'sequence' | 'success' | 'alternative';
}
export interface CollectedWrite<Cwd = unknown> {
  syntaxId: string; scopeId: string; dialect: CollectorDialect; role: 'redirect';
  word: Word; candidates: Candidate[]; context: WalkContext; ownerCwd?: Cwd;
  locations: {scopeId:string; context:WalkContext; candidates:Candidate[]; ownerCwd?:Cwd}[];
}
export interface CollectionHooks<Cwd = unknown> {
  locate?(scope: CollectorScope): Cwd;
  advance?(record: CollectedCommand<Cwd>, scope: CollectorScope): void;
  fork?(parent: CollectorScope, child: CollectorScope, kind: ScopeKind): void;
  merge?(target: CollectorScope, branches: readonly CollectorScope[], kind: ScopeKind): void;
}
export interface CollectionOptions<Cwd = unknown> {
  cwd?: string; runtimePaths?: Readonly<Record<string,string>>; dialect?: CollectorDialect;
  sessionEdits?: ReadonlySet<string>;
  sessionFile?: (path:string)=>{text:string}|'unavailable';
  hooks?: CollectionHooks<Cwd>;
}
export interface CommandEnvelope<Cwd = unknown> {
  commands: CollectedCommand<Cwd>[]; writes: CollectedWrite<Cwd>[];
  diagnostics: { syntaxId: string; reason: string }[];
}

const lit = (text:string):Word=>({parts:[{kind:'lit',text,quote:'single'}]});
const basename = (name:string)=>name.replaceAll('\\','/').split('/').at(-1)!.replace(/\.exe$/i,'');

/** Stable syntax paths identify source occurrences, never callback visit counts.
 * Available literal eval assignments are gathered before interpreting any body.
 * Variables in producer arguments remain raw Words, even when candidates expand.
 */
export function collectNoLimits<Cwd = unknown>(text:string, options:CollectionOptions<Cwd> = {}):CommandEnvelope<Cwd> {
  const envelope:CommandEnvelope<Cwd>={commands:[],writes:[],diagnostics:[]};
  const hooks=options.hooks;
  const bodies=new Map<string,Map<string,Word>>();
  const functions=new Map<string,{body:Command;id:string}>();
  const discovered=new Set<string>(), emitted=new Set<string>(), activeFunctions=new Set<string>();
  const activeBodies=new Set<string>();
  const records=new Map<string,CollectedCommand<Cwd>>();
  const writeRecords=new Map<string,CollectedWrite<Cwd>>();
  const pendingEvals:{words:Word[];id:string}[]=[];
  const root:CollectorScope={id:'root',context:newContext(options.cwd,options.runtimePaths)};
  const diagnostic=(id:string,error:unknown)=>envelope.diagnostics.push({syntaxId:id,reason:error instanceof Error?error.message:String(error)});
  function child(parent:CollectorScope,id:string,kind:ScopeKind):CollectorScope {
    const scope={id,context:fork(parent.context)};hooks?.fork?.(parent,scope,kind);return scope;
  }
  function merge(target:CollectorScope,branches:CollectorScope[],kind:ScopeKind) {
    hooks?.merge?.(target,branches,kind);
    // Ordinary expansion metadata is bounded and intentionally loses correlation.
    for(const branch of branches)for(const [name,value] of branch.context.bound){
      const prior=target.context.bound.get(name);
      if(JSON.stringify(prior)!==JSON.stringify(value))target.context.bound.set(name,null);
    }
  }
  function candidates(word:Word,scope:CollectorScope):Candidate[] {
    try{return candidatesOf(word,scope.context);}catch{return [{kind:'value',why:'unavailable expansion',path:word.parts.filter(p=>p.kind==='lit').map(p=>p.text).join(''),lead:true}];}
  }
  function remember(name:string,word:Word) {
    const choices=bodies.get(name)??new Map<string,Word>();
    choices.set(JSON.stringify(word),word);bodies.set(name,choices);
  }
  function discover(script:Script,id:string) {
    const key=JSON.stringify(script);if(discovered.has(key))return;discovered.add(key);
    function cmd(c:Command,path:string) {
      if(c.kind==='simple'){
        for(const a of c.assigns)if(!a.append)remember(a.name,a.value);
        if(c.words[0]&&resolveName(c.words[0])==='eval')pendingEvals.push({words:c.words.slice(1),id:path+'/eval-discovery'});
        if(c.words[0]&&/^(?:export|local|declare|typeset|readonly)$/.test(resolveName(c.words[0])??'')){
          for(const word of c.words.slice(1)){const a=assignmentOf(word);if(a&&!a.append)remember(a.name,a.value);}
        }
      }
      if(c.kind==='function'){functions.set(c.name,{body:c.body,id:path+'/body'});cmd(c.body,path+'/body');}
      else if(c.kind==='if'){for(const [i,clause] of c.clauses.entries()){discover(clause.cond,`${path}/cond${i}`);discover(clause.body,`${path}/arm${i}`);}if(c.otherwise)discover(c.otherwise,path+'/else');}
      else if(c.kind==='loop'){discover(c.cond,path+'/cond');discover(c.body,path+'/body');}
      else if(c.kind==='for'){for(const word of c.words??[])remember(c.name,word);discover(c.body,path+'/body');}
      else if(c.kind==='group'||c.kind==='subshell')discover(c.body,path+'/body');
      else if(c.kind==='case')for(const [i,clause] of c.clauses.entries())discover(clause.body,`${path}/case${i}`);
    }
    for(const [i,item] of script.items.entries())for(const [j,p] of item.andOr.pipelines.entries())for(const [k,c] of p.commands.entries())cmd(c,`${id}/${i}/${j}/${k}`);
  }
  function literalBodies(word:Word,seen=new Set<string>()):string[] {
    const direct=literalText(word);if(direct!==undefined)return [direct];
    // Concatenation is deliberately not a value simulator. A complete variable
    // body reference can expose each syntactic assignment independently.
    if(word.parts.length!==1||word.parts[0]?.kind!=='var')return [];
    const part=word.parts[0],name=part.name;if(seen.has(name))return [];
    const next=new Set(seen).add(name);
    return [...(bodies.get(name)?.values()??[]),...(part.word?[part.word]:[])].flatMap(w=>literalBodies(w,next));
  }
  function nested(body:string,scope:CollectorScope,id:string,dialect:CollectorDialect,kind:ScopeKind='nested',inPlace=false) {
    const key=`${dialect}:${body}`;
    if(activeBodies.has(key))return;
    if(activeBodies.size>=64){diagnostic(id,'nested syntax discovery bound');return;}
    activeBodies.add(key);
    const inner=inPlace?scope:child(scope,id,kind);
    try{
      if(dialect!=='posix')windows(body,inner,id,dialect);
      else{
        const script=parse(body);discover(script,id);
        let changed=true;
        while(changed){
          const count=discovered.size;
          for(const pending of [...pendingEvals])for(const [i,word]of pending.words.entries())for(const [j,value]of literalBodies(word).entries()){
            try{discover(parse(value),`${pending.id}/${i}/${j}`);}catch{ /* opaque body adds no operation */ }
          }
          changed=discovered.size!==count;
        }
        list(script,inner,id);
      }
    }catch(error){diagnostic(id,error);}finally{activeBodies.delete(key);}
  }
  function wordBodies(word:Word,scope:CollectorScope,id:string,dialect:CollectorDialect) {
    for(const [i,p] of word.parts.entries()){
      if(p.kind==='subst'||p.kind==='procsub')nested(p.text,scope,`${id}/part${i}`,dialect,'substitution');
      else if(p.kind==='var'&&p.word)wordBodies(p.word,scope,`${id}/part${i}`,dialect);
      else if(p.kind==='brace')for(const [j,alt] of p.alts.entries())wordBodies(alt,scope,`${id}/part${i}/alt${j}`,dialect);
    }
  }
  function redirects(rows:Redirect[],scope:CollectorScope,id:string,dialect:CollectorDialect) {
    for(const [i,row] of rows.entries())if(row.target){
      wordBodies(row.target,scope,`${id}/redirect${i}`,dialect);
      if(/^(?:\d*|&)>(?:>|\|)?$|^<>$/.test(row.op)){
        write(row.target,scope,`${id}/redirect${i}`,dialect);
      }
    }
  }
  function write(word:Word,scope:CollectorScope,syntaxId:string,dialect:CollectorDialect) {
    const location={scopeId:scope.id,context:fork(scope.context),candidates:candidates(word,scope),...(hooks?.locate?{ownerCwd:hooks.locate(scope)}:{})};
    const recordKey=`${dialect}:${syntaxId}`;
    const previous=writeRecords.get(recordKey);
    if(previous){if(!previous.locations.some(l=>l.scopeId===scope.id))previous.locations.push(location);return;}
    const row:CollectedWrite<Cwd>={syntaxId,dialect,role:'redirect',word,...location,locations:[location]};
    writeRecords.set(recordKey,row);envelope.writes.push(row);
  }
  function record(name:string,args:Word[],scope:CollectorScope,id:string,dialect:CollectorDialect,next:CollectedCommand['next'],rs:Redirect[]=[],stdin?:SimpleCommand['stdin']) {
    const context=fork(scope.context);
    const location={scopeId:scope.id,context,...(hooks?.locate?{ownerCwd:hooks.locate(scope)}:{})};
    const recordKey=`${dialect}:${id}`;
    const previous=records.get(recordKey);
    if(previous){
      if(previous.locations.some(l=>l.scopeId===scope.id))return;
      previous.locations.push(location);
      hooks?.advance?.({...previous,...location},scope);return;
    }
    if(emitted.has(recordKey))return;
    emitted.add(recordKey);
    stdin??=scope.context.stdin;
    for(const redirect of rs){
      if(redirect.heredoc)stdin={kind:'literal',text:redirect.heredoc.body,words:[]};
      else if(redirect.op==='<'&&redirect.target){
        const value=literalText(redirect.target);
        stdin=value===undefined?{kind:'value',why:'unknown redirected input'}:{kind:'file',path:resolveFrom(scope.context.cwd,value)};
      }
    }
    let command:SimpleCommand;
    try{command=simpleCommand(name,args,context,{redirects:rs,...(stdin?{stdin}:{})});}
    catch{command={name,args,operands:args.map(w=>candidates(w,scope)),redirects:rs,elevated:false,...(stdin?{stdin}:{})};}
    const item:CollectedCommand<Cwd>={syntaxId:id,dialect,command,next,locations:[location],...location};
    records.set(recordKey,item);envelope.commands.push(item);hooks?.advance?.(item,scope);
  }
  function executable(words:Word[],scope:CollectorScope,id:string,next:CollectedCommand['next'],rs:Redirect[]=[]) {
    const head=words[0];if(!head)return;
    const resolved=resolveName(head);
    if(!resolved){
      const names=new Set<string>();
      try{for(const word of expandWord(head,scope.context)){const name=resolveName(word);if(name)names.add(name);}}catch{ /* retain other available literal names */ }
      for(const body of literalBodies(head)){const name=resolveName(lit(body));if(name&&!/\s/.test(name))names.add(name);}
      for(const [i,name]of [...names].entries())executable([lit(name),...words.slice(1)],scope,`${id}/program${i}`,next,rs);
      return;
    }
    const name=basename(resolved),args=words.slice(1),plain=args.map(literalText);
    // Reuse raw words. Wrapper-carried code is never reconstructed by renderWord.
    const wrapper=ownerWrapperSpec(name);
    if(wrapper){
      record(name,args,scope,id,'posix',next,rs);
      const wrapped=/^(?:command|builtin)$/.test(name)?scope:child(scope,id+'/wrapper','nested');
      let at=0,positionals=0;
      const unknown:Word={parts:[{kind:'var',name:'MURAGE_COLLECTOR_UNKNOWN',quote:'double'}]};
      while(at<args.length){
        const value=literalText(args[at]!);if(value===undefined)break;
        if(value==='--'){at++;break;}
        if(wrapper.assignments&&/^[A-Za-z_]\w*=/.test(value)){at++;continue;}
        if(value.startsWith('-')&&value!=='-'){
          if(wrapper.numeric&&/^-\d+$/.test(value)){at++;continue;}
          const eq=value.startsWith('--')?value.indexOf('='):-1;
          const long=eq<0?value:value.slice(0,eq);
          const opts=value.startsWith('--')||wrapper.flags.has(value)?[long]:[...value.slice(1)].map(c=>'-'+c);
          let handled=false;
          for(const [i,opt]of opts.entries()){
            if(wrapper.scripts?.has(opt)||wrapper.values.has(opt)){
              const attached=eq>=0?value.slice(eq+1):!value.startsWith('--')&&opts.length>i+1?value.slice(i+2):undefined;
              const operand=attached!==undefined?lit(attached):args[at+1];
              at+=attached!==undefined?1:2;handled=true;
              if(wrapper.cwd?.has(opt))record('cd',[operand??unknown],wrapped,`${id}/cwd`,'posix','success');
              if(wrapper.scripts?.has(opt)){
                const body=operand&&literalText(operand);
                if(body!==undefined)nested(body,wrapped,id+'/wrapper-script','posix','nested',true);
                return;
              }
              break;
            }
            if(wrapper.login?.has(opt))record('cd',[unknown],wrapped,`${id}/login-cwd`,'posix','success');
          }
          if(!handled)at++;
          continue;
        }
        if(positionals<(wrapper.positional??0)){positionals++;at++;continue;}
        break;
      }
      let rest=args.slice(at);
      if(wrapper.xargs){
        const replaceAt=plain.findIndex(v=>v==='-I'||v==='--replace');
        const replacement=replaceAt<0?undefined:plain[replaceAt+1];
        if(replacement)rest=rest.map(w=>({parts:w.parts.flatMap(p=>p.kind==='lit'&&p.text.includes(replacement)?unknown.parts:[p])}));
        else rest=[...rest,unknown];
      }
      executable(rest,wrapped,`${id}/wrapped`,next,rs);return;
    }
    record(name,args,scope,id,'posix',next,rs);
    const shape=functions.get(name);
    if(shape&&!activeFunctions.has(name)){
      const call=child(scope,id+'/call','function');
      activeFunctions.add(name);try{command(shape.body,call,shape.id,next);}finally{activeFunctions.delete(name);}
      scope.context.cwd=call.context.cwd;
      for(const [name,value]of call.context.bound)scope.context.bound.set(name,value);
      hooks?.merge?.(scope,[call],'function');return;
    }
    if(name==='eval'){
      // Every available body, including correlated branch assignments, is visited.
      const alternatives=args.map(arg=>literalBodies(arg));
      if(alternatives.every(a=>a.length===1))nested(alternatives.map(a=>a[0]).join(' '),scope,id+'/eval','posix','nested',true);
      else for(const [i,choices] of alternatives.entries())for(const [j,body] of choices.entries())nested(body,scope,`${id}/eval${i}-${j}`,'posix');
    }
    if(/^(?:sh|bash|zsh|dash|ksh|mksh)$/.test(name)){
      const at=shellCScript(args,name);
      if(at!==undefined){const body=literalText(args[at]!);if(body!==undefined)nested(body,scope,id+'/shell','posix');}
      else{
        for(const [i,r] of rs.entries())if(r.heredoc)nested(r.heredoc.body,scope,`${id}/heredoc${i}`,'posix');
        if(!rs.some(r=>r.heredoc)&&scope.context.stdin?.kind==='literal')nested(scope.context.stdin.text,scope,id+'/literal-input','posix');
      }
    }
    if(name==='source'||name==='.'||/^(?:sh|bash|zsh|dash|ksh|mksh)$/.test(name)){
      const operand=args.find(w=>{const s=literalText(w);return s!==undefined&&!s.startsWith('-');});
      if(operand){
        const paths=candidates(operand,scope).filter(c=>c.kind==='literal');
        for(const candidate of paths){
          const path=resolveFrom(scope.context.cwd,candidate.path);
          if(options.sessionEdits?.has(path)){
            try{const file=options.sessionFile?.(path);if(file&&file!=='unavailable')nested(file.text,scope,id+'/session-file','posix','nested',name==='source'||name==='.');}
            catch(error){diagnostic(id+'/session-file',error);}
          }
        }
      }
    }
    if(/^(?:pwsh|powershell|cmd)$/.test(name)){
      const at=plain.findIndex(s=>s!==undefined&&/^(?:-c|-command|\/c|\/k)$/i.test(s));
      if(at>=0&&args[at+1]){
        // A single literal code word is an executable payload, not shell operands.
        const body=literalText(args[at+1]!);if(body!==undefined)nested(body,scope,id+'/windows',name==='cmd'?'cmd':'pwsh');
      }
    }
    if(name==='find')for(let i=0;i<plain.length;i++)if(plain[i]==='-exec'||plain[i]==='-execdir'){
      const end=plain.findIndex((p,j)=>j>i&&(p===';'||p==='+'&&plain[j-1]==='{}'));
      let executableScope=scope;
      if(plain[i]==='-execdir'){
        executableScope=child(scope,`${id}/execdir${i}`,'nested');
        executableScope.context.bound.set('MURAGE_COLLECTOR_UNKNOWN_CWD',null);
        record('cd',[{parts:[{kind:'var',name:'MURAGE_COLLECTOR_UNKNOWN_CWD',quote:'double'}]}],executableScope,`${id}/execdir-cwd${i}`,'posix','success');
      }
      executable(args.slice(i+1,end<0?undefined:end),executableScope,`${id}/exec${i}`,next);
    }
    if(name==='trap'&&args[0])for(const body of literalBodies(args[0]))nested(body,scope,id+'/trap','posix');
  }
  function command(c:Command,scope:CollectorScope,id:string,next:CollectedCommand['next']) {
    redirects(c.redirects,scope,id,'posix');
    if(c.kind==='simple'){
      for(const [i,a] of c.assigns.entries()){
        wordBodies(a.value,scope,`${id}/assign${i}`,'posix');
        scope.context.bound.set(a.name,a.append?null:[a.value]);
      }
      if(c.words[0]&&/^(?:export|local|declare|typeset|readonly)$/.test(resolveName(c.words[0])??'')){
        for(const word of c.words.slice(1)){const a=assignmentOf(word);if(a)scope.context.bound.set(a.name,a.append?null:[a.value]);}
      }
      for(const [i,w] of c.words.entries())wordBodies(w,scope,`${id}/word${i}`,'posix');
      executable(c.words,scope,id,next,c.redirects);return;
    }
    if(c.kind==='function'){
      const inner=child(scope,id+'/definition','function');
      command(c.body,inner,id+'/body',next);return;
    }
    if(c.kind==='group'){list(c.body,scope,id+'/group');return;}
    if(c.kind==='subshell'){list(c.body,child(scope,id+'/subshell','subshell'),id+'/subshell');return;}
    if(c.kind==='arith'||c.kind==='cond'){for(const [i,w]of c.words.entries())wordBodies(w,scope,`${id}/word${i}`,'posix');return;}
    const branches:CollectorScope[]=[];
    const branch=(script:Script,key:string)=>{const inner=child(scope,key,'branch');branches.push(inner);list(script,inner,key);};
    if(c.kind==='if'){
      for(const [i,clause] of c.clauses.entries()){branch(clause.cond,`${id}/cond${i}`);branch(clause.body,`${id}/arm${i}`);}
      if(c.otherwise)branch(c.otherwise,id+'/else');
    }else if(c.kind==='loop'){branch(c.cond,id+'/cond');branch(c.body,id+'/body');}
    else if(c.kind==='for'){
      for(const [i,w]of (c.words??[]).entries())wordBodies(w,scope,`${id}/word${i}`,'posix');
      if(c.header)wordBodies(c.header,scope,id+'/header','posix');
      const inner=child(scope,id+'/body','branch');branches.push(inner);
      inner.context.bound.set(c.name,c.words??null);list(c.body,inner,id+'/body');
    }else if(c.kind==='case'){
      wordBodies(c.word,scope,id+'/caseword','posix');for(const [i,clause]of c.clauses.entries())branch(clause.body,`${id}/case${i}`);
    }
    merge(scope,branches,'branch');
  }
  function list(script:Script,scope:CollectorScope,id:string) {
    for(const [i,item] of script.items.entries()){
      const itemScope=item.background?child(scope,`${id}/${i}/background`,'subshell'):scope;
      for(const [j,p] of item.andOr.pipelines.entries()){
        const next=item.andOr.ops[j]==='&&'?'success':item.andOr.ops[j]==='||'?'alternative':'sequence';
        for(const [k,c]of p.commands.entries()){
          const key=`${id}/${i}/${j}/${k}`,inner=p.commands.length>1?child(itemScope,key,'pipeline'):itemScope;
          const prior=inner.context.stdin;
          try{inner.context.stdin=ownerStdinProvenance(c,p.commands.slice(0,k),inner.context);}
          catch(error){diagnostic(key+'/input',error);inner.context.stdin={kind:'value',why:'unavailable input provenance'};}
          try{
            command(c,inner,key,next);
          }catch(error){diagnostic(key,error);}finally{inner.context.stdin=prior;}
        }
      }
    }
  }
  function windows(body:string,scope:CollectorScope,id:string,dialect:'cmd'|'pwsh') {
    try{collectWindowsSyntax(body,dialect,{
      command:(name,args,key,stdin)=>{
        record(name,args,scope,`${id}/${key}`,dialect,'sequence',[],stdin);
        for(const [i,w]of args.entries())wordBodies(w,scope,`${id}/${key}/word${i}`,dialect);
      },
      redirect:(word,key)=>{
        write(word,scope,`${id}/${key}`,dialect);
      },
      nested:(body,key,nestedDialect)=>nested(body,scope,`${id}/${key}`,nestedDialect,'substitution'),
    });}catch(error){diagnostic(id,error);}
  }
  const inferred=looksLikePowerShell(text);
  const dialect=options.dialect??(inferred==='pwsh'||inferred==='cmd'?inferred:/^\s*(?:mklink|fsutil)\b/i.test(text)?'cmd':'posix');
  if(inferred==='both'&&options.dialect!=='cmd'&&options.dialect!=='pwsh'){
    // Independent initial cwd states, one command envelope. Windows parsers
    // retain the same source occurrence identity with distinct dialect roles.
    for(const variant of ['cmd','pwsh'] as const)nested(text,child(root,`root/${variant}`,'nested'),'root',variant,'nested',true);
  }else nested(text,root,'root',dialect,'nested',true);
  return envelope;
}
