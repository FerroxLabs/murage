import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
const key = createPrivateKey(readFileSync(process.env.MOCK_KEY_PEM));
const der = sign("sha256", readFileSync(process.argv[2]), { key, dsaEncoding: "der" });
process.stdout.write(JSON.stringify({ KeyId: "arn:aws:kms:eu-west-1:000000000000:key/mock", Signature: der.toString("base64"), SigningAlgorithm: "ECDSA_SHA_256" }) + "\n");
