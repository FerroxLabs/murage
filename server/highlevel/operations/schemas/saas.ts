import { z } from "zod";
export const schemas = {
  "saas.location.get": { argsSchema: z.never(), bodySchema: null, projection: [] },
  "saas.subscription.update": { argsSchema: z.never(), bodySchema: null, projection: [] },
  "saas.subscription.pause": { argsSchema: z.never(), bodySchema: null, projection: [] },
  "saas.enable": { argsSchema: z.never(), bodySchema: null, projection: [] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
