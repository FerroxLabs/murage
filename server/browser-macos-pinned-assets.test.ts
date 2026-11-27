// The signature pins in browser-macos-identity.ts run against the REAL pinned release assets, not a synthetic
// layout. 1.0.19 shipped an engine bump (0.36.0-omb.2) with the old engine's signature pin, and every Apple Silicon
// install refused its own browser; the synthetic test in browser-macos-identity.test.ts builds its fixture FROM the
// pin, so it could never see that. Each asset is fetched once by its pinned URL, checked against its pinned sha256
// and cached by that sha (MURAGE_PIN_FIXTURE_DIR, else node_modules/.cache/browser-pin-fixtures). With neither a
// cached fixture nor network the test fails: a pin that was never checked against its asset does not pass.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { describe, expect, it } from "vitest";
import { browserBundleSpec } from "./browser-bundle-release.ts";
import { MAC_BROWSER_PAYLOADS, MAC_CHROME_EXECUTABLE_BYTES, verifyMacBrowserImage } from "./browser-macos-identity.ts";

const cacheDir = resolve(process.env.MURAGE_PIN_FIXTURE_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache", "browser-pin-fixtures"));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const spec = browserBundleSpec("darwin-arm64");

async function download(url: string, sha256: string): Promise<Buffer> {
  let response: Response;
  try { response = await fetch(url, { redirect: "follow" }); }
  catch (error) { throw new Error(`pinned asset ${sha256} is not cached in ${cacheDir} and could not be fetched (${(error as Error).message})`); }
  if (!response.ok) throw new Error(`pinned asset ${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(sha(bytes), `${url} no longer matches its pinned sha256`).toBe(sha256);
  return bytes;
}

function zipEntry(bytes: Buffer, name: string): Promise<Buffer> {
  return new Promise((done, fail) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) return fail(error);
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName !== name) return zip.readEntry();
      zip.openReadStream(entry, (failed, stream) => {
        if (failed || !stream) return fail(failed);
        const chunks: Buffer[] = [];
        stream.on("data", chunk => chunks.push(chunk)).on("error", fail).on("end", () => { zip.close(); done(Buffer.concat(chunks)); });
      });
    });
    zip.on("end", () => fail(new Error(`${name} is not in the pinned archive`)));
    zip.readEntry();
  }));
}

/** The bytes whose sha256 is `sha256`, from the cache or fetched (and, for an archive member, extracted) once. */
async function fixture(sha256: string, fetchBytes: () => Promise<Buffer>): Promise<Buffer> {
  const file = join(cacheDir, sha256);
  if (existsSync(file)) {
    const cached = readFileSync(file);
    if (sha(cached) === sha256) return cached;
    rmSync(file, { force: true });
  }
  const bytes = await fetchBytes();
  expect(sha(bytes)).toBe(sha256);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
  return bytes;
}

const ASSETS = {
  engine: { sha256: spec.engine.sha256, bytes: spec.engine.bytes, fetch: () => download(spec.engine.url, spec.engine.sha256) },
  chrome: { sha256: spec.chrome.executableSha256, bytes: MAC_CHROME_EXECUTABLE_BYTES,
    fetch: async () => zipEntry(await download(spec.chrome.url, spec.chrome.sha256), spec.chrome.executable.replace(/^chrome\//, "")) },
} as const;

describe("arm64 browser signature pins against the real pinned assets", () => {
  for (const image of ["engine", "chrome"] as const) it(`${image}: the pinned release asset passes the byte check, and one changed payload byte fails it`, async () => {
    const asset = ASSETS[image], bytes = await fixture(asset.sha256, asset.fetch);
    expect(bytes.length).toBe(asset.bytes);
    expect(verifyMacBrowserImage(bytes, image), `MAC_BROWSER_PAYLOADS.${image} does not match the pinned ${image} asset ${asset.sha256}: re-derive signatureOffset and payloadSha256 from it`).toBe(true);
    const changed = Buffer.from(bytes);
    changed[MAC_BROWSER_PAYLOADS[image].signatureOffset - 1] ^= 0xff;
    expect(verifyMacBrowserImage(changed, image)).toBe(false);
  }, 600_000);
});
