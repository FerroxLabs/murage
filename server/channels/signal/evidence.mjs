// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared by release tooling and activation. No captures or approvals are inferred.
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const SIGNAL_CLI_COMMIT = "48a0a5e90cb0c36153f0276c0affff090e588290";
export const SIGNAL_NETWORK_COMMIT = "6d6f87d5722a369caac59444b692ce9e8f0fdb8d";
export const REQUIRED_FIXTURES = Object.freeze([
  "version", "listAccounts-one", "listAccounts-two", "startLink", "finishLink", "subscribeReceive",
  "own-note", "edit", "remote-delete", "expiry", "owner-to-friend", "desktop-note", "own-echo",
  "send-with-timestamp", "send-without-timestamp", "other-account-text", "other-account-attachment",
  "phone-removal", "other-sender-sync", "pni-sync", "group-sync", "history", "malformed-identity",
  "long-text", "timer-update",
]);
export const invariantFixtures = Object.freeze({
  "authenticated-sender": ["other-sender-sync", "other-account-text", "other-account-attachment"],
  "pni-endpoint": ["pni-sync"], "own-echo": ["own-echo"], "group": ["group-sync"],
  "history": ["history"], "malformed-identity": ["malformed-identity"],
  "long-text": ["long-text"], "immutable-expiry": ["expiry", "timer-update"],
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().trim().min(1);
const targets = ["darwin-arm64", "win32-x64", "linux-x64"];
export const releaseInputsSchema = z.strictObject(Object.fromEntries(targets.map(target => [target,
  z.strictObject({ url: z.url().refine(url => new URL(url).protocol === "https:"), sha256, layout: z.literal("prelinked-jre") }),
])));
export const g0Schema = z.strictObject({
  signalCliVersion: text, signalCliCommit: z.literal(SIGNAL_CLI_COMMIT), citation: text,
  manifestSha256: sha256, artifactSha256: sha256, reviewedBy: text, review: text,
});
export const MUTATED_FIXTURES = Object.freeze(["other-sender-sync", "pni-sync", "malformed-identity"]);
export const FIXTURE_DEVICE = Object.freeze(Object.fromEntries([
  ...REQUIRED_FIXTURES.map(id => [id, "M"]), ["rate-limit", "M"], ["unlink-response", "P"], ["unlink-survivor", "Q"],
]));
// UnregisterCommand excludes EVERY option, even false; linked devices only.
export const unlinkContract = { params: z.strictObject({}), result: z.strictObject({}) };
export const unlinkProofSchema = z.strictObject({
  method: z.literal("unregister"), params: unlinkContract.params, signalCliCommit: z.literal(SIGNAL_CLI_COMMIT),
  role: z.literal("linked-device"), device: z.literal("P"), deviceId: z.number().int().safe().min(2),
  survivorDevice: z.literal("Q"), onlyLinkedDeviceRemoved: z.literal(true), numberStillRegistered: z.literal(true),
  phoneConfirmedPeerRemoved: z.literal(true),
  fixtures: z.strictObject({ response: z.literal("unlink-response"), survivor: z.literal("unlink-survivor") }),
  observedBy: text, citation: text,
});
const captureDevices = z.strictObject({ M: z.number().int().safe().min(2), P: z.number().int().safe().min(2), Q: z.number().int().safe().min(2) })
  .refine(devices => new Set(Object.values(devices)).size === 3);
const manifestSchema = z.strictObject({
  contract: z.literal("murage-signal-g0/1.0"), capture: z.literal("live"),
  signalCliVersion: text, signalCliCommit: z.literal(SIGNAL_CLI_COMMIT), artifactSha256: sha256,
  captureDevices, unlinkProof: unlinkProofSchema.optional(),
  results: z.strictObject({ "S1-TS": z.boolean(), "S1-ECHO": z.boolean(), "S7-UNLINK": z.boolean() }),
  fixtures: z.array(z.strictObject({ id: text, path: z.string().regex(/^[A-Za-z0-9_-]+\.json$/), sha256,
    origin: z.enum(["live", "mutated"]), from: text.optional(), capturedOn: z.enum(["M", "P", "Q"]),
    captureSequence: z.number().int().safe().positive() })).min(1).max(128),
  securityInvariants: z.record(text, z.strictObject({ passed: z.boolean(), fixtures: z.array(text).min(1) })),
});
const fail = message => { throw Error(`Signal evidence: ${message}`); };
const canonical = value => JSON.stringify(value, function (_key, v) {
  return v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
export function artifactBinding(pin) {
  return hash(canonical({ signalCliCommit: SIGNAL_CLI_COMMIT, signalCliVersion: pin.signalCliVersion,
    signalNetwork: { version: pin.signalNetwork.version, sha256: pin.signalNetwork.sha256 },
    targets: Object.fromEntries(Object.entries(pin.targets).map(([target, record]) => {
      const copy = structuredClone(record);
      if (copy.integrity) delete copy.integrity.resigned;
      return [target, copy];
    })), releaseInputs: Object.fromEntries(Object.entries(pin.releaseInputs).map(([target, { url: _url, ...bytes }]) => [target, bytes])) }));
}

/** Syntax/custody check only: independent source review establishes what the
 * cited branches prove. signal-cli serialization alone proves neither discard. */
export function assertSyncEvidence(pin) {
  const proof = pin?.signalNetwork?.syncProof;
  const dependency = new RegExp(`https://github\\.com/Turasa/libsignal-service-java/blob/${SIGNAL_NETWORK_COMMIT}/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/[A-Za-z0-9_/]+\\.(?:java|kt)#L[1-9][0-9]*(?:-L[1-9][0-9]*)?\\b`);
  if (!proof || !Array.isArray(proof.sourceIdentityTrace)
      || !proof.sourceIdentityTrace.some(s => s.includes(SIGNAL_CLI_COMMIT) && /MessageEnvelope\.java:1033\b/.test(s))
      || !proof.sourceIdentityTrace.some(s => s.includes(SIGNAL_CLI_COMMIT) && /JsonMessageEnvelope\.java:50(?:-55)?\b/.test(s))) fail("S1-SYNC identity source trace is required");
  for (const field of ["authenticatedSenderDiscard", "pniEndpointDiscard"]) {
    if (typeof proof[field] !== "string" || !dependency.test(proof[field])) fail("S1-SYNC rejection requires pinned signal-network dependency source");
    if (/SignalServiceContent\.kt:(?:[0-9,-]*\b)629\b|SignalServiceContent\.kt#L629\b/.test(proof[field])) fail("S1-SYNC sender comparison is line 623, not 629");
  }
}
function boundedFile(root, name) {
  const file = join(root, name), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail("invalid fixture file");
    const bytes = Buffer.alloc(stat.size + 1);
    // A growing file cannot cause an unbounded allocation/read.
    const size = readSyncBounded(fd, bytes);
    if (size > 1024 * 1024 || size !== stat.size) fail("fixture changed while reading");
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
function readSyncBounded(fd, bytes) {
  let offset = 0, count;
  while (offset < bytes.length && (count = readSync(fd, bytes, offset, bytes.length - offset, null)) > 0) offset += count;
  return offset;
}
function checkDirectory(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid fixture directory");
    if (dirname(current) === current) break;
  }
}
const verifiedEvidence = new WeakMap();
function freezeDeep(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
export function isVerifiedSignalEvidence(verified) {
  const record = verifiedEvidence.get(verified);
  return !!record && verified.manifestBytes.equals(record.bytes) && canonical(verified.manifest) === record.manifest;
}

/** Verify exact reviewed bytes before trusting any reported capture outcome.
 * Review/replay must record each invariant; failures cannot be overridden by
 * a new manifest digest or a matching SNAPSHOT version. */
export function verifySignalEvidence(pin, fixtureRoot) {
  if (!releaseInputsSchema.safeParse(pin?.releaseInputs).success) fail("invalid reviewed release inputs");
  if (!g0Schema.safeParse(pin?.g0).success) fail("reviewed G0 binding is required");
  assertSyncEvidence(pin);
  const g0 = pin.g0;
  if (g0.signalCliVersion !== pin.signalCliVersion || g0.artifactSha256 !== artifactBinding(pin)) fail("G0 artifact binding differs from pin");
  checkDirectory(fixtureRoot);
  const bytes = boundedFile(fixtureRoot, "manifest.json");
  if (hash(bytes) !== g0.manifestSha256) fail("reviewed manifest digest mismatch");
  const parsed = manifestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!parsed.success) fail("invalid G0 manifest");
  const manifest = parsed.data;
  if (manifest.signalCliVersion !== pin.signalCliVersion || manifest.signalCliCommit !== g0.signalCliCommit
      || manifest.artifactSha256 !== g0.artifactSha256) fail("manifest implementation binding differs from pin");
  const captures = new Map();
  const ids = new Set(), paths = new Set(["manifest.json"]);
  for (const fixture of manifest.fixtures) {
    if (ids.has(fixture.id) || paths.has(fixture.path)) fail("duplicate fixture identity or path");
    ids.add(fixture.id); paths.add(fixture.path);
    const content = boundedFile(fixtureRoot, fixture.path);
    if (hash(content) !== fixture.sha256) fail("fixture hash mismatch");
    captures.set(fixture.id, JSON.parse(content.toString("utf8")));
    if (!Object.hasOwn(FIXTURE_DEVICE, fixture.id) || fixture.capturedOn !== FIXTURE_DEVICE[fixture.id]) fail("invalid capture device");
    if (fixture.origin === "mutated") {
      const parent = manifest.fixtures.find(row => row.id === fixture.from);
      if (!MUTATED_FIXTURES.includes(fixture.id) || fixture.from !== "own-note" || !parent || parent.origin !== "live"
          || fixture.capturedOn !== parent.capturedOn) fail("invalid mutated origin");
    } else if (fixture.from !== undefined || MUTATED_FIXTURES.includes(fixture.id)) fail("invalid live origin");
  }
  if (REQUIRED_FIXTURES.some(id => !ids.has(id))) fail("complete G0 fixture set is required");
  if (readdirSync(fixtureRoot).some(path => !paths.has(path))) fail("unreviewed fixture file");
  for (const [name, required] of Object.entries(invariantFixtures)) {
    const result = manifest.securityInvariants[name];
    if (!result || required.some(id => !result.fixtures.includes(id))) fail("security invariant evidence is incomplete");
  }
  for (const result of Object.values(manifest.securityInvariants)) {
    if (!result.passed || result.fixtures.some(id => !ids.has(id))) fail("fixture contradicts a security invariant");
  }
  if (!manifest.results["S1-TS"] && !manifest.results["S1-ECHO"]) fail("S1-TS or S1-ECHO success is required");
  if (manifest.results["S7-UNLINK"]) {
    const proof = manifest.unlinkProof;
    const responseRow = manifest.fixtures.find(row => row.id === "unlink-response");
    const survivorRow = manifest.fixtures.find(row => row.id === "unlink-survivor");
    if (!proof || proof.deviceId !== manifest.captureDevices.P || !responseRow || !survivorRow
        || responseRow.origin !== "live" || survivorRow.origin !== "live"
        || survivorRow.captureSequence <= responseRow.captureSequence) fail("invalid unlink binding or observation order");
    const response = captures.get("unlink-response");
    if (!z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: unlinkContract.result }).safeParse(response).success) fail("unlink response failed");
    const frame = captures.get("unlink-survivor");
    const received = frame?.params?.result ?? frame?.params;
    const ownFrame = captures.get("own-note");
    const own = ownFrame?.params?.result ?? ownFrame?.params;
    if (frame?.jsonrpc !== "2.0" || frame?.method !== "receive" || !Number.isSafeInteger(received?.envelope?.timestamp)
        || received.envelope.timestamp < 0 || received.envelope.dataMessage?.message !== "g0 still there"
        || received.envelope.syncMessage !== undefined
        || typeof own?.account !== "string" || received.account !== own.account
        || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(received.envelope.sourceUuid)
        || received.envelope.sourceUuid === own.envelope?.sourceUuid) fail("invalid unlink survivor");
  } else if (manifest.unlinkProof !== undefined || ids.has("unlink-survivor")) fail("unlink proof without success");
  const verified = Object.freeze({ manifest: freezeDeep(manifest), manifestBytes: Buffer.from(bytes) });
  verifiedEvidence.set(verified, { bytes: Buffer.from(bytes), manifest: canonical(manifest) });
  return verified;
}
export function signalEvidenceReady(pin, fixtureRoot) {
  try { verifySignalEvidence(pin, fixtureRoot); return true; } catch { return false; }
}
