// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stop and failure lines are read by the owner in the chat: a wait reads
// "3 minutes", never "180000ms" or "180 s", and an engine that ended reads
// "closed (exit code 1)", never a protocol step or an internal name.

/** Seconds below two minutes, whole minutes from there, hours from two hours. */
export function plainDuration(ms: number): string {
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (ms >= 2 * 60 * 60_000) return unit(Math.round(ms / (60 * 60_000)), "hour");
  if (ms >= 2 * 60_000) return unit(Math.round(ms / 60_000), "minute");
  return unit(Math.max(1, Math.round(ms / 1000)), "second");
}

/** An engine process that ended before its reply: its exit code and signal
 * as the owner reads them, and the last words it wrote when there are any. */
export function engineClosedLine(engine: string, code: number | null | undefined, signal?: string | null, lastWords?: string): string {
  const how = [code !== null && code !== undefined ? `exit code ${code}` : "", signal ? `signal ${signal}` : ""].filter(Boolean).join(", ");
  return `${engine} closed${how ? ` (${how})` : ""} before it finished its reply${lastWords ? `: ${lastWords}` : ""}`;
}

/** A mounted turn ends before its prompt when a required connected app never connected: the relay fails closed, and the owner
 * reads why and what to do, not an exit code. Nothing was sent to the engine. */
export function mountNeverConnectedLine(engine: string): string {
  return `${engine} stopped because a connected app this bot needs did not connect. Nothing was sent. Send your message again in a moment.`;
}

/** Why the tool relay closed before the prompt (1.0.20 item 5). Only a native failure from an app's own connection blames a connected
 * app. A memory fence (a refusal handed over, a refusal error, or a refusal already registered for this turn) says memory, and a bare
 * seal with neither says what Murage did. `code` is what Technical details shows. */
export type MountStopCause = { kind: "memory" | "app" | "sealed"; code: string };
export function mountStopCause(nativeError: unknown, refusal: unknown, registeredRefusal: unknown): MountStopCause {
  const codeOf = (value: unknown) => typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" ? (value as { code: string }).code : undefined;
  const reasonOf = (value: unknown) => {
    const verdict = typeof value === "object" && value !== null ? (value as { fence?: unknown; verdict?: unknown }).fence ?? (value as { verdict?: unknown }).verdict : undefined;
    const reason = typeof verdict === "object" && verdict !== null ? (verdict as { reason?: unknown }).reason : undefined;
    return typeof reason === "string" ? reason : undefined;
  };
  const memory = refusal !== undefined || codeOf(nativeError) === "MEMORY_CONTEXT_REVOKED" || Boolean(registeredRefusal);
  if (memory) {
    const reason = reasonOf(refusal) ?? reasonOf(nativeError) ?? reasonOf(registeredRefusal);
    return { kind: "memory", code: `memory-fence${reason ? `:${reason}` : ""}` };
  }
  if (nativeError !== undefined) return { kind: "app", code: codeOf(nativeError) ?? "MCP_TRANSPORT_CLOSED" };
  return { kind: "sealed", code: "mount-relay-sealed" };
}

/** The owner's line for a relay that closed before the prompt: the real cause, in plain words. */
export function mountStoppedLine(engine: string, cause: MountStopCause): string {
  if (cause.kind === "app") return mountNeverConnectedLine(engine);
  if (cause.kind === "memory") return `${engine} stopped because this conversation's memory was not ready yet, so Murage held your message back. Nothing was sent. Send your message again in a moment.`;
  return `${engine} stopped because Murage closed this bot's tool connection before your message went out. Nothing was sent. Send your message again in a moment.`;
}

/** Technical details for that card: the line, then the cause code support needs. */
export function mountStoppedDetails(engine: string, cause: MountStopCause): string {
  return `${mountStoppedLine(engine, cause)}\nCause code: ${cause.code}`;
}
