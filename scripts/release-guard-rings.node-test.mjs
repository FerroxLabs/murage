// Rings B6 witnesses (designs/RINGS-DESIGN.md section 5, B6). Owner: rings BUILD lane.
//
//   node --test scripts/release-guard-rings.node-test.mjs
//
// Entry points: the guard's publishDraft (the `publish-prepared` / `publish` commands), verifyReleaseTag (the
// `verify-tag` / `body` commands) with a recorded GitHub double that behaves like GitHub for make_latest, and the
// checked-in prepare-job shell of .github/workflows/release.yml run with bash. No token, network or release is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Publication is qualified independently of Signal evidence: stub only that prerequisite, in an isolated module
// copy (as release-digests.node-test.mjs does). Production has no injectable bypass.
const guardFixture = mkdtempSync(join(tmpdir(), "murage-rings-guard-module-"));
after(() => safeWipeSync(guardFixture));
copyFileSync(join(ROOT, "scripts/release-guard.mjs"), join(guardFixture, "release-guard.mjs"));
writeFileSync(join(guardFixture, "signal-release-prerequisites.mjs"), "export function assertSignalReleaseReady() {}\n");
const { publishDraft, verifyReleaseTag } = await import(pathToFileURL(join(guardFixture, "release-guard.mjs")));

const VERSION = "1.2.3";
const TAG_SHA = "c".repeat(40);
const FILES = { "Murage-1.2.3-arm64.dmg": "signed mac bytes", "latest-mac.yml": "feed bytes" };
const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const http = (body) => ({ status: 0, stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` });

/** GitHub double for one release (id 7) and the previous latest (id 6, v1.2.2). A PATCH applies its fields the way
 * GitHub does: make_latest=true moves releases/latest to this release; prerelease is stored unless `ignorePrerelease`. */
function github({ draft = true, prerelease = false, latest = 6, ignorePrerelease = false } = {}) {
  const state = { draft, prerelease, latest, patches: [] };
  const record = () => ({ id: 7, tag_name: `v${VERSION}`, name: `Murage ${VERSION}`, draft: state.draft, prerelease: state.prerelease, immutable: false,
    assets: Object.entries(FILES).map(([name, body]) => ({ name, state: "uploaded", size: Buffer.byteLength(body), digest: sha256(body) })) });
  const run = (command, args) => {
    if (command === "git") return { status: 0, stdout: `${TAG_SHA}\trefs/tags/v${VERSION}\n` };
    const method = args[args.indexOf("--method") + 1];
    if (method === "PATCH") {
      const fields = Object.fromEntries(args.filter((a) => /^[a-z_]+=/.test(a)).map((a) => a.split("=")));
      state.patches.push(fields);
      if (fields.draft === "false") state.draft = false;
      if (fields.prerelease !== undefined && !ignorePrerelease) state.prerelease = fields.prerelease === "true";
      if (fields.make_latest === "true") state.latest = 7;
      return { status: 0, stdout: "{}" };
    }
    const endpoint = args.at(-1);
    if (endpoint.endsWith("/releases/latest")) return http(state.latest === 7 ? record() : { id: 6, tag_name: "v1.2.2", name: "Murage 1.2.2", draft: false, prerelease: false, assets: [] });
    return http(record());
  };
  return { run, state };
}

function staged() {
  const dir = mkdtempSync(join(tmpdir(), "murage-rings-assets-"));
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(dir, name), body);
  return dir;
}

test("B6(a) publish is day 0: the release goes out as a prerelease and releases/latest stays the previous release", () => {
  const gh = github(); const dir = staged();
  try { publishDraft(VERSION, 7, dir, gh.run); } finally { safeWipeSync(dir); }
  assert.equal(gh.state.latest, 6, "a shipped client or the README button would see the new release on day 0");
  assert.equal(gh.state.prerelease, true);
  assert.deepEqual(gh.state.patches, [{ draft: "false", prerelease: "true", make_latest: "false" }]);
});

test("B6(b) publish refuses to report day 0 when the published release did not become a prerelease", () => {
  const gh = github({ ignorePrerelease: true }); const dir = staged();
  try {
    assert.throws(() => publishDraft(VERSION, 7, dir, gh.run), /not a prerelease/);
  } finally { safeWipeSync(dir); }
});

test("B6(c) verifyReleaseTag accepts a published day-0 prerelease that is not latest", () => {
  const gh = github({ draft: false, prerelease: true });
  let release;
  assert.doesNotThrow(() => { release = verifyReleaseTag(VERSION, 7, gh.run); }, "a day-0 prerelease is never latest, so a latest-only check fails every ring release");
  assert.equal(release.prerelease, true);
});

test("B6(d) verifyReleaseTag refuses a prerelease that is releases/latest", () => {
  const gh = github({ draft: false, prerelease: true, latest: 7 });
  assert.throws(() => verifyReleaseTag(VERSION, 7, gh.run), /prerelease but releases\/latest/);
});

test("B6(e) a promoted release (not a prerelease) must still be releases/latest", () => {
  assert.throws(() => verifyReleaseTag(VERSION, 7, github({ draft: false, prerelease: false, latest: 6 }).run), /releases\/latest is v1\.2\.2/);
  assert.equal(verifyReleaseTag(VERSION, 7, github({ draft: false, prerelease: false, latest: 7 }).run).id, 7);
});

// The prepare job's own shell (release.yml `mode` + `pin` steps), run with bash the way the runner runs it.
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"));
function runStep(id, env) {
  const step = workflow.jobs.prepare.steps.find((s) => s.id === id);
  const dir = mkdtempSync(join(tmpdir(), "murage-rings-step-"));
  const output = join(dir, "out");
  writeFileSync(output, "");
  try {
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], { cwd: ROOT, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, ...env } });
    return { status: result.status, stderr: result.stderr + result.stdout, out: readFileSync(output, "utf8") };
  } finally { safeWipeSync(dir); }
}

test("B6(f) a ring_op run (and the scheduled resign) builds nothing: prepare reports should_release=false", () => {
  const ringRun = runStep("pin", { GITHUB_EVENT_NAME: "workflow_dispatch", RING_OP: "resign" });
  assert.equal(ringRun.status, 0, ringRun.stderr);
  assert.match(ringRun.out, /^should_release=false$/m, "every signed build job keys on should_release");
  const release = runStep("pin", { GITHUB_EVENT_NAME: "workflow_dispatch", RING_OP: "" });
  assert.match(release.out, /^should_release=true$/m);
});

test("B6(g) a ring_op run refuses publish or artifact_only, and the schedule maps to resign", () => {
  const mode = runStep("mode", { RING_OP: "halt", PUBLISH: "true", ARTIFACT_ONLY: "false", PRIVATE_REPO: "true" });
  assert.equal(mode.status, 1);
  assert.match(mode.stderr, /ring_op run builds and publishes nothing/);
  const ok = runStep("mode", { RING_OP: "resign", PUBLISH: "false", ARTIFACT_ONLY: "false", PRIVATE_REPO: "true" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.out, /^ring_op=resign$/m);
  const env = workflow.jobs.prepare.steps.find((s) => s.id === "mode").env.RING_OP;
  assert.equal(env, "${{ github.event_name == 'schedule' && 'resign' || inputs.ring_op }}");
});
