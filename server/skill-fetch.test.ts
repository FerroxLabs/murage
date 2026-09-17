// Where a pasted skill source is allowed to point, and what gets fetched for
// it. The network is always a fake: parseSkillSource decides the URL, and
// fetchSkillFromSource must request exactly that URL or nothing at all.
import { describe, expect, it, vi } from "vitest";

import { fetchSkillFromSource, parseSkillSource } from "./skill-fetch.ts";
import { installSkill, listSkills, readSkillFile } from "./skills.ts";

const fakeFetch = (body = "# A skill") => vi.fn(async (_input: string | URL | Request) => new Response(body)) as typeof fetch;
const requested = (fetcher: typeof fetch) => vi.mocked(fetcher).mock.calls.map(([input]) => String(input));

describe("skill sources", () => {
  it.each([
    ["https://github.com/a/b/blob/main/SKILL.md", "https://raw.githubusercontent.com/a/b/main/SKILL.md"],
    ["https://github.com/a/b/blob/main/skills/pdf/SKILL.md", "https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md"],
    ["http://github.com/a/b/blob/v1.2/SKILL.md", "https://raw.githubusercontent.com/a/b/v1.2/SKILL.md"],
  ])("imports a GitHub blob link to a SKILL.md: %s", async (source, raw) => {
    expect(parseSkillSource(source)).toEqual({ rawUrl: raw });
    const fetcher = fakeFetch();
    expect(await fetchSkillFromSource(source, fetcher)).toEqual({
      skills: [{ source: raw, files: [{ path: "SKILL.md", content: "# A skill" }] }],
    });
    expect(requested(fetcher)).toEqual([raw]);
  });

  it.each([
    "https://raw.githubusercontent.com/a/b/main/SKILL.md",
    "https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md",
  ])("imports a raw link to a SKILL.md unchanged: %s", async (source) => {
    expect(parseSkillSource(source)).toEqual({ rawUrl: source });
    const fetcher = fakeFetch();
    expect(await fetchSkillFromSource(source, fetcher)).toEqual({
      skills: [{ source, files: [{ path: "SKILL.md", content: "# A skill" }] }],
    });
    expect(requested(fetcher)).toEqual([source]);
  });

  it.each([
    "https://github.com/a/b/blob/main/README-SKILL.md",
    "https://github.com/a/b/blob/main/docs/notSKILL.md",
    "https://github.com/a/b/blob/main/SKILL.md.bak",
  ])("refuses a blob link to a file that is not SKILL.md, like a raw link does: %s", async (source) => {
    const fetcher = fakeFetch("# Not a skill");
    expect(await fetchSkillFromSource(source, fetcher)).toEqual({ error: expect.stringContaining("does not look like") });
    expect(await fetchSkillFromSource(source.replace("github.com/a/b/blob/", "raw.githubusercontent.com/a/b/"), fetcher)).toEqual({
      error: expect.stringContaining("does not look like"),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps repository and folder shapes as they were", () => {
    expect(parseSkillSource("obra/superpowers")).toEqual({ owner: "obra", repo: "superpowers", path: "" });
    expect(parseSkillSource("https://github.com/anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: undefined,
      path: "",
    });
    expect(parseSkillSource("https://github.com/o/r.git/")).toEqual({ owner: "o", repo: "r", ref: undefined, path: "" });
    expect(parseSkillSource("https://github.com/o/r/tree/main")).toEqual({ owner: "o", repo: "r", ref: "main", path: "" });
    expect(parseSkillSource("https://github.com/o/r/tree/main/skills/tdd")).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
      path: "skills/tdd",
    });
  });

  it.each([
    "",
    "   ",
    "not a url",
    "https://evil.example/a/b/blob/main/SKILL.md",
    "https://gist.github.com/a/b/blob/main/SKILL.md",
    "https://github.com.evil.example/a/b/blob/main/SKILL.md",
    "https://raw.githubusercontent.com.evil.example/a/b/main/SKILL.md",
    "ftp://github.com/a/b/blob/main/SKILL.md",
    "file:///etc/SKILL.md",
    "https://github.com/a/b/blob/main/",
    "https://github.com/a/b/blob/SKILL.md",
  ])("refuses an untrusted or malformed source without fetching: %j", async (source) => {
    const fetcher = fakeFetch();
    expect(parseSkillSource(source)).toEqual({ error: expect.any(String) });
    expect(await fetchSkillFromSource(source, fetcher)).toEqual({ error: expect.any(String) });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("importing a repository-root SKILL.md", () => {
  // The same two calls POST /api/bots/:id/skills makes, with the network
  // replaced. Storage is the per-file throwaway home from testing/setup.ts.
  const SKILL_MD = "---\nname: root-skill\ndescription: A skill that lives at the root of its repository.\n---\n\n# Root skill\n\nDo the thing.\n";

  it("installs it disabled, with exactly the fetched bytes", async () => {
    const bot = `root-skill-bot-${Math.random().toString(36).slice(2, 10)}`;
    const fetcher = fakeFetch(SKILL_MD);
    const fetched = await fetchSkillFromSource("https://github.com/a/b/blob/main/SKILL.md", fetcher);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(requested(fetcher)).toEqual(["https://raw.githubusercontent.com/a/b/main/SKILL.md"]);

    const results = fetched.skills.map((skill) => installSkill(bot, skill.source, skill.files));
    expect(results).toEqual([expect.objectContaining({ name: "root-skill", enabled: false })]);
    expect(listSkills(bot)).toEqual([
      expect.objectContaining({
        name: "root-skill",
        enabled: false,
        source: "https://raw.githubusercontent.com/a/b/main/SKILL.md",
      }),
    ]);
    expect(readSkillFile(bot, "root-skill")).toBe(SKILL_MD);
  });

  it("installs nothing when the link is refused", async () => {
    const bot = `refused-skill-bot-${Math.random().toString(36).slice(2, 10)}`;
    const fetcher = fakeFetch(SKILL_MD);
    const fetched = await fetchSkillFromSource("https://github.com/a/b/blob/main/README-SKILL.md", fetcher);
    expect(fetched).toEqual({ error: expect.stringContaining("does not look like") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(listSkills(bot)).toEqual([]);
  });
});
