// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// A direct or room turn reads its skills from the task's pinned copy
// (procedure-bundles.ts), in a folder of that task, never from skills/. The
// engine's tool names and the contact turn's cut of the saved image library
// (bot-shapes.ts skillLayers) must reach that copy exactly as they reach the
// shipped folder, and never an owner's own skill under a shipped id. Every
// test here pins through createProcedurePin + preparePinnedProcedures, the
// way index.ts does, and asks shippedSkillCheck, the check index.ts uses.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createProcedurePin, preparePinnedProcedures, readProcedureBundle } from "./procedure-bundles.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills, shippedSkillCheck, type BundledSkill } from "./skill-library.ts";
import { skillLayers } from "./bot-shapes.ts";
import { workspaceDir } from "./workspace.ts";
import { IMAGE_LIBRARY_TOOLS } from "../shared/image-library-audience.ts";
import { CLAUDE_TOOL_SURFACE, CODEX_TOOL_SURFACE, FUIGO_TOOL_SURFACE, NEUTRAL_TOOL_SURFACE, PI_TOOL_SURFACE, renderMurageTools, type McpToolSurface, type MurageToolMounts } from "./murage-tool-surface.ts";
import { CODEX_PHONE_MOUNT } from "./drivers/codex.ts";

const SHIPPED = join(import.meta.dirname, "..", "skills");
const bundled = loadBundledSkills(SHIPPED);
const murageSkill = shippedSkillCheck(bundled);
/** Every way an engine's driver renders Murage's tool names in a turn
 *  (murage-tool-surface.ts; each driver renders with one of these). */
const ENGINES: ReadonlyArray<readonly [name: string, surface: McpToolSurface, mounts: MurageToolMounts]> = [
  ["claude", CLAUDE_TOOL_SURFACE, { agents: "agents", phone: "phone" }],
  ["codex", CODEX_TOOL_SURFACE, { agents: "agents", phone: CODEX_PHONE_MOUNT }],
  ["fuigo", FUIGO_TOOL_SURFACE, { agents: "agents", phone: "phone" }],
  ["pi", PI_TOOL_SURFACE, { agents: "agents", phone: "phone" }],
  ["antigravity", NEUTRAL_TOOL_SURFACE, { agents: "agents", phone: "phone" }],
];
const engine = (name: string) => ENGINES.find(item => item[0] === name)!;
/** The agents tools a shipped skill may name (bot-shapes.ts SKILL_TOOL_NAMES). */
const SKILL_TOOLS = ["generate_image", "get_prompt_block", "list_image_models", "list_prompt_blocks", "list_reference_packs",
  "resolve_image_reference", "save_prompt_block", "save_reference_pack", "skill_manage", "skills_list"];
const bare = new RegExp(`(?<![A-Za-z0-9_"])(${SKILL_TOOLS.join("|")})(?![A-Za-z0-9_"])`);

const owned: string[] = [];
beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function bot(): string {
  const id = `pinned-shipped-${randomUUID()}`;
  owned.push(join(DATA_DIR, "workspaces", id), join(DATA_DIR, "skill-state", id));
  return id;
}
/** The catalogue a turn reads: pinned once for the task, then restored. */
function pinned(catalogue: BundledSkill[], botId = bot(), threadId = `task-${randomUUID()}`): BundledSkill[] {
  const pin = createProcedurePin(botId, threadId, catalogue, []);
  return preparePinnedProcedures(botId, threadId, JSON.parse(JSON.stringify(pin)), false).catalogue;
}
const byId = (skills: readonly BundledSkill[], id: string) => skills.find(skill => skill.manifest.id === id)!;
/** The skill's layer as a turn on this engine reads it: marked by skillLayers,
 *  rendered by the engine's driver. */
const layer = (skill: BundledSkill, name: string, ownerAudience?: boolean) => {
  const [, surface, mounts] = engine(name);
  return renderMurageTools(skillLayers([skill], { murageSkill, agentsMounted: true, phoneMounted: true, ownerAudience })[0]!.text, surface, mounts);
};
const ENGINE_NAMES = ENGINES.map(item => item[0]);

