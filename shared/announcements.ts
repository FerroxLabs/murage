// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements: the rules for one notice, shared by the harness (which
// fetches, checks and filters the signed feed), the renderer (which draws the
// notice and its small Markdown body) and the publishing kit in
// tools/announcements/ (whose lint runs these same rules, strictly, before
// anything is signed).
//
// Plain erasable TypeScript with no imports, so Node runs it as is: the kit's
// lint imports this file directly, and the app and the kit cannot drift.
//
// The feed is data, never markup. Every field is a plain string or a value
// from a fixed list below. A value the app does not know (a layout added in a
// later release, say) falls back to a default instead of dropping the notice,
// so an older app still shows a newer notice. The lint is strict about the
// same values, so nothing unknown is published by mistake.

export const ANNOUNCEMENT_FEED_URL = "https://updates.ferroxlabs.com/murage/announcements.json";
/** Images must live here: https, our host, our folder. */
export const ANNOUNCEMENT_IMAGE_PREFIX = "https://updates.ferroxlabs.com/murage/images/";

export const ANNOUNCEMENT_KINDS = ["info", "important", "security"] as const;
/** The style packs. Each draws on both surfaces (sidebar banner, full card),
 *  so the look can change from one notice to the next without new code. */
export const ANNOUNCEMENT_LAYOUTS = ["hero", "split", "spotlight"] as const;
export const ANNOUNCEMENT_ACCENTS = ["orange", "blue", "gold", "violet", "mint", "paper"] as const;
export const ANNOUNCEMENT_PLATFORMS = ["mac", "windows", "linux"] as const;
/** In-app places a notice can send someone. Nothing else is reachable. */
export const ANNOUNCEMENT_ACTIONS = [
  "settings-general",
  "settings-models",
  "settings-connections",
  "settings-skills",
  "settings-house-rules",
  "settings-backups",
  "check-for-updates",
] as const;

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];
export type AnnouncementLayout = (typeof ANNOUNCEMENT_LAYOUTS)[number];
export type AnnouncementAccent = (typeof ANNOUNCEMENT_ACCENTS)[number];
export type AnnouncementPlatform = (typeof ANNOUNCEMENT_PLATFORMS)[number];
export type AnnouncementActionTarget = (typeof ANNOUNCEMENT_ACTIONS)[number];

export const ANNOUNCEMENT_LIMITS = {
  feedBytes: 64 * 1024,
  signatureBytes: 1024,
  imageBytes: 1024 * 1024,
  items: 20,
  id: 64,
  title: 60,
  body: 400,
  label: 30,
  imageAlt: 140,
  url: 500,
} as const;

/** Clock skew allowance on both ends of a notice's window. */
export const ANNOUNCEMENT_GRACE_MS = 60 * 60 * 1000;

export interface Announcement {
  id: string;
  kind: AnnouncementKind;
  layout: AnnouncementLayout;
  accent: AnnouncementAccent;
  title: string;
  body: string;
  image?: string;
  imageAlt?: string;
  link?: { label: string; url: string };
  action?: { label: string; target: AnnouncementActionTarget };
  appVersions?: string;
  platforms?: AnnouncementPlatform[];
  startsAt?: string;
  endsAt?: string;
}

export interface AnnouncementFeed {
  version: 1;
  issuedAt: string;
  items: Announcement[];
}

export interface AnnouncementRules {
  /** Where images may come from. Production: ANNOUNCEMENT_IMAGE_PREFIX. */
  imagePrefix?: string;
  /** The lint: unknown fields, unknown list values and copy-rule breaks are
   *  errors. The app is lenient instead, so a newer notice still shows. */
  strict?: boolean;
}

export type Checked<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const ID = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ITEM_FIELDS = new Set(["id", "kind", "layout", "accent", "title", "body", "image", "imageAlt", "link", "action", "appVersions", "platforms", "startsAt", "endsAt"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export function validAnnouncementDate(value: unknown): value is string {
  return typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value));
}

