// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { startControlFeed, startFeed } from "./feed.mjs";

const scratch = [];
afterEach(() => { for (const dir of scratch.splice(0)) safeWipeSync(dir); });
const manifestFor = (bytes) => ({
  schema: "murage-canary-manifest/1", version: "1.2.3",
  assets: { "app-1.2.3.zip": { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } },
});

it("W7b normal mode refuses the tampered control; control mode refuses a real leg id and serves only for a qual probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-control-"));
  scratch.push(dir);
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-x509", "-nodes", "-days", "1", "-subj", "/CN=github.com",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const real = Buffer.from("real signed bytes");
  const tampered = Buffer.from("real signed bytes resigned");
  writeFileSync(join(dir, "app-1.2.3.zip"), tampered);
  const common = { dir, from: "1.2.2", cert: join(dir, "cert.pem"), key: join(dir, "key.pem"), log: join(dir, "feed.log") };
  await expect(startFeed({ ...common, manifest: manifestFor(real) })).rejects.toThrow("ARTIFACT_MISMATCH");
  await expect(startControlFeed({ ...common, legId: "leg-1", manifest: manifestFor(tampered) })).rejects.toThrow("CONTROL_FEED_REFUSED");
  await expect(startControlFeed({ ...common, manifest: manifestFor(tampered) })).rejects.toThrow("CONTROL_FEED_REFUSED");
  await expect(startControlFeed({ ...common, legId: "qual-s1-mac-a", manifest: manifestFor(real) })).rejects.toThrow("ARTIFACT_MISMATCH");
  const feed = await startControlFeed({ ...common, legId: "qual-s1-mac-a", manifest: manifestFor(tampered) });
  expect(feed.tlsPort).toBeGreaterThan(0);
  await feed.close();
});
