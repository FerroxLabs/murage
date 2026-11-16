import { workspaceFileRefSchema } from "../../../../shared/highlevel.ts";
import { z } from "zod";
/** Shared id validator: reject path traversal, including repeated percent encoding. */
export const highlevelIdSchema = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.~%-]+$/u)
  .refine(value => value !== "." && !value.includes("..") && !/%(?![0-9a-f]{2})|%25|%2e|%2f|%5c/iu.test(value));
const forbiddenKey = /^(?:__proto__|prototype|constructor|.*(?:credential|password|secret|token|authorization|apiKey|api_key|headers?|url|uri|host|endpoint|path).*)$/iu;
/** Paths come from the frozen schema, never from the shape of caller values. */
function identifierArrayPaths(schema: unknown, path: string[] = [], out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return out;
  const node = schema as Record<string, unknown>;
  if (node.type === "array") {
    if (/^(?:id|.*Id|.*Ids)$/u.test(path.at(-1) ?? "")) out.add(JSON.stringify(path));
    identifierArrayPaths(node.items, [...path, "*"], out);
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [key, child] of Object.entries(node.properties)) identifierArrayPaths(child, [...path, key], out);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[key])) for (const child of node[key]) identifierArrayPaths(child, path, out);
  }
  return out;
}
function safeInput(value: unknown, arrayPaths: ReadonlySet<string>, path: string[] = [], depth = 0): boolean {
  if (depth > 24) return false;
  if (typeof value === "string") return value.length <= 100_000 && !/(?:[a-z][a-z0-9+.-]*:\/\/|^(?:data|javascript|file):|^\/\/)/iu.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(v => safeInput(v, arrayPaths, [...path, "*"], depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= 200 && entries.every(([key, v]) => {
    if (forbiddenKey.test(key)) return false;
    if (/^(?:id|.*Id)$/u.test(key)) {
      const valid = arrayPaths.has(JSON.stringify([...path, key])) && Array.isArray(v)
        ? v.every(id => highlevelIdSchema.safeParse(id).success) : highlevelIdSchema.safeParse(v).success;
      if (!valid) return false;
    }
    if (/Ids$/u.test(key) && (!Array.isArray(v) || !v.every(id => highlevelIdSchema.safeParse(id).success))) return false;
    return safeInput(v, arrayPaths, [...path, key], depth + 1);
  });
}
function assertClosedSchema(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  if (node.type === "object" && node.additionalProperties !== false) throw new Error("HighLevel operation objects must be strict");
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(assertClosedSchema);
    else if (value && typeof value === "object") assertClosedSchema(value);
  }
}
/** A structurally similar object may not introduce a second file-path escape hatch. */
function assertWorkspaceIdentity(schema: unknown, seen = new Set<object>()): void {
  if (!schema || typeof schema !== "object" || seen.has(schema) || schema === workspaceFileRefSchema) return;
  seen.add(schema);
  if (schema instanceof z.ZodObject) {
    if (Object.hasOwn(schema.shape, "workspaceFile")) throw new Error("HighLevel workspace reference must use workspaceFileRefSchema by identity");
    for (const child of Object.values(schema.shape)) assertWorkspaceIdentity(child, seen);
  } else if (schema instanceof z.ZodType) {
    for (const child of Object.values(schema._def)) assertWorkspaceIdentity(child, seen);
  } else if (Array.isArray(schema)) {
    for (const child of schema) assertWorkspaceIdentity(child, seen);
  } else {
    for (const child of Object.values(schema)) assertWorkspaceIdentity(child, seen);
  }
}
/** Registry-owned input policy runs before family validation and execution. */
export function strictOperationArgs<A>(schema: z.ZodType<A>): z.ZodType<A> {
  assertWorkspaceIdentity(schema);
  const shape = z.toJSONSchema(schema, { io: "input" });
  if (shape.type !== "object") throw new Error("HighLevel operation args must be an object");
  assertClosedSchema(shape);
  const arrayPaths = identifierArrayPaths(shape);
  return schema.superRefine((value, ctx) => {
    if (!safeInput(value, arrayPaths)) ctx.addIssue({ code: "custom", message: "HighLevel arguments contain a field or value that is not allowed" });
  });
}
