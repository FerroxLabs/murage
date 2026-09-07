// End-to-end proof that an AppImage update lands on the path the user
// launches. Default: real release feed; --candidate-feed: isolated first-release
// full-download proof using the actual candidate, without publishing anything.
//
// The unit tests drive AppImageUpdater.doInstall with hand-made files. This
// drives the shipped bundle from the packaged resources, checking either the
// real FerroxLabs/murage-releases feed or an explicit local candidate feed,
// downloading the asset, and installing it over a copy with a version in its name —
// the exact shape that used to orphan the launcher.
//
// The current version is reported by the app adapter, not read from the file,
// so a build newer than the latest release can still be told to update: we
// claim an old version and let the published release be the newer one.
//
// Runs under Electron (electron-updater needs its net stack):
//   xvfb-run -a pnpm exec electron scripts/smoke-linux-update.mjs
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app } = require("electron");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");

// A version older than the oldest release we would ever test against, so the
// published feed is always an upgrade regardless of what is packaged here.
const PRETEND_VERSION = "0.0.1";
const candidateFeed = process.argv.includes("--candidate-feed");
const expectedVersion = process.argv.find((argument) => argument.startsWith("--expected-version="))?.slice("--expected-version=".length);
if (expectedVersion !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedVersion)) {
  throw new Error("expected-version must be stable X.Y.Z");
}

function fail(message) {
  console.error(`[smoke-linux-update] ${message}`);
  app.exit(1);
}

// Missing is an answer, not a crash: when the install renames instead of
// overwriting, the launched path is gone and that is the finding to report.
function sha512(file) {
  try {
    return createHash("sha512").update(readFileSync(file)).digest("base64");
  } catch {
    return null;
  }
}

function onlyAppImage() {
  const matches = readdirSync(releaseDir).filter((name) => name.endsWith(".AppImage"));
  if (matches.length !== 1) throw new Error(`expected one packaged AppImage, found ${matches.length}`);
  return path.join(releaseDir, matches[0]);
}

