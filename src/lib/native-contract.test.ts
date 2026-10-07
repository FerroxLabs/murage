// The phone app's native code and this page agree on the channel through
// shared fixtures in apps/mobile/contract. The Swift suite (MurageShellCore)
// and the Java suite (com.murage.mobile.shell) read the same files; this is
// the web side of each case.
//
// Some rules are native-only: the saved origin, which URLs openExternal lets
// out, and the name a saved file gets on disk. For those, a small oracle
// below states the rule both twins implement, and every fixture case is
// checked against it, so a typo in a fixture fails here first.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseOpenHash } from "./deep-link";
import { parseNativeHello, resetNativeShellForTest } from "./native-shell";
import { NATIVE_SAVE_CHUNK_BYTES, NATIVE_SAVE_MAX_BYTES, saveSource, saveUrl, type NativeSaveRequest } from "./save-file";

const contract = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../apps/mobile/contract/${name}`, import.meta.url), "utf8")) as T;

interface OriginCase { input: string; origin: string | null }
interface OpenHashCase { threadId: string; messageId?: string; hash: string | null }
interface SaveCase { request: Record<string, unknown>; error?: string }
interface ExternalCase { url: string; accepted: boolean }
interface ChannelContract { chunkBytes: number; maxBytes: number; origin: string; saves: SaveCase[]; externalUrls: ExternalCase[] }
interface FileNameCase { input: string; safe: string }

// Exactly the fields of each NativeSaveRequest variant. The Record type makes
// a new or renamed variant in save-file.ts a type error here.
const SHAPES: Record<NativeSaveRequest["kind"], string[]> = {
  url: ["filename", "kind", "url"],
  begin: ["filename", "id", "kind", "mime", "size"],
  chunk: ["base64", "id", "index", "kind"],
  end: ["id", "kind"],
  abort: ["id", "kind"],
};

// Anything a lenient parser would silently drop or rewrite: C0/C1 controls
// (a WHATWG parser deletes tab and newline), any Unicode space or line
// separator, and "\" (WHATWG reads it as "/").
const UNSAFE = /[\p{Cc}\p{Z}\\]/u;

/** The saved workspace origin (WorkspaceOrigin in Swift and Java):
 *   1. trim U+0020 from both ends; then any UNSAFE character → null
 *   2. `https://` (scheme case-insensitive, exactly two slashes), then the
 *      authority up to the first "/", "?" or "#"
 *   3. no "@" in the authority at all (no userinfo, not even empty)
 *   4. host: lower-cased, ASCII letters, digits, "." and "-" only (so no
 *      IPv6 "[", no "%", no "_", no non-ASCII: punycode passes through)
 *   5. labels: one trailing dot is allowed and kept; otherwise no empty
 *      label (no "..", no leading "."), and no label starts or ends with "-"
 *   6. not an IP: the last label must not start with a digit (catches
 *      100.64.0.1, 2130706433 and 0x7f.1)
 *   7. port: absent or empty → 443; otherwise ASCII digits only, 1–65535
 *      by value (so 0443 is 443); 443 is not written out */
