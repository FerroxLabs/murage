// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal AWS Signature Version 4 for a single JSON POST/GET. No SDK: the Worker
// only needs to sign KMS calls. Verified against the AWS get-vanilla test vector.
const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}
async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, enc.encode(data));
}

export interface SigV4Input {
  method: string; url: string; headers: Record<string, string>; body: string;
  region: string; service: string; accessKeyId: string; secretAccessKey: string; now: Date;
}

/** Returns the full header set (including host, x-amz-date, authorization) to send. */
export async function signV4(input: SigV4Input): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20150830T123600Z
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [input.method, url.pathname || "/", query, canonicalHeaders, signedHeaders, await sha256Hex(input.body)].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  let key = await hmac(enc.encode(`AWS4${input.secretAccessKey}`), day);
  key = await hmac(key, input.region); key = await hmac(key, input.service); key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
