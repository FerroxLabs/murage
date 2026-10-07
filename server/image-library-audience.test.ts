// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// The saved image library (prompt blocks and reference packs) is the owner's.
// A turn whose audience is not the owner (a linked channel person's
// conversation, or words in the owner's thread nobody proved are theirs)
// can neither read it, write it, nor pull it into a render. These build a
// real verified channel binding and bind a real task thread to it, like
// owner-audience.test.ts, and put the one owner-audience predicate in front
// of every library route; the agents proxy is spawned the way a driver
// mounts it.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, threadHumanPrincipal } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { Store } from "./store.ts";
import { internalRouteRefusal } from "./internal-route-authority.ts";
import { IMAGE_LIBRARY_CONTACT_REFUSAL, imageLibraryOwnerAudience, imageLibraryRouteRefusal } from "./image-library-audience.ts";
import { IMAGE_LIBRARY_ENV, IMAGE_LIBRARY_TOOLS } from "../shared/image-library-audience.ts";
import { TURN_PROMPTS, imageToolsPrompt, skillLayers } from "./bot-shapes.ts";
import { loadBundledSkills } from "./skill-library.ts";
import { CLAUDE_TOOL_SURFACE, FUIGO_TOOL_SURFACE, renderMurageTools } from "./murage-tool-surface.ts";

beforeEach(() => {
  closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

function threads() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot();
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture-connection", authorityId: "TEAM", userId: "U-CONTACT" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const contact = store.createTask(bot.id, "Contact conversation", false)!;
  bindHumanThread(contact.threadId, resolveHumanBinding(bindingId));
  return { owner: bot.threadId, contact: contact.threadId };
}

const LIBRARY_ROUTES: Array<[string, string]> = [
  ["GET", "/api/internal/image-prompt-blocks"],
  ["POST", "/api/internal/image-prompt-blocks"],
  ["GET", "/api/internal/image-prompt-block"],
  ["GET", "/api/internal/image-reference-packs"],
  ["POST", "/api/internal/image-reference-packs"],
  // anything later added under the library's paths is the library too
  ["GET", "/api/internal/image-prompt-blocks/brand-lock"],
  ["DELETE", "/api/internal/image-reference-pack/hero"],
];

describe("who is the library's audience", () => {
  it("is the owner in the owner's own thread, and nobody else", () => {
    const { owner, contact } = threads();
    expect(imageLibraryOwnerAudience({ threadId: owner })).toBe(true);
    // Words in the owner's thread nobody proved are the owner's (an unproven
    // send, or a chain such words started) carry notOwnerAudience.
    expect(imageLibraryOwnerAudience({ threadId: owner, notOwnerAudience: true })).toBe(false);
    expect(imageLibraryOwnerAudience({ threadId: contact })).toBe(false);
  });
});

describe("a contact turn and the saved library", () => {
  it("is refused every library route, reading and saving alike", () => {
    const { owner, contact } = threads();
    for (const claim of [{ threadId: contact }, { threadId: owner, notOwnerAudience: true }]) {
      for (const [method, path] of LIBRARY_ROUTES) expect(imageLibraryRouteRefusal({ path, claim }), `${method} ${path}`).toBe(IMAGE_LIBRARY_CONTACT_REFUSAL);
    }
  });
  it("is refused generate_image with prompt_blocks or with reference_pack", () => {
    const { contact, owner } = threads();
    for (const claim of [{ threadId: contact }, { threadId: owner, notOwnerAudience: true }]) {
      const refusal = (body: unknown) => imageLibraryRouteRefusal({ path: "/api/internal/generate-image", body, claim });
      expect(refusal({ requestId: "r1", prompt: "x", promptBlocks: ["brand-lock"] })).toBe(IMAGE_LIBRARY_CONTACT_REFUSAL);
      expect(refusal({ requestId: "r1", prompt: "x", referencePack: "hero@2" })).toBe(IMAGE_LIBRARY_CONTACT_REFUSAL);
      // A plain render keeps whatever rule it had: the library adds no refusal.
      expect(refusal({ requestId: "r1", prompt: "x" })).toBeNull();
      expect(refusal({ requestId: "r1", prompt: "x", promptBlocks: [] })).toBeNull();
    }
  });
  it("keeps the channel person's own refusal for the routes they never had", () => {
    const { contact } = threads();
    // A linked channel person holds no image grant at all today; the route
    // authority refuses them first, generate_image included.
    expect(internalRouteRefusal({ path: "/api/internal/generate-image", kind: "agents", principal: threadHumanPrincipal(contact) })).not.toBeNull();
    expect(imageLibraryOwnerAudience({ threadId: contact })).toBe(false);
  });
  it("leaves the owner's turn alone", () => {
    const { owner } = threads();
    for (const [, path] of LIBRARY_ROUTES) expect(imageLibraryRouteRefusal({ path, claim: { threadId: owner } })).toBeNull();
    expect(imageLibraryRouteRefusal({ path: "/api/internal/generate-image", body: { requestId: "r", promptBlocks: ["a"], referencePack: "b" }, claim: { threadId: owner } })).toBeNull();
  });
  it("says so plainly, with no internal id, naming generate_image on this server", () => {
    expect(IMAGE_LIBRARY_CONTACT_REFUSAL).toContain('MCP tool "generate_image" on this server');
    expect(IMAGE_LIBRARY_CONTACT_REFUSAL).not.toMatch(/\/api\/|thread|principal|—|(?:call|Call|with) generate_image\b/);
  });
  it("is enforced in the harness routes, before the library or a render reads anything", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const library = source.indexOf('if (path.startsWith("/api/internal/image-prompt-block") || path.startsWith("/api/internal/image-reference-pack")) {');
    const render = source.indexOf('if (path === "/api/internal/generate-image" && method === "POST") {');
    expect(library).toBeGreaterThan(0); expect(render).toBeGreaterThan(0);
    const firstLines = (at: number, lines: number) => source.slice(at).split("\n").slice(0, lines).join("\n");
    expect(firstLines(library, 4)).toContain("imageLibraryRouteRefusal({ path, claim: internalClaim })");
    const renderHead = source.slice(render, source.indexOf("resolvePromptBlocks(", render));
    expect(renderHead).toContain("imageLibraryRouteRefusal({ path, body, claim: internalClaim })");
  });
});

