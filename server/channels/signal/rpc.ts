// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { RpcMethod, RpcRequest, RpcResponse } from "./types.ts";

export const aciSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const integer = z.number().int().safe();
const idSchema = z.union([z.string().min(1).max(200), integer]);
const empty = z.strictObject({});
const methods = ["version", "startLink", "finishLink", "listAccounts", "subscribeReceive", "send", "unregister"] as const;
const requestSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: idSchema, method: z.enum(methods), params: z.unknown() });
const sendParams = z.strictObject({ noteToSelf: z.literal(true), message: z.string().min(1).max(2000), timestamp: integer.positive().optional() });
const address = z.strictObject({ uuid: aciSchema, number: z.string().nullable() });
const sendResult = z.strictObject({ timestamp: integer.positive(), results: z.array(z.strictObject({
  recipientAddress: address, type: z.string().min(1), retryAfterSeconds: z.number().finite().nonnegative().optional(),
})).max(100) });
export const accountsResultSchema = z.array(z.strictObject({ number: z.string().regex(/^\+[0-9]{1,15}$/), aci: aciSchema })).length(1);
export const rateLimitErrorSchema = z.strictObject({
  code: z.literal(-5), message: z.string(), data: z.strictObject({ response: z.strictObject({
    timestamp: integer.positive(), results: z.array(z.strictObject({ recipientAddress: address,
      type: z.literal("RATE_LIMIT_FAILURE"), retryAfterSeconds: z.number().finite().nonnegative().optional(),
    })),
  }) }),
});
const errorSchema = z.strictObject({ code: integer, message: z.string(), data: z.unknown().optional() });
export const notificationSchema = z.strictObject({ jsonrpc: z.literal("2.0"), method: z.literal("receive"), params: z.unknown() });
const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal("2.0"), id: idSchema, result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal("2.0"), id: idSchema.nullable(), error: errorSchema }),
]);

/** Source-derived contracts come from adapters.ts; missing contracts fail closed. */
export interface RpcContract { params: z.ZodObject; result: z.ZodType }
export interface RpcPolicy {
  contracts?: Partial<Record<"startLink" | "finishLink" | "unregister" | "subscribeReceive" | "listAccounts", RpcContract>>;
  timestampSupported?: boolean;
  /** B6 must check its durable reservations here; turn output cannot authorize a timestamp. */
  isReservedTimestamp?: (timestamp: number) => boolean;
}
export class SignalRpcError extends Error {
  readonly code: "invalid-request" | "invalid-frame";
  constructor(code: "invalid-request" | "invalid-frame") { super(code); this.code = code; }
}
export function parseRequest(raw: unknown, policy: RpcPolicy = {}): RpcRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new SignalRpcError("invalid-request");
  const request = parsed.data;
  // The pinned unregister command exposes account deletion as an option.
  // Never let even an injected contract widen this device-only parameter set.
  if (request.method === "unregister" && !empty.safeParse(request.params).success) throw new SignalRpcError("invalid-request");
  const schema = request.method === "send" ? sendParams
    : request.method === "startLink" || request.method === "finishLink" || request.method === "unregister" || request.method === "subscribeReceive"
      ? policy.contracts?.[request.method]?.params.strict() : empty;
  const params = schema?.safeParse(request.params);
  if (!params?.success) throw new SignalRpcError("invalid-request");
  if (request.method === "send") {
    const timestamp = (params.data as { timestamp?: number }).timestamp;
    if (timestamp !== undefined && (!policy.timestampSupported || !policy.isReservedTimestamp?.(timestamp))) {
      throw new SignalRpcError("invalid-request");
    }
  }
  return { ...request, params: params.data } as RpcRequest;
}
export function parseResponse<M extends RpcMethod>(method: M, raw: unknown, policy: RpcPolicy = {}): RpcResponse<M> {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new SignalRpcError("invalid-frame");
  if (!["version", "listAccounts", "send"].includes(method) && !policy.contracts?.[method as keyof NonNullable<RpcPolicy["contracts"]>]) {
    throw new SignalRpcError("invalid-frame");
  }
  if ("error" in parsed.data) return parsed.data as RpcResponse<M>;
  if (!Object.hasOwn(parsed.data, "result")) throw new SignalRpcError("invalid-frame");
  const schema = method === "version" ? z.strictObject({ version: z.string().min(1) })
    : method === "listAccounts" ? policy.contracts?.listAccounts?.result ?? accountsResultSchema : method === "send" ? sendResult
      : policy.contracts?.[method]?.result;
  const result = schema?.safeParse(parsed.data.result);
  if (!result?.success) throw new SignalRpcError("invalid-frame");
  return { ...parsed.data, result: result.data } as RpcResponse<M>;
}
