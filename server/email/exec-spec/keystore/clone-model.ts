// SPDX-License-Identifier: AGPL-3.0-or-later
/** The checker copies plain model state for every edge. Keep aliases and cycles
 * without paying the native structured-clone boundary for each small object.
 * Non-model built-ins retain structuredClone's behavior. */
export function cloneModel<T>(value: T): T {
  const copies = new Map<object, unknown>();
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      if (typeof input === "function" || typeof input === "symbol") return structuredClone(input);
      return input;
    }
    if (copies.has(input)) return copies.get(input);
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      const result = structuredClone(input); copies.set(input, result); return result;
    }
    const output = (array ? new Array(input.length) : {}) as Record<string, unknown>;
    copies.set(input, output);
    for (const key of Object.keys(input)) {
      const next = copy((input as Record<string, unknown>)[key]);
      if (key === "__proto__") Object.defineProperty(output, key, { value: next, enumerable: true, writable: true, configurable: true });
      else output[key] = next;
    }
    return output;
  };
  return copy(value) as T;
}
