// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/skills: Settings → Skills. One set of routes for the owner's own
// skills (the collection) and the library, so the screen never has to know
// where a skill lives. Switching a skill on for a bot installs it there if
// needed and always goes through Skill Guard's gate (setSkillEnabled).
// Desktop only, like every route that can put instructions in front of a bot.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { SKILL_PAGE_SIZE } from "../shared/skill-pagination.ts";
import type { SkillSearchResult } from "../shared/settings-v10/skill-search.ts";

import { skillActDigest } from "./cloud-home/owner-code.ts";
import { deleteCollectionSkill, duplicateIntoCollection, getCollectionSkill, importCollectionSkill, listCollection, prepareCollectionSkillUpdate, updateCollectionSkill, type CollectionSkill } from "./skill-collection.ts";
import { handleSkillsBulk } from "./skills-bulk.ts";
import { fetchSkillFromLink, readSkillZip } from "./skill-import-sources.ts";
import { attachedSkillOn, isChiefForAttached, loadBundledSkills, type BundledSkill } from "./skill-library.ts";
import { plainMessage } from "./skill-guard/messages.ts";
import { SKILL_RULES } from "./skill-guard/rules.ts";
import { skillContentHash } from "./skill-guard/content-hash.ts";
import { scanSkill } from "./skill-guard/scan.ts";
import { SPECTOR_PATTERNS } from "./skill-guard/spector-patterns.generated.ts";
import { browseFacets, librarySkillRows, querySkillIndex, searchSkillPage, skillIndexStats } from "./skill-search.ts";
import { isNewInVersion, recordSkillsSeen, type FirstSeen } from "./skill-first-seen.ts";
import { checkLibrarySkill, skillIndexPreview, currentSkillScan, installedLibraryVersion, installSkill, installSkillFromLibrary, isSkillName, libraryUpdateReady, listSkills, updateLibrarySkill, readLibraryAssets, readSkillFile, removeSkill, setSkillEnabled, SKILL_LIBRARY_ROOT, type SkillListing } from "./skills.ts";
import { readEveryBotMarks, writeEveryBotMarks, type EveryBotMark } from "./skill-every-bot.ts";
import type { SkillScan, SkillVerdict } from "./skill-guard/types.ts";

export interface SkillsApiBot {
  id: string;
  name: string;
  canUseSkills: boolean;
  /** The workspace Chief of Staff and its built-in switches, for the
   *  built-ins attached to it (skill-library.ts attachedSkillOn). */
  chiefOfStaff?: boolean;
  chiefScope?: "workspace";
  builtinSkills?: Partial<Record<string, boolean>>;
}
export interface SkillsApiRequest {
  method: string;
  path: string;
  url: URL;
  readBody: () => Promise<unknown>;
  /** Set only for an owner's browser on a home: the code gate for one act. Null when the request carries a code for exactly that act. */
  ownerCode?: (act: string) => Promise<SkillsApiResponse | null>;
  /** The route's act string (routeActDigest of method, path and body); the switch-on act binds the scanned content to it. */
  routeAct?: string;
  bots: () => SkillsApiBot[];
  /** The bot ids of one team, or null for no such team (K5 Used by / bulk). */
  teamMembers?: (teamId: string) => string[] | null;
  /** Persist a built-in's switch on a bot record. */
  setBuiltinSkill?: (botId: string, id: string, on: boolean) => void;
  fetcher?: typeof fetch;
}
export type SkillsApiResponse = { status: number; body: unknown };

interface SkillSummary {
  ref: string;
  name: string;
  description: string;
  kind: "collection" | "library" | "builtin";
  verdict: SkillVerdict;
  /** For a skill that needs a look or is blocked: what was found, in words (the first finding), so its row says why. */
  reason?: string;
  source: string;
  usedBy: Array<{ botId: string; botName: string; enabled: boolean }>;
  /** Library skills only (settings v10 K1, K2, K3). */
  category?: string;
  isNew?: boolean;
  /** Bots whose library copy is older than the shipped version. */
  updateReady?: Array<{ botId: string; botName: string }>;
}

/** The first finding of a scan that needs a look or blocked, in words; nothing for a clean skill. */
function scanReason(scan: Pick<SkillScan, "verdict" | "findings">): { reason?: string } {
  const first = scan.verdict === "clean" ? undefined : scan.findings[0];
  return first ? { reason: first.message } : {};
}
/** The same words from a shipped verdict's rule ids ("skillspector:AR2.1", "SG1"), without scanning again. */
function shippedReason(rules: string[] | undefined): { reason?: string } {
  for (const rule of rules ?? []) {
    const id = rule.startsWith("skillspector:") ? rule.slice("skillspector:".length) : rule;
    const category = rule.startsWith("skillspector:") ? SPECTOR_PATTERNS.find((pattern) => pattern.id === id)?.category : SKILL_RULES.find((known) => known.id === id)?.category;
    if (category) return { reason: plainMessage(category) };
  }
  return {};
}

const LIBRARY = "library:";
const BUILTIN = "builtin:";
const COLLECTION = "collection:";
const SOURCE_LABEL: Record<Exclude<CollectionSkill["source"]["kind"], "copy">, string> = { file: "Imported from a file", folder: "Imported from a folder", zip: "Imported from a zip", link: "Imported from a link" };
/** Where one of the owner's skills came from, in words. */
export function sourceLabel(source: CollectionSkill["source"]): string {
  return source.kind === "copy" ? `Copied from ${source.label}` : SOURCE_LABEL[source.kind];
}

let verdictCache: { root: string; skills: Record<string, { verdict: SkillVerdict; rules?: string[] }> } | null = null;
function shippedEntry(id: string): { verdict: SkillVerdict; rules?: string[] } | null {
  if (verdictCache?.root !== SKILL_LIBRARY_ROOT) {
    try {
      verdictCache = { root: SKILL_LIBRARY_ROOT, skills: JSON.parse(readFileSync(join(SKILL_LIBRARY_ROOT, "scan-verdicts.json"), "utf8")).skills ?? {} };
    } catch {
      verdictCache = { root: SKILL_LIBRARY_ROOT, skills: {} };
    }
  }
  return verdictCache.skills[id] ?? null;
}

const nameCache = new Map<string, string>();
/** A library skill's display name ("Invoice Creator"), from its manifest. */
function libraryName(id: string): string {
  const cached = nameCache.get(id);
  if (cached !== undefined) return cached;
  let name = id;
  try {
    const manifest = JSON.parse(readFileSync(join(SKILL_LIBRARY_ROOT, id, "manifest.json"), "utf8"));
    // A name made from its id title-cases "ai" as "Ai"; the owner reads "AI".
    if (typeof manifest?.name === "string" && manifest.name.trim()) name = manifest.name.trim().replace(/\bAi\b/g, "AI");
  } catch {
    // no manifest: the id is the name
  }
  nameCache.set(id, name);
  return name;
}

