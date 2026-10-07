// SPDX-License-Identifier: AGPL-3.0-or-later
// Site categories for Murage for Chrome (spec 2.3). Pure data and pure functions, no I/O.
//
// A hostname maps to one category. Lists are keyed by registrable domain (eTLD+1, using the bundled
// public-suffix snapshot) and a subdomain inherits its parent's category. A few entries are
// themselves subdomains of a shared registrable domain (chromewebstore.google.com); those match by
// suffix of the host. Unsure means stricter: an empty or malformed host is askEveryStep, unless the
// hostname it carries (after a port, user info, path or extra trailing dots) is stricter still.
//
// Data sources: handover and askEveryStep reuse the protected-site data in browser-protected-domains.ts
// (Murage's own list plus the lists ported from Sean's FoundryInChrome extension,
// src/lib/privacy/domain-lists.ts). That file keeps refusing every protected domain until the
// admission code switches to these categories. The neverDefault list is new and deliberately modest.
import { PROTECTED_DOMAINS, PROTECTED_GOV_PATTERNS, PROTECTED_TLDS } from "./browser-protected-domains.ts";
import { PSL_EXCEPTIONS, PSL_RULES, PSL_WILDCARDS } from "./public-suffix-snapshot.ts";

export type SiteCategory = "handover" | "neverDefault" | "askEveryStep" | "normal";

/** Bump when any list below changes. */
export const CATEGORY_LIST_VERSION = 2;

/** Password managers, browser stores and extension stores. Neither the bot nor the owner's settings can open these. */
const HANDOVER_DOMAINS = [
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com", "proton.me",
  "nordpass.com", "roboform.com", "enpass.io",
  // regional clouds and password managers on a shared registrable domain (matched by host suffix)
  "1password.eu", "1password.ca", "bitwarden.eu", "lastpass.eu",
  "keepersecurity.eu", "keepersecurity.com.au", "keepersecurity.ca", "keepersecurity.jp", "keepersecurity.us",
  "passwords.google.com",
  "chromewebstore.google.com", "chrome.google.com", "microsoftedge.microsoft.com", "addons.mozilla.org", "addons.opera.com",
] as const;

/** Adult and known piracy. Modest on purpose; the owner can change a site with a warning. */
const NEVER_DEFAULT_DOMAINS = [
  // adult
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com", "spankbang.com",
  "eporner.com", "tube8.com", "onlyfans.com", "fansly.com", "chaturbate.com", "stripchat.com", "cam4.com",
  "livejasmin.com", "bongacams.com", "brazzers.com", "rule34.xxx", "nhentai.net", "e-hentai.org",
  // known piracy
  "thepiratebay.org", "1337x.to", "rarbg.to", "yts.mx", "nyaa.si", "limetorrents.info", "torrentgalaxy.to",
  "rutracker.org", "libgen.is", "libgen.rs", "libgen.li", "annas-archive.org", "sci-hub.se", "sci-hub.ru",
] as const;
const NEVER_DEFAULT_TLDS = ["xxx", "porn", "adult", "sex"] as const;

/** National government and health portals outside the TLD and SLD patterns (.gov, .gouv.fr, .gov.au and the rest). */
const ASK_EXTRA_DOMAINS = ["elster.de", "canada.ca", "digid.nl", "belastingdienst.nl", "ameli.fr"] as const;
/** A host with this label anywhere (mychart.clevelandclinic.org) is a patient portal. */
const ASK_LABELS = new Set<string>(["mychart"]);

const HANDOVER = new Set<string>(HANDOVER_DOMAINS);
const NEVER_DEFAULT = new Set<string>(NEVER_DEFAULT_DOMAINS);
// Everything the legacy protected list holds that is not handover (banks, brokerage, crypto, payments,
// health, tax, insurance, payroll, e-signing, SSO, aggregators). SSO and aggregators stay here, not in
// normal: dropping them would loosen today's behaviour and unsure means stricter.
const ASK_EVERY_STEP = new Set<string>([...PROTECTED_DOMAINS.filter(domain => !HANDOVER.has(domain)), ...ASK_EXTRA_DOMAINS]);

/** The listed domains per category (read-only view, for tests and diagnostics). */
export const CATEGORY_DOMAINS: Readonly<Record<"handover" | "neverDefault" | "askEveryStep", readonly string[]>> = {
  handover: [...HANDOVER],
  neverDefault: [...NEVER_DEFAULT],
  askEveryStep: [...ASK_EVERY_STEP],
};
const ASK_TLDS = new Set<string>(PROTECTED_TLDS.map(tld => tld.replace(/^\./, "")));

const PSL_PLAIN = new Set<string>(PSL_RULES);
const PSL_WILD = new Set<string>(PSL_WILDCARDS);
const PSL_EXCEPT = new Set<string>(PSL_EXCEPTIONS);

