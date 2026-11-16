import { z } from "zod";
export const schemas = {
  "snapshots.list": { argsSchema: z.never(), bodySchema: null, projection: ["snapshots"] },
  "snapshots.status": { argsSchema: z.never(), bodySchema: null, projection: ["data"] },
  "snapshots.shareLink.create": { argsSchema: z.never(), bodySchema: null, projection: ["id", "shareLink"] },
  "snapshots.apply": { argsSchema: z.never(), bodySchema: null, projection: [] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