function libraryScan(id: string): { text: string; description: string; scan: SkillScan } | null {
  const checked = checkLibrarySkill(id, SKILL_LIBRARY_ROOT);
  if ("error" in checked) return null;
  return { text: checked.prepared.files[0]!.content, description: checked.prepared.parsed.description, scan: checked.prepared.scan };
}

/** The built-ins that belong to one bot (today the Chief of Staff guide),
 *  in the owner's words. Their instructions ship in skills/. */
const BUILTIN_WORDS: Record<string, { name: string; description: string }> = {
  "chief-of-staff": { name: "Chief of Staff guide", description: "How your Chief of Staff runs the morning brief, your day, your notes, research and the business." },
};
let builtinCache: { skills: Map<string, { skill: BundledSkill; scan: SkillScan }> } | null = null;
function builtin(id: string): { skill: BundledSkill; scan: SkillScan } | null {
  if (!builtinCache) {
    const skills = new Map<string, { skill: BundledSkill; scan: SkillScan }>();
    for (const skill of loadBundledSkills()) {
      if (!BUILTIN_WORDS[skill.manifest.id]) continue;
      const scan = scanSkill({ name: skill.manifest.id, description: skill.manifest.description, triggerTerms: [], files: [{ path: "SKILL.md", content: skill.instructions }] });
      skills.set(skill.manifest.id, { skill, scan });
    }
    builtinCache = { skills };
  }
  return builtinCache.skills.get(id) ?? null;
}
const isChief = (bot: SkillsApiBot) => isChiefForAttached(bot);

function builtinSummary(id: string, bots: SkillsApiBot[]): SkillSummary | null {
  const found = builtin(id);
  if (!found) return null;
  const words = BUILTIN_WORDS[id]!;
  const usedBy = bots.filter(isChief).map((bot) => ({ botId: bot.id, botName: bot.name, enabled: attachedSkillOn(bot, id) }));
  return { ref: `${BUILTIN}${id}`, name: words.name, description: words.description, kind: "builtin", verdict: found.scan.verdict, ...scanReason(found.scan), source: "Built-in", usedBy };
}

/** Every bot with this collection skill gets the new files, through the same gate as a first install: a clean
 *  skill that was on stays on; one that now needs a look is left off until the owner confirms it; Blocked is off. */
function pushCollectionToBots(name: string, ref: string, saved: { contents: Array<{ path: string; content: string }>; assets: Array<{ path: string; content: Buffer }>; scan: SkillScan }, users: SkillSummary["usedBy"]): { needsLook: string[]; failed: string[] } {
  const needsLook: string[] = [];
  const failed: string[] = [];
  for (const user of users) {
    removeSkill(user.botId, name);
    const installed = installSkill(user.botId, ref, saved.contents, { assets: saved.assets });
    if ("error" in installed) {
      failed.push(user.botName);
      continue;
    }
    if (!user.enabled || saved.scan.verdict === "blocked") continue;
    if (saved.scan.verdict === "review") {
      needsLook.push(user.botName);
      continue;
    }
    const on = setSkillEnabled(user.botId, name, true);
    if ("error" in on) failed.push(user.botName);
  }
  return { needsLook, failed };
}

/** Which bots have this skill installed, and whether it is on. */
function usedBy(ref: string, bots: SkillsApiBot[]): SkillSummary["usedBy"] {
  const matches = (listing: SkillListing) =>
    ref.startsWith(COLLECTION) ? listing.source === ref : listing.source.startsWith(`${ref}@`) || listing.source === ref;
  const out: SkillSummary["usedBy"] = [];
  for (const bot of bots) {
    const listing = listSkills(bot.id).find(matches);
    if (listing) out.push({ botId: bot.id, botName: bot.name, enabled: listing.enabled });
  }
  return out;
}

function collectionSummary(skill: CollectionSkill, bots: SkillsApiBot[]): SkillSummary {
  const ref = `${COLLECTION}${skill.name}`;
  return { ref, name: skill.displayName || skill.name, description: skill.description, kind: "collection", verdict: skill.scan.verdict, ...scanReason(skill.scan), source: sourceLabel(skill.source), usedBy: usedBy(ref, bots) };
}

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  topics: string[];
  bots: Array<{ id: string; name: string }>;
  mine: boolean;
}

const TOPIC_LABELS: Record<string, string> = {
  "health-wellness": "Health & Wellness", "home-household": "Home & Household",
  devops: "DevOps", seo: "SEO", api: "APIs", apis: "APIs",
  "ui-design": "UI Design", "ux-research": "UX Research", "ai-agents": "AI Agents", "e-commerce": "E-commerce",
};

/** The whole browse taxonomy, and the effective library with the owner's
 * copies. Bot manifests are read once per request, never once per row. */
export async function handleLibrarySkillsApi(request: SkillsApiRequest): Promise<SkillsApiResponse | null> {
  if (request.method !== "GET") return null;
  if (request.path === "/api/library/topics") {
    const [facets, stats] = await Promise.all([browseFacets(), skillIndexStats()]);
    if (!stats.available) return { status: 503, body: { error: "The skills library could not be read. Try again.", code: "library-unavailable" } };
    return { status: 200, body: {
      topics: facets.map(({ term, count }) => ({ term, label: TOPIC_LABELS[term] ?? term.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), count })),
      totalSkills: stats.count,
    } };
  }
  if (request.path !== "/api/library/skills") return null;
  const params = request.url.searchParams;
  const filter = params.get("filter") ?? "all";
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 50);
  if (!["all", "onBots", "mine"].includes(filter) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return { status: 400, body: { error: "Choose a filter and a page of 1 to 200 skills.", code: "invalid" } };
  }
  const term = (params.get("term") ?? "").trim().toLowerCase();
  const query = (params.get("q") ?? "").trim().toLowerCase();
  if (query.length > 200) return { status: 400, body: { error: "Search for up to 200 characters.", code: "invalid" } };
  let library: Awaited<ReturnType<typeof librarySkillRows>>;
  try { library = await librarySkillRows(); }
  catch { return { status: 503, body: { error: "The skills library could not be read. Try again.", code: "library-unavailable" } }; }
  const originals = new Map(library.map((skill) => [`${LIBRARY}${skill.id}`, skill]));
  const collection = listCollection();
  const overridden = new Set(collection.filter((skill) => skill.updatedAt).map((skill) => skill.source.originalRef).filter(Boolean));
  const users = new Map<string, SkillListItem["bots"]>();
  for (const bot of request.bots()) {
    for (const skill of listSkills(bot.id)) {
      if (!skill.enabled) continue;
      const ref = skill.source.startsWith(LIBRARY) ? skill.source.split("@")[0]! : skill.source;
      const list = users.get(ref) ?? [];
      list.push({ id: bot.id, name: bot.name });
      users.set(ref, list);
    }
  }
  const items: SkillListItem[] = library.filter((skill) => !overridden.has(`${LIBRARY}${skill.id}`) || users.has(`${LIBRARY}${skill.id}`)).map((skill) => ({
    id: `${LIBRARY}${skill.id}`, name: skill.name, description: skill.description, topics: skill.terms,
    bots: users.get(`${LIBRARY}${skill.id}`) ?? [], mine: false,
  }));
  for (const skill of collection) {
    const ref = `${COLLECTION}${skill.name}`;
    items.push({ id: ref, name: skill.displayName || skill.name, description: skill.description,
      topics: originals.get(skill.source.originalRef ?? "")?.terms ?? [], bots: users.get(ref) ?? [], mine: true });
  }
  const matching = items.filter((skill) => (!term || skill.topics.includes(term))
    && (!query || `${skill.name} ${skill.description} ${skill.topics.join(" ")}`.toLowerCase().includes(query))
    && (filter !== "mine" || skill.mine) && (filter !== "onBots" || skill.bots.length > 0))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { status: 200, body: { items: matching.slice(offset, offset + limit), total: matching.length, offset } };
}

