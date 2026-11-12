import { strictOperationArgs } from "./common.ts";
// F0: closed provider field schemas. Changes require a manifest amendment.
import { z } from "zod";
import { highlevelIdSchema as id } from "./common.ts";
const text = z.string().max(10000);

// MAIN 2026-11-11 F10 ruling: these are provider data, never transport controls.
// Keep the general argument guard on every other field and every other family.
export const redirectLocatorSchema = z.strictObject({
  domain: z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu),
  path: z.string().min(1).max(2048).regex(/^\/[a-z0-9_~!$&'()*+,;=@%./-]*$/iu)
    .refine(v => !v.startsWith('//') && !/\.\.|%(?:2e|2f|5c|25)|\\/iu.test(v)),
});
export function redirectSearch(value: unknown): string {
  const locator = redirectLocatorSchema.parse(value);
  return locator.domain + (locator.path.startsWith('/') ? '' : '/') + locator.path;
}
const action = z.enum(['funnel', 'website', 'url', 'all']);
const target = z.string().min(1).max(10000);
function validTarget(value: { action: string; target: string }): boolean {
  if (value.action !== 'url') return id.safeParse(value.target).success;
  if (!/^https?:\/\//iu.test(value.target)) return false;
  try { const url = new URL(value.target); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !/[\s\\]/u.test(value.target); }
  catch { return false; }
}
const createBody = z.strictObject({ locationId: id, ...redirectLocatorSchema.shape, target, action }).refine(validTarget);
const updateBody = z.strictObject({ locationId: id, target, action }).refine(validTarget);
function redirectArgs<T extends z.ZodRawShape>(shape: T, withTarget = false) {
  const schema = z.strictObject(shape);
  const rest = Object.fromEntries(Object.entries(shape).filter(([k]) => !['domain', 'path', 'target'].includes(k)));
  const guarded = strictOperationArgs(z.strictObject(rest));
  return schema.superRefine((value, ctx) => {
    const other = Object.fromEntries(Object.entries(value).filter(([k]) => !['domain', 'path', 'target'].includes(k)));
    if (!guarded.safeParse(other).success || (withTarget && !validTarget(value as { action: string; target: string })))
      ctx.addIssue({ code: 'custom', message: 'Invalid redirect data' });
  });
}

export const schemas = {
  "funnels.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "type": text.optional(), "category": text.optional(), "offset": text.optional(), "limit": text.optional(), "parentId": id.optional(), "name": text.optional()}).extend({})), bodySchema: null, projection: ["funnels", "count", "traceId"] },
  "funnels.pages.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "funnelId": id, "name": text.optional(), "limit": z.number().finite(), "offset": z.number().finite()}).extend({})), bodySchema: null, projection: ["_id", "locationId", "funnelId", "name", "stepId", "deleted", "updatedAt"] },
  "funnels.pages.count": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "funnelId": id, "name": text.optional()}).extend({})), bodySchema: null, projection: ["count"] },
  "funnels.redirects.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "limit": z.number().finite(), "offset": z.number().finite(), "search": text.optional()}).extend({})), bodySchema: null, projection: ["data"] },
  "funnels.redirects.create": { argsSchema: redirectArgs({ locationId: id, ...redirectLocatorSchema.shape, target, action }, true), bodySchema: createBody, projection: ["data"] },
  "funnels.redirects.update": { argsSchema: redirectArgs({ locationId: id, redirectId: id, ...redirectLocatorSchema.shape, target, action }, true), bodySchema: updateBody, projection: ["data"] },
  "funnels.redirects.delete": { argsSchema: redirectArgs({ locationId: id, redirectId: id, ...redirectLocatorSchema.shape }), bodySchema: null, projection: ["data"] },
  "funnels.pages.edit": { argsSchema: z.never(), bodySchema: null, projection: [] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
