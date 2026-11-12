import { z } from "zod";
import { aciSchema } from "./rpc.ts";
const connectionId = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), time = z.number().int().safe().nonnegative();
const bindingSchema = z.strictObject({ connectionId, generation: time, ownAci: aciSchema,
  ownDeviceId: z.number().int().safe().positive(), linkedAt: time, chiefBotId: z.string().min(1).max(200) });
const recordSchema = z.strictObject({ version: z.literal(1), connectionId, generation: time, enabled: z.boolean(), paused: z.boolean(),
  revoking: z.boolean(), binding: bindingSchema.nullable(), account: z.string().regex(/^\+[0-9]{1,15}$/).nullable(),
  repairedStorageOwner: z.boolean().optional(), removeDeviceOnPhone: z.boolean().optional(), ownerRepair: z.boolean().optional(), restoring: z.boolean().optional(),
  problem: z.enum(["identity-unavailable", "identity-mismatch", "link-required", "storage-owner"]).optional(),
});
export type SignalConnectionRecord = z.infer<typeof recordSchema>;
/** Shared strict schema and constructor binding invariant. */
export function parseSignalConnectionRecord(value: unknown): SignalConnectionRecord {
  const record = recordSchema.parse(value), binding = record.binding;
  if (binding && (binding.connectionId !== record.connectionId || binding.generation !== record.generation)) throw new Error("Invalid Signal binding");
  return record;
}
