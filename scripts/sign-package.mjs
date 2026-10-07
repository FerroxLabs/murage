// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign a team or bot package so Murage shows the Official mark.
//
//   node scripts/sign-package.mjs --key /path/to/official-ed25519.pem <package.zip|package.json> <signed-output>
//
// The key is read from the file path and never printed. Run this only on the
// offline machine that holds the signing key. See docs/official-package-signing.md.
import { signPackageFile } from "../server/package-signing-cli.ts";

const args = process.argv.slice(2);
const keyAt = args.indexOf("--key");
const rest = args.filter((_, index) => index !== keyAt && index !== keyAt + 1);
if (keyAt < 0 || !args[keyAt + 1] || rest.length !== 2) {
  console.error("Usage: node scripts/sign-package.mjs --key <private-key.pem> <package.zip|package.json> <signed-output>");
  process.exit(2);
}
try {
  const result = await signPackageFile(rest[0], args[keyAt + 1], rest[1]);
  console.log(`Signed ${result.kind} written to ${result.output} with key ${result.keyId}`);
} catch (error) {
  console.error(`Signing failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
