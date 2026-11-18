import { types } from 'node:util';

export const CHARGE_BUDGET_UNITS = 1_048_576;
export const OVERSIZE_CHARGE_BYTES = 8 * 1024 * 1024;
export type EventCharge = Readonly<{ bytes: number; oversize: boolean }>;
const OVERSIZE: EventCharge = Object.freeze({ bytes: OVERSIZE_CHARGE_BYTES, oversize: true });

/** Conservative accounting, never serialization. Values are read only through
 * own data descriptors. Proxy detection does not execute user code. Each
 * descent costs at least 16, so cyclic graphs terminate without a visited set.
 * The iterator yields one property at a time; no application key/value array
 * or recursive copy is constructed for unknown execution subtrees. */
export function boundedEventCharge(event: unknown, budget = CHARGE_BUDGET_UNITS): EventCharge {
  if (!Number.isFinite(budget) || budget < 0) return OVERSIZE;
  budget = Math.min(budget, CHARGE_BUDGET_UNITS);
  let bytes = 0;
  let traversalSteps = 0;
  const charge = (units: number) => (bytes += units) <= budget;
  function* descriptors(value: object): Generator<[string, PropertyDescriptor]> {
    for (const key in value) {
      if (++traversalSteps > budget) throw new Error('charge_budget');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable) yield [key, descriptor];
    }
  }
  const stack: Generator<[string, PropertyDescriptor]>[] = [];
  let value = event;
  try {
    for (;;) {
      if (typeof value === 'string') { if (!charge(value.length + 2)) return OVERSIZE; }
      else if (value !== null && typeof value === 'object') {
        if (types.isProxy(value) || !charge(16)) return OVERSIZE;
        // for-in also checks the prototype; refuse proxy prototypes before
        // creating its iterator, without touching arbitrary property values.
        let prototype = Object.getPrototypeOf(value);
        while (prototype !== null) {
          if (++traversalSteps > budget) return OVERSIZE;
          if (types.isProxy(prototype)) return OVERSIZE;
          prototype = Object.getPrototypeOf(prototype);
        }
        stack.push(descriptors(value));
      } else if (!charge(8)) return OVERSIZE;
      let next: IteratorResult<[string, PropertyDescriptor]> | undefined;
      while (stack.length) {
        next = stack[stack.length - 1]!.next();
        if (!next.done) break;
        stack.pop();
      }
      if (!stack.length || !next || next.done) return Object.freeze({ bytes, oversize: false });
      const [key, descriptor] = next.value;
      if (!charge(key.length + 4)) return OVERSIZE;
      if (!('value' in descriptor)) {
        if (!charge(64)) return OVERSIZE;
        // No extra scalar charge for an accessor. Continue to the next key.
        while (stack.length) {
          next = stack[stack.length - 1]!.next();
          if (next.done) { stack.pop(); continue; }
          const [key, descriptor] = next.value;
          if (!charge(key.length + 4)) return OVERSIZE;
          if (!('value' in descriptor)) { if (!charge(64)) return OVERSIZE; continue; }
          value = descriptor.value;
          break;
        }
        if (!stack.length) return Object.freeze({ bytes, oversize: false });
      } else value = descriptor.value;
    }
  } catch { return OVERSIZE; }
}
