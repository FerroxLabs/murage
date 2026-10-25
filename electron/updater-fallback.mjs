// When electron-updater's GitHub provider says "No published versions", ask the GitHub
// API directly which release is latest and point a generic provider at that release's
// download folder. The provider still reads latest-*.yml and still enforces the sha512
// and signature checks; only the way the newest tag is found changes.
export const RELEASES_OWNER = "FerroxLabs";
export const RELEASES_REPO = "murage-releases";
const TAG = /^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;

/** Resolves { tag, url } for the latest published release, or null when GitHub shows none
 * (a draft, a prerelease, a bad tag or no latest-*.yml asset). Throws on a failed request. */
export async function resolveLatestReleaseFeed({ fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "Murage-updater" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error("GitHub latest-release lookup failed");
    error.statusCode = response.status;
    throw error;
  }
  const release = await response.json();
  const tag = release?.tag_name;
  if (typeof tag !== "string" || !TAG.test(tag) || release.draft === true || release.prerelease === true) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (!assets.some((asset) => /^latest[\w.-]*\.yml$/.test(asset?.name ?? ""))) return null;
  return { tag, url: `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/download/${encodeURIComponent(tag)}` };
}

/** The pair the coordinator drives: switch the updater to the resolved release folder,
 * and switch back to the normal GitHub provider before the next check. */
export function createGithubFallbackFeed(autoUpdater, { resolve = resolveLatestReleaseFeed, log = () => {} } = {}) {
  let switched = false;
  return {
    async activate() {
      const feed = await resolve();
      if (!feed) return false;
      autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
      switched = true;
      log(`Update check fell back to the latest release lookup (tag ${feed.tag})`);
      return true;
    },
    reset() {
      if (!switched) return;
      switched = false;
      autoUpdater.setFeedURL({ provider: "github", owner: RELEASES_OWNER, repo: RELEASES_REPO });
    },
  };
}