describe("the agents proxy on a contact turn", () => {
  const PROXY = join(import.meta.dirname, "drivers", "agents-proxy.ts");
  const list = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, [PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: "http://127.0.0.1:9", MURAGE_BOT_ID: "b", MURAGE_THREAD_ID: "t", MURAGE_COMMS_TOKEN: "x", ...env }, stdio: ["pipe", "pipe", "ignore"] });
    const reply = new Promise<string>(resolve => { let out = ""; child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.split("\n")[0]!); }); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const line = await reply; child.kill();
    return JSON.parse(line).result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }>;
  };
  it("does not list the library, and generate_image takes no library arguments", async () => {
    const owner = await list({}), contact = await list({ [IMAGE_LIBRARY_ENV]: "0" });
    for (const tool of IMAGE_LIBRARY_TOOLS) { expect(owner.map(t => t.name)).toContain(tool); expect(contact.map(t => t.name)).not.toContain(tool); }
    expect(contact.map(t => t.name)).toEqual(owner.map(t => t.name).filter(name => !(IMAGE_LIBRARY_TOOLS as readonly string[]).includes(name)));
    const generate = contact.find(t => t.name === "generate_image")!;
    expect(Object.keys(generate.inputSchema.properties)).not.toContain("prompt_blocks");
    expect(Object.keys(generate.inputSchema.properties)).not.toContain("reference_pack");
    expect(JSON.stringify(contact)).not.toMatch(/prompt_blocks|reference_pack|prompt block|reference-pack/i);
    expect(owner.find(t => t.name === "generate_image")!.inputSchema.properties.prompt_blocks).toBeDefined();
    // with no saved blocks to lean on, the prompt is what the render needs
    expect((generate.inputSchema as { required?: string[] }).required).toEqual(["request_id", "prompt"]);
    expect((owner.find(t => t.name === "generate_image")!.inputSchema as { required?: string[] }).required).toEqual(["request_id"]);
  }, 30_000);
  it("the harness tells the agents server of a turn that is not the owner's to leave the library out", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const start = source.indexOf("function agentsIntegration(");
    expect(source.slice(start, source.indexOf("\n}\n", start))).toMatch(/imageLibraryOwnerAudience\(\{ threadId, notOwnerAudience: internalTurnOwners\.get\(threadId\)\?\.notOwnerAudience \}\) \? \{\} : \{ \[IMAGE_LIBRARY_ENV\]: "0" \}/);
  });
});

