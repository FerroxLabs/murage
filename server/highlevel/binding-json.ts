/** @internal Canonical JSON for the additive binding/journal modules. Keep this
 * leaf independent of the operation registry: family hooks import the binder.
 * Frozen-request tests compare its digest with the original registry encoder. */
export function canonicalBindingJson(value: unknown): Uint8Array {
  const seen = new Set<object>();
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v || typeof v !== "object" || seen.has(v)) throw new TypeError("Not canonical JSON");
    seen.add(v);
    try {
      if (Array.isArray(v)) return Array.from(v, visit);
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError("Not a JSON object");
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, visit((v as Record<string, unknown>)[k])]));
    } finally { seen.delete(v); }
  };
  return new TextEncoder().encode(JSON.stringify(visit(value)));
}
