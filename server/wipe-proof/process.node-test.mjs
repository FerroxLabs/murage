// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execute } from './process.mjs';

test('WINREVIEW-M3 small child streams remain exact',async()=>{
 const result=await execute(process.execPath,['-e',"process.stdout.write('fixture out');process.stderr.write('fixture err');"],process.env,process.cwd());
 assert.equal(result.code,0);assert.equal(result.error,false);
 assert.equal(result.stdout,'fixture out');assert.equal(result.stderr,'fixture err');
 assert.equal(result.stdoutOverflow,false);assert.equal(result.stderrOverflow,false);
});
for(const stream of ['stdout','stderr'])test(`WINREVIEW-M3 ${stream} overflow is bounded and explicit`,async()=>{
 // Separate writes ensure overflow after a full retained buffer is observable.
 const result=await execute(process.execPath,['-e',`process.${stream}.write('x'.repeat(65536),()=>setTimeout(()=>process.${stream}.write('tail'),10));`],process.env,process.cwd());
 assert.equal(result.code,0);assert.equal(result.error,true);
 assert.equal(result[stream].length,65536);
 assert.equal(result[stream+'Overflow'],true);
 assert.equal(result[(stream==='stdout'?'stderr':'stdout')+'Overflow'],false);
});

test('WINREVIEW-M1 MU53 changes a real production anchor',()=>{
 const manifest=readFileSync(new URL('../wipe/mutants.mjs',import.meta.url),'utf8');
 const line=manifest.split('\n').find(line=>line.trim().startsWith('["MU53",'));
 assert.ok(line);
 const [, , before, after]=JSON.parse(line.trim().replace(/,$/,''));
 assert.notEqual(before,after);
 assert.ok(readFileSync(new URL('../wipe/programs.ts',import.meta.url),'utf8').includes(before));
});

test('WINREVIEW-L1 every Windows gate error diagnostic has an inventory entry',()=>{
 const inventoryUrl=new URL('./windows-gate/ENGLISH.md',import.meta.url);
 const inventory=existsSync(inventoryUrl)?readFileSync(inventoryUrl,'utf8'):'';
 assert.ok(inventory.includes('Owners:'));
 const runner=readFileSync(new URL('./windows-gate/run.mjs',import.meta.url),'utf8');
 const launcher=readFileSync(new URL('./windows-gate/run-windows.ps1',import.meta.url),'utf8');
 const messages=[...runner.matchAll(/(?:throw new Error|console\.error)\((['"`])([^\n]+)\1\)/g)].map(match=>match[2]);
 messages.push(...[...launcher.matchAll(/throw '([^'\n]+)'/g)].map(match=>match[1]));
 assert.ok(messages.length>=10);
 for(const message of messages)assert.ok(inventory.includes(message),`Missing diagnostic: ${message}`);
 assert.ok(inventory.includes('Summary: '));
});
