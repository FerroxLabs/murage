// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements: short notices from the Murage team, fetched from one fixed
// signed file and filtered here, on this computer.
//
// What goes out: one GET for announcements.json and one for its .sig, with no
// query string, no cookies, no account, no version and a plain user agent. At
// launch and every six hours, ten seconds each, 64 KB at most. Everything
// about who sees what (version, platform, dates, dismissals, the Settings
// switch) is decided locally from the file everyone gets.
//
// What is trusted: only bytes whose Ed25519 signature checks against a key
// compiled in below (two slots, so a key can be rotated). The last good copy
// is kept in DATA_DIR/announcements-cache/ exactly as it was signed and is
// checked again when it is read, so an edited cache is as dead as an edited
// download. A feed older than the one already held (issuedAt) is ignored, and
// no failure ever replaces a good copy with nothing.
//
// Images come only from updates.ferroxlabs.com/murage/images/, are fetched by
// this server once, sniffed for PNG, JPEG or WebP, and handed to the renderer
// from the cache. The renderer never touches the network for a notice.
//
// Desktop only (routes gated in index.ts).
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import {
  ANNOUNCEMENT_FEED_URL,
  ANNOUNCEMENT_IMAGE_PREFIX,
  ANNOUNCEMENT_LIMITS,
  checkAnnouncementFeed,
  platformName,
  visibleAnnouncements,
  type Announcement,
  type AnnouncementFeed,
} from "../shared/announcements.ts";

/**
 * The production public keys, base64 of the raw 32-byte Ed25519 key.
 *
 * PLACEHOLDERS. Neither slot holds a key yet, so no signature can check and
 * the app fetches nothing: it fails closed until the owner pastes the real
 * public key into slot 1 (tools/announcements/README.md, "Keys"). Slot 2 is
 * for the next key during a rotation.
 */
export const ANNOUNCEMENT_PUBLIC_KEYS: readonly string[] = [
  "PLACEHOLDER-SLOT-1-PASTE-THE-PRODUCTION-PUBLIC-KEY-HERE",
  "PLACEHOLDER-SLOT-2-EMPTY-UNTIL-A-KEY-ROTATION",
];

export const ANNOUNCEMENT_REFRESH_MS = 6 * 60 * 60 * 1000;
export const ANNOUNCEMENT_TIMEOUT_MS = 10_000;
const RECORD_FILE = "announcements.json";
const CACHE_DIR = "announcements-cache";
const FEED_FILE = "feed.json";
const SIG_FILE = "feed.json.sig";
const IMAGE_DIR = "images";
const DISMISSED_MAX = 200;
const IMAGE_ID = /^[0-9a-f]{64}$/;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
type ImageExt = keyof typeof IMAGE_TYPES;

/** Raw base64 keys to key objects; anything that is not a 32-byte key (the
 *  placeholders included) is skipped, never guessed at. */
export function announcementKeys(slots: readonly string[]): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const slot of slots) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(slot.trim())) continue;
    const raw = Buffer.from(slot.trim(), "base64");
    if (raw.length !== 32) continue;
    try {
      keys.push(createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" }));
    } catch {
      // not a usable key; the slot is skipped
    }
  }
  return keys;
}

/** Does `signature` (base64 text, as in the .sig file) sign exactly `bytes`
 *  under any of `keys`? */
export function verifyAnnouncementSignature(bytes: Uint8Array, signature: string | Uint8Array, keys: readonly KeyObject[]): boolean {
  const text = (typeof signature === "string" ? signature : Buffer.from(signature).toString("utf8")).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;
  const raw = Buffer.from(text, "base64");
  if (raw.length !== 64) return false;
  return keys.some((key) => {
    try {
      return verify(null, bytes, key, raw);
    } catch {
      return false;
    }
  });
}

export interface AnnouncementSource {
  feedUrl: string;
  signatureUrl: string;
  imagePrefix: string;
  keys: KeyObject[];
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where the feed comes from, or null when nothing should be fetched.
 *
 * Test seam, like MURAGE_FLUX_SEARCH_API: MURAGE_ANNOUNCEMENTS_URL points at a
 * local stub feed, and MURAGE_ANNOUNCEMENTS_TEST_KEY names the test key that
 * signs it. Both are honoured only for a loopback address; images then come
 * from the stub's own /murage/images/. "off" fetches nothing.
 */
export function announcementSource(env: NodeJS.ProcessEnv = process.env, slots: readonly string[] = ANNOUNCEMENT_PUBLIC_KEYS): AnnouncementSource | null {
  const override = env.MURAGE_ANNOUNCEMENTS_URL?.trim();
  if (override === "off") return null;
  if (override) {
    let url: URL | null = null;
    try { url = new URL(override); } catch { url = null; }
    if (url && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname) && !url.search && !url.hash) {
      const keys = announcementKeys([env.MURAGE_ANNOUNCEMENTS_TEST_KEY ?? ""]);
      return keys.length ? { feedUrl: url.href, signatureUrl: `${url.href}.sig`, imagePrefix: `${url.origin}/murage/images/`, keys } : null;
    }
    console.warn("MURAGE_ANNOUNCEMENTS_URL is only honoured for a loopback test feed; using the real feed.");
  }
  const keys = announcementKeys(slots);
  // No key, nothing could ever verify: do not even ask.
  if (!keys.length) return null;
  return { feedUrl: ANNOUNCEMENT_FEED_URL, signatureUrl: `${ANNOUNCEMENT_FEED_URL}.sig`, imagePrefix: ANNOUNCEMENT_IMAGE_PREFIX, keys };
}

