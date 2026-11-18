import rows from "./provider-manifest.json" with { type: "json" };
import type { Family, OperationId, Risk } from "../../shared/highlevel.ts";
import type { HighLevelMethod, RetryClass } from "./provider-contract.ts";

/** Provider schema declarations are frozen as field/type/required/enum descriptors.
 * Family args schemas are strict, bounded subsets, never arbitrary HTTP payloads. */
export interface HighLevelProviderOperation {
  operation: OperationId; family: Family; method: HighLevelMethod | null; path: string | null;
  Version: string; scope: string | null; risk: Risk; retryClass: RetryClass;
  status: "qualified" | "provider_absent"; docUrl: string; token: string | null;
  requestSchema: { strict: boolean; providerFields: Record<string, string[]>; source: string } | null;
  responseProjection: { fields: string[]; maxItems: number; maxStringLength: number; maxBytes: number; maxDepth: number } | null;
  reason?: string; scopeDocUrl?: string; qualificationNote?: string;
}
export const HIGHLEVEL_PROVIDER_MANIFEST: readonly HighLevelProviderOperation[] = rows as HighLevelProviderOperation[];
export function providerOperation(id: string): HighLevelProviderOperation | undefined {
  return HIGHLEVEL_PROVIDER_MANIFEST.find(row => row.operation === id);
}
