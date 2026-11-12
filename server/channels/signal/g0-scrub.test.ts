// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
// @ts-expect-error Shared evidence owner.
import { SIGNAL_CLI_COMMIT } from "./evidence.mjs";
function scrub(frames: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "signal-scrub-"));
  try {
    writeFileSync(join(root, "in.jsonl"), frames.map(f => JSON.stringify(f)).join("\n"));
    const result = spawnSync("python3", ["g0/scrub.py", join(root, "in.jsonl"), join(root, "out.json")], { encoding: "utf8" });
    return { ...result, output: existsSync(join(root, "out.json")) ? readFileSync(join(root, "out.json"), "utf8") : "" };
  } finally { removeTempDirSync(root); }
}
const uuid = "ca112233-1234-4123-8123-123456789abc";
const env = () => ({ source: "+447700900123", sourceNumber: "+447700900123", sourceUuid: uuid, sourceName: "Jo", sourceDevice: 3,
  timestamp: 1830000000010, serverReceivedTimestamp: 1830000000020, serverDeliveredTimestamp: 1830000000030,
  syncMessage: { sentMessage: { destination: "+447700900123", destinationNumber: "+447700900123", destinationUuid: "PNI:" + uuid,
    timestamp: 1830000000000, message: "abc", expiresInSeconds: 60 } } });
test("T-SCRUB-IDENTITY-TIME: valid consistent ACI/PNI, numbers and relative timestamps", () => {
  const input = { jsonrpc: "2.0", method: "receive", params: { account: "+447700900123", envelope: env() } };
  const r = scrub([input, input]); expect(r.status, r.stderr).toBe(0);
  const frames = JSON.parse(r.output), e = frames[0].params.envelope;
  expect(e.sourceUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(e.sourceNumber).toMatch(/^\+1555[0-9]{7}$/);
  expect(e.source).toBe(e.sourceNumber); expect(e.sourceNumber).toBe(frames[0].params.account);
  expect(e.syncMessage.sentMessage.destinationUuid).toMatch(/^PNI:/);
  expect(e.syncMessage.sentMessage.destinationUuid.slice(4)).not.toBe(e.sourceUuid);
  expect(e.timestamp - e.syncMessage.sentMessage.timestamp).toBe(10);
  expect(e.serverDeliveredTimestamp - e.timestamp).toBe(20);
  expect(e.timestamp).not.toBe(input.params.envelope.timestamp);
  expect(frames[0]).toEqual(frames[1]);
  for (const secret of [uuid, "+447700900123", "Jo", '"abc"']) expect(r.output).not.toContain(secret);
});
test("T-SCRUB-ADVERSARIAL: unknown keys/values and unrestricted safe fields never publish", () => {
  const raw = (change: (value: any) => void) => {
    const value: any = { jsonrpc: "2.0", method: "receive", params: { account: "+447700900123", envelope: env() } };
    change(value); return value;
  };
  for (const input of [
    raw(v => { v.params.envelope.xy = "ok"; }),
    raw(v => { v.params.envelope.profileKey = "xy"; }),
    raw(v => { v.params.envelope.syncMessage.sentMessage.attachments = [{ contentType: "xy" }]; }),
    raw(v => { v.params.envelope.syncMessage.sentMessage.attachments = [{ contentType: "image/png", key: "xy", path: "/a/b" }]; }),
    raw(v => { v.method = "/a/b"; }),
    raw(v => { v.params.envelope.syncMessage.sentMessage.xy = "Jo"; }),
    { tinySecret: "xy" }, { xy: "ok" }, { jsonrpc: "xy" }, { method: "/a/b" },
    { version: "Jo" }, { type: "xy" }, { contentType: "xy" }, { id: "sgnl://linkdevice?uuid=xy&pub_key=key" },
    { attachments: [{ key: "xy", path: "/a/b", filename: "Jo" }] },
  ]) {
    const r = scrub([input]); expect(r.status).not.toBe(0); expect(r.output).toBe("");
    for (const secret of ["xy", "/a/b", "Jo", "pub_key=key"]) expect(r.stderr + r.stdout).not.toContain(secret);
  }
});
test("T-SCRUB-LINK-ATTACHMENT: link secrets, filenames, captions and attachment ids replaced", () => {
  const e: any = env(); e.syncMessage.sentMessage.attachments = [{ contentType: "image/png", filename: "/Jo/xy", id: "xy", size: 12,
    width: 1, height: 2, caption: "Jo", uploadTimestamp: 1830000000001, isVoiceNote: false }];
  const r = scrub([{ jsonrpc: "2.0", id: "xy", result: { deviceLinkUri: "sgnl://linkdevice?uuid=xy&pub_key=key" } },
    { jsonrpc: "2.0", method: "receive", params: { account: "+447700900123", envelope: e } }]);
  expect(r.status, r.stderr).toBe(0);
  for (const secret of ["xy", "/Jo/", '"Jo"', "pub_key=key"]) expect(r.output).not.toContain(secret);
  expect(JSON.parse(r.output)[0].result.deviceLinkUri).toMatch(/^sgnl:\/\/linkdevice\?/);
});

test("T-SCRUB-BUNDLE-REVIEW: identities/timing span files; review covers every exact artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "signal-bundle-"));
  try {
    const raw = join(root, "raw"), staged = join(root, "staged"), review = join(root, "review.json");
    mkdirSync(raw);
    const frame = (offset: number) => { const e = env(); e.timestamp += offset;
      return { jsonrpc: "2.0", method: "receive", params: { account: "+447700900123", envelope: e } }; };
    writeFileSync(join(raw, "own-note.json"), JSON.stringify(frame(0)));
    writeFileSync(join(raw, "desktop-note.json"), JSON.stringify(frame(50)));
    const run = (...args: string[]) => spawnSync("python3", ["g0/scrub.py", ...args], { encoding: "utf8" });
    expect(run("--bundle", raw, staged).status).toBe(0);
    const own = JSON.parse(readFileSync(join(staged, "own-note.json"), "utf8")).params.envelope;
    const other = JSON.parse(readFileSync(join(staged, "desktop-note.json"), "utf8")).params.envelope;
    expect(own.sourceUuid).toBe(other.sourceUuid); expect(other.timestamp - own.timestamp).toBe(50);
    const artifacts = Object.fromEntries(readdirSync(staged).map(name => [name, createHash("sha256").update(readFileSync(join(staged, name))).digest("hex")]));
    const attestation = { reviewer: "synthetic-test", signalCliCommit: SIGNAL_CLI_COMMIT, artifacts };
    writeFileSync(review, JSON.stringify(attestation)); expect(run("--review", staged, review).status).toBe(0);
    writeFileSync(join(staged, "unexpected.txt"), "xy"); expect(run("--review", staged, review).status).not.toBe(0);
    rmSync(join(staged, "unexpected.txt"));
    writeFileSync(join(staged, "own-note.json"), "{}"); expect(run("--review", staged, review).status).not.toBe(0);
    expect(run("--bundle", raw, staged).status).not.toBe(0);
    writeFileSync(join(raw, "unexpected.txt"), "xy");
    expect(run("--bundle", raw, join(root, "failed")).status).not.toBe(0);
    expect(existsSync(join(root, "failed"))).toBe(false);
  } finally { removeTempDirSync(root); }
});
