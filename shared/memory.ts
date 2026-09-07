export type MemoryScopeKind = "conversation" | "bot" | "room" | "team" | "project" | "workspace" | "preferences";
export type MemoryRecordState = "candidate" | "active" | "superseded" | "archived" | "deleted";
export interface MemoryRecord {
  id: string; version: number; scopeId: string; kind: string; text: string;
  assertion: "owner-statement" | "tool-observation" | "assistant-inference" | "unverified-import";
  state: MemoryRecordState; ownerPinned: boolean; validFrom: number; validTo: number | null;
}
export interface MemoryEvidenceHandle { sourceId: string; revision: number; startByte: number; endByte: number }
export interface MemoryBundle {
  bundleId: string; text: string; policyRevision: number; deletionEpoch: number;
  tokenCount: number; recordVersions: Array<{id: string; version: number}>;
  sourceVersions: Array<{id: string; revision: number}>; degradedReason?: string;
}

/** Same framing is measured by the builder and emitted by every adapter. */
export function memoryRequestPrefix(reference: string): string {
  return reference ? `${reference}\n\nCurrent request:\n` : "";
}
