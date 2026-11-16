import { describe, expect, it, vi } from 'vitest';
import * as charge from './event-charge.ts';

describe('event-charge', () => {
  it('event-charge.exact-small', () => {
    expect(charge.boundedEventCharge({ a: 'hi', b: [null, true, 7] })).toEqual({ bytes: 16 + 5 + 4 + 5 + 16 + 3 * (5 + 8), oversize: false });
    expect(charge.boundedEventCharge('hi', 4)).toEqual({ bytes: 4, oversize: false });
    expect(charge.boundedEventCharge('hi', 3)).toEqual({ bytes: charge.OVERSIZE_CHARGE_BYTES, oversize: true });
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(charge.boundedEventCharge(cycle, 100).oversize).toBe(true);
  });
  it('event-charge.accessor-tripwire', () => {
    const getter = vi.fn(() => { throw new Error('must not read'); });
    const input = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    expect(charge.boundedEventCharge(input)).toEqual({ bytes: 16 + 9 + 64, oversize: false });
    expect(getter).not.toHaveBeenCalled();
  });
  it('event-charge.no-coercion-or-proxy-traps', () => {
    const trap = vi.fn(() => { throw new Error('trap'); });
    expect(charge.boundedEventCharge(new Proxy({}, { ownKeys: trap, get: trap })).oversize).toBe(true);
    expect(trap).not.toHaveBeenCalled();
    const toJSON = vi.fn(), toString = vi.fn();
    charge.boundedEventCharge({ toJSON, toString });
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled();
  });
});
