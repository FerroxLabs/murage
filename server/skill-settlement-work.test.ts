import { expect, it } from 'vitest';
import { SkillSettlementWork } from './skill-settlement-work.ts';

it('serializes distinct drains and immediate effects, yielding even after partial batches', async () => {
  const lane = new SkillSettlementWork();
  let release!: () => void, active = 0, maximum = 0, tick = 0;
  const seen: number[] = [], hold = new Promise<void>(resolve => { release = resolve; });
  const first = lane.drain(async () => { maximum = Math.max(maximum, ++active); await hold; seen.push(tick); active--; });
  const second = lane.drain(() => { maximum = Math.max(maximum, ++active); seen.push(tick); active--; });
  expect(lane.now(() => { throw new Error('busy sync effect'); })).toBeUndefined();
  expect(await lane.owner(() => { throw new Error('owner proof was queued'); })).toBeUndefined();
  setImmediate(() => { tick++; }); release(); await Promise.all([first, second]);
  expect(maximum).toBe(1); expect(seen).toEqual([0, 1]);
  expect(lane.now(() => 1)).toBe(1);
  expect(lane.now(() => 2)).toBeUndefined();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(lane.available()).toBe(true);
});

it('allows awaited descendants in the same lease and releases after failures', async () => {
  const lane = new SkillSettlementWork();
  await expect(lane.drain(async () => { expect(await lane.item(() => 1)).toBe(1); throw new Error('fixture'); })).rejects.toThrow('fixture');
  expect(await lane.owner(() => 2)).toBe(2);
});
