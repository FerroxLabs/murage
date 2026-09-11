// Release digest hold (Q1-T2, D6): a draft whose GitHub asset digest is still
// missing after the bounded wait must never be published, and verification of
// the retained draft can resume without rebuilding.
//
//   node --test scripts/release-digests.node-test.mjs
//
// The helper cases drive release-guard/release-digests with an injected GitHub
// double. The workflow cases execute the checked-in assemble step shell with
// bash and a local `gh` executable double, the way the release job runs it on
// Ubuntu, so they need a POSIX host. No token, network call or release is used.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { compareDraftAssets, publishDraft, stagedDigests, uploadDraft } from "./release-guard.mjs";
import {
  DEFAULT_DIGEST_POLL_ATTEMPTS,
  DEFAULT_DIGEST_POLL_INTERVAL_MS,
  DigestHold,
  verifyRelease,
} from "./release-digests.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = "1.2.3";
const FILES = { "Murage-1.2.3-arm64.dmg": "signed mac bytes", "latest-mac.yml": "feed bytes" };
const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Draft metadata for the staged files; `overrides` patches individual assets. */
function draftAssets(overrides = {}) {
  return Object.entries(FILES).map(([name, body]) => ({
    name,
    state: "uploaded",
    size: Buffer.byteLength(body),
    digest: sha256(body),
    ...overrides[name],
  }));
}

async function withStagedAssets(test) {
  const dir = mkdtempSync(join(tmpdir(), "murage-release-digests-"));
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(dir, name), body);
  try {
    return await test(dir);
  } finally {
    safeWipeSync(dir);
  }
}

const http = (body) => ({
  status: 0,
  stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
});

/** GitHub double: each numeric-release read returns the next metadata view. */
function github(views, { published = false, immutable = false } = {}) {
  const calls = [];
  let reads = 0;
  let patched = false;
  const run = (command, args) => {
    calls.push([command, ...args]);
    const method = args[args.indexOf("--method") + 1];
    if (method === "PATCH") {
      patched = true;
      return { status: 0, stdout: "{}" };
    }
    if (method === "POST") return { status: 0, stdout: "{}" };
    const endpoint = args.at(-1);
    if (endpoint === "repos/FerroxLabs/murage-releases") return http({ permissions: { push: true } });
    const assets = views[Math.min(reads, views.length - 1)];
    if (endpoint.endsWith("/releases/7")) reads += 1;
    return http({ id: 7, tag_name: `v${VERSION}`, draft: !(published || patched), immutable, assets });
  };
  return {
    run,
    gets: () => calls.filter((call) => call.includes("GET")),
    patches: () => calls.filter((call) => call.includes("PATCH")),
    posts: () => calls.filter((call) => call.includes("POST")),
  };
}

