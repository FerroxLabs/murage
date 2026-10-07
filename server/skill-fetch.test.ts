// Where a pasted skill source is allowed to point, and what gets fetched for
// it. The network is always a fake: parseSkillSource decides the URL, and
// fetchSkillFromSource must request exactly that URL or nothing at all.
import { describe, expect, it, vi } from "vitest";

import { fetchSkillFromSource, parseSkillSource } from "./skill-fetch.ts";
import { installSkill, listSkills, readSkillFile } from "./skills.ts";

const fakeFetch = (body = "# A skill") => vi.fn(async (_input: string | URL | Request) => new Response(body)) as typeof fetch;
const requested = (fetcher: typeof fetch) => vi.mocked(fetcher).mock.calls.map(([input]) => String(input));

const encoder = new TextEncoder();
const RAW_SKILL = "https://raw.githubusercontent.com/o/r/main/SKILL.md";
const SOURCE_TIMEOUT = "The skill source took too long to answer. Try again in a moment.";
const SOURCE_REDIRECT = "That skill source sent Murage somewhere it does not import from.";
const FILE_TOO_LARGE = "Import stopped because the file is too large (over the 256 KB import cap). Choose a smaller file or a folder of smaller files.";
const LISTING_TOO_LARGE = "That skill folder is too large to read. Choose a smaller folder.";

const measuredBody = (chunks: Uint8Array[]) => {
  let index = 0;
  const observed = { pulled: 0, cancelled: false };
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) return controller.close();
      observed.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { observed.cancelled = true; },
  }, { highWaterMark: 0 }));
  return { response, observed };
};

describe("bounded skill downloads", () => {
  it("counts the decoded size of invalid bytes and of a trailing partial character", async () => {
    const bad = measuredBody([new Uint8Array(256 * 1024).fill(0x80)]);
    expect(await fetchSkillFromSource(RAW_SKILL, vi.fn(async () => bad.response) as typeof fetch)).toEqual({ error: FILE_TOO_LARGE });
    const tail = measuredBody([Uint8Array.from([...Array<number>(256 * 1024 - 1).fill(0x61), 0xe2])]);
    expect(await fetchSkillFromSource(RAW_SKILL, vi.fn(async () => tail.response) as typeof fetch)).toEqual({ error: FILE_TOO_LARGE });
  });

  it("stops an oversized text body while reading it", async () => {
    const chunk = encoder.encode("x".repeat(16 * 1024));
    const { response, observed } = measuredBody(Array<Uint8Array>(40).fill(chunk));
    const fetcher = vi.fn(async () => response) as typeof fetch;
    expect(await fetchSkillFromSource(RAW_SKILL, fetcher)).toEqual({ error: FILE_TOO_LARGE });
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled).toBeGreaterThan(256 * 1024);
    expect(observed.pulled).toBeLessThanOrEqual(256 * 1024 + chunk.byteLength);
  });

  it("accepts exactly the file byte cap, including split multibyte letters", async () => {
    const content = "🙂".repeat(256 * 1024 / 4);
    const bytes = encoder.encode(content);
    const { response } = measuredBody([bytes.subarray(0, 3), bytes.subarray(3)]);
    const fetcher = vi.fn(async () => response) as typeof fetch;
    expect(await fetchSkillFromSource(RAW_SKILL, fetcher)).toMatchObject({
      skills: [{ files: [{ path: "SKILL.md", content }] }],
    });
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  });

  it("stops an oversized listing while reading it", async () => {
    const chunk = encoder.encode(" ".repeat(16 * 1024));
    const { response, observed } = measuredBody([encoder.encode("["), ...Array<Uint8Array>(80).fill(chunk), encoder.encode("]")]);
    const fetcher = vi.fn(async () => response) as typeof fetch;
    expect(await fetchSkillFromSource("o/r", fetcher)).toEqual({ error: LISTING_TOO_LARGE });
    expect(observed.cancelled).toBe(true);
    expect(observed.pulled).toBeGreaterThan(1024 * 1024);
    expect(observed.pulled).toBeLessThanOrEqual(1024 * 1024 + chunk.byteLength);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a listing with more than the entry cap before downloading files", async () => {
    const listing = [
      { type: "file", name: "SKILL.md", path: "SKILL.md", download_url: RAW_SKILL },
      ...Array.from({ length: 1000 }, (_, index) => ({ type: "file", name: `${index}.txt`, path: `${index}.txt` })),
    ];
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input) === RAW_SKILL ? new Response("# Skill") : Response.json(listing)) as typeof fetch;
    expect(await fetchSkillFromSource("o/r", fetcher)).toEqual({ error: LISTING_TOO_LARGE });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [RAW_SKILL, 30_000, "fetch"],
    ["o/r", 15_000, "fetch"],
    [RAW_SKILL, 30_000, "body"],
    ["o/r", 15_000, "body"],
    ["o/r", 15_000, "discovery"],
  ] as const)("covers %s for %i milliseconds through %s", async (source, deadline, stage) => {
    vi.useFakeTimers();
    // Node's native timeout clock is separate from the fake timer clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    let cancelled = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (stage === "discovery" && String(input).endsWith("/contents/")) {
        return Response.json([{ type: "dir", name: "skills", path: "skills" }]);
      }
      if (stage === "body") {
        // The body gets only the time left after waiting for the headers.
        await new Promise<void>((resolve) => setTimeout(resolve, deadline / 2));
        return new Response(new ReadableStream<Uint8Array>({
          pull() {},
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    try {
      let settled = false;
      const result = fetchSkillFromSource(source, fetcher).then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(fetcher).mock.calls.at(-1)?.[1]).toMatchObject({ signal: expect.any(AbortSignal), redirect: "manual" });
      expect(timeout).toHaveBeenLastCalledWith(deadline);
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({ error: SOURCE_TIMEOUT });
      expect(SOURCE_TIMEOUT).not.toMatch(/\b404\b|import cap/);
      expect(fetcher).toHaveBeenCalledTimes(stage === "discovery" ? 2 : 1);
      if (stage === "body") expect(cancelled).toBe(true);
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    "https://elsewhere.example/SKILL.md",
    "http://raw.githubusercontent.com/o/r/main/SKILL.md",
    "https://raw.githubusercontent.com.elsewhere.example/SKILL.md",
    "https://name:password@github.com/o/r/SKILL.md",
  ])("refuses a redirect to %s", async (location) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } })) as typeof fetch;
    expect(await fetchSkillFromSource(RAW_SKILL, fetcher)).toEqual({ error: SOURCE_REDIRECT });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a fourth redirect", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: RAW_SKILL } })) as typeof fetch;
    expect(await fetchSkillFromSource(RAW_SKILL, fetcher)).toEqual({ error: SOURCE_REDIRECT });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([1, 3])("follows %i permitted redirects with the same deadline", async (redirects) => {
    let calls = 0;
    const destination = "https://raw.githubusercontent.com/o/r/next/SKILL.md";
    const fetcher = vi.fn(async () => ++calls <= redirects
      ? new Response(null, { status: 302, headers: { location: destination } })
      : new Response("# Skill")) as typeof fetch;
    expect(await fetchSkillFromSource(RAW_SKILL, fetcher)).toMatchObject({ skills: [{ files: [{ content: "# Skill" }] }] });
    expect(requested(fetcher)).toEqual([RAW_SKILL, ...Array<string>(redirects).fill(destination)]);
    const options = vi.mocked(fetcher).mock.calls.map((call) => call[1]);
    expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
    for (const init of options) {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBe(options[0]?.signal);
    }
  });
});

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

