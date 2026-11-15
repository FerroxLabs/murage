// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from "@/state/store";
import type { SkillDetail as SettingsSkillDetail } from "./skills-api";

export interface SkillBot { id: string; name: string }
export interface SkillTopic { term: string; label: string; count: number }
export interface TopicsPage { topics: SkillTopic[]; totalSkills: number }
export type SkillsFilter = "all" | "onBots" | "mine";
export interface SkillsQuery { term?: string; q?: string; filter?: SkillsFilter; offset?: number; limit?: number }
export interface SkillListItem {
  /** Pass this opaque ref to fetchSkill, setSkillOnBot and revertSkill. */
  id: string;
  name: string;
  description: string;
  topics: string[];
  bots: SkillBot[];
  mine: boolean;
}
export interface SkillsPage { items: SkillListItem[]; total: number; offset: number }
export interface SkillFile { path: string; size: number }
export interface SkillDetail extends Omit<SettingsSkillDetail, "files" | "bots"> {
  id: string;
  mine: boolean;
  files: SkillFile[];
  /** The bots with this skill switched on. */
  bots: SkillBot[];
  originalRef?: string;
  updatedAt?: string;
}
export interface RevertResult { id: string; reverted: true; movedBots: SkillBot[] }
type Request = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export function fetchTopics(request: Request = api): Promise<TopicsPage> {
  return request("/api/library/topics");
}

export function fetchSkills(query: SkillsQuery, request: Request = api): Promise<SkillsPage> {
  const params = new URLSearchParams();
  if (query.term?.trim()) params.set("term", query.term.trim());
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.filter !== undefined) params.set("filter", query.filter);
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString();
  return request(`/api/library/skills${suffix ? `?${suffix}` : ""}`);
}

export function fetchSkill(id: string, request: Request = api): Promise<SkillDetail> {
  return request(`/api/skills/${encodeURIComponent(id)}?view=library`);
}

/** Uses the same request helper, owner proof and Skill Guard acknowledgement
 * as Settings. A needs-review refusal carries the scan to show the owner. */
export function setSkillOnBot(id: string, botId: string, on: boolean, acknowledged?: string, request: Request = api): Promise<{ skill: unknown }> {
  return request(`/api/skills/${encodeURIComponent(id)}/bots/${encodeURIComponent(botId)}`, {
    method: "PUT", body: JSON.stringify(acknowledged ? { on, acknowledged } : { on }),
  });
}

export function revertSkill(id: string, acknowledged?: string, request: Request = api): Promise<RevertResult> {
  return request(`/api/skills/${encodeURIComponent(id)}/revert`, {
    method: "POST", body: JSON.stringify(acknowledged ? { acknowledged } : {}),
  });
}