/** Settings keeps its existing strings and per-bot switches. The Library
 * reader asks for file sizes and just the bots using this skill. */
function detailView(request: SkillsApiRequest, detail: Record<string, unknown>, files: Array<{ path: string; size: number }>, users: SkillSummary["usedBy"]) {
  if (request.url.searchParams.get("view") !== "library") return detail;
  return { ...detail, id: detail.ref, mine: detail.kind === "collection", files,
    bots: users.filter((bot) => bot.enabled).map((bot) => ({ id: bot.botId, name: bot.botName })) };
}

function librarySummary(hit: { id: string; name: string; description: string }, bots: SkillsApiBot[]): SkillSummary {
  const ref = `${LIBRARY}${hit.id}`;
  const shipped = shippedEntry(hit.id);
  const scan = shipped ? null : libraryScan(hit.id)?.scan;
  const verdict = shipped?.verdict ?? scan?.verdict ?? "clean";
  const reason = verdict === "clean" ? {} : shipped ? shippedReason(shipped.rules) : scan ? scanReason(scan) : {};
  return { ref, name: libraryName(hit.id), description: hit.description, kind: "library", verdict, ...reason, source: "Library", usedBy: usedBy(ref, bots) };
}

/** The library skills some bot already uses, found from the bots' own lists. */
function libraryInUse(bots: SkillsApiBot[]): Array<{ id: string; name: string; description: string }> {
  const seen = new Map<string, { id: string; name: string; description: string }>();
  for (const bot of bots) {
    for (const listing of listSkills(bot.id)) {
      if (!listing.source.startsWith(LIBRARY)) continue;
      const id = listing.source.slice(LIBRARY.length).split("@")[0]!;
      if (isSkillName(id) && !seen.has(id)) seen.set(id, { id, name: id, description: listing.description });
    }
  }
  return [...seen.values()];
}


let seenCache: { builtAt: string | null; map: Map<string, FirstSeen> } | null = null;
async function firstSeenMap(appVersion: string): Promise<Map<string, FirstSeen>> {
  const stats = await skillIndexStats();
  if (seenCache && seenCache.builtAt === stats.builtAt) return seenCache.map;
  const map = recordSkillsSeen((await librarySkillRows()).map((row) => row.id), appVersion);
  seenCache = { builtAt: stats.builtAt, map };
  return map;
}

