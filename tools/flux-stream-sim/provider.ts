// tools/flux-stream-sim/provider.ts
// The neutral provider interface (spec B.3). The session speaks contract A
// to the client and only these events to a provider. Exactly one "closed"
// or "error" ends every provider session.
import type { StreamConfig } from "../../shared/flux-stream-contract.ts";

export interface Word {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number | null;
}

export type ProviderEvent =
  | { kind: "speech_started"; audioMs: number }
  | { kind: "partial"; text: string; startMs: number; endMs: number }
  | { kind: "final"; text: string; startMs: number; endMs: number; words?: Word[] }
  | { kind: "turn_end"; text: string; confidence: number | null; startMs: number; endMs: number; words?: Word[] }
  | { kind: "turn_cancelled" }
  | { kind: "error"; code: "capability_unavailable" | "upstream_timeout" | "service_unavailable"; message: string }
  | { kind: "closed" };

export interface ProviderSession {
  sendAudio(pcm: Buffer): void;
  /** A barrier behind audio already sent. */
  commit(): void;
  /** False when the change cannot be applied to a live session. */
  update(config: StreamConfig): boolean;
  keepalive(): void;
  /** Provider work still queued (ms of provider audio, padding included);
   *  absent means none is queued. Admission never lets it pass burst_ms. */
  backlogMs?(): number;
  /** The most silence one barrier can pad a short tail with; admission keeps
   *  this much of burst_ms free so a barrier after any frame still fits
   *  (Astra 5 I2). Absent means 0. */
  barrierReserveMs?(): number;
  /** The config with preset silences resolved (never null). */
  effectiveConfig(): StreamConfig;
  /** Deliver queued audio, flush what is open (emitting its events), then end. */
  close(deadlineMs: number): Promise<void>;
}

export interface ProviderOptions {
  /** Scripted provider only: the text of each speech segment, in order. */
  script?: string[];
  /** Trace provider only: the name of a recorded provider message sequence. */
  trace?: string;
}

export interface Provider {
  readonly name: string;
  connect(config: StreamConfig, options: ProviderOptions, emit: (event: ProviderEvent) => void): Promise<ProviderSession>;
}
