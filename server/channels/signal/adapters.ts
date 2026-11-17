// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { authorizeUnlink, unlinkContract } from "./unlink.ts";
import { createSignalAccess } from "./access.ts";
import { aciSchema, accountsResultSchema, type RpcPolicy } from "./rpc.ts";
import type { SignalAccess, SignalLinkProtocol } from "./service.ts";
import type { RuntimePin } from "./types.ts";

// All source citations below are relative to src/main/java/org/asamk/signal/
// at this exact commit. Source-derived schemas are NOT live qualification.
// @ts-expect-error Shared ESM contract is also consumed by release scripts.
import { verifySignalEvidence } from "./evidence.mjs";
const time = z.number().int().safe().nonnegative();
const number = z.string().regex(/^\+[0-9]{1,15}$/);
const text = z.string().nullable();
// json/JsonAttachment.java:8-17 (never fetch/open attachment ids or filenames).
const attachment = z.strictObject({ contentType: z.string(), filename: text, id: text, size: time.nullable(),
  width: time.nullable(), height: time.nullable(), caption: text, uploadTimestamp: time.nullable(), isVoiceNote: z.boolean() });
const dataFields = {
  timestamp: time, // json/JsonDataMessage.java:14
  message: text, // :15
  expiresInSeconds: time.nullable(), // :16
  isExpirationUpdate: z.boolean().optional(), // :17
  viewOnce: z.boolean().optional(), // :18
  isEndSession: z.boolean().optional(), // :20
  isProfileKeyUpdate: z.boolean().optional(), // :21
  hasProfileKey: z.boolean().optional(), // :22
  attachments: z.array(attachment).optional(), // :28
  // json/JsonRemoteDelete.java:6, JsonDataMessage.java:30
  remoteDelete: z.strictObject({ targetTimestamp: time, timestamp: time }).optional(),
};
// Unsupported nested kinds (groups, reactions, quotes, stories, etc.) are
// intentionally rejected by strictObject, never stripped into an accepted note.
const dataMessage = z.strictObject(dataFields);
// json/JsonEditMessage.java:9. A new edit uses dataMessage.timestamp, not target.
const editMessage = z.strictObject({ targetSentTimestamp: time, dataMessage });
const destinationFields = {
  destination: text, // json/JsonSyncDataMessage.java:16,24-26
  destinationNumber: number.nullable(), // :17,27
  destinationUuid: text, // :18,28; keep PNI visible to the destination guard
};
// JsonSyncDataMessage.java:19-20: ordinary data is unwrapped; edits are nested.
const sentMessage = z.union([
  z.strictObject({ ...destinationFields, ...dataFields }),
  z.strictObject({ ...destinationFields, editMessage }),
]);
const envelope = z.strictObject({
  source: text, // json/JsonMessageEnvelope.java:17,53
  sourceNumber: number.nullable(), // :18,54
  sourceUuid: aciSchema, // :19,55 (authenticated service id trace is separately pinned)
  sourceName: text, // :20,56
  sourceDevice: z.number().int().safe().positive(), // :21,38-39
  timestamp: time, // :22,63
  serverReceivedTimestamp: time, // :23,64
  serverDeliveredTimestamp: time, // :24,65
  dataMessage: dataMessage.optional(), // :25,69; never admitted as a note
  editMessage: editMessage.optional(), // :26,70; non-sync edit never admitted
  syncMessage: z.strictObject({ sentMessage }).optional(), // :28,72; JsonSyncMessage.java:22
}).refine(e => [e.dataMessage, e.editMessage, e.syncMessage].filter(Boolean).length === 1);
// json/JsonReceiveMessageHandler.java:25-32. Exceptions/unknown shapes drop.
const received = z.strictObject({ account: z.string().min(1), envelope });
// jsonrpc/SignalJsonRpcDispatcherHandler.java:180-189: explicit subscription
// wraps the handler result; automatic receive emits it directly.
export const sourceDerivedReceiveSchema = z.union([received, z.strictObject({ subscription: time, result: received })]);
export function projectSourceDerivedReceive(raw: unknown): unknown {
  const parsed = sourceDerivedReceiveSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = ("result" in parsed.data ? parsed.data.result : parsed.data).envelope;
  const sent = e.syncMessage?.sentMessage;
  if (!sent) return null; // friend data and non-sync edits never enter the journal
  const data = "editMessage" in sent ? sent.editMessage.dataMessage : sent;
  // The JSON envelope has no destination service-id field. The reviewed
  // signalNetwork.syncProof must prove PNI-addressed sync is discarded upstream.
  const fields = { sourceAci: e.sourceUuid, sourceDevice: e.sourceDevice, destinationAci: sent.destinationUuid,
    envelopeDestination: null, timestamp: data.timestamp, group: false, expiresInSeconds: data.expiresInSeconds,
    longText: data.attachments?.some(a => a.contentType === "text/x-signal-plain") ?? false };
  if (data.viewOnce || data.isEndSession || data.isProfileKeyUpdate) return null;
  if (data.remoteDelete && data.isExpirationUpdate) return null;
  if (data.remoteDelete) return { ...fields, variant: "sync-control", body: null,
    control: { kind: "delete", target: data.remoteDelete.targetTimestamp } };
  if (data.isExpirationUpdate) return data.expiresInSeconds === null ? null : { ...fields, variant: "sync-control", body: null,
    control: { kind: "timer", seconds: data.expiresInSeconds } };
  return { ...fields, variant: "sync-sent", body: data.message, control: null };
}
const deviceLinkUri = z.string().max(8192).refine(value => {
  try { const uri = new URL(value); return uri.protocol === "sgnl:" && uri.hostname === "linkdevice"
    && !!uri.searchParams.get("uuid") && !!uri.searchParams.get("pub_key"); } catch { return false; }
});
// commands/StartLinkCommand.java:26,42; FinishLinkCommand.java:80,82;
// ListAccountsCommand.java:33-36,47. A second account is rejected by B5.
export const sourceDerivedContracts = {
  startLink: { params: z.strictObject({}), result: z.strictObject({ deviceLinkUri }) },
  finishLink: { params: z.strictObject({ deviceLinkUri, deviceName: z.string().min(1).max(200) }),
    result: z.strictObject({ number, aci: aciSchema }) },
  // jsonrpc/SignalJsonRpcDispatcherHandler.java:254-279 returns subscription id.
  subscribeReceive: { params: z.strictObject({}), result: time },
  listAccounts: { params: z.strictObject({}), result: accountsResultSchema },
} satisfies NonNullable<RpcPolicy["contracts"]>;
export function createSourceDerivedLinkProtocol(): SignalLinkProtocol {
  let deviceName: string | undefined;
  return { policy: { contracts: sourceDerivedContracts },
    startParams(input) { deviceName = input.deviceName; return {}; },
    readStart(result) {
      const { deviceLinkUri: uri } = sourceDerivedContracts.startLink.result.parse(result);
      if (!deviceName) throw new Error("Signal link was not started");
      return { uri, finishParams: { deviceLinkUri: uri, deviceName } };
    },
    // No unlink request or contract until pin-bound live proof is verified.
  };
}

export interface SignalAdapters { access: SignalAccess; linkProtocol?: SignalLinkProtocol; verified: boolean; timestampSupported: boolean }
export function loadSignalAdapters(pin: RuntimePin, fixtureDirectory: string): SignalAdapters {
  const access = createSignalAccess(projectSourceDerivedReceive);
  const closed: SignalAdapters = { access, verified: false, timestampSupported: false, linkProtocol: undefined };
  try {
    const verified = verifySignalEvidence(pin, fixtureDirectory);
    const { manifest } = verified;
    const linkProtocol = createSourceDerivedLinkProtocol();
    const unlink = authorizeUnlink(pin, verified);
    if (unlink) {
      linkProtocol.unlink = unlink;
      linkProtocol.policy.contracts = { ...sourceDerivedContracts, unregister: unlinkContract };
    }
    const timestampSupported = manifest.results["S1-TS"];
    linkProtocol.policy.timestampSupported = timestampSupported;
    return { access, linkProtocol, verified: true, timestampSupported };
  } catch { return closed; } // Never log raw evidence, zod errors, bodies or identities.
}
