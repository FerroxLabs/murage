// W6 (TEACH-ENTRY 1.0.23 D5, F5): a skill recorded for "Only Dax" rides only Dax's pin, an invalid
// `bots` keeps the skill from loading, and a pin built before a narrowing is released for the bot
// that lost it (read live from manifest.json), while a shipped skill updated by the app never is.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createProcedurePin, procedurePinServesTurn, readProcedureBundle } from "./procedure-bundles.ts";
import { liveUserScopes, loadBundledSkills, loadUserSkills, mergeSkills, parseSkillManifest, shippedSkillCheck } from "./skill-library.ts";
import { workspaceDir } from "./workspace.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const owned: string[] = [];
const bot = () => { const id = `teach-scope-${randomUUID()}`; owned.push(join(DATA_DIR, "workspaces", id), join(DATA_DIR, "skill-state", id)); return id; };
afterEach(() => { for (const path of owned.splice(0)) removeTempDirSync(path); });

function writeSkill(root: string, skillId: string, extra: Record<string, unknown>, body = "Recorded steps.") {
  const dir = join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: skillId, name: skillId, version: "1.0.0", description: "Recorded", defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [], audience: "owner", ...extra }));
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillId}\ndescription: Recorded\n---\n${body}\n`);
}

function world() {
  const dax = bot(), ember = bot();
  const base = join(workspaceDir(dax), "teach-scope");
  const user = join(base, "user"), shippedRoot = join(base, "shipped");
  writeSkill(shippedRoot, "shipped-check", {}, "Shipped text.");
  writeSkill(user, "only-dax", { bots: [dax] });
  writeSkill(user, "for-all", {});
  const shipped = loadBundledSkills(shippedRoot);
  const catalogue = () => mergeSkills(shipped, loadUserSkills(user));
  const live = { scope: liveUserScopes(user), bundledIds: new Set(shipped.map((skill) => skill.manifest.id)) };
  return { dax, ember, user, shippedRoot, shipped, catalogue, live, isShipped: shippedSkillCheck(shipped) };
}
const pinned = (botId: string, pin: ReturnType<typeof createProcedurePin>) => readProcedureBundle(botId, "task", pin).catalogue.map((skill) => skill.manifest.id).sort();

describe("W6 who can use a taught skill", () => {
  it("an Only-Dax skill is in Dax's pin and not in Ember's; a skill with no bots is in both", () => {
    const w = world();
    const daxPin = createProcedurePin(w.dax, "task", w.catalogue(), [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    const emberPin = createProcedurePin(w.ember, "task", w.catalogue(), [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    expect(pinned(w.dax, daxPin)).toEqual(["for-all", "only-dax", "shipped-check"]);
    expect(pinned(w.ember, emberPin)).toEqual(["for-all", "shipped-check"]);
  });

  it.each([[[]], ["dax"], [[1]], [["bad id!"]], [Array.from({ length: 51 }, (_, i) => `b${i}`)]])("an invalid bots value %j does not load", (bots) => {
    const dir = join("/fixture/skills", "bad");
    expect(() => parseSkillManifest({ id: "bad", name: "Bad", version: "1.0.0", description: "Bad", defaultEnabled: true, triggerTerms: ["x"], requiredCapabilities: [], bots }, dir)).toThrow(/invalid bots/);
  });

  it("a pin built while the skill was for every bot is released for Ember once it is narrowed to Dax", () => {
    const w = world();
    writeSkill(w.user, "narrowed", {});
    const emberPin = createProcedurePin(w.ember, "task", w.catalogue(), [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    const daxPin = createProcedurePin(w.dax, "task", w.catalogue(), [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    expect(pinned(w.ember, emberPin)).toContain("narrowed");
    expect(procedurePinServesTurn(w.ember, "task", emberPin, true, w.live)).toBe(true);
    writeSkill(w.user, "narrowed", { bots: [w.dax] });
    expect(procedurePinServesTurn(w.ember, "task", emberPin, true, w.live)).toBe(false);
    expect(procedurePinServesTurn(w.dax, "task", daxPin, true, w.live)).toBe(true);
  });

  it("a deleted recording releases the pin", () => {
    const w = world();
    const pin = createProcedurePin(w.dax, "task", w.catalogue(), [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    removeTempDirSync(join(w.user, "for-all"));
    expect(procedurePinServesTurn(w.dax, "task", pin, true, w.live)).toBe(false);
  });

  it("control: a pin holding a shipped skill whose text changed in an app update stays served", () => {
    const w = world();
    const pin = createProcedurePin(w.dax, "task", w.shipped, [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    writeSkill(w.shippedRoot, "shipped-check", {}, "Shipped text, updated by the app.");
    const updated = loadBundledSkills(w.shippedRoot);
    const live = { scope: liveUserScopes(w.user), bundledIds: new Set(updated.map((skill) => skill.manifest.id)) };
    expect(procedurePinServesTurn(w.dax, "task", pin, true, live)).toBe(true);
  });

  it("a pin with no user skills reads no manifest", () => {
    const w = world();
    const pin = createProcedurePin(w.dax, "task", w.shipped, [], undefined, undefined, { ownerTurn: true, shipped: w.isShipped });
    let reads = 0;
    const counting = { scope: (id: string) => { reads += 1; return w.live.scope(id); }, bundledIds: w.live.bundledIds };
    expect(procedurePinServesTurn(w.dax, "task", pin, true, counting)).toBe(true);
    expect(reads).toBe(0);
  });
});
