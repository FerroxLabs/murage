// SPDX-License-Identifier: AGPL-3.0-or-later
// The approved-sites list for Murage for Chrome (spec 2.3): one rule per bot, per browser profile and
// origin, kept in DATA_DIR/browser-extension/sites.json. The folder is a reserved component, so the
// file is never backed up and never restored (data-dir-inventory.ts BROWSER_EXTENSION_FILES).
//
// Nothing reads this store yet: the permission service takes it up later. Until then it only holds
// what the owner chose and what a version 1 state.json carried (migrateFromBindings, spec 8).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPrivateWindowsDirectory, readPrivateWindowsJson, writePrivateWindowsJson } from "../electron/browser-extension-windows.mjs";

export type SiteRule = "allow" | "ask" | "never";
export interface SiteRecord { origin: string; rule: SiteRule; /** An owner-lowered ask-every-step site (spec 2.3). Only meaningful with rule "ask". */ lowered?: true }
/** A version 1 "allow": read access to one origin for one task on one binding, for the task layer to turn into a grant. */
export interface OneTaskGrant { botId: string; profileId: string; bindingId: string; origin: string; level: 1 }
export interface MigrationResult { promoted: number; dropped: number; grants: OneTaskGrant[] }

/** A message the owner can read as it is. `code` is for tests and logs. */
export class BrowserExtensionSitesError extends Error {
  readonly code: string;
  /** Locale key (src/locales/*.json) for the owner-facing message; `message` is its English text. */
  readonly key: string;
  constructor(code: string, key: SitesMessageKey) { super(SITES_MESSAGES[key]); this.code = code; this.key = key; this.name = "BrowserExtensionSitesError"; }
}

const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS_PER_PROFILE = 2000;
const MAX_STATE_BINDINGS = 256;
const ID = /^[\w-]{1,128}$/;
const RULES: readonly string[] = ["allow", "ask", "never"];
/** Owner-facing messages by locale key. The English equals src/locales/en.json (a test holds them together). */
export const SITES_MESSAGES = {
  "browserExt.sites.errorNewer": "The approved sites list was saved by a newer version of Murage, so this version leaves it alone. Update Murage to use it.",
  "browserExt.sites.errorUnreadable": "Murage could not read the approved sites list, so it did not use it. Nothing was changed.",
  "browserExt.sites.errorAddress": "That is not a web address Murage can remember.",
  "browserExt.sites.errorScheme": "Only http and https sites can be approved.",
  "browserExt.sites.errorBotId": "That bot is not valid.",
  "browserExt.sites.errorProfileId": "That browser profile is not valid.",
  "browserExt.sites.errorRule": "That is not a site setting Murage knows.",
  "browserExt.sites.errorLowered": "Only an Ask site can be lowered.",
  "browserExt.sites.errorTooMany": "That is more sites than Murage keeps for one browser. Remove some first.",
  "browserExt.sites.errorOldRecord": "Murage could not read the old browser connection record, so nothing was moved. Nothing was changed.",
  "browserExt.sites.errorOldRecordNewer": "The browser connection record was saved by a newer version of Murage, so this version leaves it alone. Update Murage to use it.",
} as const;
export type SitesMessageKey = keyof typeof SITES_MESSAGES;
const fail = (code: string, key: SitesMessageKey = "browserExt.sites.errorUnreadable"): never => { throw new BrowserExtensionSitesError(code, key); };

