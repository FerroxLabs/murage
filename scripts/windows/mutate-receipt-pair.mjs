import {runNodeFixture} from './native-launcher.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
const dir=mkdtempSync(join(tmpdir(),'winscen-mutant-'));
try {
 const source=readFileSync(new URL('./receipt-pair.mjs',import.meta.url),'utf8');
 const mutant=source.replace('export function pairReceipts(receipts) {','export function pairReceipts(receipts) {\n  if (receipts.length === 1) return validateReceipt(receipts[0]); // MUTANT: accepts just one half');
 const fixedImports=code=>code.replace(/from '(\.\/[^']+)'/g,(_,path)=>`from ${JSON.stringify(new URL(path,import.meta.url).href)}`);
 assert.notEqual(source,mutant);const file=join(dir,'mutant.mjs');writeFileSync(file,fixedImports(mutant));
 const testSource=fixedImports(readFileSync(new URL('./receipt-pair.node-test.mjs',import.meta.url),'utf8').replace("'./receipt-pair.mjs'",JSON.stringify(pathToFileURL(file).href)));
 const testFile=join(dir,'receipt-pair.node-test.mjs');writeFileSync(testFile,testSource);
 const result=runNodeFixture(['--test',testFile],{encoding:'utf8'});
 const output=result.stdout+result.stderr;writeFileSync(new URL('./evidence/receipt-mutant-red.log',import.meta.url),output);
 assert.notEqual(result.status,0,'mutant survived');
 assert.match(output,/one desktop receipt cannot pass/);assert.match(output,/one handoff receipt cannot pass/);
 console.log('MUTANT RED: one-receipt bypass rejected by both missing-half tests');
} finally {safeWipeSync(dir);}
