// The server tightens its own data folder with mask 0o077 (upstream #1620):
// the records inside are owner only, so a 0755 folder still exposed their
// names and any file an older release left 0644.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { tightenOwnedDirectory } from "./private-directory.mjs";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

it.skipIf(process.platform === "win32")("closes a readable data folder to 0700 when asked for owner-only access", () => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-private-dir-")));
  const data = path.join(root, ".murage");
  mkdirSync(data); chmodSync(data, 0o755);
  expect(tightenOwnedDirectory(data, { mask: 0o077 })).toBe(true);
  expect(lstatSync(data).mode & 0o7777).toBe(0o700);
  expect(tightenOwnedDirectory(data, { mask: 0o077 })).toBe(false);
  // The default still removes only write access, as the desktop shell expects.
  chmodSync(data, 0o775);
  expect(tightenOwnedDirectory(data)).toBe(true);
  expect(lstatSync(data).mode & 0o7777).toBe(0o755);
});
