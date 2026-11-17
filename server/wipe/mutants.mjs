// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
assert.ok(process.env.CI,'Use the isolated network-none container');
const directory=process.env.WIPE_MUTANT_EVIDENCE??'/evidence/mutants';
assert.ok(!resolve(directory).startsWith(process.cwd()+'/'),'Evidence stays outside the repository');mkdirSync(directory,{recursive:true});
// A container batch can hold its preflight while the shared integration tip is merged.
const pause=join(directory,'PAUSE'),started=Date.now();
while(existsSync(pause)){assert.ok(Date.now()-started<20*60*1000,'Source integration pause expired');await new Promise(r=>setTimeout(r,500));}
const baselineFiles=['server/wipe-acceptance.test.ts','server/wipe/','server/wipe-breaker.test.ts','server/wipe-breaker-review.test.ts','server/wipe-project-roots-api.test.ts','server/no-limits-early-wipe.test.ts','server/drivers/claude-bash-hook.test.ts','server/no-limits-code.test.ts','server/no-limits-r13.test.ts','server/no-limits-symlink-r31.test.ts','server/no-limits-wipe-cover.test.ts','server/no-limits-wipe-r3.test.ts','server/no-limits-wipe-scripts.test.ts','server/decision/no-limits-truly.test.ts','server/decision/no-limits-merge-rulings.test.ts','server/decision/release-guard-r2.test.ts','server/decision/release-guard-r3.test.ts','server/decision/release-guard-r6.test.ts','server/decision/no-limits-x2.test.ts'];
const sharedReport=process.env.RESULT_DIR&&join(process.env.RESULT_DIR,'head.json');
const baseline=sharedReport&&existsSync(sharedReport)?{status:JSON.parse(readFileSync(sharedReport,'utf8')).numFailedTests?1:0,stdout:'Reused exact current SHA broad report\n',stderr:''}:spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...baselineFiles,'server/nl-win-1018.test.ts','--reporter=json','--outputFile='+join(directory,'baseline.json')],{encoding:'utf8',timeout:600000,maxBuffer:64<<20});
if(sharedReport&&existsSync(sharedReport))copyFileSync(sharedReport,join(directory,'baseline.json'));
writeFileSync(join(directory,'baseline.log'),(baseline.stdout??'')+(baseline.stderr??''));
try{await import('./preflight.mjs').then(m=>m.verifyV3Preflight(directory,baseline.status,sharedReport?process.env.RESULT_DIR:undefined));}
catch(error){writeFileSync(join(directory,'preflight-failure.json'),JSON.stringify({status:'FAIL',message:String(error)},null,2));process.exitCode=1;console.error('Preflight FAIL; all named mutant assertions still run, overall status remains failure.');}