type Fetch = typeof fetch;

/** GET with nothing that identifies this install, no redirects, a deadline
 *  and a hard byte cap that holds even when the server lies about length. */
export async function fetchCapped(url: string, maxBytes: number, options: { fetchImpl?: Fetch; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ANNOUNCEMENT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { accept: "*/*", "user-agent": "Murage" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("too large");
    if (!response.body) throw new Error("empty");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

function imageExt(bytes: Uint8Array): ImageExt | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP") return "webp";
  return null;
}

export const announcementImageId = (url: string) => createHash("sha256").update(url).digest("hex");

export interface AnnouncementRecord {
  dismissed: string[];
  show: boolean;
}

/** What the renderer gets for one notice: the image, when there is one and it
 *  is cached, as a local route. */
export type AnnouncementView = Omit<Announcement, "image" | "appVersions" | "platforms" | "startsAt" | "endsAt"> & { image?: string };

export interface AnnouncementsOptions {
  dir?: string;
  source: AnnouncementSource | null;
  fetchImpl?: Fetch;
  now?: () => number;
  platform?: string;
}

export class Announcements {
  private readonly dir: string;
  private readonly source: AnnouncementSource | null;
  private readonly fetchImpl?: Fetch;
  private readonly now: () => number;
  private readonly platform: string;
  private feed: AnnouncementFeed | null = null;
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AnnouncementsOptions) {
    this.dir = options.dir ?? DATA_DIR;
    this.source = options.source;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.feed = this.readCache();
  }

  private get cacheDir() { return join(this.dir, CACHE_DIR); }

  /** The cached copy, checked again: a cache that no longer verifies (edited,
   *  or signed by a key that has been rotated out) counts as none. */
  private readCache(): AnnouncementFeed | null {
    if (!this.source) return null;
    try {
      const bytes = readFileSync(join(this.cacheDir, FEED_FILE));
      const signature = readFileSync(join(this.cacheDir, SIG_FILE), "utf8");
      if (!verifyAnnouncementSignature(bytes, signature, this.source.keys)) return null;
      const checked = checkAnnouncementFeed(bytes, { imagePrefix: this.source.imagePrefix });
      return checked.ok ? checked.value : null;
    } catch {
      return null;
    }
  }

  current(): AnnouncementFeed | null { return this.feed; }

  /** Fetch, verify, keep. Resolves true when a newer good copy was taken.
   *  Never throws: a failure keeps what is held and says nothing. */
  refresh(): Promise<boolean> {
    if (!this.source) return Promise.resolve(false);
    this.inFlight ??= this.fetchAndKeep(this.source).catch(() => false).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetchAndKeep(source: AnnouncementSource): Promise<boolean> {
    const options = { fetchImpl: this.fetchImpl };
    const [bytes, signature] = await Promise.all([
      fetchCapped(source.feedUrl, ANNOUNCEMENT_LIMITS.feedBytes, options),
      fetchCapped(source.signatureUrl, ANNOUNCEMENT_LIMITS.signatureBytes, options),
    ]);
    if (!verifyAnnouncementSignature(bytes, signature, source.keys)) return false;
    const checked = checkAnnouncementFeed(bytes, { imagePrefix: source.imagePrefix });
    if (!checked.ok) return false;
    const held = this.feed;
    if (held && Date.parse(checked.value.issuedAt) < Date.parse(held.issuedAt)) return false;
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    // The signature last: a crash between the two leaves a pair that does not
    // verify, which reads as no cache, never as a wrong one.
    writeFileAtomic(join(this.cacheDir, FEED_FILE), bytes, { mode: 0o600 });
    writeFileAtomic(join(this.cacheDir, SIG_FILE), Buffer.from(signature).toString("utf8").trim() + "\n", { mode: 0o600 });
    this.feed = checked.value;
    await this.cacheImages(checked.value);
    return true;
  }

  private imagePath(id: string): { path: string; ext: ImageExt } | null {
    for (const ext of Object.keys(IMAGE_TYPES) as ImageExt[]) {
      const path = join(this.cacheDir, IMAGE_DIR, `${id}.${ext}`);
      if (existsSync(path)) return { path, ext };
    }
    return null;
  }

  private async cacheImages(feed: AnnouncementFeed): Promise<void> {
    const dir = join(this.cacheDir, IMAGE_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const wanted = new Set<string>();
    for (const item of feed.items) {
      if (!item.image) continue;
      const id = announcementImageId(item.image);
      wanted.add(id);
      if (this.imagePath(id)) continue;
      try {
        const bytes = await fetchCapped(item.image, ANNOUNCEMENT_LIMITS.imageBytes, { fetchImpl: this.fetchImpl });
        const ext = imageExt(bytes);
        if (ext) writeFileAtomic(join(dir, `${id}.${ext}`), bytes, { mode: 0o600 });
      } catch {
        // No picture: the notice still shows, without it.
      }
    }
    for (const name of readdirSync(dir)) {
      const id = name.split(".")[0] ?? "";
      if (!wanted.has(id)) {
        try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
      }
    }
  }

  /** Bytes and type for a cached image, by id. */
  image(id: string): { bytes: Buffer; contentType: string } | null {
    if (!IMAGE_ID.test(id)) return null;
    const found = this.imagePath(id);
    if (!found) return null;
    try {
      return { bytes: readFileSync(found.path), contentType: IMAGE_TYPES[found.ext] };
    } catch {
      return null;
    }
  }

  readRecord(): AnnouncementRecord {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, RECORD_FILE), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { dismissed: [], show: true };
      const raw = parsed as Record<string, unknown>;
      const dismissed = Array.isArray(raw.dismissed) ? raw.dismissed.filter((id): id is string => typeof id === "string" && id.length <= ANNOUNCEMENT_LIMITS.id) : [];
      return { dismissed, show: raw.show !== false };
    } catch {
      return { dismissed: [], show: true };
    }
  }

  private writeRecord(record: AnnouncementRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const dismissed = [...new Set(record.dismissed)].slice(-DISMISSED_MAX);
    writeFileAtomic(join(this.dir, RECORD_FILE), JSON.stringify({ dismissed, show: record.show }, null, 2) + "\n", { mode: 0o600 });
  }

  dismiss(id: string): void {
    const record = this.readRecord();
    if (!record.dismissed.includes(id)) this.writeRecord({ ...record, dismissed: [...record.dismissed, id] });
  }

  setShow(show: boolean): AnnouncementRecord {
    const record = { ...this.readRecord(), show };
    this.writeRecord(record);
    return record;
  }

  /** The notices for this install now, most urgent first. */
  visible(version: string): AnnouncementView[] {
    if (!this.feed) return [];
    const record = this.readRecord();
    return visibleAnnouncements(this.feed.items, {
      version,
      platform: platformName(this.platform),
      now: this.now(),
      dismissed: new Set(record.dismissed),
      showOptional: record.show,
    }).map(({ image, appVersions: _versions, platforms: _platforms, startsAt: _starts, endsAt: _ends, ...rest }) => {
      const id = image ? announcementImageId(image) : null;
      return id && this.imagePath(id) ? { ...rest, image: `/api/announcements/image/${id}` } : rest;
    });
  }

  /** At launch and every six hours while running. */
  start(intervalMs: number = ANNOUNCEMENT_REFRESH_MS): void {
    if (!this.source || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

type ApiAnswer = { status: number; body: unknown } | { status: 200; bytes: Buffer; contentType: string };

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,16})?$/;

export async function handleAnnouncementsApi(
  request: { method: string; path: string; version?: string | null; readBody: () => Promise<unknown> },
  service: Announcements,
): Promise<ApiAnswer | null> {
  const { method, path } = request;
  const body = async (): Promise<Record<string, unknown> | null> => {
    try {
      const value = await request.readBody();
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  if (path === "/api/announcements") {
    if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
    if (typeof request.version !== "string" || !VERSION.test(request.version)) return { status: 400, body: { error: "Send the app version, like ?version=0.1.60." } };
    return { status: 200, body: { show: service.readRecord().show, items: service.visible(request.version) } };
  }
  if (path === "/api/announcements/dismiss") {
    if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    const sent = await body();
    if (!sent || typeof sent.id !== "string" || !sent.id || sent.id.length > ANNOUNCEMENT_LIMITS.id || Object.keys(sent).length !== 1) return { status: 400, body: { error: "Send { id }." } };
    service.dismiss(sent.id);
    return { status: 200, body: { ok: true } };
  }
  if (path === "/api/announcements/settings") {
    if (method === "GET") return { status: 200, body: { show: service.readRecord().show } };
    if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    const sent = await body();
    if (!sent || typeof sent.show !== "boolean" || Object.keys(sent).length !== 1) return { status: 400, body: { error: "Send { show: true } or { show: false }." } };
    return { status: 200, body: { show: service.setShow(sent.show).show } };
  }
  const image = /^\/api\/announcements\/image\/([^/]+)$/.exec(path);
  if (image) {
    if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
    const found = service.image(image[1]!);
    return found ? { status: 200, bytes: found.bytes, contentType: found.contentType } : { status: 404, body: { error: "no such image" } };
  }
  return null;
}
