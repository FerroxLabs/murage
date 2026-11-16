// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { coordinationTraceSchema } from './coordination-budget.ts';
const id = z.string().min(1);
const audience = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), human: z.literal('owner'), kind: z.literal('home'), rootRequestId: id }).strict(),
  z.object({ v: z.literal(1), human: z.literal('owner'), kind: z.literal('team'), rootRequestId: id, team: id }).strict(),
  z.object({ v: z.literal(1), human: z.literal('owner'), kind: z.literal('project'), rootRequestId: id, projectId: id }).strict(),
]);
// Explicit nulls distinguish an absent ceiling from a damaged/older record. Never fill missing fields from a later turn.
export const heldPeerAuthoritySchema = z.object({
  version: z.literal(1), handoffId: id, depth: z.number().int().nonnegative(),
  notOwnerAudience: z.boolean(), unattended: z.boolean(),
  eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).nullable(),
  routineAuthority: z.object({ permissionMode: z.enum(['ask', 'auto', 'full', 'unlimited']), triggerSource: z.enum(['manual', 'schedule']) }).strict().nullable(),
  executionAudience: audience.nullable(), parentRequestId: id.nullable(),
  coordination: coordinationTraceSchema,
  source: z.object({ botId: id, threadId: id, generation: id, providerTurnId: id }).strict(),
}).strict();
export type HeldPeerAuthority = z.infer<typeof heldPeerAuthoritySchema>;
export const HELD_AUTHORITY_UNAVAILABLE = 'The original permissions for this held work could not be restored, so it did not run.';
export function restoreHeldPeerAuthority(raw: unknown, botId: string, threadId: string): HeldPeerAuthority {
  const result = heldPeerAuthoritySchema.safeParse(raw);
  if (!result.success || result.data.source.botId !== botId || result.data.source.threadId !== threadId) throw new Error(HELD_AUTHORITY_UNAVAILABLE);
  return result.data;
}
