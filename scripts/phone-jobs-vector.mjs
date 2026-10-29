// scripts/phone-jobs-vector.mjs
// Prints the `keyId` and `mint` sections of apps/mobile/contract/phone-jobs.json for a fresh
// P-256 key pair (pattern of approval-proof-vector.mjs). Private keys live in memory only and
// are thrown away. The rest of the fixture (registration, job, push) is hand-written; paste
// these two sections in and commit the file. The fixture is never generated at test time.
// Run: node --experimental-strip-types scripts/phone-jobs-vector.mjs
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { approvalKeyId } from "../shared/phone-jobs-hash.ts";
import { phoneJobsMessage, PHONE_JOBS_TAG, PHONE_JOBS_TTL_MS } from "../shared/phone-jobs-contract.ts";

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { privateKey, point };
}

const k1 = newKey();
const k2 = newKey();
const vectors = [k1, k2].map((k) => ({ point: k.point, keyId: approvalKeyId(k.point) }));
// The wrong value an implementation must refuse to match: SHA-256 of the base64url STRING.
const notKeyId = Object.fromEntries([k1, k2].map((k) => [k.point, createHash("sha256").update(k.point, "utf8").digest("base64url")]));

const fields = { origin: "https://desk.example.test", keyId: vectors[0].keyId, nonce: randomBytes(32).toString("base64url"), expiresAt: 1700000060000 };
const message = phoneJobsMessage(fields);
const signature = sign("sha256", Buffer.from(message, "utf8"), { key: k1.privateKey, dsaEncoding: "der" }).toString("base64url");

console.log(JSON.stringify({
  keyId: { vectors, notKeyId },
  mint: { tag: PHONE_JOBS_TAG, ttlMs: PHONE_JOBS_TTL_MS, vector: { ...fields, message, point: k1.point, signature } },
}, null, 2));
