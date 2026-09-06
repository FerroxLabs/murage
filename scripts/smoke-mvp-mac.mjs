// Explicit private preview artifact; never uses the installed user's profile.
import { _electron as electron } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const executablePath = resolve(process.argv[2] ?? "");
if (!executablePath.includes("/release-mvp-") || !executablePath.endsWith("/Murage.app/Contents/MacOS/Murage")) throw new Error("Explicit private MVP executable required");
const scratch = mkdtempSync(join(tmpdir(), "murage-native-mvp-"));
const data = join(scratch, "data"), userData = join(scratch, "user-data");
mkdirSync(data); mkdirSync(userData);
writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {}, profile: { name: "MVP isolated proof" } }));
let app;
try {
  app = await electron.launch({ executablePath, args: ["--user-data-dir=" + userData], timeout: 30000,
    env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, MURAGE_DATA_DIR: data, MURAGE_NO_DEV_DESKTOP_SECRET: "1" } });
  const actual = await app.evaluate(({ app }) => ({ userData: app.getPath("userData"), version: app.getVersion() }));
  assert.equal(realpathSync(actual.userData), realpathSync(userData));
  const window = await app.firstWindow({ timeout: 30000 });
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => document.body.innerText.includes("MVP isolated proof"), { timeout: 30000 });
  console.log(JSON.stringify({ nativeWindow: true, isolatedProfile: true, version: actual.version, userProfileRendered: true }));
} finally {
  if (app) await app.close();
  rmSync(scratch, { recursive: true, force: true });
}
