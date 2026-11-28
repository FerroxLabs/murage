// Ring step of the update check and the install-time admission (designs/RINGS-DESIGN.md R1-R9, K3).
// Every install fetches the same public manifest; the ring is chosen here, locally, and never sent (P6).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { KILL_SWITCH_IDS } from "../shared/kill-switch-ids.mjs";
import { activeKills, compareVersions, MAX_MANIFEST_BYTES, newerManifest, parseRingsManifest, ringTarget } from "../shared/rings-manifest.mjs";
import { RELEASES_OWNER, RELEASES_REPO, resolveLatestReleaseFeed } from "./updater-fallback.mjs";

export const RINGS_MANIFEST_URL = `https://raw.githubusercontent.com/${RELEASES_OWNER}/${RELEASES_REPO}/rings/rings/rings.json`;
export const RING_PAUSED_MESSAGE = "This update was paused. You'll get the next one automatically.";
export const RING_UNCONFIRMED_MESSAGE = "Couldn't confirm this update. Murage will try again.";
const ADMISSION_FRESH_MS = 10 * 60 * 1000;

async function fetchCapped(fetchImpl, url, timeoutMs, headers = {}) {
  const response = await fetchImpl(url, { credentials: "omit", redirect: "manual", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`rings: fetch ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("rings: refused size");
  return bytes;
}

let temporaries = 0;
export async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${temporaries += 1}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

/** R8 legacy lookup: the provider's own github.com latest request (electron-updater getLatestTagName) first, then the
 * api.github.com lookup the no-published-versions fallback uses, so a client whose update came through either host is
 * never stuck. Both answer "which release is latest now", so a pin-latest is seen through either; both failing throws. */
export async function legacyLatestVersion({ fetchImpl = globalThis.fetch } = {}) {
  try { return await githubLatestTag({ fetchImpl }); } catch (error) {
    const feed = await resolveLatestReleaseFeed({ fetchImpl, timeoutMs: 10_000 });
    if (!feed) throw error;
    return feed.tag.replace(/^v/, "");
  }
}

/** The provider's own github.com latest lookup (electron-updater getLatestTagName). */
export async function githubLatestTag({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const response = await fetchImpl(`https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`, {
    credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`rings: latest lookup ${response.status}`);
  const tag = (await response.json())?.tag_name;
  if (typeof tag !== "string") throw new Error("rings: latest lookup returned no tag");
  return tag.replace(/^v/, "");
}

// membership(): { internal, beta } read from local files only. floorSeq: the seq baked into this build (R2).
export function createRingFeed(autoUpdater, {
  currentVersion, publicKey, verify, cacheFile, killFile, membership = () => ({}), floorSeq = 0,
  fetchImpl = globalThis.fetch, latestTag = () => legacyLatestVersion({ fetchImpl }), now = Date.now, log = () => {},
  manifestUrl = RINGS_MANIFEST_URL, writeText = writeAtomic, readText = (file) => readFile(file, "utf8"),
} = {}) {
  let cached = null; // { manifest, bytes, signature, verifiedAt }
  let writtenSeq = null; // seq of the manifest the cache file holds
  let persisting = Promise.resolve();
  let cacheLoading = null;
  let offer = null; // the target the last check pointed the provider at
  let switched = false;

  const parse = (bytes, signature) => parseRingsManifest(bytes, signature, { publicKey, verify });

  // Every caller waits for the one disk read, and the stored copy never replaces a higher seq accepted meanwhile.
  function loadCache() {
    cacheLoading ??= (async () => {
      try {
        const stored = JSON.parse(await readText(cacheFile));
        const bytes = Buffer.from(String(stored.bytes), "base64");
        const manifest = parse(bytes, stored.signature); // re-verified on every read (R2)
        if (manifest.seq < floorSeq) return;
        writtenSeq ??= manifest.seq;
        if (!cached || manifest.seq > cached.manifest.seq) cached = { manifest, bytes, signature: stored.signature, verifiedAt: 0 };
      } catch { /* no cache, or a cache that no longer verifies: as if none */ }
    })();
    return cacheLoading;
  }

  async function fetchManifest(timeoutMs) {
    const [bytes, signature] = await Promise.all([
      fetchCapped(fetchImpl, manifestUrl, timeoutMs),
      fetchCapped(fetchImpl, `${manifestUrl}.asc`, timeoutMs),
    ]);
    return { manifest: parse(bytes, signature.toString("utf8")), bytes, signature: signature.toString("utf8") };
  }

  async function writeKills(manifest) {
    if (!killFile || !manifest) return;
    try {
      const kills = activeKills(manifest, currentVersion, KILL_SWITCH_IDS);
      await writeText(killFile, `${JSON.stringify({ seq: manifest.seq, kills })}\n`); }
    catch (error) { log(`rings: kill file write failed ${error?.message ?? error}`); }
  }

  // One writer at a time, and each write persists the highest manifest accepted when it runs, so a check and an
  // admission accepting manifests concurrently can never leave a lower seq on disk than this process holds (R2: a halt
  // once accepted survives a restart).
  function persist() {
    persisting = persisting.then(async () => {
      const current = cached;
      if (!current) return;
      if (writtenSeq !== current.manifest.seq) {
        try {
          await writeText(cacheFile, JSON.stringify({ bytes: current.bytes.toString("base64"), signature: current.signature }));
          writtenSeq = current.manifest.seq;
        } catch (error) { log(`rings: cache write failed ${error?.message ?? error}`); }
      }
      await writeKills(current.manifest);
    });
    return persisting;
  }

  // Merge a fetch into the cache (highest seq at or above the floor wins) and persist it.
  async function accept(fetched) {
    const best = newerManifest(cached?.manifest ?? null, fetched?.manifest ?? null, floorSeq);
    if (fetched && best === fetched.manifest) {
      cached = { ...fetched, verifiedAt: now() };
    } else if (fetched && cached && fetched.manifest.seq === cached.manifest.seq) {
      cached = { ...cached, verifiedAt: now() };
    } else if (fetched) {
      log(`rings: refused replay seq ${fetched.manifest.seq}`);
    }
    await persist();
    return cached;
  }

  function resetProvider() {
    offer = null;
    if (!switched) return;
    switched = false;
    autoUpdater.setFeedURL({ provider: "github", owner: RELEASES_OWNER, repo: RELEASES_REPO });
  }

  return {
    /** Before every check. "legacy": behave exactly as today; "ring": provider points at the target tag; "none": a ring
     * manifest is in force and names nothing newer than this build, so nothing is offered (not even GitHub latest). */
    async prepare() {
      resetProvider();
      await loadCache();
      let fetched = null;
      try { fetched = await fetchManifest(15_000); } catch (error) { log(String(error?.message ?? error)); }
      const held = await accept(fetched);
      const target = ringTarget(held?.manifest ?? null, membership() ?? {}, now());
      if (target === null) return { mode: "legacy" };
      if (compareVersions(target, currentVersion) <= 0) return { mode: "none", target };
      autoUpdater.setFeedURL({ provider: "generic", url: `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/download/v${target}` });
      switched = true;
      offer = target;
      return { mode: "ring", target };
    },
    reset: resetProvider,
    /** R6: under a ring, only the exact signed target may be offered. */
    offerAllowed(version) {
      return offer === null || version === offer;
    },
    /** R8: { ok } or { ok:false, reason:"paused"|"unconfirmed" }. Never throws. */
    async admit(version) {
      try {
        await loadCache();
        let fetched = null;
        try { fetched = await fetchManifest(10_000); } catch (error) { log(`rings: admission refetch failed ${error?.message ?? error}`); }
        const held = await accept(fetched);
        const manifest = held?.manifest ?? null;
        if (manifest && now() < manifest.expiresAt) {
          // Decide on the highest seq ever accepted; it must have been seen on the network just now.
          if (!fetched || now() - held.verifiedAt > ADMISSION_FRESH_MS) return { ok: false, reason: "unconfirmed" };
          return ringTarget(manifest, membership() ?? {}, now()) === version ? { ok: true } : { ok: false, reason: "paused" };
        }
        // Legacy path (no manifest ever accepted, or it expired): GitHub latest must still name this version.
        let latest;
        try { latest = await latestTag(); } catch (error) { log(`rings: latest lookup failed ${error?.message ?? error}`); return { ok: false, reason: "unconfirmed" }; }
        // A check that ran meanwhile may have accepted a signed manifest (a halt): it outranks the legacy answer.
        const seen = cached?.manifest ?? null;
        if (seen && seen !== manifest && now() < seen.expiresAt) {
          return ringTarget(seen, membership() ?? {}, now()) === version ? { ok: true } : { ok: false, reason: "paused" };
        }
        return latest === version ? { ok: true } : { ok: false, reason: "paused" };
      } catch (error) {
        log(`rings: admission failed ${error?.message ?? error}`);
        return { ok: false, reason: "unconfirmed" };
      }
    },
  };
}

/** Local ring membership: `<userData>/update-ring.json` {"ring":"internal"} (placed by hand, runbook) and the
 * "Get updates early" setting `<userData>/update-channel.json` {"early":true}. Unreadable = not a member. */
export function createRingMembership({ ringFile, channelFile, readText }) {
  const read = (file) => { try { return JSON.parse(readText(file)); } catch { return null; } };
  return () => ({ internal: read(ringFile)?.ring === "internal", beta: read(channelFile)?.early === true });
}

/** Settings > "Get updates early" (update:get-early / update:set-early IPC). Local only. */
export function readGetUpdatesEarly(file) {
  try { return JSON.parse(readFileSync(file, "utf8"))?.early === true; } catch { return false; }
}
export function writeGetUpdatesEarly(file, early) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ early: early === true })}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return early === true;
}