// skills.sh is a registry over GitHub: a page names owner/repo and, usually,
// one skill slug. Adapted from OpenMausBot PR #1840 (Apache-2.0).
describe("skills.sh pages", () => {
  const dir = (path: string) => ({ type: "dir", name: path.split("/").at(-1)!, path });
  const file = (name: string, at = "") => ({
    type: "file",
    name,
    path: at ? `${at}/${name}` : name,
    download_url: `https://raw.githubusercontent.com/o/r/main/${at ? `${at}/` : ""}${name}`,
  });

  it("reads a skills.sh page as the GitHub repository it indexes", () => {
    expect(parseSkillSource("https://skills.sh/vercel-labs/skills/find-skills")).toEqual({
      owner: "vercel-labs",
      repo: "skills",
      path: "",
      skill: "find-skills",
    });
    expect(parseSkillSource("https://skills.sh/vercel-labs/skills/")).toEqual({ owner: "vercel-labs", repo: "skills", path: "", skill: undefined });
  });

  it.each(["https://skills.sh/a/b/...", "https://skills.sh/a/b/---", "https://skills.sh/../b/skill", "https://skills.sh/a", "https://skills.sh.evil.example/a/b/c"])(
    "refuses a malformed skills.sh link without fetching: %s",
    async (source) => {
      const fetcher = vi.fn() as unknown as typeof fetch;
      expect(await fetchSkillFromSource(source, fetcher)).toEqual({ error: expect.stringContaining("does not look like") });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("imports just the named skill", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/pdf"), dir("skills/find-skills")]);
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response("# A skill");
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", fetcher)).toEqual({
      skills: [{ source: "github.com/vercel-labs/skills/skills/find-skills", files: [{ path: "SKILL.md", content: "# A skill" }] }],
    });
  });

  it("names the missing skill when nothing matches", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/pdf")]);
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response("---\nname: pdf\n---\n# pdf");
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/nope", fetcher)).toEqual({ error: expect.stringContaining('no skill named "nope"') });
  });

  it("matches the slug against the SKILL.md name when the folder differs", async () => {
    const skillMd = "---\nname: Find Skills\ndescription: finds things\n---\n# A skill";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/search-helper")]);
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response(skillMd);
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", fetcher)).toEqual({
      skills: [{ source: "github.com/vercel-labs/skills/skills/search-helper", files: [{ path: "SKILL.md", content: skillMd }] }],
    });
  });

  it("skips a root SKILL.md that is not the named skill, and takes one that is", async () => {
    const rootOnly = (name: string) =>
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/contents/")) return Response.json([file("SKILL.md"), dir("docs")]);
        if (url.endsWith("/contents/docs")) return Response.json([file("notes.md", "docs")]);
        return new Response(`---\nname: ${name}\n---\n# root skill`);
      }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", rootOnly("Something Else"))).toEqual({
      error: expect.stringContaining('no skill named "wanted-skill"'),
    });
    expect(await fetchSkillFromSource("https://skills.sh/a/b/wanted-skill", rootOnly("Wanted Skill"))).toMatchObject({ skills: [{ source: "github.com/a/b" }] });
  });

  it("does not take a folder named like the skill when its SKILL.md names another one", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/wanted"), dir("skills/helper")]);
      if (url.endsWith("/contents/skills/wanted")) return Response.json([file("SKILL.md", "skills/wanted")]);
      if (url.endsWith("/contents/skills/helper")) return Response.json([file("SKILL.md", "skills/helper")]);
      if (url.endsWith("skills/wanted/SKILL.md")) return new Response("---\nname: other\n---\n# other");
      return new Response("---\nname: wanted\n---\n# wanted");
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/o/r/wanted", fetcher)).toMatchObject({
      skills: [{ source: "github.com/o/r/skills/helper" }],
    });
  });

  it("says the search was cut short, not that the skill is missing, when the cap stops it", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) {
        return Response.json([...Array.from({ length: 20 }, (_, i) => dir(`skills/filler-${i}`)), dir("skills/z-helper")]);
      }
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response(url.includes("z-helper") ? "---\nname: wanted\n---\n" : "---\nname: filler\n---\n");
    }) as typeof fetch;
    const result = await fetchSkillFromSource("https://skills.sh/o/r/wanted", fetcher);
    expect(result).toEqual({ error: expect.stringContaining("too many folders") });
    expect(result).not.toEqual({ error: expect.stringContaining("no skill named") });
  });

  it("reports a refused or rate-limited GitHub as a failure, not a missing skill", async () => {
    for (const status of [403, 429, 500]) {
      let reads = 0;
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
        if (url.endsWith("/contents/skills")) return Response.json([dir("skills/a"), dir("skills/b"), dir("skills/c")]);
        if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
        return ++reads === 2 ? new Response("slow down", { status }) : new Response("---\nname: filler\n---\n");
      }) as typeof fetch;
      const result = await fetchSkillFromSource("https://skills.sh/o/r/wanted", fetcher);
      expect(result).toEqual({ error: expect.stringContaining(String(status)) });
    }
  });

  it("still skips a folder that is simply not there", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) return Response.json([dir("skills/gone"), dir("skills/wanted")]);
      if (url.endsWith("/contents/skills/gone")) return new Response("", { status: 404 });
      if (url.includes("api.github.com")) return Response.json([file("SKILL.md")]);
      return new Response("---\nname: wanted\n---\n");
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/o/r/wanted", fetcher)).toMatchObject({ skills: [{ source: "github.com/o/r/skills/wanted" }] });
  });

  it("finds the named skill even past the per-folder child cap", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return Response.json([dir("skills")]);
      if (url.endsWith("/contents/skills")) {
        return Response.json([...Array.from({ length: 40 }, (_, i) => dir(`skills/filler-${i}`)), dir("skills/find-skills")]);
      }
      if (url.endsWith("/contents/skills/find-skills")) return Response.json([file("SKILL.md")]);
      if (url.includes("api.github.com")) return Response.json([file("README.md")]);
      return new Response("# A skill");
    }) as typeof fetch;
    expect(await fetchSkillFromSource("https://skills.sh/vercel-labs/skills/find-skills", fetcher)).toMatchObject({
      skills: [{ source: "github.com/vercel-labs/skills/skills/find-skills" }],
    });
  });
});
