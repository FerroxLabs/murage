// F10/E1 "Every bot" on a fresh workspace: the first mark is made before any bot or per-bot skill exists.
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let desktop: Record<string, string>;

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
}, 30_000);

afterAll(async () => {
  await fixture?.close();
});

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(fixture.info.url + path, { method, headers: desktop, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

it("the first Every bot mark on a workspace with no skill-state folder is kept, and a bot added later gets the skill", async () => {
  const content = "---\nname: first-mark\ndescription: first-mark test skill.\n---\nSay hello.\n";
  expect((await api("POST", "/api/skills/import", { files: [{ path: "SKILL.md", content }], kind: "file" })).status).toBeLessThan(300);
  const marked = await api("PUT", "/api/skills/collection:first-mark/every-bot", { on: true });
  expect(marked.status).toBe(200);
  expect((await api("GET", "/api/skills/collection:first-mark")).body.everyBot).toBe(true);
  const bot = (await api("POST", "/api/bots", { name: "Later", modelSelection: { instanceId: "verification", model: "fake" } })).body.bot as { id: string };
  const skills = (await api("GET", `/api/bots/${bot.id}/skills`)).body.skills as Array<{ name: string; enabled: boolean }>;
  expect(skills.find((s) => s.name === "first-mark")?.enabled).toBe(true);
}, 90_000);

it("a published package gets approved marks and keeps its imported skills disabled", async () => {
  const { join } = await import("node:path");
  const { writeBotPackageArchive } = await import("./bot-package-archive.ts");
  const { createBotPackageEntry } = await import("./bot-package-manifest.ts");
  const skill = (name: string) => `---\nname: ${name}\ndescription: Review supplied notes.\nlicense: MIT\n---\nReview supplied notes.\n`;
  for (const name of ["package-mark", "package-inert"]) {
    expect((await api("POST", "/api/skills/import", { files: [{ path: "SKILL.md", content: skill(name) }], kind: "file" })).status).toBeLessThan(300);
    expect((await api("PUT", `/api/skills/collection:${name}/every-bot`, { on: true })).status).toBe(200);
  }
  const archivePath = join(fixture.info.dataDir, "marked-package.zip");
  const payloads = new Map([["skills/package-inert/SKILL.md", skill("package-inert")]]);
  const manifest = { format: "murage.package.bundle", version: 1,
    definition: { format: "murage.package", version: 1, package: {
      id: "marks-fixture", release: "1.0.0", name: "Marks fixture", tagline: "Supplied notes", summary: "Supplied notes only", category: "Starter", author: { name: "Fixture" }, license: "MIT", outcomes: ["A useful draft"], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, chiefOfStaff: "scout",
      agents: [{ key: "scout", name: "Imported Scout", appearance: { color: "green" }, skills: ["package-inert"] }], routines: [],
    } }, skills: [{ key: "package-inert", name: "Notes", license: "MIT", dependencies: [], files: ["skills/package-inert/SKILL.md"] }],
    instructions: [], entries: [...payloads].map(([path, content]) => createBotPackageEntry(path, content)),
  };
  await writeBotPackageArchive(archivePath, { manifest, payloads });
  const request = { archivePath, selection: { agents: ["scout"], skills: ["package-inert"], routines: [], instructions: [] } };
  const preview = await api("POST", "/api/packages/import", { ...request, action: "preview" });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const result = await api("POST", "/api/packages/import", { ...request, action: "import", archiveSha256: preview.body.archiveSha256, reviewHash: preview.body.reviewHash, acknowledgeWarnings: true });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const skills = (await api("GET", `/api/bots/${result.body.bots[0].id}/skills`)).body.skills as Array<{ name: string; enabled: boolean }>;
  expect(skills.find(skill => skill.name === "package-mark")?.enabled).toBe(true);
  expect(skills.find(skill => skill.name === "package-inert")?.enabled).toBe(false);
  console.info("Every bot package workflow verified", { botId: result.body.bots[0].id, skills });
}, 90_000);
