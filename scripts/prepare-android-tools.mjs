// Stage Google's official Android Platform Tools beside the packaged app so
// USB phone support works on a clean machine without Homebrew or an SDK.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const platformNames = { darwin: "darwin", linux: "linux", win32: "win32" };
const archiveNames = { darwin: "darwin", linux: "linux", win32: "windows" };
const platform = platformNames[process.platform];
const archive = archiveNames[process.platform];
if (!platform || !archive) throw new Error(`Android Platform Tools are unsupported on ${process.platform}`);

const finalDir = join(root, "dist-native", "android-platform-tools", platform);
const override = process.env.OMB_ANDROID_PLATFORM_TOOLS_SOURCE;
const temporary = mkdtempSync(join(tmpdir(), "openmaus-android-tools-"));
const staged = join(temporary, platform);

try {
  if (override) {
    if (!existsSync(join(override, process.platform === "win32" ? "adb.exe" : "adb"))) {
      throw new Error(`OMB_ANDROID_PLATFORM_TOOLS_SOURCE has no adb: ${override}`);
    }
    cpSync(override, staged, { recursive: true });
  } else {
    const url = `https://dl.google.com/android/repository/platform-tools-latest-${archive}.zip`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not download Android Platform Tools: HTTP ${response.status}`);
    const zip = join(temporary, basename(new URL(url).pathname));
    writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    const extraction = join(temporary, "extracted");
    mkdirSync(extraction);
    // git-bash ships GNU tar (cannot read .zip) but has unzip; a native
    // Windows shell has tar (bsdtar, zip-capable) but no unzip. Try unzip
    // first and fall back to tar so either environment extracts cleanly.
    // git-bash's tar also treats a "C:" drive prefix in an absolute -C path
    // as a remote host, so normalize Windows paths to MSYS/POSIX form.
    const toMsys = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
    const extractors = process.platform === "win32"
      ? [["unzip", ["-q", zip, "-d", extraction]], ["tar", ["-xf", toMsys(zip), "-C", toMsys(extraction)]]]
      : [["unzip", ["-q", zip, "-d", extraction]]];
    let result;
    for (const [command, args] of extractors) {
      result = spawnSync(command, args, { encoding: "utf8" });
      if (result.status === 0) break;
      console.error(`${command} failed: ${(result.stderr || result.stdout).trim()} — trying next`);
    }
    if (result.status !== 0) throw new Error(`could not extract Android Platform Tools: ${(result.stderr || result.stdout).trim()}`);
    cpSync(join(extraction, "platform-tools"), staged, { recursive: true });
  }

  const adb = join(staged, process.platform === "win32" ? "adb.exe" : "adb");
  if (!existsSync(adb)) throw new Error("Downloaded Android Platform Tools do not contain adb");
  mkdirSync(dirname(finalDir), { recursive: true });
  rmSync(finalDir, { recursive: true, force: true });
  cpSync(staged, finalDir, { recursive: true });
  console.log(`staged Android Platform Tools at ${finalDir}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
