// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance for packaged smokes and fixtures that launch a fresh
// profile. A fresh profile shows the terms screen over the whole app, so a
// smoke that is not about that screen seeds the record the way an install past
// its first screen has it. Exactly one packaged smoke (smoke-mvp-mac.mjs)
// accepts through the UI, which proves the gate itself.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// shared/terms.ts is TypeScript, so read the version as text.
export const termsVersion = /TERMS_VERSION = "([^"]+)"/.exec(readFileSync(new URL("../shared/terms.ts", import.meta.url), "utf8"))?.[1];
if (!termsVersion) throw new Error("TERMS_VERSION not found in shared/terms.ts");

/** Write the current-version acceptance record into a fixture data folder, before its app starts. */
export function seedTermsAccepted(dataDir) {
  writeFileSync(join(dataDir, "terms-acceptance.json"), `${JSON.stringify({ accepted: [{ version: termsVersion, acceptedAt: new Date().toISOString() }] }, null, 2)}\n`, { mode: 0o600 });
}
