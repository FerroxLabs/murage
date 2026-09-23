// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/skills: Settings → Skills. One set of routes for the owner's own
// skills (the collection) and the library, so the screen never has to know
// where a skill lives. Switching a skill on for a bot installs it there if
// needed and always goes through Skill Guard's gate (setSkillEnabled).
// Desktop only, like every route that can put instructions in front of a bot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { deleteCollectionSkill, getCollectionSkill, importCollectionSkill, listCollection, type CollectionSkill, type SkillSourceKind } from "./skill-collection.ts";
import { fetchSkillFromLink, readSkillZip } from "./skill-import-sources.ts";
import { browseFacets, searchSkills, skillIndexStats, skillsByFacet } from "./skill-search.ts";
import { checkLibrarySkill, currentSkillScan, installSkill, installSkillFromLibrary, isSkillName, listSkills, removeSkill, setSkillEnabled, SKILL_LIBRARY_ROOT, type SkillListing } from "./skills.ts";
import type { SkillScan, SkillVerdict } from "./skill-guard/types.ts";

export interface SkillsApiBot { id: string; name: string; canUseSkills: boolean }
export interface SkillsApiRequest {
  method: string;
  path: string;
  url: URL;
  readBody: () => Promise<unknown>;
  bots: () => SkillsApiBot[];
  fetcher?: typeof fetch;
}
export type SkillsApiResponse = { status: number; body: unknown };

interface SkillSummary {
  ref: string;
  name: string;
  description: string;
  kind: "collection" | "library";
  verdict: SkillVerdict;
  source: string;
  usedBy: Array<{ botId: string; botName: string; enabled: boolean }>;
}

const LIBRARY = "library:";
const COLLECTION = "collection:";
const SOURCE_LABEL: Record<SkillSourceKind, string> = { file: "Imported from a file", folder: "Imported from a folder", zip: "Imported from a zip", link: "Imported from a link" };

let verdictCache: { root: string; skills: Record<string, { verdict: SkillVerdict }> } | null = null;
function shippedVerdict(id: string): SkillVerdict | null {
  if (verdictCache?.root !== SKILL_LIBRARY_ROOT) {
    try {
      verdictCache = { root: SKILL_LIBRARY_ROOT, skills: JSON.parse(readFileSync(join(SKILL_LIBRARY_ROOT, "scan-verdicts.json"), "utf8")).skills ?? {} };
    } catch {
      verdictCache = { root: SKILL_LIBRARY_ROOT, skills: {} };
    }
  }
  return verdictCache.skills[id]?.verdict ?? null;
}

function libraryScan(id: string): { text: string; description: string; scan: SkillScan } | null {
  const checked = checkLibrarySkill(id, SKILL_LIBRARY_ROOT);
  if ("error" in checked) return null;
  return { text: checked.prepared.files[0]!.content, description: checked.prepared.parsed.description, scan: checked.prepared.scan };
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
  return { ref, name: skill.name, description: skill.description, kind: "collection", verdict: skill.scan.verdict, source: SOURCE_LABEL[skill.source.kind], usedBy: usedBy(ref, bots) };
}

function librarySummary(hit: { id: string; name: string; description: string }, bots: SkillsApiBot[]): SkillSummary {
  const ref = `${LIBRARY}${hit.id}`;
  const verdict = shippedVerdict(hit.id) ?? libraryScan(hit.id)?.scan.verdict ?? "clean";
  return { ref, name: hit.id, description: hit.description, kind: "library", verdict, source: "Library", usedBy: usedBy(ref, bots) };
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

const refPattern = /^(collection|library):([a-z0-9][a-z0-9-]{0,127})$/;
function parseRef(raw: string): { kind: "collection" | "library"; name: string; ref: string } | null {
  const match = refPattern.exec(decodeURIComponent(raw));
  if (!match || !isSkillName(match[2]!)) return null;
  return { kind: match[1] as "collection" | "library", name: match[2]!, ref: `${match[1]}:${match[2]}` };
}

const importBody = z.union([
  z.object({ link: z.string().min(1).max(2000), replace: z.boolean().optional() }).strict(),
  z.object({ files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string() })).min(1).max(200), kind: z.enum(["file", "folder"]), label: z.string().max(200).optional(), skipped: z.array(z.string().max(500)).max(200).optional(), replace: z.boolean().optional() }).strict(),
  z.object({ zip: z.string().min(1).max(12 * 1024 * 1024), label: z.string().max(200).optional(), replace: z.boolean().optional() }).strict(),
]);

