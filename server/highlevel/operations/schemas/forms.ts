import { strictOperationArgs } from "./common.ts";
// F0: closed provider field schemas. Changes require a manifest amendment.
import { z } from "zod";
import { highlevelIdSchema as id } from "./common.ts";
const text = z.string().max(10000);
export const schemas = {
  "forms.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "skip": z.number().finite().optional(), "limit": z.number().finite().optional(), "type": text.optional()}).extend({})), bodySchema: null, projection: ["forms", "total"] },
  "forms.submissions": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "page": z.number().finite().optional(), "limit": z.number().finite().optional(), "formId": id.optional(), "q": text.optional(), "startAt": text.optional(), "endAt": text.optional()}).extend({})), bodySchema: null, projection: ["submissions", "meta"] },
  "forms.surveys.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "skip": z.number().finite().optional(), "limit": z.number().finite().optional(), "type": text.optional()}).extend({})), bodySchema: null, projection: ["surveys", "total"] },
  "forms.surveys.submissions": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "page": z.number().finite().optional(), "limit": z.number().finite().optional(), "surveyId": id.optional(), "q": text.optional(), "startAt": text.optional(), "endAt": text.optional()}).extend({})), bodySchema: null, projection: ["submissions", "meta"] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