/** https only, no credentials, a real host. */
export function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > ANNOUNCEMENT_LIMITS.url) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** An image URL under the allowed prefix, with a plain file name. */
export function allowedImageUrl(value: unknown, prefix: string = ANNOUNCEMENT_IMAGE_PREFIX): value is string {
  if (typeof value !== "string" || value.length > ANNOUNCEMENT_LIMITS.url || !value.startsWith(prefix)) return false;
  const name = value.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/.test(name) || name.includes("..")) return false;
  try {
    const url = new URL(value);
    const base = new URL(prefix);
    // The prefix itself decides the scheme: production is https, and only a
    // loopback test feed ever passes an http prefix in.
    return url.origin === base.origin && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Copy rules for anything a person reads: plain words, no em or en dashes,
 *  never the word "safe", never a vendor we do not name. The lint enforces
 *  these; the app does not re-judge copy that was already signed. */
export function copyProblems(text: string): string[] {
  const problems: string[] = [];
  if (/[—–]/.test(text)) problems.push("uses an em or en dash");
  if (/\bsafe(?:ly|r|st)?\b/i.test(text)) problems.push('uses the word "safe"');
  if (/composio/i.test(text)) problems.push("names Composio");
  if (/<[a-z/!]/i.test(text)) problems.push("contains HTML");
  return problems;
}

// ── Version ranges ─────────────────────────────────────────────────────────
// A small, exact subset of semver ranges: "*", or sets of comparators
// (">=0.1.60 <0.2.0") joined by "||". Enough to target releases, and small
// enough to read in one sitting.

type Version = { main: [number, number, number]; pre: string };
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.]{1,16}))?$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,16})?)$/;

