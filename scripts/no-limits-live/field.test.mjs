import { expect, it } from 'vitest';
import { fieldRows, scenarios, assertReleaseReady } from './scenarios.mjs';
import { fieldPlan } from './field-plan.mjs';
import { checkAvailability } from '../nolim-replay/j1-availability.mjs';
it.each(fieldRows)('$id reaches the tool dispatcher with exact input and no stale S1 hold', row => {
  expect(row.dep).toBeUndefined();
  const plan=fieldPlan(row);
  expect(plan.tool).toBe(row.tool);expect(plan.input).toEqual(row.input);expect(plan.input).not.toBe(row.input);
  expect(plan.instruction).toContain(JSON.stringify(row.input));
  expect(row.expected).toBe(row.why==='wipe'?'CARD':'RUN');
});
it('release accepts the resolved pack and rejects newly introduced dependencies',()=>{
  expect(()=>assertReleaseReady()).not.toThrow();
  expect(()=>assertReleaseReady([{...scenarios[0],dep:'new-unbuilt-component'}])).toThrow('new-unbuilt-component');
});
it('missing replay corpus remains missing evidence',()=>{
  expect(checkAvailability('/tmp/nolim-corpus-that-does-not-exist')).toMatchObject({status:'MISSING',verdictsClaimed:false});
});
