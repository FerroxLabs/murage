// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Flux memory envelope (FLUX-MEMORY-CONTRACT, lane 2.2). On a Flux-routed turn with a Flux
// key and "Use Flux memory" on, Murage sends request metadata
//   flux_memory: { mode: "on", fallback_recall: { text, items?, sha256 } }
// and injects NOTHING locally for that turn: exactly one memory block reaches the model, either
// Flux's own (header x-flux-memory: flux) or Murage's recall text Flux falls back to (fallback).
// Local memory itself is always on and has no switch; "Use Flux memory" is the only switch and is
// on by default whenever a Flux key is present. This file is pure: the wire (drivers) and the
// decision point (harness/memory-adapter.ts) call into it.
import { createHash } from "node:crypto";

import { MEMORY_REFERENCE_CLOSE } from "../shared/memory.ts";
import { fluxExternalMemoryOn, isFluxUrl } from "./flux-memory-headers.ts";

/** The fallback text never exceeds this many UTF-8 bytes. */
export const FLUX_FALLBACK_MAX_BYTES = 8192;
export const FLUX_MEMORY_SOURCE_HEADER = "x-flux-memory";
export const FLUX_MEMORY_REASON_HEADER = "x-flux-memory-reason";

export interface FluxFallbackRecall { text: string; sha256: string; items?: number }
export interface FluxMemoryEnvelope { mode: "on"; fallback_recall?: FluxFallbackRecall }
export type FluxMemorySource = "flux" | "fallback" | "none";
export interface FluxMemoryReport { source: FluxMemorySource; reason?: string }

/** First-run disclosure line and privacy-policy line (copy rules: plain, true, no price talk, framed as what it does). */
export const FLUX_MEMORY_DISCLOSURE =
  "With Use Flux memory on, Flux Router remembers what you tell your bots in your own Flux conversations and brings it back when it helps, and Murage sends a short copy of its own recall with each of those turns. You can switch it off any time in Memory settings.";
export const FLUX_MEMORY_PRIVACY_LINE =
  "When Use Flux memory is on, Flux Router keeps what you say in your own Flux conversations so it can remember it for you, and up to 8 KB of Murage's memory recall travels with each of those requests, only to Flux Router. Switch it off in Memory settings and, from your next message, Flux stops saving and adding memory for you.";

const ITEM_LINE = /^- m\d+ /;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The recall block cut at an item boundary to at most `maxBytes` UTF-8 bytes (frame lines stay). null when empty or no item fits. */
export function cutRecallAtItemBoundary(block: string, maxBytes = FLUX_FALLBACK_MAX_BYTES): { text: string; items: number } | null {
  if (!block.trim()) return null;
  const lines = block.split("\n");
  const first = lines.findIndex((line) => ITEM_LINE.test(line));
  if (first < 0) return null;
  let last = first;
  while (last + 1 < lines.length && ITEM_LINE.test(lines[last + 1]!)) last++;
  const head = lines.slice(0, first), tail = lines.slice(last + 1);
  if (!tail.includes(MEMORY_REFERENCE_CLOSE)) return null;
  const bytes = (parts: string[]): number => Buffer.byteLength(parts.join("\n"), "utf8");
  const kept: string[] = [];
  for (const item of lines.slice(first, last + 1)) {
    if (bytes([...head, ...kept, item, ...tail]) > maxBytes) break;
    kept.push(item);
  }
  if (!kept.length) return null;
  return { text: [...head, ...kept, ...tail].join("\n"), items: kept.length };
}

export function buildFluxMemoryEnvelope(recallBlock: string): FluxMemoryEnvelope {
  const cut = cutRecallAtItemBoundary(recallBlock);
  if (!cut) return { mode: "on" };
  return { mode: "on", fallback_recall: { text: cut.text, items: cut.items, sha256: sha256(cut.text) } };
}

// ---------------------------------------------------------------- switch ----

// The switch lives with the header decision (flux-memory-headers.ts), so off reaches every driver's
// x-flux-memory-capture / -inject headers as well as the envelope.
export { fluxExternalMemoryOn, setFluxExternalMemory } from "./flux-memory-headers.ts";

/** What Settings shows: Flux memory counts as on only while a Flux key is present and the switch is on. */
export function fluxMemorySettingState(keyPresent: boolean): { external: boolean; keyPresent: boolean } {
  return { external: keyPresent && fluxExternalMemoryOn(), keyPresent };
}

export interface EnvelopeTurn {
  engineCommand?: unknown;
  providerRoute?: { baseUrl: string; apiKey: string };
}

/** Whether this turn takes the envelope: Flux-routed (a Flux host), key present, switch on, and the engine's driver puts it on the wire. */
export function fluxEnvelopeApplies(
  turn: EnvelopeTurn,
  options: { driverCarries: boolean; hasKey?: boolean; external?: boolean },
): boolean {
  if (!options.driverCarries || turn.engineCommand) return false;
  if (!(options.external ?? fluxExternalMemoryOn())) return false;
  const route = turn.providerRoute;
  if (!route || !isFluxUrl(route.baseUrl)) return false;
  return options.hasKey ?? Boolean(route.apiKey);
}

// ---------------------------------------------------------------- response --

/** The x-flux-memory and x-flux-memory-reason response headers, or undefined when Flux sent none. The reason is data: bounded and plain. */
export function readFluxMemoryResponse(headers: { get(name: string): string | null }): FluxMemoryReport | undefined {
  const raw = headers.get(FLUX_MEMORY_SOURCE_HEADER)?.trim().toLowerCase();
  if (raw !== "flux" && raw !== "fallback" && raw !== "none") return undefined;
  const reason = headers.get(FLUX_MEMORY_REASON_HEADER)?.trim().replace(/[^\x20-\x7e]/g, "").slice(0, 120);
  return reason ? { source: raw, reason } : { source: raw };
}

const SOURCE_WORDS: Record<FluxMemorySource, string> = {
  flux: "Flux memory", fallback: "Murage memory, sent as a backup", none: "no memory used",
};
/** One plain line for the turn's memory detail. */
export function describeFluxMemorySource(report: FluxMemoryReport): string {
  return `${SOURCE_WORDS[report.source]}${report.reason ? ` (${report.reason})` : ""}`;
}

// ------------------------------------------------------------ turn record ---

const recent = new Map<string, FluxMemoryReport & { at: number; bundleId?: string }>();
const RECENT_LIMIT = 200;
/** The source Flux reported for a thread's latest turn, for the memory detail. Bounded. */
export function recordFluxMemoryReport(threadId: string, report: FluxMemoryReport, bundleId?: string, now = Date.now()): void {
  // the contract asks Murage to log which source Flux used for each turn (no recall text, no ids beyond the thread)
  console.log(`[memory] flux memory source=${report.source}${report.reason ? ` reason=${report.reason}` : ""} thread=${threadId}`);
  recent.delete(threadId);
  recent.set(threadId, { ...report, at: now, ...(bundleId ? { bundleId } : {}) });
  if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value as string);
}
export function fluxMemoryReportFor(threadId: string): (FluxMemoryReport & { at: number; bundleId?: string }) | undefined { return recent.get(threadId); }
/** The latest report on any thread (the settings line). */
export function latestFluxMemoryReport(): (FluxMemoryReport & { at: number }) | undefined {
  let out: (FluxMemoryReport & { at: number }) | undefined;
  for (const entry of recent.values()) if (!out || entry.at >= out.at) out = entry;
  return out;
}
export function clearFluxMemoryReports(): void { recent.clear(); }
