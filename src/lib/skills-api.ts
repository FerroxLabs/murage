// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → Skills talks to /api/skills (server/skills-api.ts) through here.
import { api } from "@/state/store";

export type SkillVerdict = "clean" | "review" | "blocked";
export interface SkillFinding { rule: string; category: string; severity: string; confidence: number; message: string; evidence: string; file: string }
export interface SkillScan { verdict: SkillVerdict; findings: SkillFinding[]; contentHash: string }
export interface SkillSummary {
  ref: string;
  name: string;
  description: string;
  kind: "collection" | "library";
  verdict: SkillVerdict;
  /** "Library", or where an imported skill came from. */
  source: string;
  usedBy: Array<{ botId: string; botName: string; enabled: boolean }>;
}
export interface SkillDetail extends SkillSummary { text: string; files: string[]; skipped: string[]; scan: SkillScan }
export interface SkillsPage { yours: SkillSummary[]; library: SkillSummary[]; categories: Array<{ name: string; count: number }>; libraryReady: boolean }
export type ImportInput =
  | { link: string; replace?: boolean }
  | { files: Array<{ path: string; content: string }>; kind: "file" | "folder"; label?: string; skipped?: string[]; replace?: boolean }
  | { zip: string; label?: string; replace?: boolean };
type Request = (path: string, init?: RequestInit) => Promise<any>;

export function verdictLabel(verdict: SkillVerdict): "No red flags" | "Needs a look" | "Blocked" {
  return verdict === "clean" ? "No red flags" : verdict === "review" ? "Needs a look" : "Blocked";
}

/** Each finding once, in the order found. */
export function findingLines(scan: Pick<SkillScan, "findings">): string[] {
  return [...new Set(scan.findings.map((finding) => finding.message))];
}

export function listSkills(query: { q?: string; category?: string } = {}, request: Request = api): Promise<SkillsPage> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.category) params.set("category", query.category);
  const suffix = params.toString();
  return request(`/api/skills${suffix ? `?${suffix}` : ""}`);
}

export function readSkill(ref: string, request: Request = api): Promise<SkillDetail> {
  return request(`/api/skills/${encodeURIComponent(ref)}`);
}

export function importSkill(input: ImportInput, request: Request = api): Promise<{ skill: SkillDetail }> {
  return request("/api/skills/import", { method: "POST", body: JSON.stringify(input) });
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

/** What a refused request said, for the screens: its code, its scan, and
 *  the bots that use a skill being deleted. */
export function refusalOf(error: unknown): { code?: string; scan?: SkillScan; bots?: string[]; message: string } {
  const body = (error as { body?: { code?: string; scan?: SkillScan; bots?: string[] } } | undefined)?.body;
  return { code: body?.code, scan: body?.scan, bots: body?.bots, message: error instanceof Error ? error.message : String(error ?? "") };
}
