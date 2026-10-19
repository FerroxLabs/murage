// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 hole 11: ONE wire schema for Flux sub-key renewal, CP -> root poller -> sealed store.
// The control plane (cloudflare/control-plane/src/b4-flux.ts) and the supervisor read it from
// here. The root poller (deploy/cloud-home/murage-control) mirrors it in Python; the drift test
// (server/cloud-home/flux-renewal-wire.test.ts) fails if the two disagree on a field, a pattern or any case.
import { z } from "zod";

/** Every key Flux mints for a home. Same shape as isHomeFluxKey (server/cloud-home/flux-home-gate.ts). */
export const HOME_KEY_PATTERN = "^sk-flux-home-[A-Za-z0-9_-]{21,230}$";
/** `renew:<homeId>:<machineGeneration>:<keyGeneration>` - one renewal attempt, named by the control plane. */
export const RENEWAL_OP_ID_PATTERN = "^renew:[A-Za-z0-9_-]{1,128}:[1-9][0-9]{0,15}:[0-9]{1,16}$";
export const ISO_UTC_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$";

const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const opId = z.string().regex(new RegExp(RENEWAL_OP_ID_PATTERN));

/** POST /v1/machines/:id/flux/renewal-due  {generation}  ->  {due, op_id?}. op_id is present exactly when due. */
export const renewalDueRequest = z.strictObject({ generation });
export const renewalDueResponse = z.strictObject({ due: z.boolean(), op_id: opId.optional() })
  .refine(value => value.due === (value.op_id !== undefined), "op_id is present exactly when due");

/** POST /v1/machines/:id/flux/subkey  {generation, op_id}  ->  {key, generation, expiresAt, capUsd}.
 *  `generation` here is the MACHINE generation, as on every machine route. op_id is optional only for older homes. */
export const subkeyRequest = z.strictObject({ generation, op_id: opId.optional() });
export const subkeyResponse = z.strictObject({
  key: z.string().regex(new RegExp(HOME_KEY_PATTERN)),
  generation,
  expiresAt: z.string().regex(new RegExp(ISO_UTC_PATTERN)),
  capUsd: z.number().finite().min(0),
});

/** POST /v1/machines/:id/flux/subkey/ack  {generation (machine), op_id, key_generation?}  ->  {acked: true}.
 *  Only this ack moves the control plane's recorded key expiry. */
export const ackRequest = z.strictObject({ generation, op_id: opId, key_generation: generation.optional() });
export const ackResponse = z.strictObject({ acked: z.literal(true) });

/** The root poller's private hand-off file (key.json): the sub-key answer plus the renewal's op_id, so the supervisor can name its receipt. Never leaves the private directory. */
export const fluxHandoff = z.strictObject({ ...subkeyResponse.shape, op_id: opId });
/** The supervisor's durable receipt (receipt.json, same private directory): written only AFTER the key is sealed. No key material.
 *  `generation` is the KEY generation. The poller acks the control plane only when it finds the receipt matching its pending op_id. */
export const fluxReceipt = z.strictObject({ op_id: opId, generation });

export type RenewalDueResponse = z.infer<typeof renewalDueResponse>;
export type SubkeyResponse = z.infer<typeof subkeyResponse>;

/** Field lists, compared with the Python mirror by the drift test. */
export const FLUX_RENEWAL_WIRE = {
  renewalDueRequest: ["generation"],
  renewalDueResponse: ["due", "op_id"],
  subkeyRequest: ["generation", "op_id"],
  subkeyResponse: ["key", "generation", "expiresAt", "capUsd"],
  ackRequest: ["generation", "op_id", "key_generation"],
  ackResponse: ["acked"],
  handoff: ["key", "generation", "expiresAt", "capUsd", "op_id"],
  receipt: ["op_id", "generation"],
  patterns: { homeKey: HOME_KEY_PATTERN, opId: RENEWAL_OP_ID_PATTERN, isoUtc: ISO_UTC_PATTERN },
} as const;
