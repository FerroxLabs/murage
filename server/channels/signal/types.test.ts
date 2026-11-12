// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { diagnosticsFor, SERVER_DIR, virtualProgram } from "../../testing/virtual-program.ts";

const prelude = `import type { SignalEvent, SignalBinding, RpcRequest, RpcResponse,
  RateLimitError, ChannelState, ReviewState, OutboxEntry, DeliveryAttempt,
  ResendResult, SignalAction, ProcessHost, StorageGuard, Transport, SignalService,
  RuntimePin } from "./types.ts";
declare const binding: SignalBinding;
declare const host: ProcessHost;
declare const storage: StorageGuard;
declare const transport: Transport;
declare const service: SignalService;
`;
const note = `{ sourceAci: "00000000-0000-4000-8000-000000000001", sourceDevice: 2,
  destinationAci: null, envelopeDestination: null, timestamp: 1, group: false,
  expiresInSeconds: null, longText: false, variant: "sync-sent", body: "note", control: null }`;
const attempt = `deliveryId: "delivery", purpose: "reply", attempt: 1`;
const rateLimit = `{ code: -5, message: "busy", data: { response: { timestamp: 1,
  results: [{ recipientAddress: { uuid: "owner", number: null }, type: "RATE_LIMIT_FAILURE" }] } } }`;
