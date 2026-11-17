import type { FrozenRequest } from "./held-request.ts";
// Internal storage shared by the preparation adapter and response walker. The
// exact frozen object (not a digest or a mutable operation-global) is the key.
const tagPostStates = new WeakMap<FrozenRequest, readonly string[]>();
export function validTagSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string" && v.length > 0 && v.length <= 100)
    && new Set(value).size === value.length;
}
export function retainTagPostState(frozen: FrozenRequest, tags: readonly string[]): void {
  const sorted = [...tags].sort();
  const previous = tagPostStates.get(frozen);
  if (previous && JSON.stringify(previous) !== JSON.stringify(sorted)) throw new Error("HighLevel confirmation binding refused");
  tagPostStates.set(frozen, Object.freeze(sorted));
}
export function tagPostStateFor(frozen: FrozenRequest): readonly string[] | undefined { return tagPostStates.get(frozen); }