const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** Strict IPv6 literal check (no zone id). shared/ stays free of node modules, so no net.isIPv6. */
function isIPv6(text: string): boolean {
  let host = text;
  const lastColon = host.lastIndexOf(":");
  if (host.includes(".")) {
    // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
    const quad = host.slice(lastColon + 1).split(".");
    if (quad.length !== 4 || !quad.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
    host = `${host.slice(0, lastColon + 1)}0:0`;
  }
  const group = /^[0-9a-f]{1,4}$/;
  const halves = host.split("::");
  if (halves.length > 2) return false;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    return left.length + right.length <= 7 && [...left, ...right].every(part => group.test(part));
  }
  const groups = host.split(":");
  return groups.length === 8 && groups.every(part => group.test(part));
}

type Parsed = { kind: "ip" } | { kind: "host"; labels: string[] } | { kind: "invalid" };

function parseHost(input: unknown): Parsed {
  if (typeof input !== "string") return { kind: "invalid" };
  let host = input.trim().toLowerCase();
  if (!host || /[\s/\\?#@%]/.test(host)) return { kind: "invalid" };
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(":")) return isIPv6(host) ? { kind: "ip" } : { kind: "invalid" };
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return { kind: "invalid" };
  let ascii: string;
  try {
    ascii = new URL(`http://${host}`).hostname;
  } catch {
    return { kind: "invalid" };
  }
  if (ascii.endsWith(".")) ascii = ascii.slice(0, -1);
  const labels = ascii.split(".");
  if (labels.length === 4 && labels.every(label => /^\d{1,3}$/.test(label))) return { kind: "ip" };
  if (labels.some(label => !LABEL.test(label))) return { kind: "invalid" };
  return { kind: "host", labels };
}

/** Number of trailing labels that form the public suffix (Public Suffix List algorithm, default rule "*"). */
function suffixLength(labels: string[]): number {
  let best = 1;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    const count = labels.length - i;
    if (PSL_EXCEPT.has(candidate)) return count - 1;
    if (PSL_PLAIN.has(candidate) && count > best) best = count;
    if (count > 1 && PSL_WILD.has(labels.slice(i + 1).join(".")) && count > best) best = count;
  }
  return best;
}

/** Registrable domain (eTLD+1) of a hostname, or null for an IP, an invalid host or a bare public suffix. Punycode output. */
export function registrableDomain(hostname: string): string | null {
  const parsed = parseHost(hostname);
  if (parsed.kind !== "host") return null;
  const { labels } = parsed;
  const keep = suffixLength(labels) + 1;
  return labels.length >= keep ? labels.slice(labels.length - keep).join(".") : null;
}

const STRICTNESS: Record<SiteCategory, number> = { normal: 0, askEveryStep: 1, neverDefault: 2, handover: 3 };

function stricter(a: SiteCategory, b: SiteCategory): SiteCategory {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

/** Category of a hostname (no scheme, port or path). Unsure means stricter: a malformed input asks every
 * step, or takes the category of the hostname it carries when that is stricter (bitwarden.com:443 is handover). */
export function categoryFor(hostname: string): SiteCategory {
  const parsed = parseHost(hostname);
  if (parsed.kind !== "invalid") return classify(parsed);
  return stricter("askEveryStep", carriedHostCategory(hostname));
}

/** Category of the hostname inside a malformed input (port, user info, scheme, path, extra trailing dots). */
function carriedHostCategory(input: unknown): SiteCategory {
  if (typeof input !== "string") return "askEveryStep";
  const raw = input.trim();
  if (!raw) return "askEveryStep";
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
  } catch {
    return "askEveryStep";
  }
  const parsed = parseHost(host.replace(/\.+$/, ""));
  return parsed.kind === "invalid" ? "askEveryStep" : classify(parsed);
}

function classify(parsed: Exclude<Parsed, { kind: "invalid" }>): SiteCategory {
  if (parsed.kind === "ip") return "normal";
  const { labels } = parsed;
  const registrableStart = Math.max(0, labels.length - (suffixLength(labels) + 1));
  const tld = labels[labels.length - 1];
  let handover = false;
  let never = NEVER_DEFAULT_TLDS.includes(tld as (typeof NEVER_DEFAULT_TLDS)[number]);
  let ask = ASK_TLDS.has(tld) || PROTECTED_GOV_PATTERNS.some(pattern => pattern.test(`.${labels.join(".")}`))
    || labels.some(label => ASK_LABELS.has(label));
  // Walk from the whole host up to the registrable domain (and no further). A listed entry that is
  // itself a subdomain of a shared registrable domain, such as chromewebstore.google.com, matches here.
  for (let start = 0; start <= registrableStart; start++) {
    const candidate = labels.slice(start).join(".");
    if (HANDOVER.has(candidate)) handover = true;
    else if (NEVER_DEFAULT.has(candidate)) never = true;
    else if (ASK_EVERY_STEP.has(candidate)) ask = true;
  }
  if (handover) return "handover";
  if (never) return "neverDefault";
  if (ask) return "askEveryStep";
  return "normal";
}
