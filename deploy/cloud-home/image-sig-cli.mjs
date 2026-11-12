// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin command line over ./image-sig.mjs (the Worker's own module, copied verbatim) for sign-image.sh.
// It builds the payload with the Worker's buildPayload, converts the signature with the Worker's derToP1363 and
// b64urlEncode, and validates the build host image the same way the Worker does. No network, no secrets, no key files.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildPayload, derToP1363, b64urlEncode, imageSizeText, validImageId, validCreatedAt,
  TRUSTED_IMAGE_KEY_FPS, IMAGE_SIG_VERSION,
} from "./image-sig.mjs";

/** The public half of the KMS key alias/murage-image-verify (SPKI DER, base64). Its sha256 must be a trusted fingerprint. */
export const KMS_SPKI_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEO3QlvKOqz6qpRt7k/lc8IJgxhtxiwkk+jvwwn28fT4OV+bi/v5WP+5AAuM7OhyLJoNkvuDXPXcecqP/LNl18aA==";
export const VERIFIED_BY = "hz-live-rescue";

const die = (m) => { process.stderr.write(`sign-image: ${m}\n`); process.exit(1); };
const readStdin = () => readFileSync(0, "utf8");

const fpOf = (spkiB64) => createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("hex");
export function keyFp() {
  return fpOf(KMS_SPKI_B64);
}

/** The key the signature must verify against. Only a --dry-run (sign-image.sh sets MURAGE_DRYRUN=1 for it alone) may swap in a throwaway test key. */
function trust(opts = {}) {
  const dry = process.env.MURAGE_DRYRUN === "1" && process.env.MURAGE_DRYRUN_SPKI_B64;
  const spkiB64 = opts.spkiB64 ?? (dry ? process.env.MURAGE_DRYRUN_SPKI_B64 : KMS_SPKI_B64);
  const trustedFps = opts.trustedFps ?? (dry ? [fpOf(spkiB64)] : TRUSTED_IMAGE_KEY_FPS);
  return { spkiB64, trustedFps, fp: fpOf(spkiB64) };
}

/** Eligibility of the build host image (response of GET /images/N) for env. Returns the fields the signer needs. */
export function checkImage(json, imageId, env) {
  if (env !== "staging" && env !== "prod") throw new Error("env");
  if (!validImageId(imageId)) throw new Error("image id");
  const im = JSON.parse(json)?.image;
  if (!im || typeof im !== "object") throw new Error("no image object");
  const labels = im.labels && typeof im.labels === "object" ? im.labels : {};
  const desc = typeof im.description === "string" ? im.description : "";
  if (String(im.id) !== imageId) throw new Error("image id differs from the one asked for");
  if (im.type !== "snapshot") throw new Error("not a snapshot");
  if (im.status !== "available") throw new Error("status is not available");
  if (im.deleted !== null && im.deleted !== undefined) throw new Error("image is deleted");
  if (!desc.startsWith("mcq-home-") || labels["murage/role"] !== "image") throw new Error("not a Murage home image");
  if (labels["murage/env"] !== env) throw new Error(`image label murage/env is not ${env}`);
  if (labels["murage/image-kind"] === "staging-ops-ssh" || desc.endsWith("-stagingssh")) throw new Error("staging ops image");
  const size = imageSizeText(im.image_size);
  if (size === null) throw new Error("image_size is not a usable number");
  if (!validCreatedAt(im.created)) throw new Error("created is not an accepted timestamp");
  if (im.architecture !== "x86" && im.architecture !== "arm") throw new Error("unknown architecture");
  const disk = im.disk_size;
  if (typeof disk !== "number" || !Number.isFinite(disk) || disk < 1 || disk > 100000) throw new Error("disk_size");
  return { id: imageId, created: im.created, size, type: im.type, status: im.status, arch: im.architecture, disk };
}

/** Cheapest non-deprecated server type of the architecture with a disk that fits the image, priced at location. */
export function pickType(json, arch, disk, location) {
  const types = JSON.parse(json).server_types;
  if (!Array.isArray(types)) throw new Error("no server_types");
  const want = arch === "arm" ? "arm" : "x86";
  let best = null;
  for (const t of types) {
    if (t.architecture !== want || (t.deprecation ?? null) !== null || t.disk < disk) continue;
    // A type can be retired in one location only (cpx11 in fsn1/nbg1/hel1 since 2026-01-01); creating it there answers 422.
    const loc = (t.locations || []).find((l) => l.name === location);
    if (loc && (loc.deprecation ?? null) !== null) continue;
    const price = (t.prices || []).find((p) => p.location === location);
    const hourly = price ? Number(price.price_hourly?.gross) : NaN;
    if (!Number.isFinite(hourly)) continue;
    if (!best || hourly < best.hourly || (hourly === best.hourly && t.name < best.name)) best = { name: t.name, hourly };
  }
  if (!best) throw new Error("no server type fits");
  return best.name;
}

