// The signature pins in browser-macos-identity.ts run against the REAL pinned release assets, not a synthetic
// layout. 1.0.19 shipped an engine bump (0.36.0-omb.2) with the old engine's signature pin, and every Apple Silicon
// install refused its own browser; the synthetic test in browser-macos-identity.test.ts builds its fixture FROM the
// pin, so it could never see that. Each asset is fetched once by its pinned URL, checked against its pinned sha256
// and cached by that sha (MURAGE_PIN_FIXTURE_DIR, else node_modules/.cache/browser-pin-fixtures). With neither a
// cached fixture nor network the test fails: a pin that was never checked against its asset does not pass.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { browserBundleSpec } from "./browser-bundle-release.ts";
import { MAC_BROWSER_PAYLOADS, MAC_CHROME_EXECUTABLE_BYTES, verifyMacBrowserImage } from "./browser-macos-identity.ts";
import { WINDOWS_BROWSER_IMAGE_PINS, WINDOWS_BROWSER_PUBLISHER, clearWindowsBrowserImageCache, settleWindowsBrowserImageChecks, verifyWindowsBrowserImage, windowsBrowserImageState } from "./browser-windows-identity.ts";

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

// The Windows identity pins (browser-windows-identity.ts) are derived from the same pinned archive. A Chrome bump
// that moved the archive and executable digests but not WINDOWS_BROWSER_IMAGE_PINS.chrome.bytes made
// verifyWindowsBrowserImage refuse the real exe, and with it every Windows install and every Windows package build.
// The packaged build admits the SIGNED exe (scripts/after-pack.mjs: verifyWindowsBrowserImage(...).signed) and every
// runtime launch goes through windowsBrowserImageState, so both are driven here on the real exe with an Authenticode
// certificate table added the way signing adds it (appended table, security directory, checksum field).
const attempt = <T,>(run: () => T): T | { refused: string } => { try { return run(); } catch (error) { return { refused: (error as Error).message }; } };
function signLike(original: Buffer, pin: { bytes: number; checksum: number }): Buffer {
  const pe = original.readUInt32LE(0x3c), optional = pe + 24, certificate = original.length;
  const table = Buffer.alloc(8 + 64, 0x5a);
  table.writeUInt32LE(table.length, 0); table.writeUInt16LE(0x200, 4); table.writeUInt16LE(2, 6);
  const signed = Buffer.concat([original, table]);
  signed.writeUInt32LE(0x1234abcd, optional + 64);
  signed.writeUInt32LE(certificate, optional + 112 + 4 * 8); signed.writeUInt32LE(table.length, optional + 112 + 4 * 8 + 4);
  expect(pin.checksum).toBe(0);
  return signed;
}
describe("Windows browser image pins against the real pinned chrome-headless-shell.exe", () => {
  const winSpec = browserBundleSpec("win32-x64");
  const realExe = () => fixture(winSpec.chrome.executableSha256,
    async () => zipEntry(await download(winSpec.chrome.url, winSpec.chrome.sha256), winSpec.chrome.executable.replace(/^chrome\//, "")));
  it("the pinned original passes the original-byte check unsigned, and one changed byte fails it", async () => {
    const bytes = await realExe(), pin = WINDOWS_BROWSER_IMAGE_PINS.chrome;
    expect(attempt(() => verifyWindowsBrowserImage(bytes, pin)), "verifyWindowsBrowserImage refused the real pinned chrome-headless-shell.exe").toEqual({ signed: false });
    expect(bytes.length, "WINDOWS_BROWSER_IMAGE_PINS.chrome.bytes is not the size of the pinned chrome-headless-shell.exe").toBe(pin.bytes);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 0xff;
    expect(() => verifyWindowsBrowserImage(changed, pin)).toThrow(/differs from its pinned original/);
  }, 600_000);

  it("the signed package path: the real exe plus a certificate table is admitted as signed, and a changed original byte is refused", async () => {
    const bytes = await realExe(), pin = WINDOWS_BROWSER_IMAGE_PINS.chrome;
    const signed = signLike(bytes, pin);
    expect(attempt(() => verifyWindowsBrowserImage(signed, pin)), "after-pack's signed-image check refused the real exe with a certificate table").toEqual({ signed: true });
    const tampered = Buffer.from(signed);
    tampered[1000] ^= 0xff;
    expect(() => verifyWindowsBrowserImage(tampered, pin)).toThrow(/differs from its pinned original/);
  }, 600_000);

  it("runtime admission: windowsBrowserImageState is ok for the signed real exe only when Windows answers Valid, and failed for a changed byte", async () => {
    const bytes = await realExe(), pin = WINDOWS_BROWSER_IMAGE_PINS.chrome;
    const dir = mkdtempSync(join(tmpdir(), "chrome-admission-"));
    try {
      const good = join(dir, "good.exe"), bad = join(dir, "bad.exe"), signed = signLike(bytes, pin);
      writeFileSync(good, signed);
      const tampered = Buffer.from(signed); tampered[1000] ^= 0xff; writeFileSync(bad, tampered);
      clearWindowsBrowserImageCache();
      const valid = { authenticode: async () => ({ status: "Valid", publisher: WINDOWS_BROWSER_PUBLISHER }) };
      expect(windowsBrowserImageState(good, pin, valid)).toBe("checking");
      await settleWindowsBrowserImageChecks(30_000);
      expect(windowsBrowserImageState(good, pin, valid), "the signed real exe was not admitted").toBe("ok");
      expect(windowsBrowserImageState(bad, pin, valid)).toBe("failed");
      const refused = { authenticode: async () => ({ status: "NotSigned", publisher: "" }) };
      clearWindowsBrowserImageCache();
      windowsBrowserImageState(good, pin, refused); await settleWindowsBrowserImageChecks(30_000);
      expect(windowsBrowserImageState(good, pin, refused)).toBe("failed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 600_000);
});

// scripts/windows-sac-allowlist.json carries a sha256 per bundled Chrome DLL, derived from the same pinned archive as the
// exe pin. A Chrome bump that moved the archive but not these rows leaves the packager and the Windows SAC inventory
// pinning DLLs that are no longer in the bundle. Each row is checked against the real member of the pinned archive.
describe("Windows SAC allowlist rows for the bundled Chrome DLLs against the real pinned archive", () => {
  const winSpec = browserBundleSpec("win32-x64");
  const rows = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "windows-sac-allowlist.json"), "utf8")).files as Array<Record<string, string>>)
    .filter(row => row.component === "chrome-headless-shell");
  const archive = () => fixture(winSpec.chrome.sha256, () => download(winSpec.chrome.url, winSpec.chrome.sha256));
  it("every Chrome DLL row pins the real archive member, and every DLL in the archive has a row", async () => {
    expect(rows.length, "no chrome-headless-shell rows in the allowlist").toBeGreaterThan(0);
    expect(await allowlistDrift(rows, await archive(), winSpec.chrome.sha256)).toEqual([]);
  }, 600_000);
});

/** Every way the allowlist's Chrome DLL rows can differ from an archive, one line each; [] when they agree. */
async function allowlistDrift(rows: Array<Record<string, string>>, zip: Buffer, archiveSha256: string): Promise<string[]> {
  const member = (row: Record<string, string>) => row.path.replace(/^resources\/browser-engine\/chrome\//, "");
  const problems: string[] = [];
  for (const row of rows) {
    let actual: string;
    try { actual = sha(await zipEntry(zip, member(row))); } catch { problems.push(`${row.path}: not in the archive`); continue; }
    if (row.sha256 !== actual) problems.push(`${row.path}: allowlist sha256 is not the sha256 of the DLL in the pinned archive`);
    if (row.sourceSha256 !== actual) problems.push(`${row.path}: sourceSha256 is not the sha256 of the DLL in the pinned archive`);
    if (row.sourceReceiptSha256 !== archiveSha256) problems.push(`${row.path}: sourceReceiptSha256 is not the pinned archive sha256`);
  }
  const listed = await new Promise<string[]>((done, fail) => yauzl.fromBuffer(zip, { lazyEntries: true }, (error, z) => {
    if (error || !z) return fail(error);
    const names: string[] = [];
    z.on("entry", (entry: yauzl.Entry) => { if (/\.dll$/i.test(entry.fileName)) names.push(entry.fileName); z.readEntry(); });
    z.on("end", () => done(names.sort())); z.readEntry();
  }));
  const rowed = new Set(rows.map(member));
  for (const name of listed) if (!rowed.has(name)) problems.push(`${name}: a DLL in the archive with no allowlist row`);
  // multiplicity (the base compared the sorted member lists): a row listed twice, or a member the archive carries twice, is drift too
  const count = (names: string[]) => names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>());
  const inRows = count(rows.map(member)), inArchive = count(listed);
  for (const [name, n] of inRows) if (n > 1) problems.push(`${name}: listed ${n} times in the allowlist`);
  for (const [name, n] of inArchive) if (n > 1) problems.push(`${name}: present ${n} times in the archive`);
  return problems;
}

// q1024-weakfix (AUDIT-WEAK deps): the check above compares pins that already agree, so on its own nothing shows it would catch a Chrome bump that
// moved the archive and not the allowlist. This builds a small archive (no network) and drifts each way the real one can: a DLL whose bytes changed,
// a DLL added to the archive, a row whose DLL left it, and a stale archive receipt. Each is named; the undrifted archive reports nothing.
describe("the allowlist drift check names every way the rows and the archive disagree", () => {
  const BUNDLE = "resources/browser-engine/chrome/";
  const buildZip = async (files: Record<string, string>): Promise<Buffer> => {
    const zip = new ZipFile(); const chunks: Buffer[] = [];
    const done = new Promise<Buffer>(resolveZip => zip.outputStream.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolveZip(Buffer.concat(chunks))));
    for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text), name);
    zip.end(); return done;
  };
  const rowFor = (name: string, text: string, archive: string) => ({ path: BUNDLE + name, sha256: sha(Buffer.from(text)), sourceSha256: sha(Buffer.from(text)), sourceReceiptSha256: archive });
  const files = { "a.dll": "alpha", "b.dll": "beta" };
  it("an archive and rows that agree report nothing", async () => {
    const zip = await buildZip(files), archive = sha(zip);
    expect(await allowlistDrift([rowFor("a.dll", "alpha", archive), rowFor("b.dll", "beta", archive)], zip, archive)).toEqual([]);
  });
  it.each([
    ["a DLL whose bytes changed", { "a.dll": "alpha", "b.dll": "beta2" }, ["resources/browser-engine/chrome/b.dll: allowlist sha256 is not", "resources/browser-engine/chrome/b.dll: sourceSha256 is not"]],
    ["a DLL added to the archive", { ...files, "c.dll": "gamma" }, ["c.dll: a DLL in the archive with no allowlist row"]],
    ["a row whose DLL left the archive", { "a.dll": "alpha" }, ["resources/browser-engine/chrome/b.dll: not in the archive"]],
  ] as Array<[string, Record<string, string>, string[]]>)("%s", async (_name, drifted, expected) => {
    const zip = await buildZip(drifted), archive = sha(zip);
    const rows = [rowFor("a.dll", "alpha", archive), rowFor("b.dll", "beta", archive)];
    const got = await allowlistDrift(rows, zip, archive);
    expect(got.length, JSON.stringify(got)).toBe(expected.length);
    for (const start of expected) expect(got.some(line => line.startsWith(start)), `${start} in ${JSON.stringify(got)}`).toBe(true);
  });
  it("a row listed twice is reported", async () => {
    const zip = await buildZip(files), archive = sha(zip);
    const got = await allowlistDrift([rowFor("a.dll", "alpha", archive), rowFor("b.dll", "beta", archive), rowFor("b.dll", "beta", archive)], zip, archive);
    expect(got).toEqual(["b.dll: listed 2 times in the allowlist"]);
  });
  it("a DLL the archive carries twice is reported", async () => {
    const zip = await buildZip({ ...files }), archive = sha(zip);
    const dup = new ZipFile(); const chunks: Buffer[] = [];
    const done = new Promise<Buffer>(r => dup.outputStream.on("data", (c: Buffer) => chunks.push(c)).on("end", () => r(Buffer.concat(chunks))));
    for (const [n, t] of [["a.dll", "alpha"], ["b.dll", "beta"], ["b.dll", "beta"]]) dup.addBuffer(Buffer.from(t), n);
    dup.end(); const dupZip = await done;
    const got = await allowlistDrift([rowFor("a.dll", "alpha", archive), rowFor("b.dll", "beta", archive)], dupZip, archive);
    expect(got).toEqual(["b.dll: present 2 times in the archive"]);
  });
  it("rows that name another archive receipt are each reported", async () => {
    const zip = await buildZip(files);
    const got = await allowlistDrift([rowFor("a.dll", "alpha", "0".repeat(64)), rowFor("b.dll", "beta", "0".repeat(64))], zip, sha(zip));
    expect(got).toEqual(["resources/browser-engine/chrome/a.dll: sourceReceiptSha256 is not the pinned archive sha256", "resources/browser-engine/chrome/b.dll: sourceReceiptSha256 is not the pinned archive sha256"]);
  });
});
