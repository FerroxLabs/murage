// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signs a package for the Official mark. Used by scripts/sign-package.mjs on
// the machine that holds the offline signing key. The key is read from a file
// path, used in memory and never printed, logged or written anywhere.
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { readBotPackageArchive, writeBotPackageArchive } from "./bot-package-archive.ts";
import { packageDigest, publicKeyOf, signPackage, verifyOfficialPackage } from "./package-signature.ts";

export interface SignResult { output: string; keyId: string; kind: "archive" | "json" }

/** Sign a `.zip` package archive or a `.json` team or package file, writing a
 * new file at `output` (an existing file is never overwritten). */
export async function signPackageFile(input: string, keyPath: string, output: string): Promise<SignResult> {
  const keyStat = lstatSync(keyPath);
  if (!keyStat.isFile()) throw new Error("The key path must be a file");
  const pem = readFileSync(keyPath, "utf8");
  const pub = publicKeyOf(pem);
  if (/\.zip$/i.test(input)) {
    const archive = await readBotPackageArchive(input, { guard: false });
    const { signature: _drop, ...bare } = archive.manifest as typeof archive.manifest & { signature?: unknown };
    const signed = signPackage(bare, pem);
    await writeBotPackageArchive(output, { manifest: signed, payloads: archive.payloads }, {});
    const check = await readBotPackageArchive(output, { guard: false });
    if (!verifyOfficialPackage(JSON.parse(JSON.stringify(check.manifest)), [pub]).official) throw new Error("The signed archive did not verify");
    return { output, keyId: pub.id, kind: "archive" };
  }
  const document = JSON.parse(readFileSync(input, "utf8")) as object;
  packageDigest(document);
  const signed = signPackage(document, pem);
  if (!verifyOfficialPackage(signed, [pub]).official) throw new Error("The signed file did not verify");
  writeFileSync(output, JSON.stringify(signed, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return { output, keyId: pub.id, kind: "json" };
}
