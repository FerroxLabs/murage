import { it, expect } from 'vitest';
import { checkWindowsHideEntries, firstInstaller, inspectChildEntries } from './check-windows-hide-entries.mjs';
const prefix = `import {withHideInherit} from '../shared/win-hide-child-process.mjs'; import {Worker} from 'node:worker_threads'; import {fork,spawn,execFile} from 'node:child_process';`;
it('all package roots install first and all overrides inherit',()=>{
 const result=checkWindowsHideEntries(process.cwd());expect(result.entries.length).toBeGreaterThan(35);expect(result.failures).toEqual([]);
},120000);
it('rejects any executable import before the genuine installer',()=>{
 expect(firstInstaller(`import '../shared/win-hide-child-process.mjs';`,'server/x.ts')).toBe(true);
 expect(firstInstaller(`import type {X} from './x.ts'; import '../shared/win-hide-child-process.mjs';`,'server/x.ts')).toBe(true);
 expect(firstInstaller(`run(); import '../shared/win-hide-child-process.mjs';`,'server/x.ts')).toBe(false);
 expect(firstInstaller(`import '../fake/win-hide-child-process.mjs';`,'server/x.ts')).toBe(false);
});
it('never resolves descendants, including CWD paths and assignments after launch',()=>{
 for(const code of [`let target=unknown;new Worker(target);target=SPAWNED_PROXIES.memoryWorker;`,`new Worker('./child.cjs');`,`fork(unknown);`,`new Worker(code,{eval:true});`]) {
  const result=inspectChildEntries('server/x.ts',prefix+code);expect(result.entries).toEqual([]);expect(result.failures).toEqual([]);
 }
});
it('fails closed on literals, spreads and nonliteral options; no assignment tracking',()=>{
 for(const expression of ['{env:{}}','{execArgv:[]}','{...other}','options','makeOptions()']) for(const call of [`new Worker(target,${expression})`,`fork(target,[],${expression})`,`spawn(target,[],${expression})`,`execFile(target,[],${expression})`]) {
  expect(inspectChildEntries('server/x.ts',prefix+call).failures,call).toHaveLength(1);
 }
 for(const call of [`new Worker(target,withHideInherit({execArgv:[]}))`,`spawn(target,[],withHideInherit(options))`,`fork(target,withHideInherit({env:{}}))`]) expect(inspectChildEntries('server/x.ts',prefix+call).failures,call).toEqual([]);
 expect(inspectChildEntries('server/x.ts',prefix+'const options=withHideInherit({env:{}});spawn(target,[],options)').failures).toHaveLength(1);
});
it('a similarly named local function cannot authorize an override',()=>{
 expect(inspectChildEntries('server/x.ts',`import {spawn} from 'node:child_process';function withHideInherit(x){return x;}spawn('node',[],withHideInherit({env:{}}));`).failures).toHaveLength(1);
});

it('cannot erase Worker API discovery with an assignment after the call',()=>{
 for(const code of ["let W=Worker;new W(target,{env:{}});W=unknown;", "let W;W=Worker;new W(target,{env:{}});W=unknown;"])
  expect(inspectChildEntries('server/x.ts',prefix+code).failures.length).toBeGreaterThan(0);
});

it('rejects mutable API aliases rather than selecting a later overload kind',()=>{
 const source="import {spawn,exec} from 'node:child_process';let run=spawn;run('node',[],options);run=exec;";
 expect(inspectChildEntries('server/x.ts',source).failures.length).toBeGreaterThan(0);
});
it('rejects helper shadowing and fake CommonJS helper imports',()=>{
 for(const source of [prefix+"function f(withHideInherit){spawn('node',[],withHideInherit({env:{}}));}","const {spawn}=require('child_process');const {withHideInherit}=require('../fake/win-hide-child-process.mjs');spawn('node',[],withHideInherit({env:{}}));"])
 expect(inspectChildEntries('server/x.ts',source).failures.length).toBeGreaterThan(0);
});
it('rejects ambiguous second-slot overrides even when a third argument is present',()=>{
 for(const name of ['fork','spawn','spawnSync','execFile','execFileSync','exec','execSync']) {
  for(const tail of ['undefined','null','[]','()=>{}','{}','"arg"','42']) {
   const source=`import {${name}} from 'node:child_process';const opts={env:{},execArgv:[]};${name}('./child.cjs',opts,${tail});`;
   expect(inspectChildEntries('server/x.ts',source).failures,source).toHaveLength(1);
  }
 }
});

it('rejects spread launch arguments with unknown options positions',()=>{
 for(const code of ["fork(...args)","fork('./child.cjs',...args)","spawn('node',...args)"])
  expect(inspectChildEntries('server/x.ts',prefix+code).failures,code).toHaveLength(1);
});
