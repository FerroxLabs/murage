// The offline contract for the team library.
//
// Every test here runs with the fetcher blocked — it throws on any call — so a
// pass means the path genuinely never touched the network, not that the network
// happened to work. That is the whole point of P0: Murage runs headless,
// air-gapped and behind local models, and the library must work anyway.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBotPackage } from "./bot-package.ts";
import {
  DEFAULT_ROOTS,
  fetchLibraryTeam,
  fetchTeamCatalog,
  loadLocalCatalog,
  loadLocalTeam,
  mergeCatalogs,
  parseTeamCatalog,
  refreshRemoteCatalog,
  type TeamCatalog,
} from "./team-library.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillLibrary = join(repoRoot, "skills-library");

/** No network. Any call is a failure of the thing under test, not a slow test. */
const blocked = vi.fn(() => {
  throw new Error("network blocked");
}) as unknown as typeof fetch;

/** A cache path that does not exist, so a catalog the developer's own machine
 *  downloaded earlier can never leak into an assertion about local behaviour. */
const scratch: string[] = [];
function noCache(): string {
  const directory = mkdtempSync(join(tmpdir(), "murage-catalog-"));
  scratch.push(directory);
  return join(directory, "catalog.json");
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("the shipped catalog", () => {
  it("passes the same gate a downloaded catalog does", () => {
    const catalog = loadLocalCatalog();
    expect(catalog).not.toBeNull();
    expect(() => parseTeamCatalog(catalog)).not.toThrow();
    expect(catalog!.teams).toHaveLength(122);
    expect(catalog!.teams.filter((team) => team.members === 1)).toHaveLength(58);
  });

  it("declares no skill it does not ship", () => {
    // installSkillFromLibrary needs BOTH files (server/skills.ts:763-773). A
    // catalog entry naming an id without them is an advertisement for something
    // that installs nothing and reports nothing — the failure this lane exists
    // to remove.
    const missing: string[] = [];
    for (const entry of loadLocalCatalog()!.teams) {
      for (const path of entry.skills) {
        const id = path.split("/")[3]!;
        if (!existsSync(join(skillLibrary, id, "SKILL.md")) || !existsSync(join(skillLibrary, id, "manifest.json"))) {
          missing.push(`${entry.slug} → ${id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("advertises exactly the skills its documents will install", () => {
    // The other direction: a document that declares a skill the catalog does not
    // list would install more than the card promised, and one the catalog lists
    // but the document does not declare would install less. Both are lies.
    for (const entry of loadLocalCatalog()!.teams) {
      const document = loadLocalTeam(entry.slug);
      expect(document, entry.slug).not.toBeNull();
      const declared =
        document!.format === "murage.package"
          ? [...new Set(document!.package.agents.flatMap((agent) => agent.skills ?? []))]
          : [];
      expect(new Set(declared), entry.slug).toEqual(new Set(entry.skills.map((path) => path.split("/")[3])));
    }
  });
});

describe("offline", () => {
  it("serves the catalog with the fetcher blocked", async () => {
    // GET /api/team-library/catalog returned 502 here before P0.
    const catalog = await fetchTeamCatalog(blocked, { cacheFile: noCache() });
    expect(catalog.format).toBe("murage.catalog");
    expect(catalog.teams).toHaveLength(122);
    expect(blocked).not.toHaveBeenCalled();
  });

  it("resolves an importable document for every entry it lists, with the fetcher blocked", async () => {
    // A catalog that loads offline in front of an install that does not is worse
    // than the error box it replaced: 122 entries and 122 dead buttons.
    const catalog = await fetchTeamCatalog(blocked, { cacheFile: noCache() });
    for (const entry of catalog.teams) {
      const loaded = await fetchLibraryTeam(entry.slug, blocked, { cacheFile: noCache() });
      const id = loaded.format === "murage.package" ? loaded.package.id : entry.slug;
      expect(id, entry.slug).toBe(entry.slug);
    }
    expect(blocked).not.toHaveBeenCalled();
  });

  it("carries the six OpenMausBot teams complete rather than half", async () => {
    // These six had no source in this repo at all. Vendored, they import with
    // their crew, their room and their playbooks — the playbooks being the ids
    // upstream's catalog mislabels as skills, which no import has ever
    // installed. Nothing about them is now network-dependent.
    for (const slug of ["100x-marketing", "competitor-watch", "engineering", "inbox-follow-up", "reddit-lead-miner", "seo-growth"]) {
      const loaded = await fetchLibraryTeam(slug, blocked, { cacheFile: noCache() });
      if (loaded.format !== "murage.package") throw new Error(`${slug} is not a package`);
      expect(loaded.package.agents.length, slug).toBeGreaterThan(1);
      expect(loaded.package.rooms?.length, slug).toBe(1);
      expect(loaded.package.playbooks?.length, slug).toBeGreaterThan(1);
      for (const playbook of loaded.package.playbooks ?? []) expect(playbook.instructions.length).toBeGreaterThan(100);
    }
    expect(blocked).not.toHaveBeenCalled();
  });

  it("refuses a document whose package id is not its filename", () => {
    const roots = { library: mkdtempSync(join(tmpdir(), "murage-lib-")), botLibrary: DEFAULT_ROOTS.botLibrary };
    scratch.push(roots.library);
    mkdirSync(join(roots.library, "packages"), { recursive: true });
    const borrowed = readFileSync(join(repoRoot, "library", "assistants", "beacon.json"), "utf8");
    writeFileSync(join(roots.library, "packages", "smart-trader.json"), borrowed);
    // Otherwise one catalog entry could install another entry's bots.
    expect(loadLocalTeam("smart-trader", roots)).toBeNull();
  });

  it("refuses a slug that names a path", () => {
    // Two independent gates cover this and either alone is enough: the slug
    // pattern stops the read, and the id check refuses the document because a
    // package id can never contain a separator. Measured with negative
    // controls — removing one leaves this green, removing both turns it red.
    expect(loadLocalTeam("../assistants/beacon")).toBeNull();
    expect(loadLocalTeam("beacon/../beacon")).toBeNull();
    expect(loadLocalTeam("")).toBeNull();
  });
});

describe("the refresh", () => {
  const remoteOnly: TeamCatalog = parseTeamCatalog({
    format: "murage.catalog",
    version: 1,
    teams: [
      {
        slug: "brand-new-crew",
        name: "Brand New Crew",
        summary: "Only upstream has this one.",
        category: "Run",
        manifest: "teams/brand-new-crew/brand-new-crew.emberteam.json",
        readme: "teams/brand-new-crew/README.md",
        members: 3,
        skills: [],
        requires: { apps: [] },
      },
    ],
  });

  it("adds slugs the shipped tree does not have and overrides none that it does", () => {
    const local = loadLocalCatalog()!;
    const collision = parseTeamCatalog({
      ...remoteOnly,
      teams: [...remoteOnly.teams, { ...local.teams[0], name: "Renamed Upstream", summary: "Different upstream text." }],
    });
    const merged = mergeCatalogs(local, collision);
    expect(merged.teams).toHaveLength(local.teams.length + 1);
    // The local document is the one that installs, so the local label is the
    // one the card must show.
    expect(merged.teams[0]!.name).toBe(local.teams[0]!.name);
    expect(merged.teams.at(-1)!.slug).toBe("brand-new-crew");
  });

  it("caches a download that validates and merges it on the next read", async () => {
    const cacheFile = noCache();
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(remoteOnly), { headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    expect(await refreshRemoteCatalog(fetcher, cacheFile)).not.toBeNull();
    const merged = await fetchTeamCatalog(blocked, { cacheFile });
    expect(merged.teams).toHaveLength(123);
    expect(merged.teams.at(-1)!.slug).toBe("brand-new-crew");
  });

  it("rejects a hostile download without writing the cache or disturbing the library", async () => {
    const cacheFile = noCache();
    const hostile = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: "murage.catalog",
            version: 1,
            teams: [{ ...remoteOnly.teams[0], manifest: "../../../etc/passwd" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    expect(await refreshRemoteCatalog(hostile, cacheFile)).toBeNull();
    expect(existsSync(cacheFile)).toBe(false);
    expect((await fetchTeamCatalog(blocked, { cacheFile })).teams).toHaveLength(122);
  });

  it("keeps the whole library when the download exceeds the entry ceiling", async () => {
    // parseTeamCatalog throws before returning anything, so an over-ceiling
    // catalog used to lose every entry rather than the new ones. Local-first
    // turns that from an empty panel into a refresh that simply did not happen.
    const cacheFile = noCache();
    const entry = remoteOnly.teams[0]!;
    const flood = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: "murage.catalog",
            version: 1,
            teams: Array.from({ length: 401 }, (_, i) => ({
              ...entry,
              slug: `team-${i}`,
              manifest: `teams/team-${i}/team-${i}.emberteam.json`,
              readme: `teams/team-${i}/README.md`,
            })),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    expect(await refreshRemoteCatalog(flood, cacheFile)).toBeNull();
    expect((await fetchTeamCatalog(blocked, { cacheFile })).teams).toHaveLength(122);
  });

  it("rejects a cache file that was edited after it was written", async () => {
    const cacheFile = noCache();
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), catalog: { format: "murage.catalog", version: 1, teams: "not an array" } }));
    expect((await fetchTeamCatalog(blocked, { cacheFile })).teams).toHaveLength(122);
  });
});

describe("the vendored tree", () => {
  it("holds a parseable document for every slug and nothing it does not need", () => {
    const catalog = loadLocalCatalog()!;
    const slugs = new Set(catalog.teams.map((team) => team.slug));
    const vendored = readdirSync(join(repoRoot, "library", "packages"));
    expect(vendored).toHaveLength(65);
    for (const file of vendored) {
      const slug = file.replace(/\.(json|md)$/, "");
      expect(slugs.has(slug), file).toBe(true);
      const raw = readFileSync(join(repoRoot, "library", "packages", file), "utf8");
      expect(parseBotPackage(file.endsWith(".md") ? raw : JSON.parse(raw)).package.id).toBe(slug);
    }
  });
});
