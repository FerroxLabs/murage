// GEPA Windows signing never re-signs Microsoft's VC++ runtime, and its verifier reaches one verdict whatever the
// runner's catalog database holds. Run 44564999086 failed "Unexpected native publisher: VCRUNTIME140.dll" after the
// folder-wide action re-signed that file: Get-AuthenticodeSignature read a Microsoft catalog entry (catalog hashes skip
// the embedded signature), while run 44537735532, on an image without that entry, read our signature and passed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const pwsh = (() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 60_000 }); return true; } catch { return false; } })();
const LIST = "${{ github.workspace }}/qualification-evidence/gepa-windows-sign-list.txt";

it("both Windows workflows sign only the listed GEPA images, and the list is made right before signing", () => {
  for (const [file, job] of [["release.yml", "windows"], ["package-win.yml", "package"]]) {
    const steps = parse(fs.readFileSync(`.github/workflows/${file}`, "utf8")).jobs[job].steps;
    const sign = steps.findIndex(step => step.name === "Sign GEPA native images before freezing their manifest");
    expect(steps[sign - 1].run, file).toBe('./native/gepa/sign-list-windows.ps1 -Bundle "$pwd/dist-native/gepa/win32-x64" -List "$pwd/qualification-evidence/gepa-windows-sign-list.txt"');
    expect(steps[sign - 1].if, file).toBeUndefined();
    expect(steps[sign].with["files-catalog"], file).toBe(LIST);
    // A folder input would sign the redistributables again alongside the list.
    expect(Object.keys(steps[sign].with).filter(input => input.startsWith("files") && input !== "files-catalog"), file).toEqual([]);
  }
});

it.skipIf(!pwsh)("lists every image except Microsoft's runtime, and verifies one signed tree identically with or without a catalog entry", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "murage-gepa-signers-")); roots.push(work);
  const out = execFileSync("pwsh", ["-NoProfile", "-File", "scripts/fixtures/gepa-windows-signers-harness.ps1", "-Repo", process.cwd(), "-Work", work], { encoding: "utf8", timeout: 120_000 });
  const result = JSON.parse(out.trim().split("\n").at(-1));
  expect(result.list).toBe("ok");
  // Only PyInstaller's contents directory may hold the redistributables; a nested copy is signed and checked as ours.
  expect(result.listed).toBe("_internal/_socket.pyd,_internal/nested/VCRUNTIME140.dll,_internal/python313.dll,gepa-worker.exe");
  expect(result.listForeign).toBe("Microsoft redistributable without Microsoft's embedded signature: vcruntime140_1.dll");
  expect(result.goodCatalogFalse).toBe("ok");
  expect(result.goodCatalogTrue).toBe("ok");
  // The old pipeline's output (everything ours) and a single re-signed runtime are refused on every runner image.
  for (const [name, file] of [["resigned", "VCRUNTIME140.dll"], ["allOurs", "vcruntime140_1.dll"]]) {
    expect(result[`${name}CatalogFalse`]).toBe(`Microsoft redistributable without Microsoft's embedded signature: ${file}`);
    expect(result[`${name}CatalogTrue`]).toBe(result[`${name}CatalogFalse`]);
  }
  expect(result.oursCatalog).toBe("Unexpected native publisher: _internal/python313.dll");
  expect(result.receipt).toBe("_internal/_socket.pyd=Ferrox Labs, LLC,_internal/nested/VCRUNTIME140.dll=Ferrox Labs, LLC,_internal/python313.dll=Ferrox Labs, LLC,_internal/vcruntime140_1.dll=Microsoft Corporation,_internal/VCRUNTIME140.dll=Microsoft Corporation,gepa-worker.exe=Ferrox Labs, LLC");
});

// MAIN 20:56Z ruling: python.org 3.13.15's VCRUNTIME140.dll / VCRUNTIME140_1.dll carry the "Microsoft Windows Software
// Compatibility Publisher" leaf, which Microsoft also puts on components it did not author. It is admitted only by file
// identity (those two names in _internal, the exact sha256 in native/gepa/vcruntime-pins.json); everything else keeps the
// Microsoft Corporation rule above, whose cases are unchanged.
const PINS = {
  "VCRUNTIME140.dll": "d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7",
  "VCRUNTIME140_1.dll": "a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e",
};

