// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for deploy/cloud-home/staging-channel/worker.mjs: run with `node --test deploy/cloud-home/qualify/staging-channel_test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../staging-channel/worker.mjs";

const objects = new Map([
  ["cloud-home/x86_64/manifest.json", new Uint8Array([123, 125])],
  ["cloud-home/x86_64/manifest.json.sig", new Uint8Array(64).fill(7)],
  ["cloud-home/x86_64/murage-cloud-home-2.tar.gz", new Uint8Array([1, 2, 3, 4, 5])],
]);
const bucket = {
  async get(key) { const b = objects.get(key); return b ? { size: b.length, body: new Blob([b]).stream() } : null; },
  async head(key) { const b = objects.get(key); return b ? { size: b.length } : null; },
};
const call = (path, method = "GET") => worker.fetch(new Request("https://murage-staging-releases.sean-874.workers.dev" + path, { method }), { RELEASES: bucket });

test("serves the manifest, signature and archive as plain 200 bytes", async () => {
  for (const [key, bytes] of objects) {
    const res = await call("/" + key);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  }
});

test("HEAD answers the size without a body", async () => {
  const res = await call("/cloud-home/x86_64/murage-cloud-home-2.tar.gz", "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "5");
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test("a missing object, another path, another arch, a query or a doubled slash is 404", async () => {
  for (const path of ["/cloud-home/aarch64/manifest.json", "/cloud-home/x86_64/other.bin", "/cloud-home/x86_64/manifest.json?x=1", "/cloud-home/arm64/manifest.json",
    "/cloud-home/x86_64/manifest.json/", "/cloud-home/x86_64//manifest.json", "/", "/cloud-home/x86_64/murage-cloud-home-0.tar.gz", "/cloud-home/x86_64/murage-cloud-home-2.tar.gz/"]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
  }
});

test("writes are refused", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await call("/cloud-home/x86_64/manifest.json", method)).status, 405);
});

test("the staging image pin names this Worker's channel, and the config binds the bucket", () => {
  const check = readFileSync(new URL("../image-release-check.sh", import.meta.url), "utf8");
  assert.match(check, /^RELEASE_CHANNEL_URL_staging="https:\/\/murage-staging-releases\.sean-874\.workers\.dev\/cloud-home"$/m);
  assert.match(check, /^RELEASE_CHANNEL_URL_prod="https:\/\/releases\.murage\.ai\/cloud-home"$/m);
  const cfg = readFileSync(new URL("../staging-channel/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"binding": "RELEASES"/);
  assert.doesNotMatch(cfg, /releases\.murage\.ai/);
});

test("the prod channel Worker is the staging code under a prod header, bound to releases.murage.ai on the production account", () => {
  const code = (f) => readFileSync(new URL(`../${f}/worker.mjs`, import.meta.url), "utf8").split("const NAME")[1];
  assert.ok(code("prod-channel"));
  assert.equal(code("prod-channel"), code("staging-channel"));
  const cfg = readFileSync(new URL("../prod-channel/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"account_id": "b83123326a4b9ad76831b9cb9365b33b"/);
  assert.match(cfg, /"pattern": "releases\.murage\.ai", "custom_domain": true/);
  assert.match(cfg, /"workers_dev": false/);
  assert.match(cfg, /"bucket_name": "murage-prod-releases"/);
  assert.doesNotMatch(cfg, /874fe1689a53e6f56ff74816a9f23b26|staging/);
});
