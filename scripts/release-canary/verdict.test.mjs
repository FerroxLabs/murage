import { createHash } from "node:crypto";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { manifestSha256, phaseVerdict, verifyFlipEvidence } from "./verdict.mjs";

const now = Date.parse("2026-01-02T00:00:00Z");
const finished = new Date(now - 1000).toISOString();
const requiredLegs = ["leg-a", "leg-b"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const manifest = {
  schema: "murage-canary-manifest/1",
  version: "1.2.3",
  release_id: 7,
  run_id: 11,
  run_attempt: 1,
  commit: "a".repeat(40),
  assets: {
    "package.zip": { sha256: sha("asset-a"), size: 7 },
    "feed.yml": { sha256: sha("feed"), size: 4 },
  },
};
const repaired = { ...manifest, assets: { ...manifest.assets, "package.zip": { sha256: sha("asset-b"), size: 7 } } };
const temp = [];
afterEach(async () => {
  for (const path of temp.splice(0)) await removeTempDir(path);
});

function phase(phase, input = manifest) {
  const manifest_sha256 = manifestSha256(input);
  const legs = requiredLegs.map((machine) => ({ machine, manifest_sha256, verdict: "PASS", finished }));
  return phaseVerdict({ phase, manifest: input, manifest_sha256, requiredLegs, legs, finished });
}

async function evidence(pre = phase("pre"), post = phase("post"), current = manifest) {
  const evidenceDir = await mkdtemp(join(tmpdir(), "canary-evidence-"));
  temp.push(evidenceDir);
  const prePath = join(evidenceDir, "pre.json");
  const postPath = join(evidenceDir, "post.json");
  await writeFile(prePath, JSON.stringify(pre));
  await writeFile(postPath, JSON.stringify(post));
  const args = { evidenceDir, prePath, postPath, requiredPre: requiredLegs, requiredPost: requiredLegs, now };
  const readCurrentDraft = async (id) => {
    expect(id).toBe(manifest.release_id);
    const { release_id, version, commit, assets } = current;
    return { draft: true, release_id, version, commit, assets };
  };
  return { ...args, readCurrentDraft };
}

test("canonical manifest hash is stable across nested key order and binds every asset", () => {
  const canonical = JSON.stringify({
    assets: {
      "feed.yml": { sha256: sha("feed"), size: 4 },
      "package.zip": { sha256: sha("asset-a"), size: 7 },
    },
    commit: manifest.commit, release_id: 7, run_attempt: 1, run_id: 11, schema: manifest.schema, version: "1.2.3",
  });
  expect(manifestSha256(manifest)).toBe(sha(canonical));
  expect(manifestSha256(repaired)).not.toBe(sha(canonical));
});

test("W7b accepts matching PRE and POST and hashes the exact evidence files", async () => {
  const pre = phase("pre");
  const post = phase("post");
  expect(await verifyFlipEvidence(await evidence(pre, post))).toEqual({
    manifest_sha256: manifestSha256(manifest),
    pre_sha256: sha(JSON.stringify(pre)),
    post_sha256: sha(JSON.stringify(post)),
  });
});

test("W7b refuses valid PRE A plus valid POST B even when the current draft is B", async () => {
  await expect(verifyFlipEvidence(await evidence(phase("pre"), phase("post", repaired), repaired)))
    .rejects.toThrow("MANIFEST_MISMATCH");
});

test.each([["pre", "pre"], ["post", "post"], ["post", "pre"]])("W7b refuses %s followed by %s", async (a, b) => {
  await expect(verifyFlipEvidence(await evidence(phase(a), phase(b)))).rejects.toThrow("PHASE_MISMATCH");
});

test("W7b re-reads a same-id same-size repaired draft at the flip boundary", async () => {
  const args = await evidence();
  const changed = await evidence(phase("pre"), phase("post"), repaired);
  let current = args.readCurrentDraft;
  const check = () => verifyFlipEvidence({ ...args, readCurrentDraft: (id) => current(id) });
  await expect(check()).resolves.toBeDefined();
  current = changed.readCurrentDraft;
  await expect(check()).rejects.toThrow("DRAFT_MANIFEST_MISMATCH");
});

test("W7b checks every counted leg, including a resumed leg", async () => {
  const post = phase("post");
  post.legs[1] = { ...post.legs[1], attempt: 2, manifest_sha256: manifestSha256(repaired) };
  await expect(verifyFlipEvidence(await evidence(phase("pre"), post))).rejects.toThrow("LEG_MANIFEST_MISMATCH");
  expect(() => phaseVerdict({ ...post, requiredLegs })).toThrow("LEG_MANIFEST_MISMATCH");
});

test("phase pin rejects replacing the manifest on resume", () => {
  expect(() => phaseVerdict({ ...phase("post"), manifest: repaired, requiredLegs })).toThrow("MANIFEST_MISMATCH");
});

test("W7b rejects changed embedded manifest and separate run metadata", async () => {
  const post = phase("post");
  const edited = { ...post, manifest: repaired };
  await expect(verifyFlipEvidence(await evidence(phase("pre"), edited))).rejects.toThrow("MANIFEST_MISMATCH");
  const otherRun = { ...post, release_run: { ...post.release_run, attempt: 2 } };
  await expect(verifyFlipEvidence(await evidence(phase("pre"), otherRun))).rejects.toThrow("RELEASE_MISMATCH");
});

test("W7b checks required legs, draft state and POST leg age", async () => {
  const post = phase("post");
  await expect(verifyFlipEvidence(await evidence(phase("pre"), { ...post, legs: post.legs.slice(0, 1) })))
    .rejects.toThrow("PHASE_NOT_PASS");
  post.legs[1] = { ...post.legs[1], finished: "2026-01-01T00:00:00Z" };
  await expect(verifyFlipEvidence(await evidence(phase("pre"), post))).rejects.toThrow("EVIDENCE_STALE");
  const args = await evidence();
  const readCurrentDraft = async (id) => ({ ...await args.readCurrentDraft(id), draft: false });
  await expect(verifyFlipEvidence({ ...args, readCurrentDraft })).rejects.toThrow("DRAFT_MANIFEST_MISMATCH");
});

test("W7b confines verdict input to the evidence directory including symlinks", async () => {
  const args = await evidence();
  const outside = await evidence();
  await expect(verifyFlipEvidence({ ...args, prePath: outside.prePath })).rejects.toThrow("EVIDENCE_PATH");
  const link = join(args.evidenceDir, "alias");
  await symlink(outside.evidenceDir, link, "junction");
  await expect(verifyFlipEvidence({ ...args, prePath: join(link, "pre.json") })).rejects.toThrow("EVIDENCE_PATH");
});