/** One line per server of a GET /servers listing: id, name, murage/verify-run label (or "-"). */
export function listServers(json) {
  const servers = JSON.parse(json).servers;
  if (!Array.isArray(servers)) throw new Error("no servers array");
  return servers.map((s) => [String(s.id), String(s.name), String((s.labels || {})["murage/verify-run"] ?? "-")].join("\t"));
}

export function jget(json, path) {
  let v = JSON.parse(json);
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object" || !(part in v)) throw new Error(`no ${path}`);
    v = v[part];
  }
  if (v === null || typeof v === "object") throw new Error(`${path} is not a scalar`);
  return String(v);
}

/** Rebuild the payload from its own parsed members; the bytes must be identical (a template, not a re-serialisation). */
export function revalidatePayload(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\n")) throw new Error("payload has a newline");
  const o = JSON.parse(text);
  if (Object.keys(o).join(",") !== "v,image_id,created_at,image_size,env,check_sha256,verdict,verified_at") throw new Error("payload members");
  if (o.v !== IMAGE_SIG_VERSION) throw new Error("payload version");
  const rebuilt = buildPayload({ imageId: o.image_id, createdAt: o.created_at, imageSize: o.image_size, env: o.env, checkSha256: o.check_sha256, verdict: o.verdict, verifiedAt: o.verified_at });
  if (rebuilt !== text) throw new Error("payload differs from the Worker template");
  return o;
}

/** DER signature (base64, as `aws kms sign` prints it) to the stored form: base64url of the 64-byte r||s. */
export function derB64ToSig(derB64) {
  return b64urlEncode(derToP1363(Buffer.from(derB64, "base64")));
}

/** Self-verify then build the imageKinds entry. kmsJson is the `aws kms sign --output json` text. */
export function buildEntry(payloadBytes, kmsJson, checkVersion, opts = {}) {
  const o = revalidatePayload(payloadBytes);
  if (!/^[1-9][0-9]{0,3}$/.test(checkVersion)) throw new Error("check version");
  const { spkiB64, trustedFps, fp } = trust(opts);
  if (!trustedFps.includes(fp)) throw new Error("pinned KMS public key is not in TRUSTED_IMAGE_KEY_FPS");
  const kms = JSON.parse(kmsJson);
  if (typeof kms.Signature !== "string") throw new Error("kms response has no Signature");
  if (kms.SigningAlgorithm !== undefined && kms.SigningAlgorithm !== "ECDSA_SHA_256") throw new Error("kms signing algorithm");
  const raw = derToP1363(Buffer.from(kms.Signature, "base64"));
  const pub = createPublicKey({ key: Buffer.from(spkiB64, "base64"), format: "der", type: "spki" });
  if (!verify("sha256", Buffer.from(payloadBytes), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(raw))) throw new Error("signature does not verify against the pinned public key");
  return {
    kind: "customer", verifiedBy: VERIFIED_BY, checkVersion, verifiedAt: o.verified_at, createdAt: o.created_at,
    imageSize: o.image_size, env: o.env, checkSha256: o.check_sha256, verdict: "pass", keyFp: fp, sig: b64urlEncode(raw),
  };
}

function main(argv) {
  const [cmd, ...a] = argv;
  try {
    switch (cmd) {
      case "check-image": { // ID ENV < image json ; prints one tab line: id created size type status arch disk
        const r = checkImage(readStdin(), a[0], a[1]);
        process.stdout.write([r.id, r.created, r.size, r.type, r.status, r.arch, r.disk].join("\t") + "\n");
        break;
      }
      case "pick-type": process.stdout.write(pickType(readStdin(), a[0], Number(a[1]), a[2]) + "\n"); break;
      case "list-servers": { const rows = listServers(readStdin()); if (rows.length) process.stdout.write(rows.join("\n") + "\n"); break; }
      case "uuid": process.stdout.write(globalThis.crypto.randomUUID() + "\n"); break;
      case "jget": process.stdout.write(jget(readStdin(), a[0]) + "\n"); break;
      case "payload": { // IMAGE_ID CREATED_AT IMAGE_SIZE ENV CHECK_SHA256 VERIFIED_AT
        const [imageId, createdAt, imageSize, env, checkSha256, verifiedAt] = a;
        process.stdout.write(buildPayload({ imageId, createdAt, imageSize, env, checkSha256, verdict: "pass", verifiedAt }));
        break;
      }
      case "entry": { // PAYLOAD_FILE KMS_JSON_FILE CHECK_VERSION ; prints the imageKinds[id] JSON
        const payload = readFileSync(a[0]);
        const entry = buildEntry(payload, readFileSync(a[1], "utf8"), a[2]);
        process.stdout.write(JSON.stringify(entry) + "\n");
        break;
      }
      case "der-to-sig": process.stdout.write(derB64ToSig(readStdin().trim()) + "\n"); break;
      case "key-fp": process.stdout.write(keyFp() + "\n"); break;
      default: die("usage: image-sig-cli.mjs check-image|pick-type|list-servers|uuid|jget|payload|entry|der-to-sig|key-fp");
    }
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
