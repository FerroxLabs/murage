/**
 * Frozen 0.1.52 contract (K0): one recoverable local output receipt for
 * every trusted producer. Persisted in SQLite `output_publications`
 * (server/artifacts.ts). Consumers: R3-T3 terminal shell-output sweep,
 * R3-T4 image publication and C2 recovery, F5-T5 joined proof.
 *
 * Rules:
 * - A receipt is written as soon as the bytes are safely retained, before
 *   attachment, transcript or Files registration.
 * - Recovery resumes from the recorded bytes. It never re-dispatches a
 *   provider request or regenerates paid output.
 * - Cancelled or failed turns leave shell outputs `retained`; only a
 *   successful terminal turn auto-registers them (U-02).
 */
import { isWorkspaceRelativePath } from "./workspace-files.ts";

export const OUTPUT_PUBLICATIONS_TABLE = "output_publications";

export const OUTPUT_PRODUCERS = ["shell-output", "image-operation", "assistant-image"] as const;
export type OutputProducer = typeof OUTPUT_PRODUCERS[number];

/** retained: bytes verified on disk, nothing published yet.
 * attached: conversation attachment and transcript entry exist.
 * registered: saved version exists in Files (artifactId set).
 * failed: the last publication step failed; bytes are still retained. */
export const OUTPUT_RECEIPT_STAGES = ["retained", "attached", "registered", "failed"] as const;
export type OutputReceiptStage = typeof OUTPUT_RECEIPT_STAGES[number];

export const OUTPUT_PUBLICATION_ERROR_CATEGORIES = [
  "quota", "filesystem", "database", "attachment", "transcript", "scope", "verification", "limit",
] as const;
export type OutputPublicationErrorCategory = typeof OUTPUT_PUBLICATION_ERROR_CATEGORIES[number];

/** U-02 bounds for one terminal sweep. */
export const OUTPUT_PUBLICATION_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxFilesPerTurn: 20,
  hostCardsPerTurn: 1,
} as const;

export interface LocalOutputReceipt {
  id: string;
  producer: OutputProducer;
  botId: string;
  threadId: string;
  /** Producing run: dispatch claim/turn id for shell output, operation id
   * for image operations. Never invented for discovered files. */
  runId: string;
  /** Path relative to the producer's server-derived root (task workspace for
   * shell output, managed generated-images root for images). Never absolute. */
  pathToken: string;
  sha256: string;
  mime: string;
  bytes: number;
  stage: OutputReceiptStage;
  artifactId?: string;
  attachmentId?: string;
  messageId?: string;
  errorCategory?: OutputPublicationErrorCategory;
  createdAt: number;
  updatedAt: number;
}

export const OUTPUT_STAGE_TRANSITIONS: Readonly<Record<OutputReceiptStage, readonly OutputReceiptStage[]>> = {
  retained: ["attached", "registered", "failed"],
  attached: ["registered", "failed"],
  registered: [],
  failed: ["attached", "registered", "failed"],
};

export function canAdvanceOutputStage(from: OutputReceiptStage, to: OutputReceiptStage): boolean {
  return OUTPUT_STAGE_TRANSITIONS[from].includes(to);
}

export function isOutputProducer(value: unknown): value is OutputProducer {
  return typeof value === "string" && (OUTPUT_PRODUCERS as readonly string[]).includes(value);
}

export function isOutputReceiptStage(value: unknown): value is OutputReceiptStage {
  return typeof value === "string" && (OUTPUT_RECEIPT_STAGES as readonly string[]).includes(value);
}

export function isOutputPathToken(value: unknown): value is string {
  return isWorkspaceRelativePath(value);
}