function recordingSleep() {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

describe("digest hold before publication", () => {
  it("holds a missing digest after the bounded wait and never publishes", () => withStagedAssets(async (dir) => {
    assert.equal(DEFAULT_DIGEST_POLL_ATTEMPTS * DEFAULT_DIGEST_POLL_INTERVAL_MS, 60_000);
    for (const pending of [{ digest: null }, { digest: undefined }, { digest: "" }]) {
      const gh = github([draftAssets({ "latest-mac.yml": pending })]);
      const { sleeps, sleep } = recordingSleep();
      await assert.rejects(
        verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: gh.run, sleep }),
        (error) => {
          assert.ok(error instanceof DigestHold, String(error));
          assert.deepEqual(error.unreported, ["latest-mac.yml"]);
          assert.match(error.message, /^HOLD: /);
          assert.match(error.message, /without rebuilding/);
          return true;
        },
      );
      assert.deepEqual(sleeps, Array(DEFAULT_DIGEST_POLL_ATTEMPTS).fill(DEFAULT_DIGEST_POLL_INTERVAL_MS));
      assert.equal(gh.gets().length, DEFAULT_DIGEST_POLL_ATTEMPTS + 1);

      assert.throws(() => publishDraft(VERSION, 7, dir, gh.run), /holding publication/);
      assert.throws(() => publishDraft(VERSION, 7, undefined, gh.run), /holding publication/);
      assert.deepEqual(gh.patches(), []);
      assert.deepEqual(gh.posts(), []);
    }
  }));

  it("verifies a digest that lands during the wait, then publishes exactly once", () => withStagedAssets(async (dir) => {
    const gh = github([draftAssets({ "latest-mac.yml": { digest: null } }), draftAssets()]);
    const { sleeps, sleep } = recordingSleep();
    const result = await verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: gh.run, sleep });
    assert.deepEqual(result, { assets: 2, polls: 1 });
    assert.deepEqual(sleeps, [DEFAULT_DIGEST_POLL_INTERVAL_MS]);
    publishDraft(VERSION, 7, dir, gh.run);
    assert.equal(gh.patches().length, 1);
  }));

  it("passes complete matching digests without waiting", () => withStagedAssets(async (dir) => {
    const gh = github([draftAssets()]);
    const { sleeps, sleep } = recordingSleep();
    assert.deepEqual(
      await verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: gh.run, sleep }),
      { assets: 2, polls: 0 },
    );
    assert.deepEqual(sleeps, []);
  }));

  it("fails a reported digest mismatch at once and refuses to publish it", () => withStagedAssets(async (dir) => {
    for (const digest of [sha256("different bytes"), "sha256:wrong", 42]) {
      const gh = github([draftAssets({ "latest-mac.yml": { digest } })]);
      const { sleeps, sleep } = recordingSleep();
      await assert.rejects(
        verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: gh.run, sleep }),
        (error) => !(error instanceof DigestHold) && /digest mismatch: latest-mac\.yml/.test(error.message),
      );
      assert.deepEqual(sleeps, []);
      assert.throws(() => publishDraft(VERSION, 7, dir, gh.run), /refusing to publish/);
      assert.deepEqual(gh.patches(), []);
    }
  }));

  it("fails missing, unexpected, duplicated and unfinished assets without waiting", () => withStagedAssets(async (dir) => {
    const cases = [
      [draftAssets().slice(0, 1), /missing: latest-mac\.yml/],
      [[...draftAssets(), { name: "stray.zip", state: "uploaded", size: 1, digest: sha256("x") }], /unexpected: stray\.zip/],
      [[...draftAssets(), draftAssets()[0]], /duplicated: Murage-1\.2\.3-arm64\.dmg/],
      [draftAssets({ "Murage-1.2.3-arm64.dmg": { state: "starter", digest: null } }), /not finished uploading: Murage-1\.2\.3-arm64\.dmg/],
    ];
    for (const [assets, pattern] of cases) {
      const gh = github([assets]);
      const { sleeps, sleep } = recordingSleep();
      await assert.rejects(
        verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: gh.run, sleep }),
        pattern,
      );
      assert.deepEqual(sleeps, []);
      assert.deepEqual(gh.patches(), []);
    }
  }));

  it("keeps published and immutable releases protected by the release guard", () => withStagedAssets(async (dir) => {
    for (const options of [{ published: true }, { immutable: true }]) {
      const gh = github([draftAssets()], options);
      await assert.rejects(
        verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: gh.run, sleep: async () => {} }),
        /published or immutable/,
      );
      assert.throws(() => publishDraft(VERSION, 7, dir, gh.run), /published or immutable/);
      assert.deepEqual(gh.patches(), []);
    }
  }));

  it("resumes against the retained draft without re-uploading or replacing a digest-pending asset", () => withStagedAssets(async (dir) => {
    const retained = github([draftAssets({ "latest-mac.yml": { digest: null } })]);
    assert.equal(uploadDraft(VERSION, dir, "unused-notes", retained.run), 7);
    assert.deepEqual(retained.posts(), []);

    const resumed = github([draftAssets({ "latest-mac.yml": { digest: null } }), draftAssets()]);
    const { sleeps, sleep } = recordingSleep();
    assert.deepEqual(
      await verifyRelease({ version: VERSION, releaseId: "7", assetsDir: dir, run: resumed.run, sleep }),
      { assets: 2, polls: 1 },
    );
    assert.deepEqual(sleeps, [DEFAULT_DIGEST_POLL_INTERVAL_MS]);

    const changed = github([draftAssets({ "latest-mac.yml": { digest: sha256("different bytes") } })]);
    assert.throws(() => uploadDraft(VERSION, dir, "unused-notes", changed.run), /differs/);
    const resized = github([draftAssets({ "latest-mac.yml": { digest: null, size: 1 } })]);
    assert.throws(() => uploadDraft(VERSION, dir, "unused-notes", resized.run), /differs/);
    assert.deepEqual([...changed.posts(), ...resized.posts()], []);
  }));

  it("derives staged digests from the exact bytes", () => withStagedAssets(async (dir) => {
    const expected = stagedDigests(dir);
    assert.deepEqual([...expected], Object.entries(FILES).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, body]) => [name, sha256(body)]));
    assert.deepEqual(compareDraftAssets(expected, draftAssets()), {
      missing: [], unexpected: [], duplicated: [], notUploaded: [], unreported: [], mismatched: [],
    });
  }));
});

