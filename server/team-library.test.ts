import { describe, expect, it, vi } from "vitest";

import {
  TEAM_LIBRARY_CATALOG_URL,
  TEAM_LIBRARY_RAW_ROOT,
  fetchGithubTeam,
  fetchLibraryTeam,
  githubManifestUrls,
  parseTeamCatalog,
} from "./team-library.ts";

const manifest = {
  format: "murage.team",
  version: 2,
  team: {
    name: "Engineering",
    members: [
      {
        key: "lead",
        name: "Ada",
        title: "Tech Lead",
        description: "Coordinates the work",
        appearance: { color: "purple" },
      },
    ],
  },
};

const catalog = {
  format: "murage.catalog",
  version: 1,
  teams: [
    {
      slug: "engineering",
      name: "Engineering Team",
      summary: "Plan and ship software.",
      category: "Engineering",
      manifest: "teams/engineering/team.emberteam.json",
      readme: "teams/engineering/README.md",
      members: 1,
      skills: ["teams/engineering/skills/release/SKILL.md"],
      requires: { apps: ["GitHub"] },
    },
  ],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("team library", () => {
  it("validates catalog paths and adds the trusted repository URL", () => {
    const parsed = parseTeamCatalog(catalog);
    expect(parsed.repositoryUrl).toBe("https://github.com/FerroxLabs/murage-teams");
    expect(parsed.teams[0]).toMatchObject({ slug: "engineering", members: 1 });

    const unsafe = structuredClone(catalog);
    unsafe.teams[0]!.manifest = "../private.json";
    expect(() => parseTeamCatalog(unsafe)).toThrow("safe catalog path");
  });

  // The live catalog carries 65 teams plus 57 single-agent profiles. The
  // original ceiling was 100, so publishing the profiles made a released
  // client throw on a catalog it had to accept — and parseTeamCatalog throws
  // before returning anything, so the failure loses every team too, not just
  // the new entries. Pin the real shape, not a round number.
  it("accepts a catalog larger than the live one and still rejects an absurd one", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...catalog.teams[0]!,
        slug: `team-${i}`,
        manifest: `teams/team-${i}/team.emberteam.json`,
        readme: `teams/team-${i}/README.md`,
        skills: [],
      }));

    expect(parseTeamCatalog({ ...catalog, teams: entries(122) }).teams).toHaveLength(122);
    expect(() => parseTeamCatalog({ ...catalog, teams: entries(401) })).toThrow("catalog is invalid");
  });

  it("loads only the manifest selected by the trusted catalog", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === TEAM_LIBRARY_CATALOG_URL) return response(catalog);
      if (target === `${TEAM_LIBRARY_RAW_ROOT}/teams/engineering/team.emberteam.json`) return response(manifest);
      return response({}, 404);
    }) as unknown as typeof fetch;

    const loaded = await fetchLibraryTeam("engineering", fetcher);
    if (loaded.format !== "murage.team") throw new Error("expected a legacy team");
    expect(loaded.team.name).toBe("Engineering");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes public GitHub repository, blob, and raw links", () => {
    expect(githubManifestUrls("https://github.com/acme/team")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/main/team.md",
      "https://raw.githubusercontent.com/acme/team/main/team.emberteam.json",
      "https://raw.githubusercontent.com/acme/team/master/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/master/team.md",
      "https://raw.githubusercontent.com/acme/team/master/team.emberteam.json",
    ]);
    expect(githubManifestUrls("https://github.com/acme/team/blob/main/presets/seo.emberteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/presets/seo.emberteam.json",
    ]);
    expect(githubManifestUrls("https://raw.githubusercontent.com/acme/team/main/team.emberteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/team.emberteam.json",
    ]);
    expect(() => githubManifestUrls("http://example.com/team.json")).toThrow("public HTTPS GitHub");
    expect(() => githubManifestUrls("https://github.com/acme/team/blob/main/run.sh")).toThrow("Markdown playbook");
  });

  it("falls back from main to master for a repository link", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("team.emberteam.json") && String(url).includes("/master/")
        ? response(manifest)
        : response({}, 404),
    ) as unknown as typeof fetch;

    const loaded = await fetchGithubTeam("https://github.com/acme/team", fetcher);
    if (loaded.format !== "murage.team") throw new Error("expected a legacy team");
    expect(loaded.team.members[0]?.name).toBe("Ada");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
