// Fills the pinned-tool download cache (MURAGE_PACKAGE_DOWNLOAD_CACHE) with every archive the
// package chains fetch: age, restic, Windows age, cloudflared and the bubblewrap source. Each file
// is fetched through fetchPinned (cache, upstream, mirror; 5 tries each; sha256 verified, fail
// closed) and stored under its pinned sha256, so the cache can only hold the pinned bytes.
// Run by .github/workflows/seed-tool-cache.yml; safe to run any time (verified hits are reused).
import { fetchPinned, cacheFileFor } from "./download-retry.mjs";
import { BACKUP_AGE_PINS } from "../shared/backup-age-pins.mjs";
import { RESTIC_PINS } from "../shared/backup-restic-pin.mjs";
import { WINDOWS_BACKUP_ARCHIVE } from "../shared/windows-backup-tools.mjs";
import { CLOUDFLARED_ASSETS, cloudflaredAssetUrl } from "./prepare-cloudflared.mjs";
import { BUBBLEWRAP_URL, BUBBLEWRAP_SHA256 } from "./build-murage-cage.mjs";

if (!cacheFileFor("0".repeat(64))) throw new Error("Set MURAGE_PACKAGE_DOWNLOAD_CACHE to the cache directory");
const wanted = new Map();
const add = (label, url, sha256) => wanted.set(sha256, { label, url, sha256 });
for (const [target, pin] of Object.entries(BACKUP_AGE_PINS)) add(`age ${target}`, pin.url, pin.archiveSha256);
for (const [target, pin] of Object.entries(RESTIC_PINS)) add(`restic ${target}`, pin.url, pin.archiveSha256);
add("age windows", WINDOWS_BACKUP_ARCHIVE.url, WINDOWS_BACKUP_ARCHIVE.sha256);
for (const [target, asset] of Object.entries(CLOUDFLARED_ASSETS)) add(`cloudflared ${target}`, cloudflaredAssetUrl(asset), asset.sha256);
add("bubblewrap source", BUBBLEWRAP_URL, BUBBLEWRAP_SHA256);

let failures = 0;
for (const { label, url, sha256 } of wanted.values()) {
  const response = await fetchPinned(url, { redirect: "follow" }, { sha256, timeoutMs: 120_000 });
  if (response.ok) console.log(`seeded ${label} (${sha256})`);
  else { failures += 1; console.error(`::error::could not seed ${label} from ${url}: HTTP ${response.status}`); }
}
if (failures) process.exit(1);
