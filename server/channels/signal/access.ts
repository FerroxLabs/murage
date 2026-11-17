// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { wrapUntrusted } from "../core/wrap.ts";
import type { AccessContext, SignalAccess } from "./service.ts";
import type { SignalEvent } from "./types.ts";

// This is the frozen B0 projection, NOT a claim about signal-cli's wire format.
// G0 must supply and qualify the raw-frame projector before B8 activates it.
const aci = z.string().transform(value => value.replace(/^\{([0-9a-f-]+)\}$/i, "$1").toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));
const time = z.number().int().safe().nonnegative();
const fields = { sourceAci: aci, sourceDevice: z.number().int().safe().positive(), destinationAci: aci.nullable(),
  // Keep an explicit PNI destination so the independent destination guard rejects it.
  envelopeDestination: z.string().transform(value => value.startsWith("PNI:") ? value : value.replace(/^\{([0-9a-f-]+)\}$/i, "$1").toLowerCase()).nullable(),
  timestamp: time, group: z.boolean(), expiresInSeconds: time.nullable(), longText: z.boolean() };
const eventSchema = z.discriminatedUnion("variant", [
  z.strictObject({ ...fields, variant: z.literal("sync-sent"), body: z.string().nullable(), control: z.null() }),
  z.strictObject({ ...fields, variant: z.literal("sync-control"), body: z.null(), control: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("delete"), target: time }), z.strictObject({ kind: z.literal("timer"), seconds: time }),
  ]) }),
  z.strictObject({ ...fields, variant: z.literal("other"), body: z.null(), control: z.null() }),
]);
export function parseSignalEvent(input: unknown): SignalEvent | null {
  const parsed = eventSchema.safeParse(input);
  // Do not emit zod messages: received values can belong to strangers.
  return parsed.success ? parsed.data : null;
}
export type SignalDecision = "accept" | "malformed" | "not-owner" | "own-device" | "not-note-to-self" | "group"
  | "empty" | "too-long" | "history" | "future" | "echo" | "not-current" | "deleted";
const SKEW = 5 * 60000;
function authenticated(event: SignalEvent, context: AccessContext): SignalDecision | null {
  const { binding, now } = context;
  if (event.sourceAci !== binding.ownAci) return "not-owner";
  if (event.sourceDevice === binding.ownDeviceId) return "own-device";
  if (event.destinationAci !== binding.ownAci || (event.envelopeDestination !== null && event.envelopeDestination !== binding.ownAci)) return "not-note-to-self";
  if (event.group) return "group";
  if (event.timestamp < binding.linkedAt - SKEW) return "history";
  if (event.timestamp > now + SKEW) return "future";
  if (!context.isCurrent) return "not-current";
  return null;
}
export function decideSignal(input: SignalEvent, context: AccessContext): SignalDecision {
  const event = parseSignalEvent(input);
  if (!event) return "malformed";
  const rejected = authenticated(event, context);
  if (rejected) return rejected;
  if (event.variant !== "sync-sent") return "not-note-to-self";
  if (context.hasSentTimestamp(event.timestamp)) return "echo";
  if (context.isTombstoned(event.timestamp)) return "deleted";
  if (!event.body?.trim()) return "empty";
  // Every identity/lifecycle guard runs before a refusal can send a reply.
  if (event.longText || wrapUntrusted("SIGNAL", { body: event.body }).length > 6000) return "too-long";
  return "accept";
}
export function decideSignalControl(input: SignalEvent, context: AccessContext): boolean {
  const event = parseSignalEvent(input);
  if (!event || event.variant !== "sync-control" || authenticated(event, context)) return false;
  // Delete-before-note is permitted within this connection's link window. The
  // service derives its key from this binding's ACI and persists its tombstone.
  return event.control.kind === "timer" || (event.control.target >= context.binding.linkedAt - SKEW
    && event.control.target <= context.now + SKEW);
}
export function createSignalAccess(project?: (raw: unknown) => unknown): SignalAccess {
  return {
    parse(raw) { try { return project ? parseSignalEvent(project(raw)) : null; } catch { return null; } },
    decide(event, context) { const result = decideSignal(event, context); return result === "accept" || result === "too-long" ? result : "drop"; },
    control: decideSignalControl,
  };
}
