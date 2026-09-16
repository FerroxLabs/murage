// Static packaged-byte/signature gate; does not launch Electron or native helpers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserBundlePaths } from "../server/browser-bundle-release.ts";
import { verifyGepaBundle } from "../server/gepa-resource.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const app = resolve("release/mac-arm64/Murage.app");
const resources = join(app, "Contents/Resources");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const file = (path) => { assert(lstatSync(path).isFile(), `Not a regular file: ${path}`); assert(lstatSync(path).size > 0, `Empty file: ${path}`); };
const executable = (path) => { file(path); accessSync(path, constants.X_OK); };
const verify = (path) => run("codesign", ["--verify", "--deep", "--strict", path]);
const team = (path) => {
  // codesign prints metadata to stderr even on success.
  const output = execFileSync("/bin/bash", ["-c", 'codesign -dv --verbose=4 "$1" 2>&1', "qualification", path], { encoding: "utf8" });
  const value = /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
  assert(value && value !== "not set", `Missing Developer ID team: ${path}`);
  assert(/^Authority=Developer ID Application:/m.test(output), `Not Developer ID Application: ${path}`);
  return value;
};
verify(app);
const appTeam = team(app);
const browser = browserBundlePaths(join(resources, "browser-engine"), "darwin-arm64");
const helpers = [
  join(app, "Contents/MacOS/Murage"),
  join(resources, "cua-driver"),
  join(resources, "Murage Speech.app/Contents/MacOS/speech-helper"),
  join(resources, "Murage Recorder.app/Contents/MacOS/recorder-helper"),
  join(resources, "cloudflared/cloudflared"),
  join(resources, "fuigo/fuigo"),
  join(resources, "gepa-worker/gepa-worker"),
  join(resources, "backup-tools/arm64/age"),
  join(resources, "backup-tools/arm64/restic"),
  browser.engine, browser.chrome,
];
const inventory = [];
for (const path of helpers) {
  executable(path);
  verify(path);
  assert.equal(team(path), appTeam, `Unexpected helper signing team: ${path}`);
  const archs = run("lipo", ["-archs", path]).split(/\s+/);
  assert(archs.includes("arm64"), `Missing arm64: ${path}`);
  inventory.push({ path: path.slice(app.length + 1), archs, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
}
for (const relative of ["server/index.js", "ui/index.html", "app.asar", "app-update.yml", "browser-engine/manifest.json", "backup-tools/LICENSE", "licenses/cloudflared-LICENSE.txt", "licenses/cloudflared-README.md", "licenses/fuigo-LICENSE.txt", "licenses/fuigo-README.md", "licenses/fuigo-THIRD_PARTY_NOTICES.md"]) file(join(resources, relative));
assert(lstatSync(join(resources, "cua-sdk")).isDirectory());
const gepaMetadata = JSON.parse(readFileSync("qualification-evidence/gepa-package-metadata.json", "utf8"));
verifyGepaBundle(join(resources, "gepa-worker"), "darwin-arm64", gepaMetadata.extraMetadata.murageGepaManifests["darwin-arm64"]);
const update = readFileSync(join(resources, "app-update.yml"), "utf8");
assert(/^owner: FerroxLabs$/m.test(update));
assert(/^repo: murage-releases$/m.test(update));
const { SPAWNED_PROXIES } = await import(pathToFileURL(join(resources, "server/proxy-paths.js")));
assert(Object.keys(SPAWNED_PROXIES).length > 0, "No spawned proxy paths discovered");
for (const [name, path] of Object.entries(SPAWNED_PROXIES)) assert(existsSync(path), `Unresolved proxy ${name}: ${path}`);
// Reject accidental second architecture artifacts; never upload a broad release glob.
assert(!readdirSync("release").some(name => /-x64\.(dmg|zip)$/.test(name)), "Unexpected x64 artifact");
console.log(JSON.stringify({ sourceSha: process.env.SOURCE_SHA, appTeam, inventory, proxies: Object.keys(SPAWNED_PROXIES), scope: "packaged bytes and signatures; no installed Electron, GUI, scheduler or Keychain runtime proof" }, null, 2));
