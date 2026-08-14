import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux afterPack permissions", () => {
  it("repairs every packaged CUA ancestor and resource mode", async () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-after-pack-"));
    temporaryDirectories.push(appOutDir);
    const cua = path.join(appOutDir, "resources", "cua-linux-x64");
    const licenses = path.join(cua, "licenses");
    fs.mkdirSync(licenses, { recursive: true, mode: 0o775 });
    for (const name of ["cua-driver", "cua-cursor-theme", "release.json"]) {
      fs.writeFileSync(path.join(cua, name), "fixture", { mode: 0o664 });
    }
    for (const name of [
      "LICENSE.md",
      "Inter-OFL-1.1.txt",
      "THIRD_PARTY_LICENSES.html",
      "THIRD_PARTY_NOTICES.md",
      "SBOM.cdx.json",
    ]) {
      fs.writeFileSync(path.join(licenses, name), "fixture", { mode: 0o664 });
    }

    await afterPack({ electronPlatformName: "linux", appOutDir });

    for (const directory of [appOutDir, path.join(appOutDir, "resources"), cua, licenses]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
    }
    for (const name of ["cua-driver", "cua-cursor-theme"]) {
      expect(fs.lstatSync(path.join(cua, name)).mode & 0o777).toBe(0o755);
    }
    expect(fs.lstatSync(path.join(cua, "release.json")).mode & 0o777).toBe(0o644);
  });
});
