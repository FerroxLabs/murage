// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → Skills talks to /api/skills (server/skills-api.ts) through here.
import { api } from "@/state/store";
import type { SkillPagination } from "../../shared/skill-pagination";

export type SkillVerdict = "clean" | "review" | "blocked";
export interface SkillFinding { rule: string; category: string; severity: string; confidence: number; message: string; evidence: string; file: string }
export interface SkillScan { verdict: SkillVerdict; findings: SkillFinding[]; contentHash: string }
export interface SkillSummary {
  ref: string;
  name: string;
  description: string;
  kind: "collection" | "library" | "builtin";
  verdict: SkillVerdict;
  /** For a skill that needs a look or is blocked: what was found, in words (server/skills-api.ts). */
  reason?: string;
  /** "Library", "Built-in", or where an imported skill came from. */
  source: string;
  usedBy: Array<{ botId: string; botName: string; enabled: boolean }>;
}
export interface SkillDetail extends SkillSummary {
  text: string;
  files: string[];
  skipped: string[];
  scan: SkillScan;
  /** Every bot, and whether this skill is on for it. */
  bots: Array<{ botId: string; botName: string; canUseSkills: boolean; enabled: boolean }>;
  /** F10/E1: marked for every bot, now and later (not for built-ins). */
  everyBot?: boolean;
}
export interface SkillsPage {
  yours: SkillSummary[];
  library: SkillSummary[];
  /** Built-ins that belong to one bot, e.g. the Chief of Staff guide. */
  builtins?: SkillSummary[];
  categories: Array<{ name: string; count: number }>;
  libraryReady: boolean;
  pagination: SkillPagination;
}

/** The Chief of Staff guide: a built-in attached to the workspace Chief. */
export const CHIEF_GUIDE_REF = "builtin:chief-of-staff";
export type ImportInput =
  | { link: string; replace?: boolean }
  | { files: Array<{ path: string; content: string }>; kind: "file" | "folder"; label?: string; skipped?: string[]; replace?: boolean }
  | { zip: string; label?: string; replace?: boolean };
type Request = (path: string, init?: RequestInit) => Promise<any>;

/** What a clean verdict means, said once: the shield's label and the import result. */
export const CLEAN_LINE = "Checked, nothing risky found";

export function verdictLabel(verdict: SkillVerdict): typeof CLEAN_LINE | "Needs a look" | "Blocked" {
  return verdict === "clean" ? CLEAN_LINE : verdict === "review" ? "Needs a look" : "Blocked";
}

/** What a row says under a skill that needs a look or is blocked: what was found, then what the owner can do. */
export function verdictHint(skill: Pick<SkillSummary, "verdict" | "reason">): string | null {
  if (skill.verdict === "clean") return null;
  const found = skill.reason ? `${skill.reason}. ` : "";
  return skill.verdict === "review" ? `${found}Open it to read what was found, then decide.` : `${found}It can't be switched on.`;
}

/** The instructions without their header block (name, description and
 *  other settings), which the screens show in words instead. */
export function skillBody(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").replace(/^\s+/, "");
}

/** Each finding once, in the order found. */
export function findingLines(scan: Pick<SkillScan, "findings">): string[] {
  return [...new Set(scan.findings.map((finding) => finding.message))];
}

export function listSkills(query: { q?: string; category?: string; offset?: number; limit?: number } = {}, request: Request = api): Promise<SkillsPage> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.category) params.set("category", query.category);
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString();
  return request(`/api/skills${suffix ? `?${suffix}` : ""}`);
}

export function readSkill(ref: string, request: Request = api): Promise<SkillDetail> {
  return request(`/api/skills/${encodeURIComponent(ref)}`);
}

export function importSkill(input: ImportInput, request: Request = api): Promise<{ skill: SkillDetail }> {
  return request("/api/skills/import", { method: "POST", body: JSON.stringify(input) });
}

/** F10/E1: give a skill to every bot now and every bot added later, or take that mark away. */
export function setSkillForEveryBot(ref: string, on: boolean, acknowledged?: string, request: Request = api): Promise<{ everyBot: boolean }> {
  return request(`/api/skills/${encodeURIComponent(ref)}/every-bot`, {
    method: "PUT",
    body: JSON.stringify(acknowledged ? { on, acknowledged } : { on }),
  });
}

export function setSkillForBot(ref: string, botId: string, on: boolean, acknowledged?: string, request: Request = api): Promise<{ skill: unknown }> {
  return request(`/api/skills/${encodeURIComponent(ref)}/bots/${encodeURIComponent(botId)}`, {
    method: "PUT",
    body: JSON.stringify(acknowledged ? { on, acknowledged } : { on }),
  });
}