function workspaceOrigin(input: string): string | null {
  const text = input.replace(/^ +| +$/g, "");
  if (UNSAFE.test(text)) return null;
  const url = /^https:\/\/([^/?#]*)(?:[/?#].*)?$/is.exec(text);
  if (!url || url[1]!.includes("@")) return null;
  const authority = /^([^:]*)(?::([0-9]*))?$/.exec(url[1]!);
  if (!authority) return null;
  // ASCII first, then lower-case: U+212A KELVIN SIGN lower-cases to "k".
  if (!/^[A-Za-z0-9.-]+$/.test(authority[1]!)) return null;
  const host = authority[1]!.toLowerCase();
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return null;
  if (/^[0-9]/.test(labels[labels.length - 1]!)) return null;
  const port = authority[2] ? Number(authority[2]) : 443;
  if (!(port >= 1 && port <= 65535)) return null;
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** saveFile({kind:"url"}): anything but an absolute, clean URL is bad_args;
 * an absolute one off the saved origin is foreign_url (R3). */
function saveUrlOutcome(url: string, saved: string): string | undefined {
  if (UNSAFE.test(url) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return "bad_args";
  return workspaceOrigin(url) === saved ? undefined : "foreign_url";
}

/** saveFile begin/chunk/end/abort (SaveRequest.parse in Swift and Java):
 *   1. id: a string of 1–128 UTF-16 units; filename ≤ 1024 and mime ≤ 255
 *      UTF-16 units; base64 a string
 *   2. size and index: JSON integers in 0…2^31−1 (int32 on both twins), never
 *      a boolean or fraction; anything else is bad_args
 *   3. size over maxBytes, or base64 over 4 × ceil(chunkBytes / 3) UTF-16
 *      units, is too_large
 *   4. any other kind is bad_args */
function transferOutcome(request: Record<string, unknown>, channel: ChannelContract): string | undefined {
  const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
  const int32 = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 2 ** 31 - 1;
  const id = text(request.id, 128) && request.id !== "";
  switch (request.kind) {
    case "begin":
      if (!id || !text(request.filename, 1024) || !text(request.mime, 255) || !int32(request.size)) return "bad_args";
      return (request.size as number) > channel.maxBytes ? "too_large" : undefined;
    case "chunk":
      if (!id || !int32(request.index) || typeof request.base64 !== "string") return "bad_args";
      return request.base64.length > 4 * Math.ceil(channel.chunkBytes / 3) ? "too_large" : undefined;
    case "end":
    case "abort":
      return id ? undefined : "bad_args";
    default:
      return "bad_args";
  }
}

/** openExternal(url):
 *   1. any UNSAFE character (including a leading space) → refused
 *   2. scheme `^[A-Za-z][A-Za-z0-9+.-]*:`, case-insensitive, one of http,
 *      https, mailto, tel; everything else (javascript:, intent:, sms:, …)
 *      is refused
 *   3. http/https need "//" and a host: the authority after any userinfo
 *      (up to the last "@") is a non-empty host with no ":", then optionally
 *      ":" and ASCII digits (so "https://a::" is refused: no IPv6 literals)
 *   4. mailto: refused when any query parameter's name, after %XX decoding,
 *      is "attach" or "attachment" in any case */
function externalAccepted(url: string): boolean {
  if (UNSAFE.test(url)) return false;
  const parsed = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  if (!parsed) return false;
  const scheme = parsed[1]!.toLowerCase();
  const rest = parsed[2]!;
  if (scheme === "http" || scheme === "https") {
    const authority = /^\/\/([^/?#]*)/.exec(rest)?.[1];
    return authority !== undefined && /^[^:]+(?::[0-9]*)?$/.test(authority.slice(authority.lastIndexOf("@") + 1));
  }
  if (scheme === "tel") return true;
  if (scheme !== "mailto") return false;
  const query = rest.includes("?") ? rest.slice(rest.indexOf("?") + 1).split("#")[0]! : "";
  const decode = (text: string) => text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return !query.split("&").some((pair) => ["attach", "attachment"].includes(decode(pair.split("=")[0]!).toLowerCase()));
}

/** The name a saved file gets on disk (FileNames.safe in Swift and Java):
 *   1. the last non-empty component after splitting on "/" and "\"
 *   2. drop every code point of General Category Cc, Cf, Cs, Zl or Zp, and
 *      each of " * < > ? | :
 *   3. replace each run of Zs code points with one U+0020
 *   4. repeat until nothing changes: trim U+0020 from both ends, then drop
 *      leading "."
 *   5. if longer than 200 UTF-8 bytes: the extension is a final "." plus 1–10
 *      ASCII letters or digits (or nothing); cut the rest at a code-point
 *      boundary to fit 200 bytes with the extension; then, repeating until
 *      nothing changes, drop trailing U+0020 and "." from what is left; if
 *      that is empty use "download"; then put the extension back.
 *   6. empty → "download" */
function safeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).filter(Boolean).pop() ?? "";
  let name = [...last].filter((c) => !/^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}"*<>?|:]$/u.test(c)).join("").replace(/\p{Zs}+/gu, " ");
  for (let before = ""; before !== name; ) {
    before = name;
    name = name.replace(/^ +| +$/g, "").replace(/^\.+/, "");
  }
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  if (bytes(name) > 200) {
    const extension = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
    let stem = "";
    for (const c of name.slice(0, name.length - extension.length)) {
      if (bytes(stem + c) + extension.length > 200) break;
      stem += c;
    }
    name = (stem.replace(/[ .]+$/, "") || "download") + extension;
  }
  return name || "download";
}

type NavigationTarget = "main" | "sub" | "newWindow";
type NavigationDecision = "allow" | "cancel" | "sendOut" | "openHere";
interface NavigationCase { url: string; target: NavigationTarget; decision: NavigationDecision }
interface CaptureCase { requester: string | null; mainFrame: boolean | null; granted: boolean }
interface NavigationContract { origin: string; navigations: NavigationCase[]; captures: CaptureCase[] }

/** Where the workspace WebView may go (NavigationPolicy in Swift and Java):
 *   1. the scheme is `^[A-Za-z][A-Za-z0-9+.-]*:`, case-insensitive; none is ""
 *   2. a new window (window.open, target=_blank): on the saved origin (the
 *      origin rule above) it opens here, since the system browser has no
 *      session; anything else goes out through the openExternal rule
 *   3. about: only in a frame, and only about:blank and about:srcdoc (an
 *      empty iframe and the srcDoc previews), whole URL, any case; the main
 *      frame never shows an about: page (final review M7)
 *   4. blob: and data: in a frame are the CSP's business; the main frame
 *      never shows data:, and blob: only when the saved origin made it (the
 *      origin rule applied to the URL after "blob:")
 *   5. http and https in a frame are the CSP's business (frame-src); the main
 *      frame stays on the saved origin and anything else goes out
 *   6. any other scheme goes out from the main frame and is cancelled in a frame */
function navigationDecision(url: string, target: NavigationTarget, saved: string): NavigationDecision {
  const onOrigin = (text: string) => workspaceOrigin(text) === saved;
  if (target === "newWindow") return onOrigin(url) ? "openHere" : "sendOut";
  const main = target === "main";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1]!.toLowerCase() ?? "";
  if (scheme === "about") return !main && ["about:blank", "about:srcdoc"].includes(url.toLowerCase()) ? "allow" : "cancel";
  if (scheme === "blob" || scheme === "data") return !main || (scheme === "blob" && onOrigin(url.slice("blob:".length))) ? "allow" : "cancel";
  if (scheme === "https" || scheme === "http") return !main || onOrigin(url) ? "allow" : "sendOut";
  return main ? "sendOut" : "cancel";
}

/** Camera and microphone (NavigationPolicy.mayCapture): only the saved origin,
 * and never a frame. Android names no frame (null), so there the origin
 * decides alone (final review M8, carried to Plan 3). */
function mayCapture(requester: string | null, mainFrame: boolean | null, saved: string): boolean {
  return requester !== null && workspaceOrigin(requester) === saved && mainFrame !== false;
}

describe("where the workspace may navigate, as native decides it", () => {
  const navigation = contract<NavigationContract>("navigation.json");

  it.each(navigation.navigations)("$target $url: $decision", (c) => {
    expect(navigationDecision(c.url, c.target, navigation.origin)).toBe(c.decision);
  });

  it.each(navigation.captures)("camera/mic for $requester (main frame $mainFrame): $granted", (c) => {
    expect(mayCapture(c.requester, c.mainFrame, navigation.origin)).toBe(c.granted);
  });

  it("covers every target and every decision", () => {
    expect(new Set(navigation.navigations.map((c) => c.target))).toEqual(new Set(["main", "sub", "newWindow"]));
    expect(new Set(navigation.navigations.map((c) => c.decision))).toEqual(new Set(["allow", "cancel", "sendOut", "openHere"]));
  });
});

describe("the saved workspace origin, as native parses it", () => {
  it.each(contract<OriginCase[]>("origins.json"))("reads $input as $origin", (c) => {
    expect(workspaceOrigin(c.input)).toBe(c.origin);
  });
});

describe("#open= links, as native builds them", () => {
  const cases = contract<OpenHashCase[]>("open-hash.json");
  // deep-link.ts MAX_ID, counted in UTF-16 units like JavaScript's length.
  const valid = (id: string | undefined): id is string => !!id && id.length <= 512;

  it.each(cases.filter((c) => c.hash !== null))("parses $hash back to the ids native started from", (c) => {
    const expected = valid(c.messageId) ? { threadId: c.threadId, messageId: c.messageId } : { threadId: c.threadId };
    expect(parseOpenHash(c.hash!)).toEqual(expected);
  });

  it.each(cases.filter((c) => c.hash !== null))("encodes $hash byte-for-byte like URLSearchParams", (c) => {
    const params = new URLSearchParams({ open: c.threadId, ...(valid(c.messageId) ? { msg: c.messageId } : {}) });
    expect(`#${params.toString()}`).toBe(c.hash);
  });

  it.each(cases.filter((c) => c.hash === null))("refuses a thread id native will not link to: $threadId", (c) => {
    expect(parseOpenHash(`#${new URLSearchParams({ open: c.threadId })}`)).toBeNull();
  });

  it("reads an empty thread as no link at all", () => {
    expect(parseOpenHash("#open=")).toBeNull();
    expect(parseOpenHash("#open=&msg=m1")).toBeNull();
  });
});

describe("saveFile requests, as native accepts them", () => {
  const channel = contract<ChannelContract>("channel.json");
  const urlCases = channel.saves.filter((c) => c.request.kind === "url");

  it("uses the page's own chunk size and cap", () => {
    expect(channel.chunkBytes).toBe(NATIVE_SAVE_CHUNK_BYTES);
    expect(channel.maxBytes).toBe(NATIVE_SAVE_MAX_BYTES);
  });

  it.each(channel.saves.filter((c) => !c.error))("accepts a $request.kind request with exactly the page's fields", (c) => {
    const kind = c.request.kind as NativeSaveRequest["kind"];
    expect(Object.keys(c.request).sort()).toEqual(SHAPES[kind]);
  });

  it.each(channel.saves.filter((c) => c.request.kind !== "url"))("expects $error for a $request.kind request by the transfer rule", (c) => {
    expect(transferOutcome(c.request, channel)).toBe(c.error);
  });

  it.each(urlCases)("expects $error for $request.url by the origin rule", (c) => {
    expect(saveUrlOutcome(c.request.url as string, channel.origin)).toBe(c.error);
  });

  // Native refuses a kind:"url" off the saved origin with foreign_url (R3);
  // the page never classes one of those as its own server's file.
  it.each(urlCases)("routes $request.url where native expects ($error)", (c) => {
    const source = saveSource(c.request.url as string, channel.origin);
    if (c.error === "foreign_url") expect(source).not.toBe("server");
    else if (!c.error) expect(source).toBe("server");
  });

  describe("what saveUrl actually sends", () => {
    let saveFile: ReturnType<typeof vi.fn>;
    let openExternal: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      saveFile = vi.fn(async () => undefined);
      openExternal = vi.fn(async () => undefined);
      vi.stubGlobal("location", { href: `${channel.origin}/`, origin: channel.origin });
      vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile", "openExternal"] }), saveFile, openExternal });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("hello")));
    });
    afterEach(() => {
      resetNativeShellForTest();
      vi.unstubAllGlobals();
    });

    it.each(urlCases)("never sends a url request native would refuse: $request.url", async (c) => {
      await saveUrl(c.request.url as string, c.request.filename as string);
      const sent = saveFile.mock.calls.map(([request]) => request as Record<string, unknown>);
      for (const request of sent) expect(Object.keys(request).sort()).toEqual(SHAPES[request.kind as NativeSaveRequest["kind"]]);
      const byUrl = sent.filter((request) => request.kind === "url");
      if (!c.error) {
        expect(byUrl).toEqual([c.request]);
        return;
      }
      expect(byUrl).not.toContainEqual(c.request);
      if (c.error === "foreign_url") {
        expect(byUrl).toEqual([]);
        // blob:/data: bytes live in the page and go as chunks; any other
        // site opens in the system browser.
        if (saveSource(c.request.url as string, channel.origin) === "page") {
          expect(sent.map((request) => request.kind)).toEqual(["begin", "chunk", "end"]);
        } else {
          expect(openExternal).toHaveBeenCalledWith(c.request.url);
        }
      }
    });
  });

  it.each(channel.externalUrls)("lets openExternal($url) out: $accepted", (c) => {
    expect(externalAccepted(c.url)).toBe(c.accepted);
  });

  // Java must not refuse what the page sends raw: WHATWG leaves | { } ^ in a
  // query unescaped, so an accepted URL is already in the page's own form.
  it.each(channel.externalUrls.filter((c) => c.accepted))("sends openExternal($url) byte for byte", (c) => {
    expect(new URL(c.url).href).toBe(c.url);
  });
});

describe("saved file names, as native writes them", () => {
  it.each(contract<FileNameCase[]>("filenames.json"))("makes $input safe as $safe", (c) => {
    expect(safeFileName(c.input)).toBe(c.safe);
  });

  it("never writes more than 200 UTF-8 bytes", () => {
    for (const { safe } of contract<FileNameCase[]>("filenames.json")) {
      expect(new TextEncoder().encode(safe).length).toBeLessThanOrEqual(200);
    }
  });
});

describe("hello(), as native answers it", () => {
  it("keeps every method native advertises", () => {
    const channel = contract<{ version: number; methods: string[] }>("channel.json");
    expect(parseNativeHello({ version: channel.version, methods: channel.methods })).toEqual({
      version: channel.version,
      methods: channel.methods,
    });
  });
});

interface TailscaleAddressCase { address: string; tailnet: boolean }

/** Tailscale's own addresses (TailscaleAddress in Swift and Java), which tell
 * the launcher whether Tailscale is on: IPv4 100.64.0.0/10 (100.64.0.0 to
 * 100.127.255.255, also IPv4-mapped as ::ffff:6440:0/106) and IPv6
 * fd7a:115c:a1e0::/48. Native compares raw bytes;
 * here each fixture's text is turned into those bytes first. */
function addressBytes(text: string): number[] {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) return v4.slice(1).map(Number);
  const [head, tail] = text.toLowerCase().split("::") as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const left = groups(head);
  const right = groups(tail);
  const words = tail === undefined ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  expect(words, text).toHaveLength(8);
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

function isTailnetAddress(text: string): boolean {
  let b = addressBytes(text);
  // IPv4-mapped (::ffff:0:0/96) is the IPv4 inside it: Java hands it over as 4 bytes.
  if (b.length === 16 && b.slice(0, 12).join() === "0,0,0,0,0,0,0,0,0,0,255,255") b = b.slice(12);
  if (b.length === 4) return b[0] === 100 && (b[1]! & 0xc0) === 64;
  return [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0].every((byte, i) => b[i] === byte);
}

describe("Tailscale addresses, as native tells Tailscale is on", () => {
  const cases = contract<TailscaleAddressCase[]>("tailscale-address.json");

  it.each(cases)("$address is on the tailnet: $tailnet", (c) => {
    expect(isTailnetAddress(c.address)).toBe(c.tailnet);
  });

  it("covers both edges of both ranges", () => {
    const has = (address: string, tailnet: boolean) => cases.some((c) => c.address === address && c.tailnet === tailnet);
    expect(has("100.64.0.0", true) && has("100.127.255.255", true) && has("100.63.255.255", false) && has("100.128.0.0", false)).toBe(true);
    expect(has("fd7a:115c:a1e0::", true) && has("fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff", true)).toBe(true);
    expect(has("fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff", false) && has("fd7a:115c:a1e1::1", false)).toBe(true);
  });
});

it("knows approveWithDevice, which both platforms advertise", () => {
  const channel = contract<{ methods: string[] }>("channel.json");
  expect(channel.methods).toContain("approveWithDevice");
  expect(parseNativeHello({ version: 1, methods: ["approveWithDevice"] })?.methods).toEqual(["approveWithDevice"]);
});
