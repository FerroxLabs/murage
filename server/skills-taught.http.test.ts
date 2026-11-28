// W9 (TEACH-ENTRY 1.0.23 D6): Taught by you, through the real route handler and the real
// browser-owner policy. GET lists recordings with bot names (and damaged folders); PATCH rewrites
// only manifest.json `bots`, atomically, for bots that exist; a remembered-owner browser needs a code.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleTaughtSkills, TAUGHT_PATH } from "./skills-taught.ts";
import { browserOwnerTier } from "./browser-owner-policy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const bots = () => [{ id: "dax", name: "Dax" }, { id: "ember", name: "Ember" }];
function world() {
  const root = join(tmpdir(), `taught-${randomUUID()}`);
  roots.push(root);
  const write = (id: string, extra: Record<string, unknown>) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0", description: "Recorded", defaultEnabled: true, triggerTerms: [id], requiredCapabilities: [], audience: "owner", ...extra }));
    writeFileSync(join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: Recorded\n---\nSteps.\n`);
  };
  write("only-dax", { bots: ["dax"] });
  write("for-all", {});
  write("gone-bot", { bots: ["deleted-bot"] });
  mkdirSync(join(root, "damaged"), { recursive: true });
  writeFileSync(join(root, "damaged", "manifest.json"), "{ not json");
  return root;
}
const manifest = (root: string, id: string) => JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8"));
const patch = (root: string, id: string, body: unknown, rename?: (a: string, b: string) => void) =>
  handleTaughtSkills("PATCH", `${TAUGHT_PATH}/${id}`, { root, bots, readBody: async () => body, ...(rename ? { rename } : {}) });

describe("W9 Taught by you routes", () => {
  it("GET lists each recording with its bot names; a deleted bot and a damaged folder are shown as such", async () => {
    const root = world();
    const answer = await handleTaughtSkills("GET", TAUGHT_PATH, { root, bots, readBody: async () => ({}) });
    expect(answer?.status).toBe(200);
    const rows = (answer!.body as { skills: any[] }).skills;
    expect(rows.find((row) => row.id === "only-dax")).toMatchObject({ bots: ["dax"], botNames: ["Dax"], missingBots: 0 });
    expect(rows.find((row) => row.id === "for-all")).not.toHaveProperty("bots");
    expect(rows.find((row) => row.id === "gone-bot")).toMatchObject({ botNames: [], missingBots: 1 });
    expect(rows.find((row) => row.id === "damaged")).toEqual({ id: "damaged", damaged: true });
  });
  it("PATCH [dax] writes it; null removes it (All my bots)", async () => {
    const root = world();
    expect((await patch(root, "for-all", { bots: ["dax"] }))?.status).toBe(200);
    expect(manifest(root, "for-all").bots).toEqual(["dax"]);
    expect((await patch(root, "for-all", { bots: null }))?.status).toBe(200);
    expect(manifest(root, "for-all")).not.toHaveProperty("bots");
  });
  it("an unknown bot is refused and the manifest is unchanged", async () => {
    const root = world();
    const before = readFileSync(join(root, "only-dax", "manifest.json"), "utf8");
    const answer = await patch(root, "only-dax", { bots: ["nobody"] });
    expect(answer).toEqual({ status: 400, body: { error: "Choose bots that exist." } });
    expect(readFileSync(join(root, "only-dax", "manifest.json"), "utf8")).toBe(before);
  });
  it("an id outside the skills folder is 404", async () => {
    const root = world();
    expect((await patch(root, "..%2Fescape", { bots: null }))?.status).toBe(404);
    expect((await patch(root, "missing", { bots: null }))?.status).toBe(404);
  });
  it("a failing rename leaves the old manifest intact (temp + rename)", async () => {
    const root = world();
    const before = readFileSync(join(root, "only-dax", "manifest.json"), "utf8");
    const answer = await patch(root, "only-dax", { bots: null }, () => { throw new Error("disk full"); });
    expect(answer).toEqual({ status: 500, body: { error: "Could not save who can use this skill. Nothing changed." } });
    expect(readFileSync(join(root, "only-dax", "manifest.json"), "utf8")).toBe(before);
  });
  it("a remembered-owner browser reads freely and needs a code to change who can use a skill", () => {
    expect(browserOwnerTier("GET", "/api/skills/taught").tier).toBe("plain");
    expect(browserOwnerTier("PATCH", "/api/skills/taught/only-dax", { bots: ["dax"] }).tier).toBe("code");
  });
  it("other skills paths are left to the skills handler", async () => {
    expect(await handleTaughtSkills("GET", "/api/skills/library:x", { root: world(), bots, readBody: async () => ({}) })).toBeNull();
  });
});
