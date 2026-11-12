import { expect, it } from 'vitest';
import { declaredTestTimeout, dedicatedFileBudget } from './test-truth/file-budget.mjs';

it('respects actual nested Vitest deadlines without treating fixture or poll timeouts as test budgets', () => {
  const source = `const fixture={timeout:1728000000};
    it.each([{timeout:999999999}])('ordinary',()=>expect.poll(read,{timeout:9000000}));
    describe.skipIf(false)('drain',{timeout:900_000},()=>{it('case',()=>{});});`;
  expect(declaredTestTimeout(source)).toBe(900_000);
  expect(dedicatedFileBudget(source)).toBe(3_900_000);
});

it('allows the declared two-hour scale case and legacy positional case budgets', () => {
  expect(dedicatedFileBudget(`it('scale',{timeout:2*60*60*1000},()=>{});`)).toBe(14_520_000);
  expect(declaredTestTimeout(`it('legacy',()=>{},1_800_000);`)).toBe(1_800_000);
  expect(dedicatedFileBudget(`it('ordinary',{timeout:45_000},()=>{});`)).toBeNull();
});
