import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
import {scanWindowsTree,scanSource} from './scan-native.mjs';

test('p11f: crev6 exact Function-constructor input is rejected',()=>{
 const root=mkdtempSync(join(tmpdir(),'winscen-crev6-'));
 try {
  mkdirSync(join(root,'nested'));
  writeFileSync(join(root,'nested','test.mjs'),"(()=>{}).constructor('process.kill(123)')();\n");
  const hits=scanWindowsTree(root);
  assert(hits.some(hit=>hit.file==='nested/test.mjs'&&!hit.rule.startsWith('parse failure:')),'crev6 exact input escaped scanner');
  assert.equal(hits.filter(hit=>hit.rule.startsWith('parse failure:')).length,0,'valid reviewer input must parse');
 }finally{safeWipeSync(root);}
});

test('p11f: MAIN cheap structural bans reject valid JavaScript',()=>{
 const cases=[
  "(()=>{}).constructor('process.kill(123)')();",
  "(()=>{})['constructor'](code)();",
  "(()=>{})['con'+'structor'](code)();",
  'consume(value.constructor);',
  'const make=value.constructor; make(code)();',
  'value.constructor?.(code);',
  'new value.constructor(code);',
  'Reflect.apply(fn,receiver,args);',
  'Reflect.construct(fn,args);',
  "Reflect['apply'](fn,receiver,args);",
  "Reflect['construct'](fn,args);",
  'const invoke=Reflect.apply; invoke(fn,receiver,args);',
  ...['call','apply','bind'].flatMap(method=>[
   `helpers[name].${method}(receiver,args);`,
   `helpers['run'].${method}(receiver,args);`,
   `(helpers[name]).${method}(receiver,args);`,
   `const fn=helpers[name]; const alias=fn; alias.${method}(receiver,args);`,
   `helpers[name]['${method}'](receiver,args);`,
  ]),
 ];
 for(const [i,code] of cases.entries())for(const ext of ['js','mjs','cjs']) {
  const hits=scanSource(code,`nested/${i}.${ext}`);
  assert.equal(hits.filter(hit=>hit.rule.startsWith('parse failure:')).length,0,code);
  assert(hits.length>0,code);
 }
 console.log(`P11F BANNED FIXTURES ${cases.length*3}/${cases.length*3}; PARSE-FAILURE COUNT 0`);
});

test('p11f: ordinary local functions, data and lexical scopes remain accepted',()=>{
 const cases=[
  'function local(){} local.call(null); local.apply(null,[]); local.bind(null);',
  'const local=()=>{}; local.call(null);',
  'const text=".constructor Reflect.apply helpers[name].call";',
  'const data={constructor:"label",call:"text",apply:"text",bind:"text"};',
  'const fn=helpers[name]; function local(fn){fn.call(null);}',
 ];
 for(const code of cases)for(const ext of ['js','mjs','cjs'])assert.deepEqual(scanSource(code,`allowed.${ext}`),[],code);
 console.log(`P11F ALLOWED FIXTURES ${cases.length*3}/${cases.length*3}`);
});