describe("a task's pinned copy of a shipped skill", () => {
  it("lives in the task's folder, keeps its shipped mark in the pin, and is still Murage's", () => {
    const id = bot(), thread = "task-mark";
    const pin = createProcedurePin(id, thread, bundled, []);
    expect(readProcedureBundle(id, thread, pin).catalogue.every(skill => skill.shipped === true)).toBe(true);
    const copies = preparePinnedProcedures(id, thread, pin, false).catalogue;
    expect(copies.map(skill => skill.manifest.id)).toEqual(bundled.map(skill => skill.manifest.id));
    for (const copy of copies) {
      expect(bundled.some(skill => skill.directory === copy.directory)).toBe(false);
      expect(copy.directory.startsWith(DATA_DIR)).toBe(true);
      expect(murageSkill(copy), copy.manifest.id).toBe(true);
    }
  });

  it("on a contact turn, leaves the saved library out on every engine, and the owner's copy keeps it", () => {
    const copy = byId(pinned(bundled), "image-generation"), shipped = byId(bundled, "image-generation");
    for (const kind of ENGINE_NAMES) {
      const contact = layer(copy, kind, false), owner = layer(copy, kind, true);
      // word for word what the shipped folder's skill gives the same turn
      expect(contact, kind).toBe(layer(shipped, kind, false));
      expect(owner, kind).toBe(layer(shipped, kind, true));
      expect(layer(copy, kind), kind).toBe(owner);
      for (const tool of IMAGE_LIBRARY_TOOLS) { expect(contact, kind).not.toContain(tool); expect(owner, kind).toContain(tool); }
      expect(contact, kind).not.toMatch(/prompt_blocks|reference_pack/);
      expect(contact, kind).toContain("Send the lock first, then the scene");
      expect(contact, kind).toContain("generate_image");
    }
  });

  it.each(ENGINE_NAMES)("%s: every shipped skill names Murage's tools the way this engine calls them", kind => {
    const copies = pinned(bundled);
    for (const shipped of bundled) {
      const copy = byId(copies, shipped.manifest.id), text = layer(copy, kind, true);
      expect(text, shipped.manifest.id).toBe(layer(shipped, kind, true));
      if (engine(kind)[1].kind === "search-then-call") {
        // nothing left that use_tool would call bare and fail "Tool not found"
        expect(text.replace(/use_tool with tool_name "[^"]+"/g, "").replace(/\n---[\s\S]*?\n---/, ""), shipped.manifest.id).not.toMatch(bare);
      } else {
        expect(text, shipped.manifest.id).not.toContain("use_tool with tool_name");
      }
    }
    const image = layer(byId(copies, "image-generation"), kind, true);
    const [, surface, mounts] = engine(kind);
    expect(image).toContain(surface.kind === "search-then-call" ? 'use_tool with tool_name "agents__generate_image"'
      : surface.kind === "direct" ? surface.qualify("agents", "generate_image") : 'the tool "generate_image" on MCP server "agents"');
    expect(layer(byId(copies, "phone-harness"), kind, true)).toContain(`Use the \`${mounts.phone}\` tools`);
  });

  it("pinned before the mark was recorded (an earlier version), is known by its id and its exact text", () => {
    const unmarked = bundled.map(({ shipped: _shipped, ...skill }) => skill);
    const copies = pinned(unmarked);
    for (const copy of copies) { expect(copy.shipped).toBeUndefined(); expect(murageSkill(copy), copy.manifest.id).toBe(true); }
    const image = byId(copies, "image-generation");
    expect(layer(image, "fuigo", false)).toBe(layer(byId(bundled, "image-generation"), "fuigo", false));
    // an earlier Windows build pinned the guide as it read it, with CRLF
    const crlf = { ...image, instructions: image.instructions.replace(/\n/g, "\r\n") };
    expect(murageSkill(crlf)).toBe(true);
    const contact = layer(crlf, "fuigo", false);
    for (const tool of IMAGE_LIBRARY_TOOLS) expect(contact).not.toContain(tool);
    expect(contact).toContain('use_tool with tool_name "agents__generate_image"');
  });
});

describe("a copy pinned by an earlier version, with an earlier text", () => {
  it("is Murage's for a skill shipped since before pins, and not for one that shipped later", () => {
    const edited = (id: string): BundledSkill => {
      const { shipped: _shipped, ...skill } = byId(bundled, id);
      return { ...skill, directory: join(DATA_DIR, "workspaces", "b", ".murage-procedures", "x", "catalogue", id), instructions: `${skill.instructions}\nAn earlier line.` };
    };
    for (const id of ["phone-harness", "create-verification-skill"]) expect(murageSkill(edited(id)), id).toBe(true);
    for (const id of ["image-generation", "chief-of-staff"]) expect(murageSkill(edited(id)), id).toBe(false);
    expect(layer(edited("phone-harness"), "codex", true)).toContain("Use the `murage_phone` tools");
  });
});

describe("an owner's own skill under a shipped skill's id", () => {
  // An install from before image-generation shipped could hold the owner's
  // own skill of that id; mergeSkills lets it in only when none ships.
  function ownSkill(body: (shipped: string) => string): BundledSkill[] {
    const root = join(workspaceDir(bot()), "own-skills"), directory = join(root, "image-generation");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "manifest.json"), readFileSync(join(SHIPPED, "image-generation", "manifest.json")));
    writeFileSync(join(directory, "SKILL.md"), body(readFileSync(join(SHIPPED, "image-generation", "SKILL.md"), "utf8")));
    return mergeSkills(bundled.filter(skill => skill.manifest.id !== "image-generation"), loadUserSkills(root));
  }
  it("is theirs word for word through the pin: no tool names spelled, no passage cut", () => {
    const own = ownSkill(text => `${text.trimEnd()}\n\nMy own rule: call generate_image once per brief, and save_prompt_block for the brand lock.\n`);
    const copy = byId(pinned(own), "image-generation");
    expect(copy.shipped).toBeUndefined();
    expect(murageSkill(copy)).toBe(false);
    const plain = skillLayers([copy])[0]!.text;
    expect(layer(copy, "fuigo", false)).toBe(plain);
    expect(layer(copy, "claude", false)).toBe(plain);
    expect(plain).toContain("save_prompt_block for the brand lock");
    expect(plain).toContain("Save the lock once with");
  });
  it("identical to the shipped text, it is Murage's text and read as such", () => {
    const copy = byId(pinned(ownSkill(text => text)), "image-generation");
    expect(murageSkill(copy)).toBe(true);
    expect(layer(copy, "fuigo", false)).toBe(layer(byId(bundled, "image-generation"), "fuigo", false));
  });
});
