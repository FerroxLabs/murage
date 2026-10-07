// Cache headers for the packaged UI the server hands the window. The build
// names every file under /assets by its content hash, so one never changes
// under its name: letting the window keep it makes the second launch skip the
// 3.8 MB entry download and lets the renderer reuse its compiled code.
// index.html and everything else stay uncached, since they name the hashes.
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export function staticCacheControl(path: string): string | undefined {
  return HASHED_ASSET.test(path) ? "public, max-age=31536000, immutable" : undefined;
}
