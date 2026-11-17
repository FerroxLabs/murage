// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import pin from "./runtime-pin.json" with { type: "json" };
import { parseRequest, parseResponse } from "./rpc.ts";
import { sourceDerivedReceive, sourceAci, sourceNow } from "./fixtures/source-derived.ts";
const modulePath = "./adapters.ts";
const adapters = () => import(/* @vite-ignore */ modulePath);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
// @ts-expect-error Synthetic ESM helper shared with staging tests.
import { makeSyntheticEvidence } from '../../../scripts/fixtures/signal-test-evidence.mjs';
function manifestFixture() {
  const root = mkdtempSync(join(tmpdir(), "signal-source-derived-manifest-")); roots.push(root);
  const f = makeSyntheticEvidence(root);
  return { root, ...f, provenPin: f.pin };
}
test("T-SOURCE-DERIVED-RECEIVE: raw subscription projects note, edit, delete and timer; unknown shape drops", async () => {
  const { loadSignalAdapters } = await adapters(); const { access } = loadSignalAdapters(pin, "/missing-synthetic-evidence");
  const raw = sourceDerivedReceive(); const event = access.parse(raw);
  expect(event).toMatchObject({ sourceAci, sourceDevice: 3, destinationAci: sourceAci, timestamp: sourceNow,
    variant: "sync-sent", body: "source-derived note", group: false });
  const context = { binding: { ownAci: sourceAci, ownDeviceId: 2, linkedAt: sourceNow - 1000 }, now: sourceNow,
    isCurrent: true, hasSentTimestamp: () => false, isTombstoned: () => false };
  expect(access.decide(event, context)).toBe("accept");
  expect(access.decide(event, { ...context, hasSentTimestamp: () => true })).toBe("drop");
  for (const mutate of [
    (r: any) => { r.result.envelope.sourceUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; },
    (r: any) => { r.result.envelope.sourceDevice = 2; },
    (r: any) => { r.result.envelope.syncMessage.sentMessage.destinationUuid = "PNI:" + sourceAci; },
    (r: any) => { r.result.envelope.syncMessage.sentMessage.destinationUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; },
    (r: any) => { r.result.envelope.dataMessage = r.result.envelope.syncMessage.sentMessage; delete r.result.envelope.syncMessage; },
  ]) { const r = sourceDerivedReceive(); mutate(r); const e = access.parse(r); expect(e === null || access.decide(e, context) === "drop").toBe(true); }
  const edit: any = sourceDerivedReceive(); const sent = edit.result.envelope.syncMessage.sentMessage;
  edit.result.envelope.syncMessage.sentMessage = { destination: sent.destination, destinationNumber: sent.destinationNumber,
    destinationUuid: sent.destinationUuid, editMessage: { targetSentTimestamp: sourceNow - 1,
      dataMessage: { timestamp: sourceNow + 1, message: "edited", expiresInSeconds: 0 } } };
  expect(access.parse(edit)).toMatchObject({ variant: "sync-sent", timestamp: sourceNow + 1, body: "edited" });
  for (const [extra, control] of [[{ remoteDelete: { targetTimestamp: sourceNow - 1, timestamp: sourceNow - 1 } }, { kind: "delete", target: sourceNow - 1 }],
    [{ isExpirationUpdate: true, expiresInSeconds: 60 }, { kind: "timer", seconds: 60 }]]) {
    const r: any = sourceDerivedReceive(); Object.assign(r.result.envelope.syncMessage.sentMessage, { message: null }, extra);
    const e = access.parse(r); expect(e).toMatchObject({ variant: "sync-control", control }); expect(access.control(e, context)).toBe(true);
  }
  expect(access.parse({ ...raw, unexpected: true })).toBeNull();
});
test("T-SOURCE-DERIVED-CONTRACTS: source paths link and subscribe; no contract permits unregister", async () => {
  const { createSourceDerivedLinkProtocol } = await adapters(); const protocol = createSourceDerivedLinkProtocol();
  const start = { jsonrpc: "2.0", id: 1, method: "startLink", params: protocol.startParams({ deviceName: "Murage (2026-11-10)", args: ["-n", "Murage (2026-11-10)"] }) };
  expect(parseRequest(start, protocol.policy).params).toEqual({});
  const result = { deviceLinkUri: "sgnl://linkdevice?uuid=fixture&pub_key=fixture" };
  expect(parseResponse("startLink", { jsonrpc: "2.0", id: 1, result }, protocol.policy).result).toEqual(result);
  expect(protocol.readStart(result)).toEqual({ uri: result.deviceLinkUri, finishParams: { ...result, deviceName: "Murage (2026-11-10)" } });
  expect(parseResponse("finishLink", { jsonrpc: "2.0", id: 1, result: { number: "+15550001234", aci: sourceAci } }, protocol.policy)).toHaveProperty("result.aci", sourceAci);
  expect(parseResponse("subscribeReceive", { jsonrpc: "2.0", id: 1, result: 0 }, protocol.policy).result).toBe(0);
  expect(() => parseRequest({ ...start, method: "subscribeReceive" })).toThrow("invalid-request");
  expect(() => parseResponse("subscribeReceive", { jsonrpc: "2.0", id: 1, error: { code: -1, message: "refused" } })).toThrow("invalid-frame");
  expect(protocol.unlink).toBeUndefined();
  expect(() => parseRequest({ ...start, method: "unregister" }, protocol.policy)).toThrow("invalid-request");
  expect(() => parseResponse("listAccounts", { jsonrpc: "2.0", id: 1, result: Array(2).fill({ number: "+15550001234", aci: sourceAci }) }, protocol.policy)).toThrow();
});
test("T-SOURCE-DERIVED-MANIFEST: all hashes, complete set, pin equality, review and sync proof are mandatory", async () => {
  const { loadSignalAdapters } = await adapters(); const f = manifestFixture();
  expect(loadSignalAdapters(f.provenPin, f.root)).toMatchObject({ verified: true, timestampSupported: true });
  expect(loadSignalAdapters({ ...f.provenPin, g0: null }, f.root).verified).toBe(false);
  expect(loadSignalAdapters({ ...f.provenPin, signalNetwork: { ...f.provenPin.signalNetwork, syncProof: null } }, f.root).verified).toBe(false);
  f.manifest.signalCliVersion = "wrong"; f.save(); expect(loadSignalAdapters(f.provenPin, f.root).verified).toBe(false);
  f.manifest.signalCliVersion = pin.signalCliVersion; f.save();
  writeFileSync(join(f.root, "own-note.json"), "tampered"); expect(loadSignalAdapters(f.provenPin, f.root)).toMatchObject({ verified: false, timestampSupported: false, linkProtocol: undefined });
  const missingReview = manifestFixture();
  delete missingReview.provenPin.g0.review;
  expect(loadSignalAdapters(missingReview.provenPin, missingReview.root).verified).toBe(false);
  const wrongG0 = manifestFixture();
  expect(loadSignalAdapters({ ...wrongG0.provenPin, g0: { ...wrongG0.provenPin.g0, signalCliVersion: "wrong" } }, wrongG0.root).verified).toBe(false);
  wrongG0.manifest.results["S1-TS"] = false; wrongG0.save();
  expect(loadSignalAdapters(wrongG0.provenPin, wrongG0.root)).toMatchObject({ verified: true, timestampSupported: false });
  const g = manifestFixture(); g.manifest.fixtures.pop(); g.save(); expect(loadSignalAdapters(g.provenPin, g.root).verified).toBe(false);
  const h = manifestFixture(); h.manifest.fixtures[0].path = "../escape.json"; h.save(); expect(loadSignalAdapters(h.provenPin, h.root).verified).toBe(false);
  const j = manifestFixture(); rmSync(join(j.root, "own-note.json")); symlinkSync(join(j.root, "edit.json"), join(j.root, "own-note.json"));
  expect(loadSignalAdapters(j.provenPin, j.root).verified).toBe(false);
});

test("T-UNLINK-MANIFEST: loader binds unlink response to the verified manifest", async () => {
 const { loadSignalAdapters } = await adapters(); const f = manifestFixture();
 expect(loadSignalAdapters(f.pin, f.root).linkProtocol?.unlink).toBeDefined();
 f.frames['unlink-response'] = { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'refused' } }; f.save();
 expect(loadSignalAdapters(f.pin, f.root).verified).toBe(false);
});
