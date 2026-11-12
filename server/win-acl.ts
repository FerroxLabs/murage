// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sentinel keeps its existing bundle-local helper. Signal shares its DACL rules,
// but checks the owner separately before trusting or repairing a DACL.
export { currentUserSid, ownerOnlyVerdict, parseDacl, windowsAclRestrict } from "./sentinel/win-acl.ts";
export type { ToolRunner, AclVerdict } from "./sentinel/win-acl.ts";

const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const RID_500 = /^S-1-5-21-\d+-\d+-\d+-500$/;

/** Ownership is independent of access: a foreign owner can replace the DACL. */
export function ownerVerdict(sddl: string, userSid: string): "ok" | "foreign" | "unknown" {
  if (!SID.test(userSid)) return "unknown";
  // The reader supplies one SDDL descriptor, not an icacls filename/header.
  // O: must occur once at the beginning, with a complete SID or alias token.
  const owner = /^O:(S-1-(?:\d+-){1,14}\d+|[A-Z]{2})(?=[GDS]:|$)/.exec(sddl)?.[1];
  if (!owner || sddl.slice(2).includes("O:")) return "unknown";
  if (owner === userSid || owner === "SY" || owner === "S-1-5-18"
      || owner === "BA" || owner === "S-1-5-32-544"
      || (owner === "LA" && RID_500.test(userSid))) return "ok";
  return "foreign";
}
