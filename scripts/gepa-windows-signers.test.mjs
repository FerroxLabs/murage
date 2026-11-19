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