const acceptance='server/wipe-acceptance.test.ts';
// MU4 retired: Equivalent mv -T operand selection on valid argv (retained original retirement).
// MU38 retired: S9 deleted the uncontained depth-fault path; throwing at that seam is now contained and equivalent on the old harmless nesting witness. Scanner loss is covered by MU39 and MU-V3-11.
const mutants=[
 ["MU1", "sh.ts", "c.redirects.push(r);", "if(!c.words.length)c.words.push({raw:'redirect',parts:[{k:'lit',s:'redirect',quoted:true}]});c.redirects.push(r);", "R2-H1b"],
 ["MU2", "programs.ts", "if(g.shortWithValue.includes(ch)){", "if(j===1&&g.shortWithValue.includes(ch)){", "R2-H1a|M3|M4"],
 ["MU3", "programs.ts", "const targetDir=has('t','target-directory')", "const targetDir=false", "M2"],
 ["MU5", "invocation.ts", "argv=c.words.flatMap((w,i)=>", "for(const a of c.assigns){const v=expandWord(a.value,st);st.env.set(a.name,text(v));}if(c.words[0]?.raw==='env'&&c.words[1]?.raw==='-u')st.env.set(c.words[2]?.raw??'',undefined);argv=c.words.flatMap((w,i)=>", "R1-H1a|R1-H1b"],
 ["MU6", "invocation.ts", "run:(source,host,from,opts,positional,cwd)=>{const next=start(from,host,opts);", "run:(source,host,from,opts,positional,cwd)=>{void from;const next=start(st,host,opts);", "R1-H1d"],
 ["MU7", "hosts.ts", "wrapper('sudo','AbEHiklnPSsVvKBN','ughpCTrtUDR',", "wrapper('sudo','AbEHiklnPSsVvKBNughpCTrtUDR','',", "W2"],
 ["MU8", "programs.ts", "if(uncertain&&risky)effects.push", "if(false)effects.push", "M13"],
 ["MU9", "programs.ts", "if(uncertain&&risky)effects.push", "if(opts.uncertain)effects.push", "M15", "server/wipe/v2.test.ts"],
 ["MU10", "programs.ts", "const dest=opts.positionals.at(-1)", "const dest=opts.positionals[0]", "Y1"],
 ["MU11", "programs.ts", "'eBTfM'", "'BTfM'", "Y9", "server/wipe/v2.test.ts"],
 ["MU12", "find.ts", "if(restrictive.test(name)&&!matchAll)t=", "if(false)t=", "W19|W21"],
 ["MU13", "find.ts", "const restrictive=/^-(?:", "const restrictive=/^-(?:type|", "W18"],
 ["MU14", "native.ts", "if(effect.op==='delete')return [{k:'delete',target:known(effect.path),recursive:effect.recursive??'unknown',follow:effect.followFinal}];", "if(effect.op==='delete')return [{k:'write',target:known(effect.path)}];", "X3"],
 ["MU15", "native.ts", "recursive:effect.recursive??'unknown'", "recursive:effect.recursive??false", "R2-H2b-effects"],
 ["MU16", "native.ts", "if(effect.op==='rename')return effect.source?[{k:'move-away',source:known(effect.source),follow:effect.sourceFollowFinal??effect.followFinal}]:[];", "if(effect.op==='rename')return [];", "X11"],
 ["MU17", "../decision/wipe-input.ts", "catch{return captureWipeFields(value);}", "catch{return null;}", "R1-H2a"],
 ["MU18", "../drivers/claude-bash-hook.ts", "noLimitsWipe(command,{...current,cwd})", "noLimitsWipe(command,{...current,cwd,registry:{contains:()=>false}})", "R1-H5"],
 ["MU19", "root-wiring.ts", "if(change.type!=='workroot')return;", "if(change.type==='bot'){build();return;}if(change.type!=='workroot')return;", "P-1", "server/wipe/perf.test.ts"],
 ["MU20", "registry.ts", "this.ensureBuilt();this.stats.queries++;", "this.ensureBuilt();for(const paths of this.owners.values())for(const path of paths.keys())physicalPath(this.port,path);this.stats.queries++;", "V3-P1", "server/wipe/perf-v3.test.ts"],
 ["MU21", "roots.ts", "target===root||root.startsWith(target==='/'?'/':target+'/')", "target===root", "T22|T26"],
 ["MU22", "expand.ts", "return {...known(whole[1]!),wholeDirGlob:true,globText:s};", "return known(s);", "T9"],
 ["MU23", "expand.ts", "return globValue(s,st.dialect==='sh'&&s.includes('\\\\')?'pwsh':st.dialect);", "{const slash=Math.max(s.lastIndexOf('/'),s.lastIndexOf('\\\\'));return known(slash<0?'.':s.slice(0,slash)||'/');}", "V3-A16", "server/wipe/v3-regressions.test.ts"],
 ["MU24", "decide.ts", "if(effect.k==='write'||effect.k==='delete'&&effect.recursive===false)continue;", "if(effect.k==='write')continue;", "T35", "server/wipe/v2.test.ts"],
 ["MU25", "native.ts", "else effects.push({k:device(known(path))?'device-write':'write',target:known(path)});", "else effects.push({k:'delete',target:known(path),recursive:true});", "X7"],
 ["MU26", "programs.ts", "if(p==='dd'){", "if(p==='dd')return effects;if(false){", "D3"],
 ["MU27", "invocation.ts", "return c.stdinHeredoc??c.redirects.find(r=>r.heredoc!==undefined)?.heredoc??(here?", "return undefined??(here?", "N8"],
 ["MU28", "invocation.ts", "if(shellHost?.kind==='shell'){inspectHost(shellHost,argv,hostCtx(program,raw));return;}", "if(shellHost?.kind==='shell'||c.stdinHeredoc!==undefined){inspectHost(shellHost??hostFor('sh')!,argv,hostCtx(program,raw));return;}", "N9"],
 ["MU29", "pwsh-model.ts", "const matches = exact.length ? exact : parameters.filter(p => p.name.toLowerCase().startsWith(spelling));", "const matches = exact;", "P3"],
 ["MU30", "programs.ts", "opts.flags.has('s')", "opts.flags.has('never-recursive')", "C1"],
 ["MU31", "../wipe-breaker.ts", "catch{return coarseEvidence(text)?wipeCheckFault():null;}", "catch{return null;}", "V3-G6", "server/wipe/v3-regressions.test.ts"],
 ["MU32", "../decision/implementation.ts", "):boolean{return noLimitsAppliesTo", "):boolean{return value.actor==='other'||noLimitsAppliesTo", "G1"],
 ["MU33", "roots.ts", "if(/^workspaces\\/", "if(/^never-workspaces\\/", "T27"],
 ["MU34", "roots.ts", "(?:\\/threads\\/[\\w-]+)?$/.test(relative)", "(?:\\/threads\\/[\\w-]+)?(?:\\/.*)?$/.test(relative)", "T28"],
 ["MU35", "../decision/release-guard.ts", "shared=wipeContextFor(identity?.threadId,identity?.botId,{cwd:operation.cwd});", "shared={};", "X13"],
 ["MU36", "expand.ts", "return known(value??'');", "if(value===undefined)return opaque('unset');return known(value);", "T11"],
 ["MU37", "programs.ts", "opts.positionals.filter(v=>!nonDestructive.has(v)).map(target)", "a.map(target)", "M17", "server/wipe/v2.test.ts"],
 ["MU39", "evidence.ts", "const out:Invocation[]=[],work=[source];", "const out:Invocation[]=[],work:string[]=[];void source;", "F5 F6 H1", "server/wipe/fault-v2.test.ts"],
 ["MU40", "find.ts", "if(restrictive.test(name)&&!matchAll)t=", "if(restrictive.test(name))t=", "W24", "server/wipe/v2.test.ts"],
 ["MU41", "find.ts", "effects.push(...peel(argv,state).flatMap(effectsOf));", "void argv;void state;", "W25", "server/wipe/v2.test.ts"],
 ["MU42", "invocation.ts", "if(n.k==='subshell'){out.push(...walk(n.body,fork(st,'subshell')));return;}", "if(n.k==='subshell'){out.push(...walk(n.body,st));return;}", "S1b", "server/wipe/v2.test.ts"],
 ["MU43", "hosts.ts", " for(const path of read.cwd)x.chdir(child,path);", " void 0;", "S6b", "server/wipe/v2.test.ts"],
 ["MU44", "invocation.ts", "if(r.heredoc!==undefined&&r.expanding)", "if(false&&r.heredoc!==undefined&&r.expanding)", "S8", "server/wipe/v2.test.ts"],
 ["MU45", "pwsh-model.ts", "{name:'NewName',kind:'newname',pos:1},...switches('Force','PassThru'),...values('Credential'),...common],effect:'move-away',recursive:'always'},", "{name:'NewName',kind:'newname',pos:1},...switches('Force','PassThru'),...values('Credential'),...common],recursive:'always'},", "P16", "server/wipe/v2.test.ts"],
 ["MU46", "../no-limits-operation.ts", "followFinal:!['delete','rename','link'].includes(op),...more}", "followFinal:!['delete','rename','link'].includes(op),...more,...(body.recursive===false||more.recursive===false?{recursive:undefined}:{})}", "X14|X15", "server/wipe/v2.test.ts"],
 ["MU47", "../decision/action.ts", "const native=nativeWipeBreaker(effective,payload,wipeContext,engine?.filePaths);", "const native=/^(?:purge|trash)/.test(effective)?null:nativeWipeBreaker(effective,payload,wipeContext,engine?.filePaths);", "X18", "server/wipe/v2.test.ts"],
 ["MU48", "roots.ts", "if(!follow&&stat?.isSymbolicLink?.())return;", "void 0;", "L1|L4|L5", "server/wipe/v2.test.ts"],
 ["MU49", "roots.ts", "const lexical=canonicalPath(raw,this.ctx.platform);", "const lexical=canonicalPath(raw,this.ctx.platform);if(/^\\/mnt\\/[^/]+$/.test(lexical))return 'drive-root';", "K3", "server/wipe/mount-v2.test.ts"],
 ["MU50", "../store.ts", "if(priorRootTasks)this.taskWorkRootDelta", "if(false)this.taskWorkRootDelta", "E1", "server/wipe/events-v2.test.ts"],
 ["MU51", "../store.ts", "this.taskWorkRootDelta(id,priorRootTasks,live.tasks??[])", "this.taskWorkRootDelta(id,priorRootTasks,priorRootTasks)", "E7", "server/wipe/events-v2.test.ts"],
 ["MU52", "invocation.ts", "st.dialect==='sh'&&!st.proc?.errexit&&n.join!=='&&'", "false", "S10", "server/wipe/v2.test.ts"],
 ["MU53", "programs.ts", "['mke2fs','wipefs','diskpart','format-volume','clear-disk','remove-partition']", "['mke2fs','wipefs','diskpart','format-volume','clear-disk','remove-partition','initialize-disk']", "D13", "server/wipe/v2.test.ts"],
 ["MU-WINREVIEW-H1", "pwsh-model.ts", "filters:[...filters,'hidden','readonly','system']", "filters:[...filters,'readonly','system']", "WINREVIEW-H1 hidden", "server/wipe/wincheck-review.test.ts"],
 ["MU-WINREVIEW-H2", "evidence.ts", "coarseDiskEvidence(source)||", "", "WINREVIEW-H2 plain", "server/wipe/wincheck-review.test.ts"],
 ["MU-WINREVIEW-M2", "../wipe-breaker.ts", "}catch{\n  try{return evaluate(evidenceScan", "}catch{\n  if(ctx.dialect)return null;\n  try{return evaluate(evidenceScan", "WINREVIEW-M2", "server/wipe/wincheck-review.test.ts"],
 ["MU-V3-1", "sh.ts", "ansi.split('\\0')[0]!", "ansi", "V3-X2", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-2", "sh.ts", "|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})", "", "V3-A1", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-3", "expand.ts", "else values=parameter(part,st);split=st.dialect==='sh'&&!part.quoted;", "else values=parameter(part,st);split=false;", "V3-A2", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-4", "hosts.ts", "x.run(source,host,child,read.setOpts,[words[1]??known(x.program),...words.slice(2)]);", "x.run(source,host,child,read.setOpts,[]);", "V3-A3", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-5", "invocation.ts", "(?:--|-L|-P|-e|-@|", "(?:-L|-P|-e|-@|", "V3-A4", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-6", "find.ts", "flows:[{restricted:false,root:minDepth<1}]", "flows:[{restricted:units.some(unit=>unit.op==='test'&&restrictive.test(unit.name)),root:minDepth<1}]", "V3-A5", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-7", "find.ts", "effects.push(...peel(argv,state).flatMap(effectsOf));", "void argv;void state;", "V3-A6", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-8", "find.ts", "node.op==='|'?left.f:", "node.op==='|'?left.t:", "V3-G2", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-9", "find.ts", "rootSelf=flows.some(flow=>flow.root)", "rootSelf=false", "V3-G2", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-10", "may.ts", "return {...known(selected[0]!),values:selected,opaque:true,original,candidates:selected};", "return {...opaque('cap-loss'),values:[],opaque:true,original};", "V3-MU-cap", "server/wipe/mutant-v3-witness.test.ts"],
 ["MU-V3-11", "evidence.ts", "const out:Invocation[]=[],work=[source];", "const out:Invocation[]=[],work=[source.replace(/^echo\\s+[\"']/,'').replace(/[\"']$/,'')];", "V3-G1", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-12", "invocation.ts", "dialect:child.dialect,drive:child.drive,links:", "dialect:child.dialect,drive:/^([a-z]:)/i.exec(st.startCwd??'')?.[1],links:", "V3-R3", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-13", "roots.ts", "const key=mountedRoots.keyFor(path)??path.replaceAll('\\\\','/').split('/').filter(Boolean).slice(0,2).join('/');", "const key='shared';", "V3-FAULT-1", "server/wipe/fault-v3.test.ts"],
 ["MU-V3-14", "roots.ts", "try{physical=physicalPath(this.port,raw);}catch{}", "try{this.port.mountId?.(raw);physical=physicalPath(this.port,raw);}catch{}", "V3-R4", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-15", "roots.ts", "if(this.port.confirmMount)confirmed=this.port.confirmMount(raw);", "if(this.port.confirmMount)confirmed=true;", "V3-FAULT-3", "server/wipe/fault-v3.test.ts"],
 ["MU-V3-16", "roots.ts", "if(!follow&&stat?.isSymbolicLink?.())return;", "if(this.registry.contains(lexical))return 'project-root';if(!follow&&stat?.isSymbolicLink?.())return;", "V3-A17", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-17", "invocation.ts", "try{walk(n.body,st);}", "try{out.push(...walk(n.body,{...st,defining:false}));}", "V3-A15", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-18", "invocation.ts", "for(const block of blocks)out.push(...walk(block,first==='.'?st:clone(st)));", "void blocks;", "V3-A8", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-19", "pwsh-model.ts", "if (row.pass.endsOn.some(name => bound.flags.has(name))) {items=[];continue;}", "{items=[];continue;}", "V3-A10", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-20", "programs.ts", "const scan=interpreterEffects(source,inv.env?.get('HOME')??inv.env?.get('USERPROFILE')??inv.home??'',p);", "const scan={effects:[],shells:[],argv:[]};", "V3-A13", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-21", "decide.ts", "effect.k==='git-clean'&&root==='project-root'", "false", "V3-A14", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-22", "hosts.ts", "{short:'o',arity:1,role:'set-opt'},{short:'O',arity:1,role:'inert'},", "{short:'o',arity:0,role:'flag'},{short:'O',arity:0,role:'flag'},", "V3-X1", "server/wipe/v3-regressions.test.ts"],
 ["MU-V3-TIMEOUT", "roots.ts", "if(left<=0)throw Error('wipe-path-probe-timeout');", "if(left<=0){Atomics.wait(done,0,0,1500);break;}", "V3-R5", "server/wipe/v3-regressions.test.ts"]
 // Shared layers (wipe text tables design): class 1 hosts.ts, class 2 process.ts, class 5 bounds.
 ["MU-C1-1", "hosts.ts", "{c:'source',command:'source','session-command':'source',s:'shell',shell:'shell'}),permute:true,positional:'user-then-shell-args'},", "{c:'source',command:'source','session-command':'source',s:'shell',shell:'shell'}),permute:false,positional:'user-then-shell-args'},", "MU-C1-1", "server/wipe/class125-witness.test.ts"],
 ["MU-C1-2", "hosts.ts", "  for(let j=1;j<s.length;j++){\n   const ch=s[j]!,opt=host.opts.find(o=>o.short===ch);", "  for(let j=1;j<2;j++){\n   const ch=s[j]!,opt=host.opts.find(o=>o.short===ch);", "MU-C1-2", "server/wipe/class125-witness.test.ts"],
 ["MU-C1-3", "hosts.ts", "if(host.anyLong){r.flags.add(name);optionByName(r.setOpts,name,true);}else unknown(i);continue;}", "return finish();}", "MU-C1-3", "server/wipe/class125-witness.test.ts"],
 ["MU-C1-4", "hosts.ts", "if(read.uncertain.length>1&&host.positional==='program')x.peel(", "if(false)x.peel(", "MU-C1-4", "server/wipe/class125-witness.test.ts"],
 ["MU-C2-1", "process.ts", "next.proc={nounset:inherited&&!!st.proc?.nounset,", "next.proc={nounset:!!st.proc?.nounset,", "MU-C2-1", "server/wipe/class125-witness.test.ts"],
 ["MU-C2-2", "process.ts", "allexport:false,delayed:false,strict:false,...opts};", "allexport:false,delayed:false,strict:false};", "MU-C2-2", "server/wipe/class125-witness.test.ts"],
 ["MU-C2-3", "process.ts", " next.functions=new Map([...(st.functions??[])].filter(([name])=>st.exportedFns?.has(name)));\n next.inheritedFns=new Set(next.functions.keys());", " next.functions=new Map(st.functions);\n next.inheritedFns=new Set();", "MU-C2-3", "server/wipe/class125-witness.test.ts"],
 ["MU-C2-4", "process.ts", "if(!st.exported!.has(name))next.vars!.set(name,{...may,maybeUnset:true});", "void may;", "MU-C2-4", "server/wipe/class125-witness.test.ts"],
 ["MU-C5-1", "invocation.ts", "items=computed?[]:c.words.slice(at+1,run);", "items=computed?[]:c.words.slice(at+1,run).slice(0,8);", "MU-C5-1", "server/wipe/class125-witness.test.ts"],
 ["MU-C5-2", "may.ts", "const keep=new Set<string>(unique.filter(value=>{try{return protect(value);}catch{return true;}}));", "const keep=new Set<string>();void protect;", "MU-C5-2", "server/wipe/class125-witness.test.ts"],
 ["MU-C5-3", "invocation.ts", "out.push(...(child.depth>=16?evidenceScan(source,child):walk(", "out.push(...(child.depth>=16?[]:walk(", "MU-C5-3", "server/wipe/class125-witness.test.ts"],
 ["MU-C5-4", "invocation.ts", "words.shift();return evidenceScan(words.join(' '),state);}", "words.shift();return [];}", "MU-C5-4", "server/wipe/class125-witness.test.ts"],
 ["MU-C5-5", "invocation.ts", "const union=(old:MaySet,next:MaySet,weak:boolean,original:string|undefined,protect:ShellState['lexicalProtected'],literal:boolean):MaySet=>{const values=weak?[...old.values,...next.values]:next.values,fault=weak?old.opaque||next.opaque:next.opaque;return literal||next.values.length>4||weak&&old.values.length>4?literalSet(values,fault,original):maySet(values,fault,original,protect);};", "const union=(old:MaySet,next:MaySet,weak:boolean,original:string|undefined,protect:ShellState['lexicalProtected'],literal:boolean):MaySet=>{const values=weak?[...old.values,...next.values]:next.values,fault=weak?old.opaque||next.opaque:next.opaque;void literal;void literalSet;return maySet(values,fault,original,protect);};", "MU-C5-5", "server/wipe/class125-witness.test.ts"],
];
const report=[],baselines=new Map(),unmodified=JSON.parse(readFileSync(join(directory,'baseline.json'),'utf8'));
assert.equal(spawnSync('git',['diff','--quiet','HEAD','--']).status,0,'Mutation source must match its committed SHA');
const rawFallbackFile='server/decision/implementation.ts';
for(const [id,path,before,after,pattern,test=acceptance]of mutants){
 const file=join('server/wipe',path),source=readFileSync(file,'utf8');
 const extraFile='server/wipe/registry.ts',extraSource=id==='MU21'?readFileSync(extraFile,'utf8'):undefined;
 assert.ok(source.includes(before),id+': missing production anchor');
 const rawFallbackSource=id==='MU47'?readFileSync(rawFallbackFile,'utf8'):undefined;
 try{
  writeFileSync(file,source.replace(before,after));
  if(rawFallbackSource!==undefined)writeFileSync(rawFallbackFile,rawFallbackSource.replace('nativeWipeBreaker(operation.rawTool??source.tool,operation.rawInput??source.input,ctx)','null'));
  if(extraSource!==undefined){assert.ok(extraSource.includes('return current.subtreeCount>0;'));writeFileSync(extraFile,extraSource.replace('return current.subtreeCount>0;','return current.count>0;'));}
  const baselineKey=test+'\0'+pattern;
  if(!baselines.has(baselineKey)){
   const covered=unmodified.testResults.filter(file=>file.name.endsWith('/'+test)).flatMap(file=>file.assertionResults).filter(row=>new RegExp(`^(?:${pattern})(?: |$)`).test(row.fullName));
   if(covered.length)baselines.set(baselineKey,covered.every(row=>row.status==='passed'));
  }
  if(!baselines.has(baselineKey)){
   writeFileSync(file,source);if(rawFallbackSource!==undefined)writeFileSync(rawFallbackFile,rawFallbackSource);if(extraSource!==undefined)writeFileSync(extraFile,extraSource);
   const json=join(directory,id+'-baseline.json');const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'-t',`^(?:${pattern})$|^(?:${pattern}) `,'--reporter=json',`--outputFile=${json}`],{encoding:'utf8',timeout:240000,maxBuffer:16<<20});
   writeFileSync(join(directory,id+'-baseline.log'),(result.stdout??'')+(result.stderr??''));
   const rows=existsSync(json)?JSON.parse(readFileSync(json,'utf8')).testResults.flatMap(f=>f.assertionResults).filter(t=>new RegExp(`^(?:${pattern})(?: |$)`).test(t.fullName)):[];
   baselines.set(baselineKey,result.status===0&&rows.length>0&&rows.every(t=>t.status==='passed'));
   writeFileSync(file,source.replace(before,after));if(rawFallbackSource!==undefined)writeFileSync(rawFallbackFile,rawFallbackSource.replace('nativeWipeBreaker(operation.rawTool??source.tool,operation.rawInput??source.input,ctx)','null'));if(extraSource!==undefined)writeFileSync(extraFile,extraSource.replace('return current.subtreeCount>0;','return current.count>0;'));
  }
  const json=join(directory,id+'.json');
  const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'-t',`^(?:${pattern})$|^(?:${pattern}) `,'--reporter=json',`--outputFile=${json}`],{encoding:'utf8',timeout:240000,maxBuffer:16<<20});
  writeFileSync(join(directory,id+'.log'),(result.stdout??'')+(result.stderr??''));
  const tests=JSON.parse(readFileSync(json,'utf8')).testResults.flatMap(f=>f.assertionResults);
  const killed=tests.filter(t=>t.status==='failed'&&new RegExp(`^(?:${pattern})(?: |$)`).test(t.fullName)&&/AssertionError/.test(t.failureMessages.join('\n'))).map(t=>t.fullName);
  const baselinePassed=baselines.get(test+'\0'+pattern);report.push({id,file,pattern,baselinePassed,exit:result.status,killed});
  writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(baselinePassed&&result.status===1&&killed.length?'KILLED':'OPEN',id,killed.join(', '));
 }finally{if(rawFallbackSource!==undefined)writeFileSync(rawFallbackFile,rawFallbackSource);writeFileSync(file,source);if(extraSource!==undefined)writeFileSync(extraFile,extraSource);}
}
const killed=report.filter(row=>row.baselinePassed&&row.exit===1&&row.killed.length).length;console.log('Mutants killed',killed+'/'+mutants.length);assert.equal(killed,mutants.length,'Every mutant needs a green baseline and named AssertionError');
