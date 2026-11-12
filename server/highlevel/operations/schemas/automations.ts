import { strictOperationArgs } from "./common.ts";
// F0: closed provider field schemas. Changes require a manifest amendment.
import { z } from "zod";
import { highlevelIdSchema as id } from "./common.ts";
const text = z.string().max(10000);
export const schemas = {
  "automations.workflows.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id}).extend({})), bodySchema: null, projection: ["workflows"] },
  "automations.campaigns.list": { argsSchema: strictOperationArgs(z.strictObject({"locationId": id, "status": text.optional()}).extend({})), bodySchema: null, projection: ["campaigns"] },
  "automations.workflow.addContact": { argsSchema: strictOperationArgs(z.strictObject({}).extend({"contactId": id, "workflowId": id}) .extend(z.strictObject({"eventStartTime": text.optional()}).shape)), bodySchema: z.strictObject({"eventStartTime": text.optional()}), projection: ["succeeded", "succeded"] },
  "automations.workflow.removeContact": { argsSchema: strictOperationArgs(z.strictObject({}).extend({"contactId": id, "workflowId": id}) .extend(z.strictObject({"eventStartTime": text.optional()}).shape)), bodySchema: z.strictObject({"eventStartTime": text.optional()}), projection: ["succeeded", "succeded"] },
  "automations.campaign.addContact": { argsSchema: strictOperationArgs(z.strictObject({}).extend({"contactId": id, "campaignId": id}) .extend(z.strictObject({}).shape)), bodySchema: z.strictObject({}), projection: ["succeeded", "succeded"] },
  "automations.campaign.removeContact": { argsSchema: strictOperationArgs(z.strictObject({}).extend({"contactId": id, "campaignId": id})), bodySchema: null, projection: ["succeeded", "succeded"] },
  "automations.campaign.removeAll": { argsSchema: strictOperationArgs(z.strictObject({}).extend({"contactId": id})), bodySchema: null, projection: ["succeeded", "succeded"] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
