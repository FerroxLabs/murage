#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Operator script: create the PRODUCTION control-plane signing key (ES256 / P-256).
// The private JWK is generated in memory and written straight to the Worker secret
// CLOUD_B3_SIGNING_JWK through `wrangler secret put` on stdin. It is never written to disk,
// never put in argv or the environment, and never printed. Only the PUBLIC JWK is printed, for
// electron/cloud-home-client.mjs (CLOUD_HOME_CP.prod.jwk).
//
//   cd cloudflare/control-plane && node scripts/gen-prod-signing-key.mjs            (first time)
//   node scripts/gen-prod-signing-key.mjs --rotate                                  (replace; every paired desktop must ship the new key first)
//
// Run it logged in to the PRODUCTION Cloudflare account (`wrangler whoami`). It targets the default
// (production) environment of wrangler.jsonc, not staging.
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";

const SECRET = "CLOUD_B3_SIGNING_JWK";
const wrangler = process.env.WRANGLER_BIN ?? "wrangler"; // override only for the test stub
const rotate = process.argv.includes("--rotate");
const run = (args, input) => new Promise((resolve) => {
  const child = spawn(wrangler, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  child.on("close", (code) => resolve({ code, out }));
  child.stdin.on("error", () => {}); // a command that exits without reading stdin is fine; its exit code decides
  child.stdin.end(input ?? "");
});

const listed = await run(["secret", "list", "--format", "json", "--config", "wrangler.jsonc"]);
if (listed.code !== 0) { console.error("Could not list secrets (wrangler failed). Are you logged in to the production account?"); process.exit(1); }
let exists = false;
try { exists = JSON.parse(listed.out).some((s) => s.name === SECRET); } catch { console.error("Unexpected wrangler output."); process.exit(1); }
if (exists && !rotate) { console.error(`${SECRET} already exists in production. Re-run with --rotate only if you mean to replace it.`); process.exit(2); }

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateJwk = privateKey.export({ format: "jwk" }); // kty, crv, x, y, d
const publicJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y };
const put = await run(["secret", "put", SECRET, "--config", "wrangler.jsonc"], JSON.stringify(privateJwk));
if (put.code !== 0) { console.error("wrangler secret put failed; no key was stored."); process.exit(1); }

console.log(`${SECRET} stored in production (private half is in the Worker only).`);
console.log("Paste this PUBLIC key into electron/cloud-home-client.mjs as CLOUD_HOME_CP.prod.jwk:\n");
console.log(JSON.stringify(publicJwk));
console.log("\nThen commit, ship a desktop build, and only then enable Cloud for customers.");
