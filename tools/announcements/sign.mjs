#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign announcements.yml for upload:
//
//   ANNOUNCEMENTS_SIGNING_KEY="$(cat key.pem)" node sign.mjs announcements.yml out/
//
// Writes out/announcements.json (the exact bytes), out/announcements.json.sig
// (base64 Ed25519 signature over those bytes) and out/images/ (the pictures
// the notices use). Lints first and refuses to sign anything the lint fails.
//
// The key is an Ed25519 private key in PKCS#8 PEM, from the environment only,
// never a file in a repo. If ANNOUNCEMENTS_PUBLIC_KEY is set (the base64 key
// compiled into the app), the signing key must match it, so a wrong secret
// fails here instead of on every install.
//
//   node sign.mjs --public-key key.pem
//
// prints the base64 public key to paste into ANNOUNCEMENT_PUBLIC_KEYS in
// server/announcements.ts.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { buildFeed, isMain } from "./build.mjs";

/** Base64 of the raw 32-byte public key, the form the app compiles in. */
export function rawPublicKey(privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be an Ed25519 key.");
  return Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url").toString("base64");
}

/**
 * @param {string} ymlPath
 * @param {string} outDir
 * @param {{ privateKeyPem: string, expectedPublicKey?: string, issuedAt?: string }} options
 */
export function signFeed(ymlPath, outDir, options) {
  if (!options.privateKeyPem) throw new Error("ANNOUNCEMENTS_SIGNING_KEY is not set.");
  const key = createPrivateKey(options.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be an Ed25519 key.");
  const publicKey = rawPublicKey(options.privateKeyPem);
  if (options.expectedPublicKey && options.expectedPublicKey.trim() !== publicKey) {
    throw new Error("The signing key does not match ANNOUNCEMENTS_PUBLIC_KEY, the key the app trusts.");
  }
  const built = buildFeed(ymlPath, { issuedAt: options.issuedAt ?? new Date().toISOString() });
  if (!built.ok) throw new Error(`announcements.yml does not pass the lint:\n${built.errors.join("\n")}`);
  const signature = sign(null, built.bytes, key);
  if (!verify(null, built.bytes, createPublicKey(key), signature)) throw new Error("The signature did not verify.");
  mkdirSync(join(outDir, "images"), { recursive: true });
  writeFileSync(join(outDir, "announcements.json"), built.bytes);
  writeFileSync(join(outDir, "announcements.json.sig"), signature.toString("base64") + "\n");
  for (const name of built.images) copyFileSync(join(dirname(resolve(ymlPath)), "images", name), join(outDir, "images", name));
  return { publicKey, feed: built.feed, images: built.images };
}

if (isMain(import.meta.url)) {
  if (process.argv[2] === "--public-key") {
    console.log(rawPublicKey(readFileSync(process.argv[3] ?? "", "utf8")));
  } else {
    const [ymlPath = "announcements.yml", outDir = "out"] = process.argv.slice(2);
    try {
      const result = signFeed(ymlPath, outDir, { privateKeyPem: process.env.ANNOUNCEMENTS_SIGNING_KEY ?? "", expectedPublicKey: process.env.ANNOUNCEMENTS_PUBLIC_KEY });
      console.log(`Signed ${result.feed.items.length} notice(s), issuedAt ${result.feed.issuedAt}, with public key ${result.publicKey}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
