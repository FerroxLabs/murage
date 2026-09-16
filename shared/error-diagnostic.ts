import { z } from "zod";
import { ENGINE_ERROR_CATEGORIES } from "./provider-error.ts";

/** Display/support facts only; never input to retry, routing or auth policy. */
// Fuigo 1.0.18's 17 canonical tags plus the existing legacy diagnostic value.
export const DIAGNOSTIC_FAILURE_KINDS = [...ENGINE_ERROR_CATEGORIES, "context_length"] as const;
export type DiagnosticFailureKind = (typeof DIAGNOSTIC_FAILURE_KINDS)[number];
export const DIAGNOSTIC_RPC_METHODS = ["initialize","authenticate","session/new","session/load","session/prompt","session/set_mode","session/set_model","session/set_config_option"] as const;
export const RUNTIME_ERROR_DIAGNOSTIC_MAX_BYTES = 1024;
export const runtimeErrorDiagnosticSchema = z.object({
  version:z.literal(1),
  diagnosticId:z.string().max(40).regex(/^ev-[0-9a-z]{1,16}-[0-9a-z]{1,16}$/),
  turnId:z.uuid(),
  processGeneration:z.uuid().optional(),
  rpcId:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  method:z.enum(DIAGNOSTIC_RPC_METHODS).optional(),
  rpcCode:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  httpStatus:z.number().int().min(100).max(599).optional(),
  terminalKind:z.enum(DIAGNOSTIC_FAILURE_KINDS).optional(),
  observedKind:z.enum(DIAGNOSTIC_FAILURE_KINDS).optional(),
}).strict();
export type RuntimeErrorDiagnostic = z.infer<typeof runtimeErrorDiagnosticSchema>;
export function parseRuntimeErrorDiagnostic(value:unknown):RuntimeErrorDiagnostic|undefined {
  try{const parsed=runtimeErrorDiagnosticSchema.safeParse(value);if(!parsed.success||new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength>RUNTIME_ERROR_DIAGNOSTIC_MAX_BYTES)return;return parsed.data;}catch{return;}
}
export function diagnosticFailureKind(value:unknown):DiagnosticFailureKind|undefined {
  return typeof value==="string"&&(DIAGNOSTIC_FAILURE_KINDS as readonly string[]).includes(value)?value as DiagnosticFailureKind:undefined;
}
