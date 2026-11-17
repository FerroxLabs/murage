// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";

it("makes all 141 shipped topics and all 2,247 shipped skills reachable", async () => {
  const fixture = await launchVerificationServer(process.env);
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const get = async (path: string) => {
      const response = await fetch(fixture.info.url + path, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    const topics = await get("/api/library/topics") as { topics: Array<{ term: string; label: string; count: number }>; totalSkills: number };
    expect(topics.topics).toHaveLength(141);
    expect(topics.totalSkills).toBe(2247);
    expect(topics.topics.find((topic) => topic.term === "health-wellness")?.label).toBe("Health & Wellness");
    expect(topics.topics.find((topic) => topic.term === "home-household")?.label).toBe("Home & Household");
    const ids: string[] = [];
    for (let offset = 0; offset < topics.totalSkills; offset += 200) {
      const page = await get(`/api/library/skills?offset=${offset}&limit=200`) as { total: number; offset: number; items: Array<{ id: string }> };
      expect(page.total).toBe(topics.totalSkills);
      expect(page.offset).toBe(offset);
      ids.push(...page.items.map((item) => item.id));
    }
    expect(ids).toHaveLength(2247);
    expect(new Set(ids).size).toBe(2247);
    for (const topic of topics.topics) {
      const page = await get(`/api/library/skills?term=${encodeURIComponent(topic.term)}&limit=1`) as { total: number; items: unknown[] };
      expect(page.total, topic.term).toBe(topic.count);
      expect(page.items, topic.term).toHaveLength(1);
    }
    console.info("Shipped library proof", JSON.stringify({ fixture: fixture.info, topics: topics.topics.length, skills: ids.length, lastId: ids.at(-1) }));
  } finally { await fixture.close(); }
}, 60_000);
