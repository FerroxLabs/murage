// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Authorization equality, not display JSON. No normalization or toJSON hooks.
 * Object members with undefined values are omitted; undefined array slots are
 * null (their positions are never removed). An unreadable value never matches. */
export function canonicalJson(value: unknown): string | undefined {
  const active = new Set<object>();
  const walk = (v: unknown): string | undefined => {
    if (v === null) return "null";
    if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : undefined;
    if (typeof v !== "object") return undefined;
    if (active.has(v) || Object.getOwnPropertySymbols(v).length) return undefined;
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))) return undefined;
    active.add(v);
    try {
      const parts: string[] = [];
      if (array) {
        // Extra properties are not JSON array members and must not disappear.
        if (Object.keys(descriptors).some((k) => k !== "length" && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))) return undefined;
        for (let i = 0; i < v.length; i++) {
          const item: unknown = descriptors[String(i)]?.value;
          const encoded = item === undefined ? "null" : walk(item);
          if (encoded === undefined) return undefined;
          parts.push(encoded);
        }
        return `[${parts.join(",")}]`;
      }
      // Emit sorted entries directly: reconstructing an object would put its
      // integer keys back into numeric order before JSON.stringify sees them.
      for (const key of Object.keys(descriptors).sort(codePointOrder)) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable) return undefined;
        if (descriptor.value === undefined) continue;
        const encoded = walk(descriptor.value);
        if (encoded === undefined) return undefined;
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(",")}}`;
    } finally { active.delete(v); }
  };
  try { return walk(value); } catch { return undefined; }
}

/** Python sorts strings by Unicode scalar values, not JavaScript UTF-16 units. */
function codePointOrder(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!);
  const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}
