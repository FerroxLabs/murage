// scripts/phone-ask-vector.mjs
// Prints the `mint` section of apps/mobile/contract/phone-ask.json for a fresh P-256 key pair
// (pattern of phone-jobs-vector.mjs), plus the same fields under the jobs tag so the cross-purpose
// check has a jobs-tag message. Private keys live in memory only and are thrown away. The rest of
// the fixture is hand-written; paste the section in and commit the file. The fixture is never
// generated at test time.
// Run: node --experimental-strip-types scripts/phone-ask-vector.mjs
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { approvalKeyId } from "../shared/phone-jobs-hash.ts";
import { phoneJobsMessage } from "../shared/phone-jobs-contract.ts";
import { phoneAskMessage, PHONE_ASK_TAG, PHONE_ASK_TTL_MS } from "../shared/phone-ask-contract.ts";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const fields = { origin: "https://desk.example.test", keyId: approvalKeyId(point), nonce: randomBytes(32).toString("base64url"), expiresAt: 1700000060000 };
const message = phoneAskMessage(fields);
const signature = sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64url");

console.log(JSON.stringify({
  mint: {
    tag: PHONE_ASK_TAG, ttlMs: PHONE_ASK_TTL_MS,
    vector: { ...fields, message, point, signature },
    crossPurpose: { askVectorAsJobs: { message: phoneJobsMessage(fields) } },
  },
}, null, 2));
