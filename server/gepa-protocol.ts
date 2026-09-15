import { z } from "zod";

export const GEPA_FRAME_BYTES = 1024 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
export const gepaCandidateSchema = z.object({ instruction: z.string().min(1).max(20_000).refine(text => Boolean(text.trim()) && !text.includes("\0")) }).strict();
export const gepaLimitsSchema = z.object({ maxMetricCalls: z.number().int().min(1).max(24), maxReflections: z.number().int().min(1).max(2), wallMs: z.number().int().min(1).max(30_000) }).strict();
export const gepaStartSchema = z.object({
  v: z.literal(1), type: z.literal("start"), jobId: identifier.max(180), candidate: gepaCandidateSchema,
  trainIds: z.array(identifier).min(1).max(24), validationIds: z.array(identifier).min(1).max(24),
  limits: gepaLimitsSchema, randomSeed: z.number().int().min(0).max(2_147_483_647),
}).strict().refine(job => new Set([...job.trainIds, ...job.validationIds]).size === job.trainIds.length + job.validationIds.length, "Training and validation identities must be unique and disjoint");

export type GepaStart = z.infer<typeof gepaStartSchema>;
export type GepaCandidate = z.infer<typeof gepaCandidateSchema>;
export type GepaJson = null | boolean | number | string | GepaJson[] | { [key: string]: GepaJson };
const jsonValue: z.ZodType<GepaJson> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)]));
export const gepaEvaluationSchema = z.object({ outputs: z.array(jsonValue).max(24), scores: z.array(z.number().finite()).max(24), trajectories: z.array(jsonValue).max(24).nullable() }).strict();
export type GepaEvaluation = z.infer<typeof gepaEvaluationSchema>;
const decision = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proposal"), iteration: z.number().int().nonnegative(), candidate: gepaCandidateSchema }).strict(),
  z.object({ type: z.literal("rejected"), iteration: z.number().int().nonnegative(), oldScore: z.number().finite(), newScore: z.number().finite(), reason: z.string().max(1000) }).strict(),
  z.object({ type: z.literal("accepted"), iteration: z.number().int().nonnegative(), candidateIndex: z.number().int().nonnegative(), newScore: z.number().finite(), parents: z.array(z.number().int().nonnegative()).max(3) }).strict(),
]);
export const gepaResultSchema = z.object({
  v: z.literal(1), type: z.literal("result"), jobId: identifier,
  bestCandidate: gepaCandidateSchema, bestIndex: z.number().int().nonnegative(),
  candidates: z.array(gepaCandidateSchema).min(1).max(3), parents: z.array(z.array(z.number().int().nonnegative().nullable()).max(3)).min(1).max(3),
  validationScores: z.array(z.number().finite()).min(1).max(3), metricCalls: z.number().int().min(1).max(24), reflectionCalls: z.number().int().min(0).max(2),
  decisionEvents: z.array(decision).max(16),
}).strict();
export type GepaResult = z.infer<typeof gepaResultSchema>;
export const gepaChildFrameSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("ready"), gepaVersion: z.literal("0.1.4"), pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
  z.object({ v: z.literal(1), type: z.literal("evaluate"), jobId: identifier, callId: identifier, candidate: gepaCandidateSchema, caseIds: z.array(identifier).min(1).max(24), captureTraces: z.boolean() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("reflect"), jobId: identifier, callId: identifier, prompt: z.string().min(1).max(200_000) }).strict(),
  gepaResultSchema,
  z.object({ v: z.literal(1), type: z.literal("failed"), jobId: identifier.nullable(), code: z.string().regex(/^[A-Z0-9_]{1,100}$/) }).strict(),
]);
export type GepaChildFrame = z.infer<typeof gepaChildFrameSchema>;

export function encodeGepaFrame(frame: unknown): string {
  const text = JSON.stringify(frame);
  if (!text || Buffer.byteLength(text) + 1 > GEPA_FRAME_BYTES) throw new Error("GEPA_FRAME_LIMIT");
  return text + "\n";
}

/** One outer envelope, preserving Markdown code fences inside the instruction. */
export function validateGepaReflection(text: string): string {
  const match = /^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```$/.exec(text.trim());
  if (!match) throw new Error("GEPA_REFLECTION_ENVELOPE_INVALID");
  gepaCandidateSchema.parse({ instruction: match[1].trim() });
  return text.trim();
}