describe("the images line on a contact turn", () => {
  it("leaves the saved library out, and the owner's line exactly as it was", () => {
    expect(imageToolsPrompt(true)).toBe(TURN_PROMPTS.imageTools);
    const contact = imageToolsPrompt(false);
    expect(contact.length).toBeLessThan(TURN_PROMPTS.imageTools.length);
    expect(TURN_PROMPTS.imageTools.startsWith(contact)).toBe(true);
    for (const surface of [CLAUDE_TOOL_SURFACE, FUIGO_TOOL_SURFACE]) {
      const shown = renderMurageTools(contact, surface, { agents: "agents" });
      expect(shown).not.toMatch(/prompt_block|reference_pack/);
      expect(shown).toContain("generate_image");
    }
  });
  it("the direct turn builds its images line with the turn's owner audience", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toContain("${TURN_PROMPTS.imageTools}");
    expect(source).toContain("const directOwnerAudience = humanIsOwner && surfacesForOwner && !memoryNotOwner;");
    expect(source).toContain("imageToolsPrompt(directOwnerAudience)");
  });
});

describe("the image skill on a contact turn", () => {
  const bundled = join(import.meta.dirname, "..", "skills");
  // A Windows checkout, and the Windows app built from it, ships the guide
  // with CRLF line endings: the cut must find the same passages there.
  const crlf = (() => {
    const root = join(tmpdir(), `murage-crlf-skills-${process.pid}`), directory = join(root, "image-generation");
    mkdirSync(directory, { recursive: true });
    for (const name of ["SKILL.md", "manifest.json"]) writeFileSync(join(directory, name), readFileSync(join(bundled, "image-generation", name), "utf8").replace(/\r?\n/g, "\r\n"));
    return root;
  })();
  afterAll(() => rmSync(crlf, { recursive: true, force: true }));
  const load = (root: string) => loadBundledSkills(root).find(item => item.manifest.id === "image-generation")!;
  const layer = (root: string, ownerAudience?: boolean) => { const skill = load(root); return skillLayers([skill], { murageSkill: item => item === skill, agentsMounted: true, ownerAudience })[0]!.text; };
  it("cuts the guide that a task pinned by an earlier version kept with CRLF", () => {
    const skill = load(bundled), pinned = { ...skill, instructions: skill.instructions.replace(/\n/g, "\r\n") };
    const cut = skillLayers([pinned], { murageSkill: item => item === pinned, agentsMounted: true, ownerAudience: false })[0]!.text;
    const contact = renderMurageTools(cut, CLAUDE_TOOL_SURFACE, { agents: "agents" });
    for (const tool of IMAGE_LIBRARY_TOOLS) expect(contact).not.toContain(tool);
    expect(contact).not.toMatch(/prompt_blocks|reference_pack/);
    expect(contact).toContain("Send the lock first, then the scene");
  });
  it("reads the CRLF copy as CRLF on disk", () => expect(readFileSync(join(crlf, "image-generation", "SKILL.md"), "utf8")).toContain("\r\n"));
  it.each([["claude", CLAUDE_TOOL_SURFACE, "LF"], ["fuigo", FUIGO_TOOL_SURFACE, "LF"], ["claude", CLAUDE_TOOL_SURFACE, "CRLF"], ["fuigo", FUIGO_TOOL_SURFACE, "CRLF"]] as const)("%s, %s file: teaches no saved library, and the owner's copy keeps all of it", (_engine, surface, eol) => {
    const root = eol === "CRLF" ? crlf : bundled;
    const shown = (text: string) => renderMurageTools(text, surface, { agents: "agents" });
    const contact = shown(layer(root, false)), owner = shown(layer(root));
    expect(owner).toBe(shown(layer(bundled))); expect(contact).toBe(shown(layer(bundled, false)));
    expect(shown(layer(root, true))).toBe(owner);
    for (const tool of IMAGE_LIBRARY_TOOLS) { expect(owner).toContain(tool); expect(contact).not.toContain(tool); }
    expect(contact).not.toMatch(/prompt_blocks|reference_pack/);
    // the rest of the guide is still there, lock plus scene included
    expect(contact).toContain("Lock plus scene");
    expect(contact).toContain("Send the lock first, then the scene");
    expect(contact).toContain("resolve_image_reference");
    expect(contact).toContain("generate_image");
  });
  it("the direct and room turns pass the turn's owner audience to the skills", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).toContain("phoneMounted: Boolean(integrations.phone), ownerAudience: directOwnerAudience,");
    expect(source).toContain("phoneMounted: Boolean(integrations.phone), ownerAudience: roomOwnerAudience }),");
  });
  it("a room turn mounts the owner's phone for the owner's audience only, as a 1:1 turn does", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).toContain("if (directOwnerAudience && selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes(\"phoneMcp\"))) {");
    expect(source).toContain("if (roomOwnerAudience && selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes(\"phoneMcp\"))) {");
  });
});