function parseVersion(value: string): Version | null {
  const match = VERSION.exec(value);
  if (!match) return null;
  return { main: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" };
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index++) {
    const delta = a.main[index]! - b.main[index]!;
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function rangeSets(range: string): Array<Array<{ op: string; version: Version }>> | null {
  const trimmed = range.trim();
  if (!trimmed || trimmed.length > 100) return null;
  if (trimmed === "*") return [[]];
  const sets: Array<Array<{ op: string; version: Version }>> = [];
  for (const part of trimmed.split("||")) {
    const comparators = part.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return null;
    const set: Array<{ op: string; version: Version }> = [];
    for (const text of comparators) {
      const match = COMPARATOR.exec(text);
      const version = match ? parseVersion(match[2]!) : null;
      if (!match || !version) return null;
      set.push({ op: match[1] ?? "=", version });
    }
    sets.push(set);
  }
  return sets;
}

export function validVersionRange(range: unknown): range is string {
  return typeof range === "string" && rangeSets(range) !== null;
}

export function versionInRange(version: string, range: string): boolean {
  const sets = rangeSets(range);
  const parsed = parseVersion(version);
  if (!sets || !parsed) return false;
  return sets.some((set) => set.every(({ op, version: bound }) => {
    const order = compare(parsed, bound);
    switch (op) {
      case ">=": return order >= 0;
      case "<=": return order <= 0;
      case ">": return order > 0;
      case "<": return order < 0;
      default: return order === 0;
    }
  }));
}

// ── One notice ─────────────────────────────────────────────────────────────

export function checkAnnouncement(raw: unknown, rules: AnnouncementRules = {}): Checked<Announcement> {
  const strict = rules.strict === true;
  const prefix = rules.imagePrefix ?? ANNOUNCEMENT_IMAGE_PREFIX;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["a notice must be an object"] };
  const at = typeof raw.id === "string" ? `${raw.id}: ` : "";
  const fail = (message: string) => errors.push(at + message);

  if (strict) for (const key of Object.keys(raw)) if (!ITEM_FIELDS.has(key)) fail(`unknown field "${key}"`);
  if (typeof raw.id !== "string" || raw.id.length > ANNOUNCEMENT_LIMITS.id || !ID.test(raw.id)) fail("id must be lowercase letters, digits and dashes, up to 64");
  if (!oneOf(ANNOUNCEMENT_KINDS, raw.kind)) fail(`kind must be one of ${ANNOUNCEMENT_KINDS.join(", ")}`);
  if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > ANNOUNCEMENT_LIMITS.title) fail(`title is required, up to ${ANNOUNCEMENT_LIMITS.title} characters`);
  if (typeof raw.body !== "string" || !raw.body.trim() || raw.body.length > ANNOUNCEMENT_LIMITS.body) fail(`body is required, up to ${ANNOUNCEMENT_LIMITS.body} characters`);

  let layout: AnnouncementLayout = raw.image === undefined ? "spotlight" : "hero";
  if (raw.layout !== undefined) {
    if (oneOf(ANNOUNCEMENT_LAYOUTS, raw.layout)) layout = raw.layout;
    else if (strict) fail(`layout must be one of ${ANNOUNCEMENT_LAYOUTS.join(", ")}`);
    else warnings.push(`${at}unknown layout, using ${layout}`);
  }
  let accent: AnnouncementAccent = "orange";
  if (raw.accent !== undefined) {
    if (oneOf(ANNOUNCEMENT_ACCENTS, raw.accent)) accent = raw.accent;
    else if (strict) fail(`accent must be one of ${ANNOUNCEMENT_ACCENTS.join(", ")}`);
    else warnings.push(`${at}unknown accent, using orange`);
  }

  if (raw.image !== undefined) {
    if (!allowedImageUrl(raw.image, prefix)) fail(`image must be a .png, .jpg or .webp under ${prefix}`);
    if (typeof raw.imageAlt !== "string" || !raw.imageAlt.trim() || raw.imageAlt.length > ANNOUNCEMENT_LIMITS.imageAlt) fail(`imageAlt is required with an image, up to ${ANNOUNCEMENT_LIMITS.imageAlt} characters`);
  } else if (raw.imageAlt !== undefined && strict) {
    fail("imageAlt without an image");
  } else if (layout !== "spotlight" && strict) {
    fail(`layout ${layout} needs an image; use spotlight for a notice without one`);
  }

  if (raw.link !== undefined && raw.action !== undefined) fail("use a link or an action, not both");
  if (raw.link !== undefined) {
    const link = raw.link;
    if (!isRecord(link) || typeof link.label !== "string" || !link.label.trim() || link.label.length > ANNOUNCEMENT_LIMITS.label || !httpsUrl(link.url)) {
      fail(`link needs a label (up to ${ANNOUNCEMENT_LIMITS.label}) and an https url`);
    } else if (strict && Object.keys(link).some((key) => key !== "label" && key !== "url")) fail("link has an unknown field");
  }
  if (raw.action !== undefined) {
    const action = raw.action;
    if (!isRecord(action) || typeof action.label !== "string" || !action.label.trim() || action.label.length > ANNOUNCEMENT_LIMITS.label || !oneOf(ANNOUNCEMENT_ACTIONS, action.target)) {
      fail(`action needs a label (up to ${ANNOUNCEMENT_LIMITS.label}) and a target from: ${ANNOUNCEMENT_ACTIONS.join(", ")}`);
    } else if (strict && Object.keys(action).some((key) => key !== "label" && key !== "target")) fail("action has an unknown field");
  }

  if (raw.appVersions !== undefined && !validVersionRange(raw.appVersions)) fail('appVersions must be a range like ">=0.1.60 <0.2.0"');
  if (raw.platforms !== undefined) {
    if (!Array.isArray(raw.platforms) || !raw.platforms.length || !raw.platforms.every((platform) => oneOf(ANNOUNCEMENT_PLATFORMS, platform))) {
      fail(`platforms must be a list from: ${ANNOUNCEMENT_PLATFORMS.join(", ")}`);
    }
  }
  for (const key of ["startsAt", "endsAt"] as const) {
    if (raw[key] !== undefined && !validAnnouncementDate(raw[key])) fail(`${key} must be a date and time like 2026-10-01T09:00:00Z`);
  }
  if (validAnnouncementDate(raw.startsAt) && validAnnouncementDate(raw.endsAt) && Date.parse(raw.endsAt) <= Date.parse(raw.startsAt)) fail("endsAt must be after startsAt");

  if (strict) {
    const texts: Array<[string, unknown]> = [["title", raw.title], ["body", raw.body], ["imageAlt", raw.imageAlt]];
    if (isRecord(raw.link)) texts.push(["link label", raw.link.label]);
    if (isRecord(raw.action)) texts.push(["action label", raw.action.label]);
    for (const [field, text] of texts) if (typeof text === "string") for (const problem of copyProblems(text)) fail(`${field} ${problem}`);
    if (typeof raw.body === "string") for (const problem of bodyProblems(raw.body)) fail(`body ${problem}`);
  }

  if (errors.length) return { ok: false, errors };
  const item: Announcement = {
    id: raw.id as string,
    kind: raw.kind as AnnouncementKind,
    layout,
    accent,
    title: (raw.title as string).trim(),
    body: (raw.body as string).trim(),
  };
  if (raw.image !== undefined) { item.image = raw.image as string; item.imageAlt = (raw.imageAlt as string).trim(); }
  if (isRecord(raw.link)) item.link = { label: (raw.link.label as string).trim(), url: raw.link.url as string };
  if (isRecord(raw.action)) item.action = { label: (raw.action.label as string).trim(), target: raw.action.target as AnnouncementActionTarget };
  if (raw.appVersions !== undefined) item.appVersions = raw.appVersions as string;
  if (raw.platforms !== undefined) item.platforms = [...new Set(raw.platforms as AnnouncementPlatform[])];
  if (raw.startsAt !== undefined) item.startsAt = raw.startsAt as string;
  if (raw.endsAt !== undefined) item.endsAt = raw.endsAt as string;
  return { ok: true, value: item, warnings };
}