export function deleteCollectionSkill(name: string, fromBots = false, request: Request = api): Promise<{ removedFrom: string[] }> {
  return request(`/api/skills/collection/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify(fromBots ? { fromBots: true } : {}) });
}

/** A copy of any skill in Your skills ("<name>-copy"), to open or edit. */
export function duplicateSkill(ref: string, request: Request = api): Promise<{ skill: SkillDetail }> {
  return request(`/api/skills/${encodeURIComponent(ref)}/duplicate`, { method: "POST", body: JSON.stringify({}) });
}

/** The name a skill in Your skills is kept under (its ref without "collection:"). */
export function collectionSlug(ref: string): string {
  return ref.startsWith("collection:") ? ref.slice("collection:".length) : ref;
}

/** Save an edit to one of your skills. `needsLook` names the bots it was
 *  switched off on because the new version needs a look first. */
export function saveSkill(
  ref: string,
  edit: { displayName: string; description: string; body: string },
  request: Request = api,
): Promise<{ skill: SkillDetail; needsLook: string[]; failed: string[] }> {
  return request(`/api/skills/collection/${encodeURIComponent(collectionSlug(ref))}`, { method: "PUT", body: JSON.stringify(edit) });
}

/** What a refused request said, for the screens: its code, its scan, and
 *  the bots that use a skill being deleted. */
export function refusalOf(error: unknown): { code?: string; scan?: SkillScan; bots?: string[]; message: string } {
  const body = (error as { body?: { code?: string; scan?: SkillScan; bots?: string[] } } | undefined)?.body;
  return { code: body?.code, scan: body?.scan, bots: body?.bots, message: error instanceof Error ? error.message : String(error ?? "") };
}

// ── Settings v10 (K5, K9, B6): the query route, bulk operations and the "In every message" preview ──────────────────────

export interface SkillQueryRow extends SkillSummary {
  category: string;
  isNew: boolean;
  /** Bots holding a copy older than the library's. */
  updateReady?: Array<{ botId: string; botName: string }>;
}
export interface SkillQueryParams {
  q?: string;
  show?: "all" | "mine" | "onBots" | "new";
  category?: string;
  source?: "" | "library" | "yours";
  status?: "" | "clean" | "flagged" | "update";
  sort?: "name" | "newest";
  usedBy?: string;
  cursor?: string | null;
  rid?: string;
}
export interface SkillQueryResult {
  rid: string;
  rows: SkillQueryRow[];
  yours: SkillSummary[];
  total: number;
  facets: Array<{ category: string; count: number }>;
  next: string | null;
  /** The search has matches outside the scope: how many in the whole library. */
  widen?: { all: number };
}
/** Rows the Skills page shows at a time; the header box selects exactly these. */
export const SKILL_QUERY_PAGE = 60;

export function querySkills(query: SkillQueryParams = {}, request: Request = api): Promise<SkillQueryResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string" && value.trim()) params.set(key, value.trim());
  const suffix = params.toString();
  return request(`/api/skills/query${suffix ? `?${suffix}` : ""}`);
}

export type BulkPairState = "on" | "already-on" | "off" | "already-off" | "refused" | "unknown" | "kept";
export interface BulkPairResult { skill: string; botId: string; botName: string; state: BulkPairState; reason?: string; code?: string }
export interface BulkTarget { botIds?: string[]; teamId?: string }
export interface BulkOpResult { opId: string; on: boolean; skills: string[]; target?: BulkTarget; pairs: BulkPairResult[]; undoOf?: string }

/** A fresh id for one bulk act; a retry of the same act reuses it so only the pairs still unknown run again. */
export function newBulkOpId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "op" + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** `target` is sent exactly as first chosen: the server compares it to the recorded operation, so a retry must not rebuild it. */
export function bulkSkills(input: { opId: string; skills: string[]; on: boolean; target: BulkTarget }, request: Request = api): Promise<{ op: BulkOpResult }> {
  return request("/api/skills/bulk", { method: "PUT", body: JSON.stringify({ opId: input.opId, skills: input.skills, on: input.on, target: input.target }) });
}
export function readBulkOp(opId: string, request: Request = api): Promise<{ op: BulkOpResult }> {
  return request(`/api/skills/bulk/${encodeURIComponent(opId)}`);
}
export function undoBulk(opId: string, undoId: string, request: Request = api): Promise<{ op: BulkOpResult }> {
  return request(`/api/skills/bulk/${encodeURIComponent(opId)}/undo`, { method: "PUT", body: JSON.stringify({ opId: undoId }) });
}

/** How one pair reads to the owner. Not saved is only ever a refusal the computer recorded, drawn with its reason; a pair
 *  still unknown (a lost reply, a restart) is Could not check, never Not saved and never read off the current switch. */
export function pairLine(pair: Pick<BulkPairResult, "state" | "reason">, on: boolean): { label: "Saved" | "Not saved" | "Could not check" | "Left as it is"; detail: string } {
  if (pair.state === "refused") return { label: "Not saved", detail: pair.reason ?? "Murage refused this one." };
  if (pair.state === "unknown") return { label: "Could not check", detail: "Murage could not tell whether this one was saved. Try again." };
  if (pair.state === "kept") return { label: "Left as it is", detail: pair.reason ?? "Changed since, so it was left as it is." };
  const already = pair.state === "already-on" || pair.state === "already-off";
  return { label: "Saved", detail: already ? (on ? "Already on." : "Already off.") : (on ? "On." : "Off.") };
}

export interface SkillIndexPreview { inEveryMessage: Array<{ name: string; bytes: number }>; lookedUp: string[]; omitted: number; reason: string | null }
export function skillIndexPreview(botId: string, request: Request = api): Promise<SkillIndexPreview> {
  return request(`/api/skills/preview?botId=${encodeURIComponent(botId)}`);
}
