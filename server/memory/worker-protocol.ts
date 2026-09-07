import { z } from "zod";

export const chunkSchema = z.object({text:z.string().max(65536),startByte:z.number().int().nonnegative(),endByte:z.number().int().nonnegative()});
export const workSchema = z.object({id:z.string(),sourceId:z.string(),revision:z.number().int(),leaseGeneration:z.number().int(),policyRevision:z.number().int(),deletionEpoch:z.number().int(),scopeId:z.string(),stage:z.string(),kind:z.string(),speaker:z.string(),outcome:z.string(),cursor:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative(),text:z.string().max(65536)});
export type MemoryWork = z.infer<typeof workSchema>;
export const resultSchema = z.object({id:z.string(),leaseGeneration:z.number().int(),status:z.enum(["complete","partial","deferred","failed"]),nextCursor:z.number().int().nonnegative(),chunks:z.array(chunkSchema).max(1024),reason:z.string().max(160).optional()});
export type MemoryWorkResult = z.infer<typeof resultSchema>;
export const indexBatchSchema=z.array(z.object({id:z.string(),version:z.number().int(),scopeId:z.string(),text:z.string().max(65536),deleted:z.boolean(),archived:z.boolean().optional()})).max(16);
export const searchInputSchema=z.object({query:z.string().max(4096),scopeIds:z.array(z.string()).max(256),policyRevision:z.number().int(),deletionEpoch:z.number().int(),historical:z.boolean(),cursor:z.string(),limit:z.number().int().min(1).max(20),semantic:z.boolean(),profile:z.boolean().optional()});
export type MemorySearchInput=z.infer<typeof searchInputSchema>;