export async function handleSkillsApi(request: SkillsApiRequest): Promise<SkillsApiResponse | null> {
  const { method, path } = request;
  if (path !== "/api/skills" && !path.startsWith("/api/skills/")) return null;

  if (method === "GET" && path === "/api/skills") {
    const bots = request.bots();
    const q = (request.url.searchParams.get("q") ?? "").trim().slice(0, 200);
    const category = (request.url.searchParams.get("category") ?? "").trim().slice(0, 80);
    const needle = q.toLowerCase();
    const matchesQuery = (s: { name: string; description: string }) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);
    const yoursCollection = listCollection().filter(matchesQuery).map((skill) => collectionSummary(skill, bots));
    const yoursLibrary = libraryInUse(bots).filter(matchesQuery).map((hit) => librarySummary(hit, bots));
    const [stats, facets] = await Promise.all([skillIndexStats(), browseFacets().catch(() => [])]);
    const hits = q ? await searchSkills(q, 50) : category ? await skillsByFacet(category, 50) : [];
    const yoursRefs = new Set(yoursLibrary.map((s) => s.ref));
    return {
      status: 200,
      body: {
        yours: [...yoursCollection, ...yoursLibrary].sort((a, b) => a.name.localeCompare(b.name)),
        library: hits.map((hit) => librarySummary(hit, bots)).filter((s) => !yoursRefs.has(s.ref)),
        categories: facets.slice(0, 12).map((facet) => ({ name: facet.term, count: facet.count })),
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
    return { status: 201, body: { skill: { ...collectionSummary(imported, request.bots()), scan: imported.scan, skipped: imported.skipped } } };
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
    for (const user of users) removeSkill(user.botId, name);
    deleteCollectionSkill(name);
    return { status: 200, body: { removedFrom: users.map((u) => u.botName) } };
  }

  const forBot = /^\/api\/skills\/([^/]+)\/bots\/([\w-]+)$/.exec(path);
  if (forBot && method === "PUT") {
    const ref = parseRef(forBot[1]!);
    const bot = request.bots().find((b) => b.id === forBot[2]);
    if (!ref) return { status: 404, body: { error: "No such skill." } };
    if (!bot) return { status: 404, body: { error: "No such bot." } };
    const input = z.object({ on: z.boolean(), acknowledged: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(await request.readBody());
    if (!input.success) return { status: 400, body: { error: "on must be true or false" } };
    const existing = listSkills(bot.id).find((listing) => listing.name === ref.name);
    const ours = existing && (ref.kind === "collection" ? existing.source === ref.ref : existing.source.startsWith(`${ref.ref}@`));
    if (!input.data.on) {
      if (!existing || !ours) return { status: 200, body: { skill: null } };
      const off = setSkillEnabled(bot.id, ref.name, false);
      return "error" in off ? { status: 409, body: off } : { status: 200, body: { skill: off } };
    }
    if (!bot.canUseSkills) return { status: 409, body: { error: "This bot's engine can't use skills.", code: "engine" } };
    if (existing && !ours) return { status: 409, body: { error: `${bot.name} already has a different skill called ${ref.name}.`, code: "name-taken" } };

    // What the owner acknowledged is the scan they were shown in the reader.
    let acknowledged = input.data.acknowledged;
    if (ref.kind === "collection") {
      const skill = getCollectionSkill(ref.name);
      if (!skill) return { status: 404, body: { error: "No such skill." } };
      if (skill.scan.verdict === "blocked") return { status: 409, body: { error: "This skill was blocked by the safety check and can't be switched on.", code: "blocked", scan: skill.scan } };
      if (skill.scan.verdict === "review" && acknowledged !== skill.scan.contentHash) return { status: 409, body: { error: "This skill needs a look before it can be switched on.", code: "needs-review", scan: skill.scan } };
      if (!existing) {
        const installed = installSkill(bot.id, ref.ref, skill.contents);
        if ("error" in installed) return { status: 409, body: installed };
      }
      // The bot keeps the instructions, a part of what was reviewed: the
      // owner's yes to the whole skill covers it.
      if (skill.scan.verdict === "review") acknowledged = currentSkillScan(bot.id, ref.name)?.contentHash;
    } else if (!existing) {
      const installed = installSkillFromLibrary(bot.id, ref.name, SKILL_LIBRARY_ROOT);
      if ("error" in installed) return { status: 404, body: { error: installed.error } };
    }
    const on = setSkillEnabled(bot.id, ref.name, true, { acknowledged });
    if ("error" in on) return { status: on.code ? 409 : 404, body: on };
    return { status: 200, body: { skill: on } };
  }

  const one = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (one && method === "GET") {
    const ref = parseRef(one[1]!);
    if (!ref) return { status: 404, body: { error: "No such skill." } };
    const bots = request.bots();
    // Every bot, for the reader's "Use with" switches.
    const forBots = (users: SkillSummary["usedBy"]) =>
      bots.map((bot) => ({ botId: bot.id, botName: bot.name, canUseSkills: bot.canUseSkills, enabled: users.find((u) => u.botId === bot.id)?.enabled ?? false }));
    if (ref.kind === "collection") {
      const skill = getCollectionSkill(ref.name);
      if (!skill) return { status: 404, body: { error: "No such skill." } };
      const summary = collectionSummary(skill, bots);
      return { status: 200, body: { ...summary, text: skill.text, files: skill.files, skipped: skill.skipped, scan: skill.scan, bots: forBots(summary.usedBy) } };
    }
    const library = libraryScan(ref.name);
    if (!library) return { status: 404, body: { error: "No such skill." } };
    const summary = librarySummary({ id: ref.name, name: ref.name, description: library.description }, bots);
    return {
      status: 200,
      body: { ...summary, verdict: library.scan.verdict, text: library.text, files: ["SKILL.md"], skipped: [], scan: library.scan, bots: forBots(summary.usedBy) },
    };
  }

  return { status: 404, body: { error: "no such route" } };
}