function shippedVersion(id: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(SKILL_LIBRARY_ROOT, id, "manifest.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch { return null; }
}

const intersect = (a: Set<string> | null, b: Set<string>): Set<string> => (a ? new Set([...a].filter((id) => b.has(id))) : b);

/** Settings v10 K9: GET /api/skills/query?q&show&category&source&usedBy&status&sort&cursor&rid.
 * Every filter runs before paging; `total` and `facets` count the filtered set. */
async function handleSkillsQuery(request: SkillsApiRequest): Promise<SkillsApiResponse> {
  const params = request.url.searchParams;
  const invalid = (error: string): SkillsApiResponse => ({ status: 400, body: { error, code: "invalid" } });
  const q = (params.get("q") ?? "").trim();
  if (q.length > 200) return invalid("Search for up to 200 characters.");
  const show = params.get("show") ?? "all";
  const source = params.get("source") ?? "";
  const status = params.get("status") ?? "";
  const sort = params.get("sort") ?? "name";
  const usedByRaw = params.get("usedBy") ?? "";
  const category = (params.get("category") ?? "").trim().slice(0, 80);
  const rid = (params.get("rid") ?? "").slice(0, 64);
  if (!["all", "mine", "onBots", "new"].includes(show) || !["", "library", "yours"].includes(source) || !["", "clean", "flagged", "update"].includes(status) || !["name", "newest"].includes(sort)) return invalid("Choose a filter the page offers.");
  let offset = 0;
  const cursor = params.get("cursor");
  if (cursor) {
    try { offset = Number((JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o); } catch { offset = NaN; }
    if (!Number.isSafeInteger(offset) || offset < 0) return invalid("That page is not available.");
  }
  const bots = request.bots();
  const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
  let usedByIds: Set<string> | null = null;
  if (usedByRaw) {
    const [kind, id] = [usedByRaw.slice(0, usedByRaw.indexOf(":")), usedByRaw.slice(usedByRaw.indexOf(":") + 1)];
    if (kind === "bot" && botName.has(id)) usedByIds = new Set([id]);
    else if (kind === "team") {
      const members = request.teamMembers?.(id);
      if (!members) return { status: 404, body: { error: "No such team.", code: "no-team" } };
      usedByIds = new Set(members);
    } else return invalid("Choose a bot or a team.");
  }
  const appVersion = (process.env.MURAGE_APP_VERSION || "dev").slice(0, 64);
  const stats = await skillIndexStats();
  if (!stats.available) return { status: 503, body: { error: "The skills library could not be read. Try again.", code: "library-unavailable" } };

  // Per library skill: who has it on, and who holds a copy older than the shipped one.
  const users = new Map<string, Set<string>>();
  const stale = new Map<string, Array<{ botId: string; botName: string }>>();
  for (const bot of bots) {
    for (const listing of listSkills(bot.id)) {
      if (!listing.source.startsWith(LIBRARY)) continue;
      const id = listing.source.slice(LIBRARY.length).split("@")[0]!;
      if (listing.enabled && (!usedByIds || usedByIds.has(bot.id))) users.set(id, (users.get(id) ?? new Set()).add(bot.id));
      const shipped = shippedVersion(id);
      if (shipped && libraryUpdateReady(installedLibraryVersion(listing), shipped) && (!usedByIds || usedByIds.has(bot.id))) {
        stale.set(id, [...(stale.get(id) ?? []), { botId: bot.id, botName: bot.name }]);
      }
    }
  }
  const seen = await firstSeenMap(appVersion);
  let only: Set<string> | null = null;
  let exclude: string[] | undefined;
  if (show === "onBots" || usedByIds) only = intersect(only, new Set(users.keys()));
  if (show === "new") only = intersect(only, new Set([...seen].filter(([, value]) => isNewInVersion(value, appVersion)).map(([id]) => id)));
  if (status === "update") only = intersect(only, new Set(stale.keys()));
  if (status === "flagged" || status === "clean") {
    const flagged = Object.keys(await shippedFlagged());
    if (status === "flagged") only = intersect(only, new Set(flagged));
    else exclude = flagged;
  }
  const libraryOff = show === "mine" || source === "yours";
  const result = libraryOff
    ? { rows: [], total: 0, facets: [], offset: 0, limit: 60 }
    : await querySkillIndex({ q, category, ...(only ? { onlyIds: [...only] } : {}), ...(exclude ? { excludeIds: exclude } : {}), sort: sort as "name" | "newest", firstSeen: new Map([...seen].map(([id, value]) => [id, value.at])), offset, limit: SKILL_PAGE_SIZE });
  const rows = result.rows.map((hit) => ({
    ...librarySummary(hit, bots), category: hit.category, hit: { kind: "skill" as const, ref: { skillId: hit.id }, title: libraryName(hit.id), description: hit.description } satisfies SkillSearchResult,
    isNew: isNewInVersion(seen.get(hit.id), appVersion),
    ...(stale.has(hit.id) ? { updateReady: stale.get(hit.id) } : {}),
  }));
  const scoped = Boolean(category || only || exclude || libraryOff);
  let widen: { all: number } | undefined;
  if (!libraryOff && !result.total && scoped && q) {
    const wide = await querySkillIndex({ q, limit: 1 });
    if (wide.total) widen = { all: wide.total };
  }
  const needle = q.toLowerCase();
  const yours = offset === 0 && source !== "library" && !category && show !== "new"
    ? listCollection().filter((skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
      .map((skill) => collectionSummary(skill, bots)).filter((skill) => (show !== "onBots" && !usedByIds) || skill.usedBy.some((user) => user.enabled && (!usedByIds || usedByIds.has(user.botId))))
    : [];
  const next = result.offset + result.rows.length < result.total ? Buffer.from(JSON.stringify({ o: result.offset + result.rows.length })).toString("base64url") : null;
  return { status: 200, body: { rid, rows, yours, total: result.total, facets: result.facets, next, ...(widen ? { widen } : {}) } };
}

async function shippedFlagged(): Promise<Record<string, { verdict: SkillVerdict }>> {
  shippedEntry("");
  return Object.fromEntries(Object.entries(verdictCache?.skills ?? {}).filter(([, value]) => value.verdict !== "clean"));
}

const refPattern = /^(collection|library|builtin):([a-z0-9][a-z0-9-]{0,127})$/;
function parseRef(raw: string): { kind: "collection" | "library" | "builtin"; name: string; ref: string } | null {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const match = refPattern.exec(decoded);
  if (!match || !isSkillName(match[2]!)) return null;
  return { kind: match[1] as "collection" | "library" | "builtin", name: match[2]!, ref: `${match[1]}:${match[2]}` };
}

const importBody = z.union([
  z.object({ link: z.string().min(1).max(2000), replace: z.boolean().optional() }).strict(),
  z.object({ files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string() })).min(1).max(200), kind: z.enum(["file", "folder"]), label: z.string().max(200).optional(), skipped: z.array(z.string().max(500)).max(200).optional(), replace: z.boolean().optional() }).strict(),
  z.object({ zip: z.string().min(1).max(12 * 1024 * 1024), label: z.string().max(200).optional(), replace: z.boolean().optional() }).strict(),
]);

export async function handleSkillsApi(request: SkillsApiRequest): Promise<SkillsApiResponse | null> {
  const { method, path } = request;
  if (path !== "/api/skills" && !path.startsWith("/api/skills/")) return null;

  if (path === "/api/skills/bulk" || path.startsWith("/api/skills/bulk/")) return handleSkillsBulk(request, handleSkillsApi);

  if (method === "GET" && path === "/api/skills/query") return handleSkillsQuery(request);

  // Settings v10 B6: which of a bot's skills ride in every message and which are looked up, from the run that builds the message.
  if (method === "GET" && path === "/api/skills/preview") {
    const botId = request.url.searchParams.get("botId") ?? "";
    if (!request.bots().some((bot) => bot.id === botId)) return { status: 404, body: { error: "No such bot.", code: "no-bot" } };
    return { status: 200, body: skillIndexPreview(botId) };
  }

  if (method === "GET" && path === "/api/skills") {
    const bots = request.bots();
    const q = (request.url.searchParams.get("q") ?? "").trim().slice(0, 200);
    const category = (request.url.searchParams.get("category") ?? "").trim().slice(0, 80);
    const needle = q.toLowerCase();
    const matchesQuery = (s: { name: string; description: string }) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);
    const yoursCollection = listCollection().filter(matchesQuery).map((skill) => collectionSummary(skill, bots));
    const yoursLibrary = libraryInUse(bots).filter(matchesQuery).map((hit) => librarySummary(hit, bots));
    const [stats, facets] = await Promise.all([skillIndexStats(), browseFacets().catch(() => [])]);
    const result = await searchSkillPage({ q, term: category,
      offset: Number(request.url.searchParams.get("offset")),
      limit: request.url.searchParams.has("limit") ? Number(request.url.searchParams.get("limit")) : undefined,
    });
    return {
      status: 200,
      body: {
        yours: [...yoursCollection, ...yoursLibrary].sort((a, b) => a.name.localeCompare(b.name)),
        library: result.skills.map((hit) => librarySummary(hit, bots)),
        pagination: result.pagination,
        builtins: category ? [] : Object.keys(BUILTIN_WORDS).map((id) => builtinSummary(id, bots)).filter((s): s is SkillSummary => Boolean(s) && matchesQuery(s!)),
        categories: facets.map((facet) => ({ name: facet.term, count: facet.count })),
        libraryReady: stats.available,
      },
    };
  }

  if (method === "POST" && path === "/api/skills/import") {
    const parsed = importBody.safeParse(await request.readBody());
    if (!parsed.success) return { status: 400, body: { error: "Send a link, the skill's files, or a zip.", code: "invalid" } };
    const input = parsed.data;
    let files: Array<{ path: string; content: string }>;
    let skipped: string[] = [];
    let source: CollectionSkill["source"];
    if ("link" in input) {
      const fetched = await fetchSkillFromLink(input.link, request.fetcher);
      if ("error" in fetched) return { status: fetched.code === "unreachable" ? 502 : 400, body: fetched };
      files = fetched.files;
      source = { kind: "link", label: input.link.slice(0, 200) };
    } else if ("zip" in input) {
      const read = await readSkillZip(Buffer.from(input.zip, "base64"));
      if ("error" in read) return { status: 400, body: read };
      files = read.files;
      skipped = read.skipped;
      source = { kind: "zip", label: input.label ?? "zip" };
    } else {
      files = input.files;
      skipped = input.skipped ?? [];
      source = { kind: input.kind, label: input.label ?? input.kind };
    }
    const imported = importCollectionSkill(files, source, { replace: input.replace, skipped });
    if ("error" in imported) return { status: imported.code === "exists" ? 409 : 400, body: imported };
    // A replace puts the new files on every bot that has the skill, as the editor does: the reader shows the collection copy, the bot follows its own.
    const users = input.replace ? usedBy(`${COLLECTION}${imported.name}`, request.bots()) : [];
    const current = users.length ? getCollectionSkill(imported.name) : null;
    const pushed = current ? pushCollectionToBots(imported.name, `${COLLECTION}${imported.name}`, current, users) : null;
    return { status: 201, body: { skill: { ...collectionSummary(imported, request.bots()), scan: imported.scan, skipped: imported.skipped }, ...(pushed ?? {}) } };
  }

  const dup = /^\/api\/skills\/([^/]+)\/duplicate$/.exec(path);
  if (dup && method === "POST") {
    const ref = parseRef(dup[1]!);
    if (!ref) return { status: 404, body: { error: "No such skill." } };
    const input = z.object({ name: z.string().max(200).optional() }).strict().safeParse((await request.readBody().catch(() => ({}))) ?? {});
    if (!input.success) return { status: 400, body: { error: "name must be a skill name", code: "invalid" } };
    let files: Array<{ path: string; content: string }>;
    let assets: Array<{ path: string; content: Buffer }> = [];
    let original: { name: string; displayName: string; description: string; originalRef?: string };
    if (ref.kind === "collection") {
      const skill = getCollectionSkill(ref.name);
      if (!skill) return { status: 404, body: { error: "No such skill." } };
      files = skill.contents;
      assets = skill.assets;
      original = { name: skill.name, displayName: skill.displayName || skill.name, description: skill.description, originalRef: skill.source.originalRef };
    } else if (ref.kind === "builtin") {
      const found = builtin(ref.name);
      if (!found) return { status: 404, body: { error: "No such skill." } };
      files = [{ path: "SKILL.md", content: found.skill.instructions }];
      original = { name: ref.name, displayName: BUILTIN_WORDS[ref.name]!.name, description: BUILTIN_WORDS[ref.name]!.description };
    } else {
      const library = libraryScan(ref.name);
      if (!library) return { status: 404, body: { error: "No such skill." } };
      const checked = checkLibrarySkill(ref.name, SKILL_LIBRARY_ROOT);
      if ("error" in checked) return { status: 503, body: checked };
      const supporting = checked.assetsDirectory ? readLibraryAssets(checked.assetsDirectory) : [];
      if ("error" in supporting) return { status: 503, body: { ...supporting, code: "assets-unavailable" } };
      assets = supporting;
      // Instructions remain separate from opaque shipped supporting files.
      files = [{ path: "SKILL.md", content: library.text }];
      original = { name: ref.name, displayName: libraryName(ref.name), description: library.description, originalRef: ref.ref };
    }
    const copied = duplicateIntoCollection(files, original, input.data.name, assets);
    if ("error" in copied) return { status: copied.code === "exists" ? 409 : 400, body: copied };
    return { status: 201, body: { skill: { ...collectionSummary(copied, request.bots()), scan: copied.scan } } };
  }

  const edit = /^\/api\/skills\/collection\/([^/]+)$/.exec(path);
  if (edit && method === "PUT") {
    const name = decodeURIComponent(edit[1]!);
    const current = getCollectionSkill(name);
    if (!current) return { status: 404, body: { error: "No such skill." } };
    const input = z.object({ displayName: z.string().max(200).optional(), description: z.string().min(1).max(4000), body: z.string().max(256 * 1024) }).strict().safeParse(await request.readBody());
    if (!input.success) return { status: 400, body: { error: "Send a description and the instructions.", code: "invalid" } };
    const bots = request.bots();
    const ref = `${COLLECTION}${name}`;
    const snapshot = prepareCollectionSkillUpdate(current, input.data);
    if ("error" in snapshot) return { status: 400, body: snapshot };
    const original = current.source.originalRef ? parseRef(current.source.originalRef) : null;
    const originalUsers = original?.kind === "library" ? usedBy(original.ref, bots) : [];
    const usersByBot = new Map(usedBy(ref, bots).map((user) => [user.botId, user]));
    for (const user of originalUsers) {
      const existing = usersByBot.get(user.botId);
      usersByBot.set(user.botId, { ...user, enabled: user.enabled || (existing?.enabled ?? false) });
    }
    for (const user of originalUsers) {
      const existing = listSkills(user.botId).find((skill) => skill.name === name);
      if (existing && existing.source !== ref) return { status: 409, body: { error: `${user.botName} already has a different skill called ${name}.`, code: "name-taken" } };
    }
    const users = [...usersByBot.values()];
    if (request.ownerCode) {
      if (!request.routeAct) return { status: 403, body: { error: "The skill approval changed. Try again.", code: "fresh_auth_changed" } };
      const digest = createHash("sha256").update("skill-install-v1\n");
      for (const file of snapshot.contents) {
        const bytes = Buffer.from(file.content, "utf8");
        digest.update(`file ${file.path}\n${bytes.length}\n`).update(bytes).update("\n");
      }
      for (const asset of [...snapshot.assets].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        digest.update(`asset ${asset.path}\n${asset.content.length}\n`).update(asset.content).update("\n");
      }
      digest.update("bots\n");
      const enabledBotIds = users.filter((user) => user.enabled).map((user) => user.botId).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      for (const id of enabledBotIds) digest.update(`${id}\n`);
      const refusal = await request.ownerCode(skillActDigest(request.routeAct, digest.digest("hex")));
      if (refusal) return refusal;
    }
    const saved = updateCollectionSkill(snapshot);
    if ("error" in saved) return { status: 400, body: saved };
    const { needsLook, failed } = pushCollectionToBots(name, ref, saved, users);
    // Saving a library copy replaces that original on the bots that used it.
    // Keep an original on any bot whose copy could not be installed.
    if (original?.kind === "library" && original.name !== name) {
      for (const user of originalUsers) if (!failed.includes(user.botName)) removeSkill(user.botId, original.name);
    }
    return { status: 200, body: { skill: { ...collectionSummary(saved, request.bots()), scan: saved.scan }, needsLook, failed } };
  }

  const del = /^\/api\/skills\/collection\/([^/]+)$/.exec(path);
  if (del && method === "DELETE") {
    const name = decodeURIComponent(del[1]!);
    if (!isSkillName(name) || !getCollectionSkill(name)) return { status: 404, body: { error: "No such skill." } };
    const body = z.object({ fromBots: z.boolean().optional() }).strict().safeParse((await request.readBody().catch(() => ({}))) ?? {});
    const users = usedBy(`${COLLECTION}${name}`, request.bots());
    if (users.length && !(body.success && body.data.fromBots)) {
      return { status: 409, body: { error: `Used by ${users.map((u) => u.botName).join(", ")}.`, code: "in-use", bots: users.map((u) => u.botName) } };
    }
    if (!clearEveryBotMark(`${COLLECTION}${name}`)) return { status: 409, body: everyBotStateUnavailable };
    for (const user of users) removeSkill(user.botId, name);
    deleteCollectionSkill(name);
    return { status: 200, body: { removedFrom: users.map((u) => u.botName) } };
  }

  const revert = /^\/api\/skills\/([^/]+)\/revert$/.exec(path);
  if (revert && method === "POST") {
    const ref = parseRef(revert[1]!);
    const copy = ref?.kind === "collection" ? getCollectionSkill(ref.name) : null;
    const original = copy?.source.kind === "copy" && copy.source.originalRef ? parseRef(copy.source.originalRef) : null;
    if (!ref || !copy || original?.kind !== "library") return { status: 404, body: { error: "This skill has no library original.", code: "no-original" } };
    const library = libraryScan(original.name);
    const checked = checkLibrarySkill(original.name, SKILL_LIBRARY_ROOT);
    if (!library || "error" in checked) return { status: 404, body: { error: "The library original is no longer available.", code: "no-original" } };
    const assets = checked.assetsDirectory ? readLibraryAssets(checked.assetsDirectory) : [];
    if ("error" in assets) return { status: 409, body: assets };
    const input = z.object({ acknowledged: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
      .safeParse((await request.readBody().catch(() => ({}))) ?? {});
    if (!input.success) return { status: 400, body: { error: "Send the skill check you acknowledged.", code: "invalid" } };
    const users = usedBy(ref.ref, request.bots());
    if (users.some((user) => user.enabled && !request.bots().find((bot) => bot.id === user.botId)?.canUseSkills)) {
      return { status: 409, body: { error: "This bot's engine can't use skills.", code: "engine" } };
    }
    // Revert ends by forgetting the copy's Every bot ownership. Refuse while
    // that record is unreadable, before any bot or approval is touched.
    if (!readEveryBotMarks()) return { status: 409, body: everyBotStateUnavailable };
    if (users.some((user) => user.enabled)) {
      if (library.scan.verdict === "blocked") return { status: 409, body: { error: "The library original was blocked by the skill check.", code: "blocked", scan: library.scan } };
      if (library.scan.verdict === "review" && input.data.acknowledged !== library.scan.contentHash) return { status: 409, body: { error: "The library original needs a look before it can be switched on.", code: "needs-review", scan: library.scan } };
      if (request.ownerCode) {
        const refusal = await request.ownerCode(skillActDigest(request.routeAct ?? "", library.scan.contentHash));
        if (refusal) return refusal;
      }
    }
    // Preflight every bot before changing any. Keep the copy and its switches
    // until all original installs succeeded, so a refusal never loses it.
    const prior = users.map((user) => ({ user, existing: listSkills(user.botId).find((skill) => skill.name === original.name) }));
    for (const { user, existing } of prior) {
      if (existing && existing.source !== ref.ref && !existing.source.startsWith(`${original.ref}@`)) return { status: 409, body: { error: `${user.botName} already has a different skill called ${original.name}.`, code: "name-taken" } };
    }
    const changed: typeof prior = [];
    const removedCopies: typeof users = [];
    const rollback = () => {
      const failed: Array<{ id: string; name: string; error: string }> = [];
      const attempt = (user: typeof users[number], operation: () => object) => {
        try {
          const result = operation();
          if (!("error" in result) || typeof result.error !== "string") return true;
          failed.push({ id: user.botId, name: user.botName, error: result.error });
        } catch (error) {
          failed.push({ id: user.botId, name: user.botName, error: error instanceof Error ? error.message : String(error) });
        }
        return false;
      };
      const restoreCopy = (user: typeof users[number]) => {
        const now = listSkills(user.botId).find((skill) => skill.name === ref.name);
        if (now?.source !== ref.ref && !attempt(user, () => installSkill(user.botId, ref.ref, copy.contents, { assets: copy.assets }))) return;
        if (now?.enabled !== user.enabled) attempt(user, () => setSkillEnabled(user.botId, ref.name, user.enabled, { acknowledged: currentSkillScan(user.botId, ref.name)?.contentHash }));
      };
      for (const user of [...removedCopies].reverse()) restoreCopy(user);
      for (const { user, existing } of [...changed].reverse()) {
        const now = listSkills(user.botId).find((skill) => skill.name === original.name);
        if (!existing) {
          if (now) attempt(user, () => removeSkill(user.botId, original.name));
        } else if (existing.source === ref.ref) {
          if (now?.source === ref.ref) continue;
          if (now && !attempt(user, () => removeSkill(user.botId, original.name))) continue;
          restoreCopy(user);
        } else if (now?.enabled !== existing.enabled) {
          attempt(user, () => setSkillEnabled(user.botId, original.name, existing.enabled));
        }
      }
      return failed;
    };
    const recover = (cause: { error: string }): SkillsApiResponse => {
      const recoveryFailed = rollback();
      return { status: 409, body: recoveryFailed.length ? {
        error: "Some bots could not be restored. Your copy has been kept.", code: "recovery-incomplete", cause: cause.error, recoveryFailed,
      } : cause };
    };
    try {
      for (const entry of prior) {
        const { user, existing } = entry;
        changed.push(entry);
        if (existing?.source === ref.ref) {
          const removed = removeSkill(user.botId, ref.name);
          if ("error" in removed) return recover(removed);
        }
        if (!existing || existing.source === ref.ref) {
          const installed = installSkillFromLibrary(user.botId, original.name, SKILL_LIBRARY_ROOT);
          if ("error" in installed) return recover(installed);
        }
        if (user.enabled && (!existing?.enabled || existing.source === ref.ref)) {
          const on = setSkillEnabled(user.botId, original.name, true, { acknowledged: input.data.acknowledged });
          if ("error" in on) return recover(on);
        }
      }
      if (ref.name !== original.name) for (const user of users) {
        // A disk error can occur after the manifest was changed, so record
        // the attempt first and inspect its actual state during recovery.
        removedCopies.push(user);
        const removed = removeSkill(user.botId, ref.name);
        if ("error" in removed) return recover(removed);
      }
      if (!clearEveryBotMark(ref.ref)) return recover(everyBotStateUnavailable);
    } catch (error) {
      return recover({ error: error instanceof Error ? error.message : String(error) });
    }
    deleteCollectionSkill(ref.name);
    return { status: 200, body: { id: original.ref, reverted: true, movedBots: users.map((user) => ({ id: user.botId, name: user.botName })) } };
  }

  // K3: bring a bot's library copy up to the shipped version through the install path and its check.
  const refresh = /^\/api\/skills\/([^/]+)\/bots\/([\w-]+)\/update$/.exec(path);
  if (refresh && method === "PUT") {
    const ref = parseRef(refresh[1]!);
    const bot = request.bots().find((b) => b.id === refresh[2]);
    if (!ref || ref.kind !== "library") return { status: 404, body: { error: "No such skill." } };
    if (!bot) return { status: 404, body: { error: "No such bot." } };
    if (request.ownerCode) return { status: 409, body: { error: "Update from the desktop app.", code: "update-needs-desktop" } };
    const updated = updateLibrarySkill(bot.id, ref.name, SKILL_LIBRARY_ROOT);
    if ("error" in updated) return { status: 409, body: updated };
    return { status: 200, body: { skill: updated } };
  }

  const forBot = /^\/api\/skills\/([^/]+)\/bots\/([\w-]+)$/.exec(path);
  if (forBot && method === "PUT") {
    const ref = parseRef(forBot[1]!);
    const bot = request.bots().find((b) => b.id === forBot[2]);
    if (!ref) return { status: 404, body: { error: "No such skill." } };
    if (!bot) return { status: 404, body: { error: "No such bot." } };
    const input = z.object({ on: z.boolean(), acknowledged: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(await request.readBody());
    if (!input.success) return { status: 400, body: { error: "on must be true or false" } };
    if (ref.kind === "builtin") {
      if (!builtin(ref.name)) return { status: 404, body: { error: "No such skill." } };
      if (!isChief(bot)) return { status: 409, body: { error: "Only your Chief of Staff uses this guide.", code: "not-chief" } };
      if (!request.setBuiltinSkill) return { status: 404, body: { error: "no such route" } };
      request.setBuiltinSkill(bot.id, ref.name, input.data.on);
      return { status: 200, body: { skill: builtinSummary(ref.name, request.bots()) } };
    }
    const existing = listSkills(bot.id).find((listing) => listing.name === ref.name);
    const ours = existing && ownedBy(existing, ref as SkillRef);
    if (!input.data.on) {
      if (!existing || !ours) return { status: 200, body: { skill: null } };
      const off = setSkillEnabled(bot.id, ref.name, false);
      return "error" in off ? { status: 409, body: off } : { status: 200, body: { skill: off } };
    }
    let ownerHash: string | undefined;
    if (request.ownerCode && ref.kind === "collection" && bot.canUseSkills && (!existing || ours)) {
      const skill = getCollectionSkill(ref.name);
      const denied = collectionSwitchRefusal(skill, input.data.acknowledged);
      if (denied || !skill) return denied!;
      ownerHash = skill.scan.contentHash;
      const refusal = await request.ownerCode(skillActDigest(request.routeAct ?? "", ownerHash));
      if (refusal) return refusal;
    }
    return switchSkillOn(bot, ref as SkillRef, input.data.acknowledged, ownerHash);
  }

  const everyBot = /^\/api\/skills\/([^/]+)\/every-bot$/.exec(path);
  if (everyBot && method === "PUT") {
    const ref = parseRef(everyBot[1]!);
    if (!ref) return { status: 404, body: { error: "No such skill." } };
    if (ref.kind === "builtin") return { status: 409, body: { error: "Only your Chief of Staff uses this guide.", code: "not-chief" } };
    const input = z.object({ on: z.boolean(), acknowledged: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(await request.readBody());
    if (!input.success) return { status: 400, body: { error: "on must be true or false" } };
    const marks = readEveryBotMarks();
    if (!marks) return { status: 409, body: everyBotStateUnavailable };
    if (!input.data.on) {
      const mark = marks[ref.ref];
      if (!mark) return { status: 200, body: { everyBot: false, switchedOff: [] } };
      mark.turningOff = true;
      writeEveryBotMarks(marks);
      const switchedOff: string[] = [];
      for (const botId of new Set([...mark.appliedTo, ...(mark.pendingTo ?? [])])) {
        const existing = listSkills(botId).find((listing) => listing.name === ref.name);
        if (existing && ownedBy(existing, ref as SkillRef) && existing.enabled) {
          const off = setSkillEnabled(botId, ref.name, false);
          if ("error" in off) return { status: 409, body: off };
          switchedOff.push(botId);
        }
        mark.appliedTo = mark.appliedTo.filter(id => id !== botId);
        mark.pendingTo = mark.pendingTo?.filter(id => id !== botId);
        writeEveryBotMarks(marks);
      }
      delete marks[ref.ref];
      writeEveryBotMarks(marks);
      return { status: 200, body: { everyBot: false, switchedOff } };
    }
    const scan = ref.kind === "collection" ? getCollectionSkill(ref.name)?.scan : libraryScan(ref.name)?.scan;
    if (!scan) return { status: 404, body: { error: "No such skill." } };
    if (scan.verdict === "blocked") return { status: 409, body: { error: "This skill was blocked by the skill check and can't be switched on.", code: "blocked", scan } };
    if (scan.verdict === "review" && input.data.acknowledged !== scan.contentHash) return { status: 409, body: { error: "This skill needs a look before it can be switched on.", code: "needs-review", scan } };
    const mark: EveryBotMark = { appliedTo: marks[ref.ref]?.appliedTo ?? [], pendingTo: marks[ref.ref]?.pendingTo ?? [], ...(scan.verdict === "review" ? { acknowledged: input.data.acknowledged } : {}) };
    marks[ref.ref] = mark;
    writeEveryBotMarks(marks);
    const result = { applied: [] as string[], needsLook: [] as string[], blocked: [] as string[], skipped: [] as string[] };
    for (const bot of request.bots()) applyMark(bot, ref as SkillRef, mark, result, () => writeEveryBotMarks(marks));
    writeEveryBotMarks(marks);
    return { status: 200, body: { everyBot: true, ...result } };
  }

  const one = /^\/api\/skills\/([^/]+)$/.exec(path);
  return oneSkill(request, one);
}

// A later import with the same name must start without the removed copy's mark.
function clearEveryBotMark(ref: string): boolean {
  const marks = readEveryBotMarks();
  if (!marks) return false;
  if (Object.hasOwn(marks, ref)) {
    delete marks[ref];
    writeEveryBotMarks(marks);
  }
  return true;
}

const everyBotStateUnavailable = { error: "The Every bot settings could not be read. Try again after restoring them.", code: "every-bot-state-unavailable" };

type SkillRef = { kind: "collection" | "library"; name: string; ref: string };
const ownedBy = (listing: SkillListing, ref: SkillRef) => ref.kind === "collection" ? listing.source === ref.ref : listing.source.startsWith(`${ref.ref}@`);
type MarkResult = { applied: string[]; needsLook: string[]; blocked: string[]; skipped: string[] };

/** One mark on one bot: the same "Use with" ON path the owner's per-bot switch takes. A bot the mark
 *  already switched on once is never given it again (the owner may have taken it away since). */
function applyMark(bot: SkillsApiBot, ref: SkillRef, mark: EveryBotMark, result: MarkResult, persist: () => void): void {
  if (mark.turningOff) { result.skipped.push(bot.id); return; }
  if (mark.appliedTo.includes(bot.id)) { result.skipped.push(bot.id); return; }
  const existing = listSkills(bot.id).find((listing) => listing.name === ref.name);
  if (existing && ownedBy(existing, ref) && existing.enabled) {
    if (mark.pendingTo?.includes(bot.id)) {
      mark.appliedTo.push(bot.id);
      mark.pendingTo = mark.pendingTo.filter(id => id !== bot.id);
      persist();
    }
    result.skipped.push(bot.id); return;
  }
  mark.pendingTo = [...new Set([...(mark.pendingTo ?? []), bot.id])];
  persist();
  const answer = switchSkillOn(bot, ref, mark.acknowledged);
  const code = answer.status === 200 ? "ok" : (answer.body as { code?: string } | null)?.code;
  if (code === "ok") { mark.appliedTo.push(bot.id); result.applied.push(bot.id); }
  else if (code === "needs-review") result.needsLook.push(bot.id);
  else if (code === "blocked") result.blocked.push(bot.id);
  else result.skipped.push(bot.id);
  mark.pendingTo = mark.pendingTo.filter(id => id !== bot.id);
  persist();
}

/** A bot just made (Store.onBotCreated, after its create committed) gets every marked skill. Never throws. */
export function applyEveryBotMarks(bot: SkillsApiBot, options: { preserveExisting?: boolean } = {}): MarkResult {
  const result: MarkResult = { applied: [], needsLook: [], blocked: [], skipped: [] };
  const marks = readEveryBotMarks();
  if (!marks) return result;
  const refs = Object.keys(marks);
  if (!refs.length) return result;
  for (const raw of refs) {
    const ref = parseRef(raw);
    if (!ref || ref.kind === "builtin") continue;
    if (options.preserveExisting && listSkills(bot.id).some(skill => skill.name === ref.name)) { result.skipped.push(bot.id); continue; }
    try { applyMark(bot, ref as SkillRef, marks[raw]!, result, () => writeEveryBotMarks(marks)); } catch { result.skipped.push(bot.id); }
  }
  writeEveryBotMarks(marks);
  return result;
}

function collectionSwitchRefusal(skill: ReturnType<typeof getCollectionSkill>, acknowledged?: string): SkillsApiResponse | null {
  if (!skill) return { status: 404, body: { error: "No such skill." } };
  const scan = skill.scan;
  if (scan.verdict === "blocked") return { status: 409, body: { error: "This skill was blocked by the skill check and can't be switched on.", code: "blocked", scan } };
  if (scan.verdict === "review" && acknowledged !== scan.contentHash) return { status: 409, body: { error: "This skill needs a look before it can be switched on.", code: "needs-review", scan } };
  return null;
}

/** The per-bot "Use with" ON path shared with durable Every bot marks. */
function switchSkillOn(bot: SkillsApiBot, ref: SkillRef, acknowledgedInput: string | undefined, ownerHash?: string): SkillsApiResponse {
  const existing = listSkills(bot.id).find((listing) => listing.name === ref.name);
  const ours = existing && ownedBy(existing, ref);
  {
    if (!bot.canUseSkills) return { status: 409, body: { error: "This bot's engine can't use skills.", code: "engine" } };
    if (existing && !ours) return { status: 409, body: { error: `${bot.name} already has a different skill called ${ref.name}.`, code: "name-taken" } };

    // What the owner acknowledged is the scan they were shown in the reader.
    let acknowledged = acknowledgedInput;
    if (ref.kind === "collection") {
      const skill = getCollectionSkill(ref.name);
      const denied = collectionSwitchRefusal(skill, acknowledged);
      if (denied || !skill) return denied!;
      if (ownerHash !== undefined && ownerHash !== skill.scan.contentHash) {
        return { status: 409, body: { error: "This skill changed. Review it again before switching it on." } };
      }
      if (!existing) {
        const installed = installSkill(bot.id, ref.ref, skill.contents, { assets: skill.assets });
        if ("error" in installed) return { status: 409, body: installed };
      }
      if (skill.scan.verdict === "review") {
        const input = { name: skill.name, description: skill.description, triggerTerms: [] };
        if (readSkillFile(bot.id, ref.name) !== skill.text || skillContentHash({ ...input, files: skill.contents }) !== skill.scan.contentHash) {
          return { status: 409, body: { error: "The installed instructions or collection skill changed. Review them before switching on.", code: "needs-review" } };
        }
        acknowledged = skillContentHash({ ...input, files: [{ path: "SKILL.md", content: skill.text }] });
      }
    } else if (!existing) {
      const installed = installSkillFromLibrary(bot.id, ref.name, SKILL_LIBRARY_ROOT);
      if ("error" in installed) return { status: 404, body: { error: installed.error } };
    }
    const on = setSkillEnabled(bot.id, ref.name, true, { acknowledged });
    if ("error" in on) return { status: on.code ? 409 : 404, body: on };
    return { status: 200, body: { skill: on } };
  }
}

function oneSkill(request: SkillsApiRequest, one: RegExpExecArray | null): SkillsApiResponse | null {
  if (one && request.method === "GET") {
    const ref = parseRef(one[1]!);
    if (!ref) return { status: 404, body: { error: "No such skill." } };
    const bots = request.bots();
    const everyBot = ref.kind !== "builtin" && Boolean(readEveryBotMarks()?.[ref.ref]);
    // Every bot, for the reader's "Use with" switches.
    const forBots = (users: SkillSummary["usedBy"]) =>
      bots.map((bot) => ({ botId: bot.id, botName: bot.name, canUseSkills: bot.canUseSkills, enabled: users.find((u) => u.botId === bot.id)?.enabled ?? false }));
    if (ref.kind === "collection") {
      const skill = getCollectionSkill(ref.name);
      if (!skill) return { status: 404, body: { error: "No such skill." } };
      const summary = collectionSummary(skill, bots);
      return { status: 200, body: detailView(request, { ...summary, originalRef: skill.source.originalRef, text: skill.text, files: skill.files, skipped: skill.skipped, scan: skill.scan, bots: forBots(summary.usedBy), everyBot, ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}) },
        [...skill.contents.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content, "utf8") })),
          ...skill.assets.map((file) => ({ path: file.path, size: file.content.length }))], summary.usedBy) };
    }
    if (ref.kind === "builtin") {
      const found = builtin(ref.name);
      const summary = builtinSummary(ref.name, bots);
      if (!found || !summary) return { status: 404, body: { error: "No such skill." } };
      const chiefs = bots.filter(isChief).map((bot) => ({ botId: bot.id, botName: bot.name, canUseSkills: true, enabled: attachedSkillOn(bot, ref.name) }));
      return { status: 200, body: detailView(request, { ...summary, text: found.skill.instructions, files: ["SKILL.md"], skipped: [], scan: found.scan, bots: chiefs },
        [{ path: "SKILL.md", size: Buffer.byteLength(found.skill.instructions, "utf8") }], summary.usedBy) };
    }
    const library = libraryScan(ref.name);
    if (!library) return { status: 404, body: { error: "No such skill." } };
    const summary = librarySummary({ id: ref.name, name: ref.name, description: library.description }, bots);
    const checked = checkLibrarySkill(ref.name, SKILL_LIBRARY_ROOT);
    const assets = !("error" in checked) && checked.assetsDirectory ? readLibraryAssets(checked.assetsDirectory) : [];
    if ("error" in assets) return { status: 503, body: { ...assets, code: "assets-unavailable" } };
    const files = [{ path: "SKILL.md", size: Buffer.byteLength(library.text, "utf8") },
      ...assets.map((file) => ({ path: file.path, size: file.content.length }))];
    return {
      status: 200,
      body: detailView(request, { ...summary, verdict: library.scan.verdict, text: library.text, files: ["SKILL.md"], skipped: [], scan: library.scan, bots: forBots(summary.usedBy), everyBot }, files, summary.usedBy),
    };
  }

  return { status: 404, body: { error: "no such route" } };
}
