// Regression (0.1.60 audit W-A1, kept from the audit): an Entra ID (Azure AD) signed-in user has a SID of the
// form S-1-12-1-..., not S-1-5-21-.... whoami /user prints it; the ACL helper
// must accept it or every off-site step that restricts a file/folder fails.
import test from "node:test";
import assert from "node:assert/strict";
process.env.SystemRoot = "C:\\Windows";
const { currentUserSid, ownerOnlyIcaclsArguments, restrictToOwner } = await import("./backup-windows-acl.mjs");

const ENTRA_SID = "S-1-12-1-2743382473-1146318542-2395616179-3871231519";
const whoamiEntra = { status: 0, stdout: `"azuread\\samlee","${ENTRA_SID}"\r\n` };

test("Entra ID user SID is recognised by currentUserSid", () => {
  assert.equal(currentUserSid({ runTool: () => whoamiEntra }), ENTRA_SID);
});

test("icacls arguments accept an Entra ID user SID", () => {
  assert.deepEqual(ownerOnlyIcaclsArguments("C:\\Users\\samlee\\Documents\\murage-offsite-password.txt", ENTRA_SID, { directory: false }).slice(3, 4), [`*${ENTRA_SID}:F`]);
});

test("restrictToOwner succeeds for an Entra ID user whose icacls and Get-Acl both succeed", () => {
  const runTool = (file) => /whoami/i.test(file) ? whoamiEntra : { status: 0, stdout: "" };
  assert.doesNotThrow(() => restrictToOwner("C:\\Users\\samlee\\Documents\\x.txt", { runTool, readSddl: () => `D:PAI(A;;FA;;;${ENTRA_SID})` }));
});