/** The feed as a whole. A single bad notice is dropped (and named in
 *  `warnings`); a bad envelope rejects the feed. The lint treats a dropped
 *  notice as an error, since strict mode returns errors for it. */
export function checkAnnouncementFeed(input: string | Uint8Array, rules: AnnouncementRules = {}): Checked<AnnouncementFeed> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > ANNOUNCEMENT_LIMITS.feedBytes) return { ok: false, errors: [`the feed is over ${ANNOUNCEMENT_LIMITS.feedBytes} bytes`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, errors: ["the feed is not valid JSON"] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: ["the feed must be an object"] };
  if (parsed.version !== 1) return { ok: false, errors: ["the feed version must be 1"] };
  if (!validAnnouncementDate(parsed.issuedAt)) return { ok: false, errors: ["issuedAt must be a date and time"] };
  if (!Array.isArray(parsed.items)) return { ok: false, errors: ["items must be a list"] };
  if (parsed.items.length > ANNOUNCEMENT_LIMITS.items) return { ok: false, errors: [`at most ${ANNOUNCEMENT_LIMITS.items} notices`] };
  if (rules.strict) for (const key of Object.keys(parsed)) if (!["version", "issuedAt", "items"].includes(key)) return { ok: false, errors: [`unknown field "${key}"`] };

  const items: Announcement[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.items) {
    const checked = checkAnnouncement(raw, rules);
    if (!checked.ok) { (rules.strict ? errors : warnings).push(...checked.errors); continue; }
    if (seen.has(checked.value.id)) { (rules.strict ? errors : warnings).push(`${checked.value.id}: the same id appears twice`); continue; }
    seen.add(checked.value.id);
    warnings.push(...checked.warnings);
    items.push(checked.value);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { version: 1, issuedAt: parsed.issuedAt, items }, warnings };
}

