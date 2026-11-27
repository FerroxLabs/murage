// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-heldbound fixtures (owner: lane q1023-heldbound): generated key-shaped material for heldbound-1023.test.ts and
// heldbound-api-1023.test.ts. A seeded generator; no real key, token or cookie, and the PEM armour is built at run time.
export const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function fixtureChars(n: number, seed: number, alphabet = B64): string {
  let x = seed >>> 0, out = "";
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out += alphabet[(x >>> 16) % alphabet.length]; }
  return out;
}
const PEM_HEAD = "-----BEGIN " + "PRIVATE KEY-----", PEM_FOOT = "-----END " + "PRIVATE KEY-----";
export const PEM_LINES = Array.from({ length: 46 }, (_, i) => fixtureChars(64, 7001 + i));
/** A service-account JSON as a tool prints it: the PEM on ONE line (JSON-escaped line breaks), about 3 KB. */
export const SA_JSON = JSON.stringify({ type: "service_account", project_id: "fixture-project", private_key: `${PEM_HEAD}\n${PEM_LINES.join("\n")}\n${PEM_FOOT}\n`, client_email: "fixture-runner@fixture-project.example.test" }, null, 2);
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const GROUPS = Array.from({ length: 48 }, (_, i) => `fixture-group-${i}-${fixtureChars(6, 300 + i, "abcdefghijklmnopqrstuvwxyz")}`);
/** A JWT of about 2 KB (a long groups claim). */
export const JWT = [b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fixture-kid" })),
  b64url(JSON.stringify({ iss: "https://issuer.example.test", sub: "fixture-subject", aud: "fixture-audience", groups: GROUPS, exp: 4102444800 })),
  fixtureChars(342, 99, B64.slice(0, 62) + "-_")].join(".");
/** 40 characters of the key past its 512th character, as a reply would quote them. */
export const PEM_QUOTE = PEM_LINES[20]!.slice(10, 50);
export const JWT_QUOTE = JWT.slice(1200, 1240);
