import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MANIFEST_SCHEMA = "murage-canary-manifest/1";
const VERDICT_SCHEMA = "murage-canary/2";
const DAY_MS = 24 * 60 * 60 * 1000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function canonical(value) {
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function manifestSha256(manifest) {
  if (!isRecord(manifest)) throw new Error("INVALID_MANIFEST");
  const { schema, version, run_id, run_attempt, release_id, commit, assets } = manifest;
  if (Object.keys(manifest).length !== 7 || schema !== MANIFEST_SCHEMA ||
      typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ||
      ![run_id, run_attempt, release_id].every((id) => Number.isSafeInteger(id) && id > 0) ||
      typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit) ||
      !isRecord(assets) || Object.keys(assets).length === 0) {
    throw new Error("INVALID_MANIFEST");
  }
  for (const [name, asset] of Object.entries(assets)) {
    if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f]/.test(name) ||
        !isRecord(asset) || Object.keys(asset).length !== 2 ||
        typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error("INVALID_MANIFEST_ASSET");
    }
  }
  return digest(canonical(manifest));
}

export function phaseVerdict({ phase, manifest, manifest_sha256, requiredLegs, legs, finished }) {
  if (!["pre", "post", "latest"].includes(phase)) throw new Error("PHASE_MISMATCH");
  if (manifestSha256(manifest) !== manifest_sha256) throw new Error("MANIFEST_MISMATCH");
  if (!Array.isArray(requiredLegs) || requiredLegs.length === 0 ||
      requiredLegs.some((machine) => typeof machine !== "string" || !machine) ||
      new Set(requiredLegs).size !== requiredLegs.length || !Array.isArray(legs)) {
    throw new Error("INVALID_LEG_MATRIX");
  }
  const counted = new Map();
  for (const leg of legs) {
    if (leg?.manifest_sha256 !== manifest_sha256) throw new Error("LEG_MANIFEST_MISMATCH");
    if (typeof leg.machine !== "string" || !leg.machine || counted.has(leg.machine) ||
        !["PASS", "FAIL", "INCOMPLETE"].includes(leg.verdict)) {
      throw new Error("INVALID_LEG_RESULT");
    }
    counted.set(leg.machine, leg.verdict);
  }
  let verdict = "INCOMPLETE";
  if (legs.some((leg) => leg.verdict === "FAIL")) verdict = "FAIL";
  else if (requiredLegs.every((machine) => counted.get(machine) === "PASS")) verdict = "PASS";
  return {
    schema: VERDICT_SCHEMA, phase, version: manifest.version, release_id: manifest.release_id,
    release_run: { id: manifest.run_id, attempt: manifest.run_attempt, commit: manifest.commit },
    manifest, manifest_sha256, legs, finished, verdict,
  };
}

function inside(root, path) {
  const subpath = relative(root, path);
  return subpath !== "" && subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
}

async function readVerdict(evidenceDir, root, input) {
  const path = resolve(evidenceDir, input);
  if (!inside(evidenceDir, path) && !inside(root, path)) throw new Error("EVIDENCE_PATH");
  const real = await realpath(path);
  if (!inside(root, real) || !(await stat(real)).isFile()) throw new Error("EVIDENCE_PATH");
  const bytes = await readFile(real);
  return { verdict: JSON.parse(bytes.toString("utf8")), sha256: digest(bytes) };
}

function verifyPhase(verdict, phase, requiredLegs, now) {
  if (verdict?.phase !== phase) throw new Error("PHASE_MISMATCH");
  const computed = phaseVerdict({ ...verdict, requiredLegs });
  if (verdict.schema !== VERDICT_SCHEMA || verdict.verdict !== "PASS" || computed.verdict !== "PASS") {
    throw new Error("PHASE_NOT_PASS");
  }
  if (verdict.release_id !== computed.release_id || verdict.version !== computed.version ||
      verdict.release_run?.id !== computed.release_run.id ||
      verdict.release_run?.attempt !== computed.release_run.attempt ||
      verdict.release_run?.commit !== computed.release_run.commit) {
    throw new Error("RELEASE_MISMATCH");
  }
  const fresh = (value) => {
    const age = now - Date.parse(value);
    return age >= 0 && age < DAY_MS;
  };
  if ((phase === "post" && !fresh(verdict.finished)) ||
      !verdict.legs.filter((leg) => requiredLegs.includes(leg.machine)).every((leg) => fresh(leg.finished))) {
    throw new Error("EVIDENCE_STALE");
  }
}

export async function verifyFlipEvidence({
  evidenceDir, prePath, postPath, requiredPre, requiredPost, readCurrentDraft, now = Date.now(),
}) {
  const directory = resolve(evidenceDir);
  const root = await realpath(directory);
  const pre = await readVerdict(directory, root, prePath);
  const post = await readVerdict(directory, root, postPath);
  verifyPhase(pre.verdict, "pre", requiredPre, now);
  verifyPhase(post.verdict, "post", requiredPost, now);
  const { manifest, manifest_sha256 } = post.verdict;
  if (pre.verdict.manifest_sha256 !== manifest_sha256) throw new Error("MANIFEST_MISMATCH");

  const current = await readCurrentDraft(manifest.release_id);
  if (current?.draft !== true) throw new Error("DRAFT_MANIFEST_MISMATCH");
  const { release_id, version, commit, assets } = current;
  const rebuilt = { ...manifest, release_id, version, commit, assets };
  if (manifestSha256(rebuilt) !== manifest_sha256) throw new Error("DRAFT_MANIFEST_MISMATCH");
  return { manifest_sha256, pre_sha256: pre.sha256, post_sha256: post.sha256 };
}
