// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const schema = z.fromJSONSchema(JSON.parse(readFileSync(new URL("./runtime-pin.schema.json", import.meta.url), "utf8")));
// @ts-expect-error Shared ESM evidence owner.
import { SIGNAL_CLI_COMMIT } from "./evidence.mjs";
const hash = "a".repeat(64);
const target = () => ({
  jars: [{ path: "lib/signal-cli.jar", sha256: hash }],
  jre: { build: "25+1", sha256: hash },
  libsignal: { version: "test-tag", sha256: hash, provenance: { kind: "upstream-jar", jar: "lib/libsignal-client.jar", entry: "native/libsignal.so" } },
});
// Synthetic contract fixture: no runtime version, hash or citation here is release evidence.
const fixture = () => ({
  contract: "murage-signal-runtime-pin/1.0",
  signalCliVersion: "0.14.11-SNAPSHOT",
  rateLimitNotSentProof: null,
  g0: null,
  signalNetwork: { coordinate: "com.github.turasa:signal-network", version: "2.15.3_unofficial_157", sha256: hash, syncProof: null },
  targets: { "darwin-arm64": target(), "win32-x64": target(), "linux-x64": target() },
});
type Fixture = ReturnType<typeof fixture>;
const cases: Array<[string, (pin: Fixture) => void]> = [
  ["T-PIN: kill missing target", pin => { Reflect.deleteProperty(pin.targets, "win32-x64"); }],
  ["T-PIN: kill unshipped target", pin => { Object.assign(pin.targets, { "linux-arm64": target() }); }],
  ["T-PIN: kill empty jar inventory", pin => { pin.targets["linux-x64"].jars = []; }],
  ["T-PIN: kill malformed jar hash", pin => { pin.targets["linux-x64"].jars[0].sha256 = "a".repeat(63); }],
  ["T-PIN: kill missing JRE hash", pin => { Reflect.deleteProperty(pin.targets["linux-x64"].jre, "sha256"); }],
  ["T-PIN: kill malformed JNI hash", pin => { pin.targets["darwin-arm64"].libsignal.sha256 = "g".repeat(64); }],
  ["T-PIN: kill unpinned version range", pin => { pin.signalCliVersion = "^0.14.11"; }],
  ["T-PIN: kill unknown pin fields", pin => { Object.assign(pin, { bypassHash: true }); }],
  ["T-PIN: kill unknown nested fields", pin => { Object.assign(pin.targets["linux-x64"].jre, { skipCheck: true }); }],
  ["T-RL-PIN: kill omitted proof gate", pin => { Reflect.deleteProperty(pin, "rateLimitNotSentProof"); }],
  ["T-RL-PIN: kill boolean proof", pin => { Object.assign(pin, { rateLimitNotSentProof: true }); }],
  ["T-PIN S1-SYNC: kill wrong dependency coordinate", pin => { pin.signalNetwork.coordinate = "com.github.turasa:libsignal-service-java"; }],
  ["T-PIN S1-SYNC: kill missing dependency hash", pin => { Reflect.deleteProperty(pin.signalNetwork, "sha256"); }],
  ["T-PIN: kill unverified activation marker", pin => { Object.assign(pin, { g0: true }); }],
];

describe("B0 runtime pin JSON Schema", () => {
  it.each(cases)("%s", (_, mutate) => {
    const pin = fixture();
    expect(schema.safeParse(pin).success).toBe(true);
    mutate(pin);
    expect(schema.safeParse(pin).success).toBe(false);
  });
  it.each(["signalCliVersion", "citation", "reviewedBy"])("T-RL-PIN: cited future proof requires %s (kill incomplete evidence)", key => {
    const proof = { signalCliVersion: "0.14.11-SNAPSHOT", citation: "Send.java:1", reviewedBy: "review.md" };
    const pin = { ...fixture(), rateLimitNotSentProof: proof };
    expect(schema.safeParse(pin).success).toBe(true);
    Reflect.deleteProperty(proof, key);
    expect(schema.safeParse(pin).success).toBe(false);
  });
  it("T-PIN: source-built JNI requires a build log (kill untraceable native binary)", () => {
    const pin = fixture();
    const provenance = { kind: "source-build", tag: "v-test", buildLog: "macos-release.log" };
    Object.assign(pin.targets["darwin-arm64"].libsignal, { provenance });
    expect(schema.safeParse(pin).success).toBe(true);
    Reflect.deleteProperty(provenance, "buildLog");
    expect(schema.safeParse(pin).success).toBe(false);
  });
  it("T-PIN S1-SYNC: proof needs both discards and the identity trace (kill empty trace)", () => {
    const pin = fixture();
    const syncProof = { authenticatedSenderDiscard: "Sender.java:1", pniEndpointDiscard: "Endpoint.java:1", sourceIdentityTrace: ["MessageEnvelope.java:1033", "JsonMessageEnvelope.java:50-55"] };
    Object.assign(pin.signalNetwork, { syncProof });
    Object.assign(pin, { g0: { signalCliVersion: pin.signalCliVersion, citation: "S1.md", signalCliCommit: SIGNAL_CLI_COMMIT, manifestSha256: hash, artifactSha256: hash, reviewedBy: "synthetic", review: "synthetic" } });
    expect(schema.safeParse(pin).success).toBe(true);
    syncProof.sourceIdentityTrace = [];
    expect(schema.safeParse(pin).success).toBe(false);
  });
  it.each(["authenticatedSenderDiscard", "pniEndpointDiscard", "sourceIdentityTrace"])("T-PIN S1-SYNC: kill missing %s", key => {
    const syncProof = { authenticatedSenderDiscard: "Sender.java:1", pniEndpointDiscard: "Endpoint.java:1", sourceIdentityTrace: ["MessageEnvelope.java:1033", "JsonMessageEnvelope.java:50-55"] };
    const pin = fixture();
    Object.assign(pin.signalNetwork, { syncProof });
    expect(schema.safeParse(pin).success).toBe(true);
    Reflect.deleteProperty(syncProof, key);
    expect(schema.safeParse(pin).success).toBe(false);
  });
});
