import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('one predicate means one implementation, not imports or duplicate definitions',async()=>{
  const {predicateDefinitions}=await import('./predicate-inventory.mjs');
  const root=mkdtempSync(join(tmpdir(),'gnl-predicate-'));
  try {
    mkdirSync(join(root,'server'));mkdirSync(join(root,'shared'));
    writeFileSync(join(root,'server','origin.ts'),'export function noLimitsAppliesTo(value) { return value.owner; }');
    writeFileSync(join(root,'server','consumer.ts'),"import {noLimitsAppliesTo} from './origin.ts'; export const use=noLimitsAppliesTo;");
    assert.equal(predicateDefinitions(root).length,1);
    writeFileSync(join(root,'shared','duplicate.ts'),'export const noLimitsAppliesTo = value => value.level === "unlimited";');
    assert.equal(predicateDefinitions(root).length,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