// ── Who sees what ──────────────────────────────────────────────────────────

const KIND_RANK: Record<AnnouncementKind, number> = { security: 3, important: 2, info: 1 };

export function platformName(platform: string): AnnouncementPlatform | null {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return null;
}

export interface AnnouncementAudience {
  version: string;
  platform: AnnouncementPlatform | null;
  now: number;
  dismissed: ReadonlySet<string>;
  /** Settings > General > Show announcements. Off hides info and important,
   *  never security. */
  showOptional: boolean;
}

/** The notices this install should see now, most urgent first, then newest. */
export function visibleAnnouncements(items: readonly Announcement[], audience: AnnouncementAudience): Announcement[] {
  const shown = items.filter((item) => {
    if (audience.dismissed.has(item.id)) return false;
    if (!audience.showOptional && item.kind !== "security") return false;
    if (item.appVersions !== undefined && !versionInRange(audience.version, item.appVersions)) return false;
    if (item.platforms !== undefined && (!audience.platform || !item.platforms.includes(audience.platform))) return false;
    if (item.startsAt !== undefined && audience.now < Date.parse(item.startsAt) - ANNOUNCEMENT_GRACE_MS) return false;
    if (item.endsAt !== undefined && audience.now > Date.parse(item.endsAt) + ANNOUNCEMENT_GRACE_MS) return false;
    return true;
  });
  const started = (item: Announcement) => (item.startsAt ? Date.parse(item.startsAt) : 0);
  return shown
    .map((item, index) => ({ item, index }))
    .sort((a, b) => KIND_RANK[b.item.kind] - KIND_RANK[a.item.kind] || started(b.item) - started(a.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** Which surface a notice takes: info is a sidebar banner, the rest a card. */
export function announcementSurface(item: Pick<Announcement, "kind">): "banner" | "card" {
  return item.kind === "info" ? "banner" : "card";
}

// ── The body: a small Markdown subset ──────────────────────────────────────
// Paragraphs (split on a blank line), **bold**, and [label](https://link).
// Everything else is literal text. Nothing here produces markup: the renderer
// turns these pieces into elements, so no string is ever parsed as HTML.

export type AnnouncementInline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "link"; text: string; href: string };

const INLINE = /\*\*([^*\n]+?)\*\*|\[([^\]\n]{1,120})\]\(([^()\s]{1,500})\)/g;

export function parseAnnouncementBody(body: string): AnnouncementInline[][] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((paragraph) => {
      const pieces: AnnouncementInline[] = [];
      const push = (piece: AnnouncementInline) => {
        const last = pieces[pieces.length - 1];
        if (piece.type === "text" && last?.type === "text") last.text += piece.text;
        else if (piece.text) pieces.push(piece);
      };
      let cursor = 0;
      for (const match of paragraph.matchAll(INLINE)) {
        push({ type: "text", text: paragraph.slice(cursor, match.index) });
        if (match[1] !== undefined) push({ type: "bold", text: match[1] });
        else if (httpsUrl(match[3])) push({ type: "link", text: match[2]!, href: match[3]! });
        else push({ type: "text", text: match[2]! });
        cursor = match.index! + match[0].length;
      }
      push({ type: "text", text: paragraph.slice(cursor) });
      return pieces;
    });
}

/** What the lint says about a body the parser would quietly flatten. */
export function bodyProblems(body: string): string[] {
  const problems: string[] = [];
  for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)]*)\)/g)) if (!httpsUrl(match[1])) problems.push(`has a link that is not https: ${match[1]}`);
  if (/^\s{0,3}(?:#|[-*+]\s|\d+\.\s|>)/m.test(body)) problems.push("uses Markdown this feed does not support (headings, lists, quotes)");
  if (/`/.test(body)) problems.push("uses code formatting, which this feed does not support");
  return problems;
}
