import { strictOperationArgs } from "./common.ts";
// F0: closed provider field schemas. Changes require a manifest amendment.
import { z } from "zod";
import { highlevelIdSchema as id } from "./common.ts";
const text = z.string().max(10000);
import { workspaceFileRefSchema } from "../../../../shared/highlevel.ts";
export const schemas = {
  "media.files.list": { argsSchema: strictOperationArgs(z.strictObject({"offset": text.optional(), "limit": text.optional(), "sortBy": text, "sortOrder": text, "type": text, "query": text.optional(), "altType": z.enum(["location"]), "altId": id, "parentId": id.optional(), "fetchAll": text.optional()}).extend({})), bodySchema: null, projection: ["files"] },
  "media.files.upload": { argsSchema: strictOperationArgs(z.strictObject({file: workspaceFileRefSchema, name: text.optional(), parentId: id.optional()})), bodySchema: z.strictObject({name: text.optional(), parentId: id.optional()}), projection: ["fileId", "url"] },
  "media.folders.create": { argsSchema: z.never(), bodySchema: null, projection: ["altId", "altType", "name", "parentId", "type", "deleted", "pendingUpload", "category", "subCategory", "isPrivate", "relocatedFolder", "migrationCompleted", "appFolder", "isEssential", "status", "lastUpdatedBy"] },
  "media.files.delete": { argsSchema: strictOperationArgs(z.strictObject({"altType": z.enum(["location"]), "altId": id}).extend({"fileId": id})), bodySchema: null, projection: [] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