/** `https://Example.com/a?b` becomes `https://example.com`; anything that is not a web origin is refused. */
export function normalizeSiteOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) return fail("invalid_origin", "browserExt.sites.errorAddress");
  let url: URL;
  try { url = new URL(raw); } catch { return fail("invalid_origin", "browserExt.sites.errorAddress"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return fail("invalid_origin", "browserExt.sites.errorScheme");
  return url.origin;
}
const checkId = (value: unknown, key: SitesMessageKey): string => typeof value === "string" && ID.test(value) ? value : fail("invalid_id", key);

type Rows = Map<string, { rule: SiteRule; lowered?: true }>;

export class BrowserExtensionSites {
  // botId -> profileId -> origin -> row. Maps, so no id can reach Object.prototype.
  private readonly data = new Map<string, Map<string, Rows>>();

  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!path.isAbsolute(file)) fail("invalid_path");
    this.load();
  }

  get(botId: string, profileId: string, origin: string): SiteRecord | undefined {
    const normal = normalizeSiteOrigin(origin);
    const row = this.data.get(botId)?.get(profileId)?.get(normal);
    return row ? { origin: normal, ...row } : undefined;
  }

  list(botId: string, profileId: string): SiteRecord[] {
    return [...(this.data.get(botId)?.get(profileId) ?? [])].map(([origin, row]) => ({ origin, ...row }));
  }

  set(botId: string, profileId: string, origin: string, rule: SiteRule, options: { lowered?: boolean } = {}): SiteRecord {
    this.put(botId, profileId, origin, rule, options.lowered === true);
    this.save();
    return this.get(botId, profileId, origin)!;
  }

  /** Spec 8. Never rows are promoted (the stricter choice is never a surprise); an allow is NOT
   * promoted to Allow always but handed back as a one-task read grant on that same binding (never for a
   * stopped or retired task, and never where a Never now stands); an ask is dropped, Ask being the default.
   * Safe to run twice. Fails closed on a state it does not know. */
  migrateFromBindings(state: unknown): MigrationResult {
    const root = state as { version?: unknown; bindings?: unknown } | null;
    if (!root || typeof root !== "object" || Array.isArray(root) || typeof root.version !== "number") return fail("invalid_state", "browserExt.sites.errorOldRecord");
    if (root.version !== 1) return fail("unknown_state_version", root.version > 1 ? "browserExt.sites.errorOldRecordNewer" : "browserExt.sites.errorOldRecord");
    if (!Array.isArray(root.bindings) || root.bindings.length > MAX_STATE_BINDINGS) return fail("invalid_state", "browserExt.sites.errorOldRecord");
    let promoted = 0, dropped = 0;
    const wanted: OneTaskGrant[] = [];
    for (const binding of root.bindings as { context?: Record<string, unknown>; state?: unknown; sites?: unknown; retired?: unknown }[]) {
      const context = binding?.context;
      if (!context || typeof context !== "object" || !binding.sites || typeof binding.sites !== "object") continue;
      const { botId, profileId, bindingId } = context;
      if (typeof botId !== "string" || !ID.test(botId) || typeof profileId !== "string" || !ID.test(profileId) || typeof bindingId !== "string" || !ID.test(bindingId)) continue;
      const live = binding.state !== "stopped" && binding.retired !== true;
      for (const [rawOrigin, access] of Object.entries(binding.sites as Record<string, unknown>)) {
        let origin: string;
        try { origin = normalizeSiteOrigin(rawOrigin); } catch { continue; }
        if (access === "never") {
          if (this.data.get(botId)?.get(profileId)?.get(origin)?.rule !== "never") { this.put(botId, profileId, origin, "never", false); promoted++; }
        } else if (access === "allow") { if (live) wanted.push({ botId, profileId, bindingId, origin, level: 1 }); }
        else if (access === "ask") dropped++;
      }
    }
    const grants = wanted.filter((grant, index) => this.data.get(grant.botId)?.get(grant.profileId)?.get(grant.origin)?.rule !== "never"
      && wanted.findIndex(other => other.bindingId === grant.bindingId && other.origin === grant.origin) === index);
    this.save();
    return { promoted, dropped, grants };
  }

  private put(botId: string, profileId: string, origin: string, rule: SiteRule, lowered: boolean) {
    checkId(botId, "browserExt.sites.errorBotId"); checkId(profileId, "browserExt.sites.errorProfileId");
    const normal = normalizeSiteOrigin(origin);
    if (!RULES.includes(rule)) fail("invalid_rule", "browserExt.sites.errorRule");
    if (lowered && rule !== "ask") fail("invalid_rule", "browserExt.sites.errorLowered");
    let profiles = this.data.get(botId); if (!profiles) this.data.set(botId, profiles = new Map());
    let rows = profiles.get(profileId); if (!rows) profiles.set(profileId, rows = new Map());
    if (!rows.has(normal) && rows.size >= MAX_ROWS_PER_PROFILE) fail("too_many_sites", "browserExt.sites.errorTooMany");
    rows.set(normal, { rule, ...(lowered ? { lowered: true as const } : {}) });
  }

  private load() {
    const win = process.platform === "win32";
    const parent = path.dirname(this.file);
    if (win) createPrivateWindowsDirectory(parent); else fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (!win && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) fail("unsafe_file");
    let parsed: unknown;
    try { parsed = win ? readPrivateWindowsJson(this.file) : JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return fail("invalid_file"); }
    const root = parsed as { version?: unknown; sites?: unknown } | null;
    if (!root || typeof root !== "object" || Array.isArray(root)) return fail("invalid_file");
    if (typeof root.version === "number" && root.version > FORMAT_VERSION) return fail("newer_version", "browserExt.sites.errorNewer");
    if (root.version !== FORMAT_VERSION || !root.sites || typeof root.sites !== "object" || Array.isArray(root.sites)) return fail("invalid_file");
    for (const [botId, profiles] of Object.entries(root.sites)) {
      if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return fail("invalid_file");
      for (const [profileId, rows] of Object.entries(profiles as object)) {
        if (!rows || typeof rows !== "object" || Array.isArray(rows)) return fail("invalid_file");
        for (const [origin, row] of Object.entries(rows as object)) {
          const value = row as { rule?: unknown; lowered?: unknown } | null;
          if (!value || typeof value !== "object" || typeof value.rule !== "string" || !RULES.includes(value.rule) || (value.lowered !== undefined && value.lowered !== true)) return fail("invalid_file");
          try { this.put(botId, profileId, origin, value.rule as SiteRule, value.lowered === true); } catch { return fail("invalid_file"); }
        }
      }
    }
  }

  private save() {
    const sites = Object.fromEntries([...this.data].map(([botId, profiles]) => [botId, Object.fromEntries([...profiles].map(([profileId, rows]) => [profileId, Object.fromEntries(rows)]))]));
    const content = { version: FORMAT_VERSION, sites };
    if (process.platform === "win32") { writePrivateWindowsJson(this.file, content); return; }
    // The same atomic write the connection state uses: a private temp file, then a rename over the target.
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(content), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, this.file); }
    finally { fs.rmSync(temp, { force: true }); }
  }
}
