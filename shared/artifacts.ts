import type { OutputProducer } from "./output-publication.ts";

export type ArtifactKind = "html" | "text" | "image" | "other";
export interface Artifact {
  id: string; name: string; filename: string; kind: ArtifactKind; mime: string; bytes: number; sha256: string; createdAt: number;
  botId: string; botName: string; threadId: string; runId?: string; relativePath: string;
  /** Trusted automatic producer (0.1.52). Absent for manual/tool registration and older rows. */
  producer?: OutputProducer;
  sourceState: "current" | "changed" | "missing" | "unavailable";
  savedState: "available" | "missing" | "unavailable";
  sourceConversationAvailable: boolean;
}
export interface ArtifactQuery { query?: string; botId?: string; threadId?: string; kind?: ArtifactKind; since?: number; until?: number; page?: number; pageSize?: number }
export interface ArtifactPage { items: Artifact[]; total: number; page: number; pageSize: number }
export interface ArtifactPreview { artifact: Artifact; mode: "html" | "text" | "image" | "download"; content?: string }
export interface ArtifactRegistration { botId: string; threadId: string; relativePath: string; name?: string }