const pairs: Array<[string, string, string]> = [
  ["T-GROUP-RAW contract: kill omitted group field", `const e: SignalEvent = ${note};`, `const e: SignalEvent = ${note.replace("group: false,", "")};`],
  ["T-TIMER contract: kill omitted expiry field", `const e: SignalEvent = ${note};`, `const e: SignalEvent = ${note.replace("expiresInSeconds: null,", "")};`],
  ["T-LONGTEXT contract: kill omitted long-text field", `const e: SignalEvent = ${note};`, `const e: SignalEvent = ${note.replace("longText: false,", "")};`],
  ["T-NORM contract: kill mixed variants", `const e: SignalEvent = ${note};`, `const e: SignalEvent = ${note.replace("control: null", 'control: { kind: "delete", target: 1 }')};`],
  ["T-TIMER contract: kill obsolete expiry control", `const e: SignalEvent = ${note.replace('variant: "sync-sent", body: "note", control: null', 'variant: "sync-control", body: null, control: { kind: "timer", seconds: 60 }')};`, `const e: SignalEvent = ${note.replace('variant: "sync-sent", body: "note", control: null', 'variant: "sync-control", body: null, control: { kind: "expiry", seconds: 60 }')};`],
  ["T-ACCOUNTS contract: kill optional device identity", `const b: SignalBinding = { connectionId: "c", generation: 1, ownAci: "owner", ownDeviceId: 2, linkedAt: 1, chiefBotId: "chief" };`, `const b: SignalBinding = { connectionId: "c", generation: 1, ownAci: "owner", linkedAt: 1, chiefBotId: "chief" };`],
  ["T-HOOK-ID contract: kill missing attempt", `const a: DeliveryAttempt = { ${attempt} };`, `const a: DeliveryAttempt = { deliveryId: "delivery", purpose: "reply" };`],
  ["T-NOTICE-ONCE contract: kill repeated notice attempt", `const a: DeliveryAttempt = { deliveryId: "delivery", purpose: "notice", attempt: 1 };`, `const a: DeliveryAttempt = { deliveryId: "delivery", purpose: "notice", attempt: 2 };`],
  ["T-HOOK-ID outbox: kill missing purpose", `const o: OutboxEntry = { ${attempt}, occurredAt: 1, chunks: [{ state: "written" }] };`, `const o: OutboxEntry = { deliveryId: "delivery", attempt: 1, occurredAt: 1, chunks: [{ state: "written" }] };`],
  ["T-A8 outbox: kill confirmed chunk without timestamp", `const o: OutboxEntry = { ${attempt}, occurredAt: 1, chunks: [{ state: "confirmed", timestamp: 1 }] };`, `const o: OutboxEntry = { ${attempt}, occurredAt: 1, chunks: [{ state: "confirmed" }] };`],
  ["T-SEND-SCHEMA contract: kill recipient parameter", `const r: RpcRequest<"send"> = { jsonrpc: "2.0", id: 1, method: "send", params: { noteToSelf: true, message: "reply" } };`, `const r: RpcRequest<"send"> = { jsonrpc: "2.0", id: 1, method: "send", params: { noteToSelf: true, message: "reply", recipient: "friend" } };`],
  ["T-SEND-SCHEMA contract: kill noteToSelf false", `const r: RpcRequest<"send"> = { jsonrpc: "2.0", id: 1, method: "send", params: { noteToSelf: true, message: "reply" } };`, `const r: RpcRequest<"send"> = { jsonrpc: "2.0", id: 1, method: "send", params: { noteToSelf: false, message: "reply" } };`],
  ["T-RPC-ALLOW contract: kill arbitrary method", `const r: RpcRequest = { jsonrpc: "2.0", id: 1, method: "version", params: {} };`, `const r: RpcRequest = { jsonrpc: "2.0", id: 1, method: "sendGroup", params: {} };`],
  ["T-RPC-ALLOW response: kill simultaneous result and error", `const r: RpcResponse<"version"> = { jsonrpc: "2.0", id: 1, result: { version: "0.14.11" } };`, `const r: RpcResponse<"version"> = { jsonrpc: "2.0", id: 1, result: { version: "0.14.11" }, error: { code: -1, message: "error" } };`],
  ["T-RL-PIN contract: kill flattened error results", `const r: RateLimitError = ${rateLimit};`, `const r: RateLimitError = ${rateLimit.replace("data: { response: {", "data: {").replace("} } }", "} }")};`],
  ["T-RL-DEADLINE contract: kill missing cooldown", `const r: ReviewState = { state: "uncertain", reason: "rate-limit", deliveryId: "d", response: "reply", partial: false, resendAfter: 100 };`, `const r: ReviewState = { state: "uncertain", reason: "rate-limit", deliveryId: "d", response: "reply", partial: false };`],
  ["T-STUCK contract: kill reply-lost with resend text", `const r: ReviewState = { state: "needs-review", reason: "run-receipt-missing", deliveryId: "d" };`, `const r: ReviewState = { state: "needs-review", reason: "run-receipt-missing", deliveryId: "d", response: "untrusted" };`],
  ["T-RESEND contract: kill invented result", `const r: ResendResult[] = ["resent", "already", "full"];`, `const r: ResendResult[] = ["resent", "already", "full", "sent"];`],
  ["T-RESEND action: kill missing delivery identity", `const a: SignalAction = { action: "resend", deliveryId: "d" };`, `const a: SignalAction = { action: "resend" };`],
  ["T-REDACT transport: kill missing synchronous fence", `transport.sendNoteToSelf({ ${attempt}, text: "reply", isRedacted: () => false });`, `transport.sendNoteToSelf({ ${attempt}, text: "reply" });`],
  ["T-REDACT transport: kill asynchronous fence", `transport.sendNoteToSelf({ ${attempt}, text: "reply", isRedacted: () => false });`, `transport.sendNoteToSelf({ ${attempt}, text: "reply", isRedacted: async () => false });`],
  ["T-SEND-SCHEMA transport: kill arbitrary destination", `transport.sendNoteToSelf({ ${attempt}, text: "reply", isRedacted: () => false });`, `transport.sendNoteToSelf({ ${attempt}, text: "reply", isRedacted: () => false, recipient: "friend" });`],
];
const problems = ["link-required", "identity-unavailable", "identity-mismatch", "needs-update", "storage-permissions", "storage-owner", "revoke-recovery-required", "disk-full", "storage-slow", "ledger-write-failed", "notes-stuck", "reply-lost"];
for (const reason of problems) pairs.push([
  `T-STUCK state: accept ${reason}; kill open-ended problem strings`,
  `const s: ChannelState = { state: "blocked", reason: "${reason}" };`,
  `const s: ChannelState = { state: "blocked", reason: "${reason}-typo" };`,
]);
const files: Record<string, string> = {};
const path = (index: number, side: string) => join(SERVER_DIR, "channels/signal", `__b0_${index}_${side}.ts`);
pairs.forEach(([, accepted, rejected], i) => {
  files[path(i, "accepted")] = prelude + accepted;
  files[path(i, "rejected")] = prelude + rejected;
});
const interfaces = join(SERVER_DIR, "channels/signal/__b0_interfaces.ts");
files[interfaces] = prelude + `
host.spawn({ generation: 1, account: null });
host.request({ jsonrpc: "2.0", id: 1, method: "version", params: {} }, { generation: 1 });
host.onNotification(frame => { const generation: number = frame.generation; });
host.pauseReading(); host.resumeReading(); host.stop();
storage.check(); storage.repair();
service.status(); service.link({ chiefBotId: "chief" }); service.disconnect();
service.resend("delivery"); service.settle("delivery"); service.retryNotes();
service.finishRevocation(); service.fixPermissions();
const idle: ChannelState = { state: "not-linked" };
const linked: ChannelState = { state: "linked", binding, maskedNumber: "•••1234", reviews: [], reviewCount: 0 };
const partial: ReviewState = { state: "uncertain", reason: "delivery-unknown", deliveryId: "d", response: "reply", partial: true };
const rejected: ReviewState = { state: "rejected", reason: "invalid-request", deliveryId: "d" };
declare const pin: RuntimePin;
const proof: null | { signalCliVersion: string; citation: string; reviewedBy: string } = pin.rateLimitNotSentProof;
`;
let diagnostics: Map<string, string[]>;
beforeAll(() => {
  const program = virtualProgram(files);
  diagnostics = new Map(Object.keys(files).map(file => [file, diagnosticsFor(program, file)]));
  const typesFile = join(SERVER_DIR, "channels/signal/types.ts");
  diagnostics.set(typesFile, diagnosticsFor(program, typesFile));
});

describe("B0 frozen Signal contracts (real TypeScript compiler)", () => {
  it.each(pairs.map(([name], i) => [name, i] as const))("%s", (_, i) => {
    expect(diagnostics.get(path(i, "accepted"))).toEqual([]);
    const rejected = diagnostics.get(path(i, "rejected"))!;
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every(d => !/^(2307|2305|1005|1128):/.test(d)), rejected.join("\n")).toBe(true);
  });
  it("T-NO-SURFACE contract: standalone interfaces compile without implementations", () => {
    expect(diagnostics.get(interfaces)).toEqual([]);
    expect(diagnostics.get(join(SERVER_DIR, "channels/signal/types.ts"))).toEqual([]);
  });
});