it("pins python.org 3.13.15's VC++ runtime in one file that both the build and the signer helper read", () => {
  expect(JSON.parse(fs.readFileSync("native/gepa/vcruntime-pins.json", "utf8")).sha256).toEqual(PINS);
  const build = fs.readFileSync("native/gepa/build-windows.py", "utf8");
  const signers = fs.readFileSync("native/gepa/windows-signers.ps1", "utf8");
  expect(build).toContain('json.loads((SOURCE / "native/gepa/vcruntime-pins.json")');
  expect(signers).toContain("Read-PinnedRuntime (Join-Path $PSScriptRoot 'vcruntime-pins.json')");
  // No second copy of a pin can drift from the file.
  for (const digest of Object.values(PINS)) {
    expect(build, "build-windows.py").not.toContain(digest);
    expect(signers, "windows-signers.ps1").not.toContain(digest);
  }
});

it.skipIf(!pwsh)("admits the Software Compatibility Publisher leaf only for the pinned bytes of VCRUNTIME140.dll and VCRUNTIME140_1.dll", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "murage-gepa-signers-")); roots.push(work);
  const out = execFileSync("pwsh", ["-NoProfile", "-File", "scripts/fixtures/gepa-windows-signers-harness.ps1", "-Repo", process.cwd(), "-Work", work], { encoding: "utf8", timeout: 120_000 });
  const result = JSON.parse(out.trim().split("\n").at(-1));
  const cp = "Microsoft Windows Software Compatibility Publisher";
  // The helper loads exactly the repo pins.
  expect(result.repoPins).toBe(`VCRUNTIME140_1.dll=${PINS["VCRUNTIME140_1.dll"]},VCRUNTIME140.dll=${PINS["VCRUNTIME140.dll"]}`);
  // GREEN: pinned bytes + valid timestamped embedded Authenticode + CN and O=Microsoft Corporation, never put on our sign list.
  for (const name of ["compatPinned", "compatPinnedList", "compatMixed", "compatMixedList"]) expect(result[name], name).toBe("ok");
  expect(result.compatReceipt).toBe(`_internal/_socket.pyd=Ferrox Labs, LLC,_internal/nested/VCRUNTIME140.dll=Ferrox Labs, LLC,_internal/python313.dll=Ferrox Labs, LLC,_internal/vcruntime140_1.dll=${cp},_internal/VCRUNTIME140.dll=${cp},gepa-worker.exe=Ferrox Labs, LLC`);
  expect(result.compatListed).toBe("_internal/_socket.pyd,_internal/nested/VCRUNTIME140.dll,_internal/python313.dll,gepa-worker.exe");
  // RED: any other hash under the right name (the real python.org pins against other bytes, another file's hash, swapped pins).
  for (const name of ["compatRepoPins", "compatOtherHash", "compatSwapped"]) {
    expect(result[name], name).toBe("Compatibility-signed Microsoft redistributable is not the pinned runtime: VCRUNTIME140.dll");
    expect(result[`${name}List`], name).toBe(result[name]);
  }
  // RED: the leaf on any other name, even with VCRUNTIME140.dll's exact pinned bytes.
  for (const file of ["MSVCP140", "MSVCP140_1", "MSVCP140_2"]) {
    expect(result[`compatName${file}`], file).toBe(`Compatibility-signed Microsoft redistributable is not a pinned VC++ runtime name: ${file}.dll`);
    expect(result[`compatName${file}List`], file).toBe(result[`compatName${file}`]);
  }
  expect(result.compatOurName).toBe("Unexpected native publisher: _internal/python313.dll");
  expect(result.compatNested).toBe("Unexpected native publisher: _internal/nested/VCRUNTIME140.dll");
  // RED: pinned bytes without a valid, timestamped, embedded (not catalog) signature by exactly CN + O=Microsoft Corporation.
  for (const name of ["compatUntimestamped", "compatHashMismatch", "compatNotSigned"]) {
    expect(result[name], name).toBe("Invalid pinned VC++ runtime signature: VCRUNTIME140.dll");
    expect(result[`${name}List`], name).toBe(result[name]);
  }
  for (const name of ["compatNoOrg", "compatContoso", "compatTwoOrgs", "compatOrgCase", "compatOtherLeaf", "compatLookalikeLeaf"]) {
    expect(result[name], name).toBe("Unexpected pinned VC++ runtime signer: VCRUNTIME140.dll");
    expect(result[`${name}List`], name).toBe(result[name]);
  }
  // A catalog signed by CN=Microsoft Windows without O=Microsoft Corporation stays refused; since the MAIN 23:22Z ruling
  // admits Microsoft catalogs for the pinned bytes, the refusal names the catalog signer instead of the signature type.
  expect(result.compatCatalog).toBe("Unexpected pinned VC++ runtime catalog signer: VCRUNTIME140.dll");
  expect(result.compatCatalogList).toBe(result.compatCatalog);
  expect(result.compatEmbeddedCase).toBe("Microsoft redistributable without Microsoft's embedded signature: VCRUNTIME140.dll");
  // RED: the pin file cannot name a third file, change case, or drop a pin.
  expect(result.pinsExtraName).toBe("Invalid VC++ runtime pin: MSVCP140.dll");
  expect(result.pinsUpperHex).toBe("Invalid VC++ runtime pin: VCRUNTIME140.dll");
  expect(result.pinsMissing).toBe("VC++ runtime pins incomplete");
  expect(result.pinsNameCase).toBe("Invalid VC++ runtime pin: vcruntime140.dll");
});

