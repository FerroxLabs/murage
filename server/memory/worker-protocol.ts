import { z } from "zod";
import type { IndexHit } from "./index.ts";

export const chunkSchema = z.object({text:z.string().max(65536),startByte:z.number().int().nonnegative(),endByte:z.number().int().nonnegative()});
export const workSchema = z.object({id:z.string(),sourceId:z.string(),revision:z.number().int(),leaseGeneration:z.number().int(),policyRevision:z.number().int(),deletionEpoch:z.number().int(),scopeId:z.string(),stage:z.string(),kind:z.string(),speaker:z.string(),outcome:z.string(),cursor:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative(),text:z.string().max(65536)});
export type MemoryWork = z.infer<typeof workSchema>;
export const resultSchema = z.object({id:z.string(),leaseGeneration:z.number().int(),status:z.enum(["complete","partial","deferred","failed"]),nextCursor:z.number().int().nonnegative(),chunks:z.array(chunkSchema).max(1024),reason:z.string().max(160).optional()});
export type MemoryWorkResult = z.infer<typeof resultSchema>;
export const indexBatchSchema=z.array(z.object({id:z.string(),version:z.number().int(),scopeId:z.string(),text:z.string().max(65536),deleted:z.boolean(),archived:z.boolean().optional(),rolled:z.boolean().optional(),ageKey:z.number().int().nonnegative().nullable().optional()})).max(16);
export const searchInputSchema=z.object({query:z.string().max(4096),scopeIds:z.array(z.string().max(512)).max(256),scopeCount:z.number().int().min(1).max(200000).optional(),policyRevision:z.number().int(),deletionEpoch:z.number().int(),historical:z.boolean(),cursor:z.string(),limit:z.number().int().min(1).max(20),semantic:z.boolean(),deadlineAt:z.number().optional(),profile:z.boolean().optional()});
/** One bounded part of a scope list too long for the query message itself (scope-set.ts). */
export const scopePartSchema=z.object({part:z.number().int().nonnegative(),ids:z.array(z.string().max(512)).max(256)});
export type MemorySearchInput=z.infer<typeof searchInputSchema>;
/** Candidates the helper hands back per list. The main thread checks each against what the reader may read, in order, and
 * pages on when candidates are refused, so a refused record can never crowd a readable one out (msearch review round 3). */
export const SEARCH_LIST_DEPTH=1000;
/** Eligible records without a vector the helper names per search. The main process reads them until it finds one the reader
 * may read (search.ts), so this is a bound on work spent on records it may not, not a figure anyone sees. */
export const UNVECTORED_LIMIT=1024;
/** A candidate the helper ranked: [id, version] or [id, version, similarity]. */
export type RankedRef=[string,number]|[string,number,number];
/** What the helper answers a search with. Everything but `hits` is internal to the process: the main thread authorizes the
 * ranked candidate lists first and only then ranks, counts and pages, so nothing here reaches a reader as it stands. */
export interface MemorySearchResult{
  hits:IndexHit[];vectorRows:number;degradedReason?:string;coverageComplete?:boolean;
  /** Where the helper's meaning scan stopped short of the end of the eligible set (an eligible-set cursor). The helper cannot say
   * whether anything the reader may READ is left past it; the main process reads on from here until it finds out (search.ts). */
  resumeAfter?:string;
  /** Candidates in the helper's own order, before any readability check: words (best first) and meaning (most similar first). */
  lexicalRanked?:RankedRef[];vectorRanked?:RankedRef[];
  /** Eligible records that have no vector yet (at most 256), and whether there are more. Present only when meaning search ran. */
  unvectored?:Array<[string,number]>;unvectoredMore?:boolean;
  /** The embedding model the vectors above were looked up under: with `unvectoredMore`, the main process reads on past the names it was
   * given, through the eligible records, and needs to know which of them have no vector for this model (search.ts). */
  vectorModel?:string;
  workerPeakRssBytes?:number;profile?:unknown;timings?:unknown;
}
