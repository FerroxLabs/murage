import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";

import { fetchSkillFromLink, readSkillZip } from "./skill-import-sources.ts";

async function zipOf(entries: Array<{ name: string; data: Buffer | string; mode?: number; compress?: boolean }>): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name, { mode: entry.mode, compress: entry.compress ?? true });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const md = "---\nname: my-skill\ndescription: Test.\n---\nBody.\n";

describe("reading a skill zip", () => {
  it("reads text files and names the ones that are not text", async () => {
    const result = await readSkillZip(await zipOf([
      { name: "my-skill/SKILL.md", data: md },
      { name: "my-skill/notes.md", data: "Notes." },
      { name: "my-skill/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]) },
      { name: "__MACOSX/my-skill/._SKILL.md", data: "junk" },
    ]));
    expect(result).toEqual({ files: [{ path: "my-skill/SKILL.md", content: md }, { path: "my-skill/notes.md", content: "Notes." }], skipped: ["my-skill/logo.png"] });
  });

  it("refuses a link inside the zip", async () => {
    expect(await readSkillZip(await zipOf([{ name: "SKILL.md", data: md }, { name: "evil", data: "/etc/passwd", mode: 0o120777 }]))).toMatchObject({ code: "invalid" });
  });

  it("refuses a zip bomb", async () => {
    expect(await readSkillZip(await zipOf([{ name: "SKILL.md", data: md }, { name: "bomb.md", data: "0".repeat(250 * 1024) }]))).toMatchObject({ code: "invalid" });
  });

  it("refuses too many files", async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}.md`, data: "x" }));
    expect(await readSkillZip(await zipOf([{ name: "SKILL.md", data: md }, ...many]))).toMatchObject({ code: "too-big" });
  });

  it("refuses something that is not a zip", async () => {
    expect(await readSkillZip(Buffer.from("not a zip at all"))).toMatchObject({ code: "invalid" });
  });
});

describe("fetching a skill from a link", () => {
  it("fetches the skill a GitHub link points at", async () => {
    const fetcher = (async (url: string) =>
      url.includes("raw.githubusercontent.com") ? new Response(md) : new Response("[]", { status: 404 })) as unknown as typeof fetch;
    const result = await fetchSkillFromLink("https://raw.githubusercontent.com/acme/skills/main/my-skill/SKILL.md", fetcher);
    expect(result).toEqual({ files: [{ path: "SKILL.md", content: md }] });
  });

  it("says plainly when a link is not a skill, or cannot be reached", async () => {
    expect(await fetchSkillFromLink("https://example.com/whatever")).toMatchObject({ code: "invalid" });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await fetchSkillFromLink("https://raw.githubusercontent.com/acme/skills/main/x/SKILL.md", down)).toMatchObject({ code: "unreachable" });
  });

  it("takes a skills.sh page, and says plainly when the skill it names is not there", async () => {
    const listing = (entries: object[]) => new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } });
    const fetcher = (async (input: string) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return listing([{ type: "dir", name: "skills", path: "skills" }]);
      if (url.endsWith("/contents/skills")) return listing([{ type: "dir", name: "my-skill", path: "skills/my-skill" }]);
      if (url.includes("api.github.com")) return listing([{ type: "file", name: "SKILL.md", path: "skills/my-skill/SKILL.md", download_url: "https://raw.githubusercontent.com/acme/skills/main/skills/my-skill/SKILL.md" }]);
      return new Response(md);
    }) as unknown as typeof fetch;
    expect(await fetchSkillFromLink("https://skills.sh/acme/skills/my-skill", fetcher)).toEqual({ files: [{ path: "SKILL.md", content: md }] });
    expect(await fetchSkillFromLink("https://skills.sh/acme/skills/other-skill", fetcher)).toEqual({
      error: "That skills.sh page names a skill that isn't in its repository.",
      code: "invalid",
    });
  });

  it("asks for the skill's own folder when the repository is too big to search", async () => {
    const listing = (entries: object[]) => new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } });
    const fetcher = (async (input: string) => {
      const url = String(input);
      if (url.endsWith("/contents/")) return listing([{ type: "dir", name: "skills", path: "skills" }]);
      if (url.endsWith("/contents/skills")) return listing(Array.from({ length: 25 }, (_, i) => ({ type: "dir", name: `s-${i}`, path: `skills/s-${i}` })));
      if (url.includes("api.github.com")) return listing([{ type: "file", name: "SKILL.md", path: "x/SKILL.md", download_url: "https://raw.githubusercontent.com/acme/skills/main/x/SKILL.md" }]);
      return new Response("---\nname: filler\n---\n");
    }) as unknown as typeof fetch;
    expect(await fetchSkillFromLink("https://skills.sh/acme/skills/wanted", fetcher)).toEqual({
      error: "That repository has too many folders to search for this skill. Paste the GitHub link to the skill's own folder instead.",
      code: "invalid",
    });
  });
});
