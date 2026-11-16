// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reviewed Git for Windows reference; discovery never supplies authentication.
export const engineBashReference = {
  "schema": 1,
  "referenceId": "gfw-2.51.2.windows.1-amd64-qa1",
  "gitVersion": "2.51.2.windows.1",
  "machine": 34404,
  "layouts": [
    {
      "id": "GFW-BIN",
      "entry": "bin/bash.exe",
      "implementation": "usr/bin/bash.exe"
    },
    {
      "id": "GFW-USR",
      "entry": "usr/bin/bash.exe",
      "implementation": "usr/bin/bash.exe"
    }
  ],
  "members": [
    {
      "relative": "bin/bash.exe",
      "bytes": 47008,
      "sha256": "3e90094a809e73ba5d4dbd00c48d2eec702adcc68145a7d7f764fa9f26454444"
    },
    {
      "relative": "usr/bin/bash.exe",
      "bytes": 2553064,
      "sha256": "fc362aae1f217d34d02237d99527839dd6cf85b37c7a0277109400bfa0faa594"
    },
    {
      "relative": "usr/bin/cygpath.exe",
      "bytes": 53959,
      "sha256": "5e701f516240ef651896de22da94c3dd72c603108201276920dfcf3fae6502bd"
    },
    {
      "relative": "usr/bin/env.exe",
      "bytes": 44180,
      "sha256": "b5d80f13e6b4b422a8c22d32be9cc1f5fd9b482fc60008ed80e513a2fa938cdc"
    },
    {
      "relative": "usr/bin/msys-2.0.dll",
      "bytes": 3360863,
      "sha256": "b41bfda735cd7686ab4c2b56b4cc6a6fc6c33992b1739626be94d7ae1e8eed0b"
    },
    {
      "relative": "usr/bin/msys-iconv-2.dll",
      "bytes": 1098126,
      "sha256": "5d890c42222c7b86519f7c368836cc2930f11dc975341b7ded30f26ef8770e0b"
    },
    {
      "relative": "usr/bin/msys-intl-8.dll",
      "bytes": 111181,
      "sha256": "50f7de0c712d867ddca2c9eb8562ca6ee2d69e120e798ec6126ad29dd1ed5402"
    },
    {
      "relative": "usr/bin/uname.exe",
      "bytes": 35876,
      "sha256": "1cba275ff8e0c81f48898f017758c558ee5951cb0448c36628580beffdf4ef89"
    }
  ],
  "launchProtocol": 1
};
export type EngineBashManifest = typeof engineBashReference;
const keys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === expected.length && expected.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key]!, "value"));
};
/** A manifest is a claim to the reviewed reference, never a new source of trust.
 * Reject every unreviewed member, byte count, digest, layout or protocol. */
export function parseEngineBashManifest(input: unknown): EngineBashManifest | null {
  try {
    const ref = engineBashReference;
    if (!keys(input, ["schema", "referenceId", "gitVersion", "machine", "layouts", "members", "launchProtocol"])) return null;
    for (const field of ["schema", "referenceId", "gitVersion", "machine", "launchProtocol"] as const) if (input[field] !== ref[field]) return null;
    if (!Array.isArray(input.layouts) || input.layouts.length !== ref.layouts.length
      || !Array.isArray(input.members) || input.members.length !== ref.members.length) return null;
    const seen = new Set<string>();
    let total = 0;
    for (const member of input.members) {
      if (!keys(member, ["relative", "bytes", "sha256"]) || typeof member.relative !== "string"
        || !/^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/.test(member.relative)
        || member.relative.split("/").some(part => part === "." || part === "..")
        || seen.has(member.relative.toLowerCase()) || !Number.isSafeInteger(member.bytes)
        || (member.bytes as number) <= 0 || (member.bytes as number) > 64 * 1024 * 1024
        || typeof member.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(member.sha256)) return null;
      seen.add(member.relative.toLowerCase()); total += member.bytes as number;
      const pinned = ref.members.find(row => row.relative === member.relative);
      if (!pinned || pinned.bytes !== member.bytes || pinned.sha256 !== member.sha256) return null;
    }
    if (total > 256 * 1024 * 1024 || input.members.length > 256) return null;
    const layouts = new Set<string>();
    for (const layout of input.layouts) {
      if (!keys(layout, ["id", "entry", "implementation"]) || typeof layout.id !== "string" || layouts.has(layout.id)) return null;
      layouts.add(layout.id);
      const pinned = ref.layouts.find(row => row.id === layout.id);
      if (!pinned || pinned.entry !== layout.entry || pinned.implementation !== layout.implementation) return null;
    }
    return structuredClone(ref);
  } catch { return null; }
}
// No caller may alter the embedded reference through an import.
for (const row of [...engineBashReference.members, ...engineBashReference.layouts]) Object.freeze(row);
Object.freeze(engineBashReference.members); Object.freeze(engineBashReference.layouts); Object.freeze(engineBashReference);