// MAIN 23:22Z ruling: release run 44636264306 read the pinned VCRUNTIME140.dll (embedded Compatibility Publisher) as
// status=Valid, type=Catalog, signer CN=Microsoft Windows, O=Microsoft Corporation; run 44616560307 read the same bytes as
// type=Authenticode. For the pinned bytes with that embedded signer, a Microsoft catalog (Microsoft Windows or Microsoft
// Corporation, O=Microsoft Corporation) is accepted too. Nothing else is admitted.
it.skipIf(!pwsh)("admits the pinned compat-embedded VC++ runtime through a Microsoft catalog, and nothing else through any catalog", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "murage-gepa-signers-")); roots.push(work);
  const out = execFileSync("pwsh", ["-NoProfile", "-File", "scripts/fixtures/gepa-windows-signers-harness.ps1", "-Repo", process.cwd(), "-Work", work], { encoding: "utf8", timeout: 120_000 });
  const result = JSON.parse(out.trim().split("\n").at(-1));
  const cp = "Microsoft Windows Software Compatibility Publisher";
  // GREEN: pinned bytes + embedded CN/O + Valid Catalog by Microsoft Windows or Microsoft Corporation; never on our sign list.
  for (const name of ["catWindows", "catWindowsList", "catCorporation", "catCorporationList"]) expect(result[name], name).toBe("ok");
  expect(result.catReceipt).toBe(`_internal/_socket.pyd=Ferrox Labs, LLC,_internal/nested/VCRUNTIME140.dll=Ferrox Labs, LLC,_internal/python313.dll=Ferrox Labs, LLC,_internal/vcruntime140_1.dll=${cp},_internal/VCRUNTIME140.dll=${cp},gepa-worker.exe=Ferrox Labs, LLC`);
  // RED: pinned bytes, but the catalog is signed by any other name or organisation.
  for (const name of ["catOtherName", "catOtherOrg", "catNoOrg", "catTwoOrgs", "catOrgCase", "catLookalike", "catCompatLeaf", "catSelfName"]) {
    expect(result[name], name).toBe("Unexpected pinned VC++ runtime catalog signer: VCRUNTIME140.dll");
    expect(result[`${name}List`], name).toBe(result[name]);
  }
  // RED: a Microsoft catalog for bytes that are not the pin.
  for (const name of ["catRepoPins", "catOtherHash"]) {
    expect(result[name], name).toBe("Compatibility-signed Microsoft redistributable is not the pinned runtime: VCRUNTIME140.dll");
    expect(result[`${name}List`], name).toBe(result[name]);
  }
  // RED: pinned bytes and a Microsoft catalog, but the status is not Valid.
  for (const status of ["HashMismatch", "NotSigned", "UnknownError", "NotTrusted"]) {
    expect(result[`catStatus${status}`], status).toBe("Invalid pinned VC++ runtime signature: VCRUNTIME140.dll");
    expect(result[`catStatus${status}List`], status).toBe(result[`catStatus${status}`]);
  }
  // RED: the embedded signer read from the file is not exactly CN + O=Microsoft Corporation, or cannot be read.
  for (const name of ["catEmbeddedContoso", "catEmbeddedNoOrg", "catEmbeddedMissing"]) {
    expect(result[name], name).toBe("Unexpected pinned VC++ runtime signer: VCRUNTIME140.dll");
    expect(result[`${name}List`], name).toBe(result[name]);
  }
  // RED: a Microsoft catalog does not widen the names.
  expect(result.catNameMSVCP140).toBe("Compatibility-signed Microsoft redistributable is not a pinned VC++ runtime name: MSVCP140.dll");
});