async function main() {
  const packaged = onlyAppImage();
  const workspace = mkdtempSync(path.join(tmpdir(), "murage-update-smoke-"));
  const installDir = path.join(workspace, "opt");
  const applications = path.join(workspace, "applications");
  mkdirSync(installDir);
  mkdirSync(applications);

  // The bug shape: a version in the filename, and a launcher pinned to it.
  const launched = path.join(installDir, "Murage-0.0.1-x86_64.AppImage");
  copyFileSync(packaged, launched);
  // Make the old bytes observably different; this isolated copy is never run.
  if (candidateFeed) appendFileSync(launched, "\nMurage old-version update fixture\n");
  const originalHash = sha512(launched);
  const desktopEntry = path.join(applications, "com.murage.app.desktop");
  writeFileSync(
    desktopEntry,
    `[Desktop Entry]\nName=Murage\nExec=${launched} %U\nType=Application\n`,
  );

  // Isolate every path the updater writes to.
  process.env.XDG_CACHE_HOME = path.join(workspace, "cache");
  process.env.APPIMAGE = launched;
  app.setPath("userData", path.join(workspace, "userdata"));

  // The updater under test is the one that ships, not the one in the tree.
  // Electron resolves paths inside an asar natively, so this loads the exact
  // module the packaged app would require. An explicit path lets the same
  // harness run against an unpatched bundle, which must fail — a smoke that
  // cannot fail proves nothing.
  const bundle =
    process.argv.find((argument) => argument.startsWith("--updater="))?.slice("--updater=".length) ??
    path.join(root, "release/linux-unpacked/resources/app.asar/electron/vendor/electron-updater.cjs");
  console.log(`[smoke-linux-update] updater under test: ${bundle}`);
  const { AppImageUpdater } = require(bundle);

  const updateConfig = path.join(workspace, "app-update.yml");
  const bakedConfig = path.join(root, "release/linux-unpacked/resources/app-update.yml");
  const baked = readFileSync(bakedConfig, "utf8");
  for (const [key, value] of [["provider", "github"], ["owner", "FerroxLabs"], ["repo", "murage-releases"]]) {
    assert.match(baked, new RegExp(`^${key}: ${value}\\s*$`, "m"), `wrong baked updater ${key}`);
  }
  copyFileSync(bakedConfig, updateConfig);

  let feedServer;
  if (candidateFeed) {
    const name = path.basename(packaged);
    const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
    const metadata = JSON.stringify({ version, files: [{ url: name, sha512: sha512(packaged), size: statSync(packaged).size }], path: name, sha512: sha512(packaged) });
    feedServer = createServer((request, response) => {
      const requested = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      if (requested === "/latest-linux.yml") {
        response.writeHead(200, { "Content-Type": "application/yaml" });
        response.end(metadata);
      } else if (requested === `/${name}`) {
        response.writeHead(200, { "Content-Length": statSync(packaged).size });
        createReadStream(packaged).pipe(response);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve, reject) => {
      feedServer.once("error", reject);
      feedServer.listen(0, "127.0.0.1", resolve);
    });
    // Override only this disposable configuration; shipped GitHub config is untouched.
    writeFileSync(updateConfig, `provider: generic\nurl: http://127.0.0.1:${feedServer.address().port}\nupdaterCacheDirName: murage-candidate-smoke\n`);
  }

  // The constructor parses the current version once, so this has to be in
  // place before the updater exists. Without it the comparison runs against
  // Electron's own version and every real release looks like a downgrade.
  app.getVersion = () => PRETEND_VERSION;

  const updater = new AppImageUpdater();
  updater.updateConfigPath = updateConfig;
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  // The first release has no prior blockmap. Live-feed mode retains differential download.
  if (candidateFeed) updater.disableDifferentialDownload = true;
  updater.logger = { info: log, warn: log, error: log, debug: () => {} };

  function log(...values) {
    console.log("   ", ...values.map(String));
  }

  // A failed staging move must preserve the user's original app and launcher.
  // Exercise the shipped installer implementation, as in the existing unit regression.
  assert.throws(() => AppImageUpdater.prototype.doInstall.call({
    installerPath: path.join(workspace, "never-downloaded.AppImage"),
    _logger: { info: log, warn: log, error: log, debug() {} },
    dispatchError: (error) => { throw error; },
    emit() {},
    spawnLog: () => assert.fail("failed install must not relaunch"),
  }, { isForceRunAfter: true }));
  assert.equal(sha512(launched), originalHash, "failed install must preserve original bytes");
  assert.deepEqual(readdirSync(installDir), [path.basename(launched)], "failed install must leave no staged file");
  console.log("[smoke-linux-update] failed-install preservation passed");

  console.log(`[smoke-linux-update] checking ${candidateFeed ? "isolated candidate" : "real GitHub release"} feed…`);
  const result = await updater.checkForUpdates();
  if (!result?.updateInfo?.version) throw new Error("the feed returned no update");
  // A feed response alone is not an offer: a version comparison that decided
  // "not available" still carries updateInfo, and reading only that would let
  // this smoke pass without ever installing anything.
  if (result.isUpdateAvailable !== true) {
    throw new Error(
      `the feed's ${result.updateInfo.version} was not treated as an update over ${PRETEND_VERSION}`,
    );
  }
  const offered = result.updateInfo.version;
  if (expectedVersion !== undefined) assert.equal(offered, expectedVersion, "live feed offered a different release");
  console.log(`[smoke-linux-update] feed offers ${offered}`);

  const expected = result.updateInfo.files?.find((file) => file.url.endsWith(".AppImage"));
  if (!expected?.sha512) throw new Error("the feed declares no AppImage checksum");

  console.log("[smoke-linux-update] downloading…");
  await updater.downloadUpdate(result.cancellationToken);

  // Record the relaunch instead of starting a second app; the file placement
  // is what this proves, and the target it would launch is part of that.
  let relaunched = null;
  updater.spawnLog = (target) => {
    relaunched = target;
  };
  updater.quitAndInstall(true, true);

  const survivors = readdirSync(installDir);
  const desktop = readFileSync(desktopEntry, "utf8");
  const execTarget = desktop.match(/^Exec=(.*?) %U$/m)?.[1];
  console.log(`[smoke-linux-update] files left in the install directory: ${survivors.join(", ")}`);

  const checks = [
    ["the update stayed on the launched path", survivors.includes(path.basename(launched))],
    ["no second AppImage appeared", survivors.length === 1],
    [
      "the launcher still points at a real file",
      execTarget === launched && existsSync(launched),
    ],
    ["the file now holds the offered build", sha512(launched) === expected.sha512],
    ["candidate replaced distinct old bytes", !candidateFeed || sha512(launched) !== originalHash],
    ["the relaunch uses the launched path", relaunched === launched],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✔" : "✖"} ${label}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`[smoke-linux-update] ${failed} check(s) failed; workspace kept at ${workspace}`);
    app.exit(1);
    return;
  }

  rmSync(workspace, { recursive: true, force: true });
  if (feedServer) await new Promise((resolve) => feedServer.close(resolve));
  console.log(`[smoke-linux-update] OK — updated 0.0.1 → ${offered} in place`);
  if (candidateFeed) console.log("[smoke-linux-update] POST-PUBLICATION REQUIRED: rerun without --candidate-feed to prove the live GitHub feed and download path; candidate proof does not cover differential downloads.");
  app.exit(0);
}

app.whenReady().then(main).catch((error) => fail(error.stack ?? String(error)));
