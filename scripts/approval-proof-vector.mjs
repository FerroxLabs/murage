// scripts/approval-proof-vector.mjs
// Writes apps/mobile/contract/approval-proof.json: the cases Swift, Java and
// the harness all read. Run once and commit the output; signatures are
// randomized, so a re-run changes the file but never its meaning. The private
// keys are generated in memory and thrown away; none is ever written.
// Run: node --experimental-strip-types scripts/approval-proof-vector.mjs
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { approvalDigest } from "../shared/approval-digest.ts";
import { proofMessage } from "../server/approval-fresh-auth.ts";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n; // P-256 group order
const card = { title: "Run a command?", subtitle: "{\"command\":\"ls\"}", tool: "Bash", summary: "ls" };
const digest = await approvalDigest("t1", "req-1", card);
// A skill request: the digest binds its displayed source, preview and sha256 (SHA-256 of the preview's UTF-8 text).
const skillPreview = "---\nname: tidy-notes\n---\nTidy my notes every Friday.\n";
const skillCard = { title: "Add a skill?", subtitle: "tidy-notes", skillRequest: { source: "Learned in a chat", preview: skillPreview, sha256: createHash("sha256").update(skillPreview).digest("hex"), name: "tidy-notes", action: "create", warnings: ["Runs a script on your computer.", "Reads files in your Notes folder."] } };
const skillDigest = await approvalDigest("t1", "req-skill", skillCard);
// A routine proposal: the digest binds the canonical JSON of its operation (object keys sorted at every depth, no spaces).
const routineCard = { title: "Add a routine?", subtitle: "Friday digest", routineRequest: { operation: { routine: { prompt: "Send me a summary", name: "Friday digest", schedule: { every: "week", day: "fri" } }, action: "create" } } };
const routineDigest = await approvalDigest("t1", "req-routine", routineCard);
const base = { v: 1, threadId: "t1", requestId: "req-1", decision: "allow", digest, nonce: "n".repeat(43), expiresAt: 1700000060000, reason: "Allow Lena: Run a command?" };
// A random-looking nonce (32 random bytes, base64url, 43 characters) and the other decision.
const second = { ...base, decision: "allow-task", nonce: randomBytes(32).toString("base64url"), reason: "Allow Lena: Run a command for this task?" };

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { privateKey, point };
}
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const der = (message, privateKey) => sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "der" });
const p1363 = (message, privateKey) => sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" });
const derInt = (n) => { let h = n.toString(16); if (h.length % 2) h = "0" + h; let b = Buffer.from(h, "hex"); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
const derSig = (r, s) => { const body = Buffer.concat([derInt(r), derInt(s)]); return Buffer.concat([Buffer.from([0x30, body.length]), body]); };
/** Sign, then force S low (<= N/2) or high (> N/2) and return DER. */
function derWithS(message, privateKey, high) {
  const raw = p1363(message, privateKey);
  const r = BigInt("0x" + raw.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + raw.subarray(32).toString("hex"));
  if ((s > N / 2n) !== high) s = N - s; // (r, N-s) is the other valid form of the same signature
  return derSig(r, s);
}

const k1 = newKey();
const k2 = newKey();
const kWrong = newKey();
const msg1 = proofMessage(base);
const msg2 = proofMessage(second);
const sigLow = derWithS(msg1, k1.privateKey, false);
const sigHigh = derWithS(msg1, k1.privateKey, true);

const accepted = [
  { name: "allow, low-S", args: base, message: msg1, publicKey: k1.point, signatureDer: b64(sigLow) },
  { name: "allow-task, random nonce", args: second, message: msg2, publicKey: k2.point, signatureDer: b64(derWithS(msg2, k2.privateKey, false)) },
  { name: "allow, high-S (accepted: Node does not normalise S; Swift and Java must not either)", args: base, message: msg1, publicKey: k1.point, signatureDer: b64(sigHigh) },
];

const tamperedMessage = msg1.slice(0, -1) + "1"; // last digit of expiresAt changed
const wrongDigestMessage = proofMessage({ ...base, digest: "b".repeat(64) });
const malformed = Buffer.from(sigLow); malformed[0] = 0x31; // SEQUENCE tag broken
const raw64 = p1363(msg1, k1.privateKey);
const gateBase = { issuedAt: base.expiresAt - 60000, submitAt: base.expiresAt - 30000, submitDigest: digest };
const failed = { status: 403, code: "fresh_auth_failed" };

// Every signature case is verified directly (expect.verify) and sent through the
// gate with the accepted[0] challenge (gate.expect).
const signatureCases = [
  { name: "wrong key", why: "valid signature, other device key", publicKey: kWrong.point, message: msg1, signatureDer: b64(sigLow), expect: { verify: false }, gate: { ...gateBase, expect: failed } },
  { name: "tampered message byte", why: "signature over a message whose last digit was changed", publicKey: k1.point, message: tamperedMessage, signatureDer: b64(sigLow), expect: { verify: false }, gate: { ...gateBase, signatureDer: b64(derWithS(tamperedMessage, k1.privateKey, false)), expect: failed } },
  { name: "malformed DER", why: "SEQUENCE tag 0x30 replaced by 0x31", publicKey: k1.point, message: msg1, signatureDer: b64(malformed), expect: { verify: false }, gate: { ...gateBase, expect: failed } },
  { name: "raw r||s, 64 bytes", why: "IEEE P1363 form is never accepted; the proof is ASN.1 DER only", publicKey: k1.point, message: msg1, signatureDer: b64(raw64), expect: { verify: false }, gate: { ...gateBase, expect: failed } },
  { name: "wrong digest", why: "signature over a message carrying a different card digest", publicKey: k1.point, message: wrongDigestMessage, signatureDer: b64(sigLow), expect: { verify: false }, gate: { ...gateBase, submitDigest: "b".repeat(64), expect: { status: 409, code: "fresh_auth_changed" } } },
  { name: "expired proof", why: "valid signature, submitted at expiresAt: the gate issues a new challenge", publicKey: k1.point, message: msg1, signatureDer: b64(sigLow), expect: { verify: true }, gate: { ...gateBase, submitAt: base.expiresAt, expect: { status: 403, code: "fresh_auth", reason: "expired" } } },
];

const bad = (code, why, over) => ({ args: { ...base, ...over }, why, expect: { code } });
const refused = [
  bad("bad_version", "unknown version", { v: 2 }),
  { ...bad("bad_decision", "decision answer is not signable", { decision: "answer" }), gate: { status: 403, code: "answer_on_computer" } },
  { ...bad("bad_digest", "digest not lowercase hex", { digest: "A".repeat(64) }), gate: failed },
  bad("bad_nonce", "nonce length", { nonce: "n".repeat(42) }),
  { ...bad("bad_thread_id", "thread id characters", { threadId: "t 1" }), gate: failed },
  { ...bad("bad_request_id", "empty request id", { requestId: "" }), gate: failed },
  { ...bad("bad_request_id", "request id with a newline (would shift the signed fields)", { requestId: "req-1\nallow" }), gate: failed },
  { ...bad("bad_thread_id", "thread id with a newline", { threadId: "t1\nt2" }), gate: failed },
  bad("bad_expiry", "fractional expiry", { expiresAt: 1.5 }),
  bad("bad_expiry", "expiry as text", { expiresAt: "1700000060000" }),
  bad("bad_reason", "empty reason", { reason: "" }),
  bad("bad_reason", "reason too long", { reason: "x".repeat(161) }),
  bad("bad_reason", "control character in reason", { reason: "line\nbreak" }),
  bad("bad_reason", "bidi override (Cf) in reason is refused, not stripped", { reason: "Allow Lena\u202e: Run a command?" }),
  bad("bad_reason", "zero-width space (Cf) in reason", { reason: "Allow Lena\u200b: Run a command?" }),
  bad("bad_reason", "byte order mark (Cf) in reason", { reason: "Allow\ufeff Lena: Run a command?" }),
  bad("bad_reason", "Arabic letter mark (Cf) in reason", { reason: "Allow Lena\u061c: Run a command?" }),
  bad("bad_reason", "astral format character (language tag U+E0001) in reason", { reason: "Allow \u{1F600} Lena\u{E0001}: Run a command?" }),
];

// ASCII only: every non-ASCII code unit is written as a \u escape, so the file reads the same in any editor.
const ascii = (text) => text.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
writeFileSync(new URL("../apps/mobile/contract/approval-proof.json", import.meta.url), ascii(JSON.stringify({
  tag: "murage-approval-proof/1",
  ttlMs: 60000,
  notes: [
    "Card digest (digestTag): SHA-256 hex of the JSON array [tag, threadId, requestId, tool, title, subtitle, summary, held, toolInputTruncated===true, approvalScope, taskAllowKey, skillRequest.source, skillRequest.preview, skillRequest.sha256, skillRequest.name, skillRequest.action, skillRequest.warnings, routineRequest.operation]; a missing or non-string field is null. skillRequest.warnings is the JSON array of its strings (null when absent or not a list of strings; an empty list is []). routineRequest.operation is its canonical JSON text: the operation re-serialised with object keys sorted at every depth, no whitespace, array order kept (null when absent). routineDigest carries a routine proposal. skillDigest carries a skill request: before signing, a phone must also check that SHA-256 of the UTF-8 preview equals skillRequest.sha256, and refuse otherwise.",
    "Signed message: UTF-8 of the tag, threadId, requestId, decision, digest, nonce and decimal expiresAt joined by LF, no trailing newline. The nonce is signed as its base64url string, never decoded.",
    "Signature: ECDSA P-256 over SHA-256 of that message, encoded as ASN.1 DER, then base64url. Public key: 65-byte uncompressed point (0x04||X||Y), base64url.",
    "High-S is ACCEPTED. The server verifies with Node crypto, which does not require low-S, and Secure Enclave and AndroidKeyStore emit either form. Swift and Java must send whatever the platform signs and must never normalise, re-encode or reject S. Swift verifiers and tests must use a verifier that accepts high-S too.",
    "Raw 64-byte r||s (IEEE P1363) is REFUSED. The platform must convert to DER before sending.",
    "threadId matches [A-Za-z0-9_-]{1,128}. requestId is 1 to 256 characters with no control character (C0, DEL, C1) and no U+2028 or U+2029; an id with a line break is refused at parse, never signed.",
    "The gate rebuilds the message from the challenge it holds, so a tampered message reaches it as gate.signatureDer, a signature over the altered bytes. args are checked by expect.code (the native parser must refuse with bad_args-class error); gate shows what the server gate returns for the same ids. signatureCases run against accepted[0]'s challenge: expect.verify is the direct verifier result; gate.expect is the outcome when issuedAt is the challenge time and submitAt the proof time.",
  ],
  digestTag: "murage-approval-digest/2",
  digest: { threadId: "t1", requestId: "req-1", card, digest },
  skillDigest: { threadId: "t1", requestId: "req-skill", card: skillCard, digest: skillDigest },
  routineDigest: { threadId: "t1", requestId: "req-routine", card: routineCard, digest: routineDigest, canonicalOperation: JSON.stringify(JSON.parse(JSON.stringify(routineCard.routineRequest.operation), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v))) },
  accepted,
  refused,
  signatureCases,
  signature: { publicKey: k1.point, message: msg1, signatureDer: b64(sigLow) },
}, null, 2)) + "\n");
