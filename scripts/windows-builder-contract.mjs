// Locked dispatch contract owner: win-sac-sign; dependency upgrades/review and Windows CI consumer owner: MAIN.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const WINDOWS_BUILDER_DISPATCH = Object.freeze({
  "./out/winPackager.js": "ac4ae48193db71cc50be3eeb6017d4e35f934637eac0ae7ef4e0c62fbd9db552",
  "./out/codeSign/windowsSignToolManager.js": "4b956727cd23830550c56315e8debe73f4bbc120b57dc3302952390d7ce09e8d",
  "./out/codeSign/windowsCodeSign.js": "84dbd212d4352e099a7d8c7715314c51fc743eef7ed8b0b94b50e173c419d70c",
  "./out/targets/nsis/NsisTarget.js": "43a6cb5c64b0f0f889bc9dd9d66fa351e5294cd6a7baedfa834c0067fd123372",
  "./out/util/resEdit.js": "02ddb3dee119c3f8aaf6a427e7fea8b2765a61778e5db6f5e02df1cbb5b16cde",
  "./out/vm/WineVm.js": "dce471a598e059f2d1289e5363cb7cbb9049da990ef9a9bf3c9ff0823edf6e24",
  "builder-util": "83ef1efb33f18337c52d70f5413182da064e7b2e5a3fe3f3a5dbb9b0e4018e76",
  "./out/toolsets/windows.js": "a6e3009ca9680aec48646793289224a8df26cfb9c8dafba1e3b08323f09a331b",
  "./out/targets/nsis/nsisUtil.js": "fca86cb65c9a9e63744204379cad053ad14b774bff4f33eafec797227dd0dbf1",
});
export function verifyWindowsBuilderDispatch(fromLibrary) {
  if (fromLibrary("./package.json").version !== "26.15.3") throw Error("WINDOWS_BUILDER_VERSION_UNREVIEWED");
  for (const [file, expected] of Object.entries(WINDOWS_BUILDER_DISPATCH)) {
    if (createHash("sha256").update(readFileSync(fromLibrary.resolve(file))).digest("hex") !== expected) throw Error("WINDOWS_BUILDER_DISPATCH_UNREVIEWED");
  }
}