describe("release workflow wiring", () => {
  const release = parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"));
  const steps = release.jobs.assemble.steps;
  const uploadIndex = steps.findIndex((step) => step.id === "upload");
  const proofIndex = steps.findIndex((step) => step.name === "Prove the draft holds the exact staged bytes");
  const publishIndex = steps.findIndex((step) => String(step.name).startsWith("Publish"));

  const GH_DOUBLE = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
const method = args[args.indexOf("--method") + 1];
if (method === "PATCH") { writeFileSync(process.env.PUBLISHED, "1"); process.exit(0); }
if (method !== "GET") process.exit(1);
const endpoint = args.at(-1);
let body;
if (endpoint === "repos/FerroxLabs/murage-releases") body = { permissions: { push: true } };
else {
  const views = JSON.parse(readFileSync(process.env.VIEWS, "utf8"));
  const reads = existsSync(process.env.READS) ? Number(readFileSync(process.env.READS, "utf8")) : 0;
  writeFileSync(process.env.READS, String(reads + 1));
  body = { id: 7, tag_name: "v${VERSION}", draft: !existsSync(process.env.PUBLISHED), immutable: false,
    assets: views[Math.min(reads, views.length - 1)] };
}
process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(body));
`;

  /** Run the proof step, then the publish step only when the proof succeeded
   *  (GitHub's default success() gate), unless `forcePublish` simulates a
   *  bypassed gate. */
  function runAssembleTail(views, { forcePublish = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "murage-release-tail-"));
    try {
      for (const sub of ["bin", "scripts", "assets"]) mkdirSync(join(dir, sub));
      for (const script of ["release-guard.mjs", "release-digests.mjs"]) {
        copyFileSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
      }
      for (const [name, body] of Object.entries(FILES)) writeFileSync(join(dir, "assets", name), body);
      writeFileSync(join(dir, "views.json"), JSON.stringify(views));
      writeFileSync(join(dir, "calls"), "");
      writeFileSync(join(dir, "bin", "gh"), GH_DOUBLE, { mode: 0o755 });
      const env = {
        PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GH_TOKEN: "test-only-not-a-token",
        VERSION,
        RELEASE_ID: "7",
        RELEASE_DIGEST_POLL_ATTEMPTS: "2",
        RELEASE_DIGEST_POLL_INTERVAL_MS: "1",
        VIEWS: join(dir, "views.json"),
        CALLS: join(dir, "calls"),
        READS: join(dir, "reads"),
        PUBLISHED: join(dir, "published"),
      };
      const exec = (step) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
        cwd: dir, env, encoding: "utf8", timeout: 30_000,
      });
      const proof = exec(steps[proofIndex]);
      const publish = proof.status === 0 || forcePublish ? exec(steps[publishIndex]) : null;
      const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return { calls, proof, publish };
    } finally {
      safeWipeSync(dir);
    }
  }

  it("proves digests after upload and before a publish step that cannot bypass the proof", () => {
    assert.ok(uploadIndex >= 0 && proofIndex > uploadIndex, "proof runs after upload");
    assert.ok(publishIndex > proofIndex, "publish runs after the proof");
    assert.equal(steps[proofIndex].run.trim(), 'node scripts/release-digests.mjs verify "$VERSION" "$RELEASE_ID" assets');
    assert.equal(steps[proofIndex]["continue-on-error"], undefined);
    assert.equal(release.jobs.assemble["continue-on-error"], undefined);
    // No always()/failure()/cancelled(): a failed proof leaves Publish skipped.
    assert.equal(steps[publishIndex].if, "${{ inputs.publish }}");
    assert.match(steps[publishIndex].run, /node scripts\/release-guard\.mjs publish "\$VERSION" "\$RELEASE_ID" assets/);
  });

  it("fails the checked-in proof step on a null digest so the release is never published", () => {
    const { calls, proof, publish } = runAssembleTail([draftAssets({ "latest-mac.yml": { digest: null } })]);
    assert.notEqual(proof.status, 0);
    assert.match(proof.stderr, /::error::HOLD: .*latest-mac\.yml/);
    assert.equal(publish, null);
    assert.equal(calls.filter((call) => call.includes("GET")).length, 3);
    assert.deepEqual(calls.filter((call) => call.includes("PATCH")), []);
  });

  it("refuses a null digest in the publish step itself even if the proof gate were bypassed", () => {
    const { calls, publish } = runAssembleTail([draftAssets({ "latest-mac.yml": { digest: null } })], { forcePublish: true });
    assert.notEqual(publish.status, 0);
    assert.match(publish.stderr, /holding publication/);
    assert.deepEqual(calls.filter((call) => call.includes("PATCH")), []);
  });

  it("fails a reported mismatch immediately without polling", () => {
    const { calls, proof, publish } = runAssembleTail([draftAssets({ "latest-mac.yml": { digest: sha256("tampered") } })]);
    assert.notEqual(proof.status, 0);
    assert.match(proof.stderr, /digest mismatch: latest-mac\.yml/);
    assert.equal(publish, null);
    assert.equal(calls.length, 1);
  });

  it("verifies complete digests and publishes exactly once", () => {
    const { calls, proof, publish } = runAssembleTail([draftAssets()]);
    assert.equal(proof.status, 0, proof.stderr);
    assert.match(proof.stdout, /all digest-verified/);
    assert.equal(publish.status, 0, publish.stderr);
    assert.match(publish.stdout, /v1\.2\.3 is live/);
    assert.equal(calls.filter((call) => call.includes("PATCH")).length, 1);
  });
});
