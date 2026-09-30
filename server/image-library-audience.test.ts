// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// The saved image library (prompt blocks and reference packs) is the owner's.
// A turn whose audience is not the owner (a linked channel person's
// conversation, or words in the owner's thread nobody proved are theirs)
// can neither read it, write it, nor pull it into a render. These build a
// real verified channel binding and bind a real task thread to it, like
// internal-route-authority.test.ts, and put the real decision in front of
// every library route; the agents proxy is spawned the way a driver mounts it.
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
import { withToolCallStyle } from "./tool-call-context.ts";
import { internalRouteRefusal } from "./internal-route-authority.ts";
import { imageLibraryContactRefusal, imageLibraryOwnerAudience, imageLibraryRouteRefusal } from "./image-library-audience.ts";
import { IMAGE_LIBRARY_ENV, IMAGE_LIBRARY_TOOLS } from "../shared/image-library-audience.ts";
import { MURAGE_MCP_TOOLS } from "../shared/murage-tool-names.ts";
import { TURN_PROMPTS, imageToolsPrompt, skillLayers } from "./bot-shapes.ts";
import { loadBundledSkills } from "./skill-library.ts";
import { toolCallStyleFor } from "../shared/murage-tool-names.ts";

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

const LIBRARY_ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/api/internal/image-prompt-blocks"],
  ["POST", "/api/internal/image-prompt-blocks", { name: "brand-lock", text: "A red fox." }],
  ["GET", "/api/internal/image-prompt-block"],
  ["GET", "/api/internal/image-reference-packs"],
  ["POST", "/api/internal/image-reference-packs", { name: "hero", referenceIds: ["a.png"] }],
  // anything later added under the library's paths is the library too
  ["GET", "/api/internal/image-prompt-blocks/brand-lock"],
  ["DELETE", "/api/internal/image-reference-pack/hero"],
];

describe("who is the library's audience", () => {
  it("is the owner in the owner's own thread, and nobody else", () => {
    const { owner, contact } = threads();
    expect(imageLibraryOwnerAudience({ threadId: owner })).toBe(true);
    // Words in the owner's thread nobody proved are the owner's (an unproven
    // send, or a peer turn such words started).
    expect(imageLibraryOwnerAudience({ threadId: owner, notOwnerAudience: true })).toBe(false);
    expect(imageLibraryOwnerAudience({ threadId: contact })).toBe(false);
  });
});

describe("a contact turn and the saved library", () => {
  it("is refused every library route, reading and saving alike", () => {
    const { owner, contact } = threads();
    for (const claim of [{ threadId: contact }, { threadId: owner, notOwnerAudience: true }]) {
      const ownerAudience = imageLibraryOwnerAudience(claim);
      for (const [method, path, body] of LIBRARY_ROUTES) expect(imageLibraryRouteRefusal({ path, body, ownerAudience }), `${method} ${path}`).toBe(imageLibraryContactRefusal());
    }
  });
  it("is refused generate_image with prompt_blocks or with reference_pack", () => {
    const { contact, owner } = threads();
    for (const claim of [{ threadId: contact }, { threadId: owner, notOwnerAudience: true }]) {
      const ownerAudience = imageLibraryOwnerAudience(claim);
      const refusal = (body: unknown) => imageLibraryRouteRefusal({ path: "/api/internal/generate-image", body, ownerAudience });
      expect(refusal({ requestId: "r1", prompt: "x", promptBlocks: ["brand-lock"] })).toBe(imageLibraryContactRefusal());
      expect(refusal({ requestId: "r1", prompt: "x", referencePack: "hero@2" })).toBe(imageLibraryContactRefusal());
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
    const ownerAudience = imageLibraryOwnerAudience({ threadId: owner });
    for (const [, path, body] of LIBRARY_ROUTES) expect(imageLibraryRouteRefusal({ path, body, ownerAudience })).toBeNull();
    expect(imageLibraryRouteRefusal({ path: "/api/internal/generate-image", body: { requestId: "r", promptBlocks: ["a"], referencePack: "b" }, ownerAudience })).toBeNull();
  });
  it("says so plainly, with no internal id, naming generate_image the way the engine calls it", () => {
    const direct = imageLibraryContactRefusal();
    expect(direct).toContain("generate_image");
    expect(direct).not.toMatch(/\/api\/|thread|principal|—/);
    const fuigo = withToolCallStyle("use-tool", () => imageLibraryContactRefusal());
    expect(fuigo).toContain('use_tool with tool_name "agents__generate_image"');
    const bare = new RegExp(`(?<![A-Za-z0-9_"])(${MURAGE_MCP_TOOLS.agents.join("|")})(?![A-Za-z0-9_"])`);
    expect(fuigo.replace(/use_tool with tool_name "[^"]+"/g, "")).not.toMatch(bare);
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
  });
});

describe("the images line on a contact turn", () => {
  it("leaves the saved library out, and the owner's line exactly as it was", () => {
    expect(imageToolsPrompt(true)).toBe(TURN_PROMPTS.imageTools);
    const contact = imageToolsPrompt(false);
    expect(contact.length).toBeLessThan(TURN_PROMPTS.imageTools.length);
    expect(TURN_PROMPTS.imageTools.startsWith(contact)).toBe(true);
    expect(contact).not.toMatch(/prompt_block|reference_pack/);
    expect(contact).toContain("generate_image");
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
  const layer = (root: string, kind: string, ownerAudience?: boolean) => { const skill = load(root); return skillLayers([skill], { toolCallStyle: toolCallStyleFor(kind), murageSkill: item => item === skill, ownerAudience })[0]!.text; };
  it("reads the CRLF copy as CRLF on disk", () => expect(readFileSync(join(crlf, "image-generation", "SKILL.md"), "utf8")).toContain("\r\n"));
  it.each([["claude", "LF"], ["fuigoAgent", "LF"], ["claude", "CRLF"], ["fuigoAgent", "CRLF"]])("%s, %s file: teaches no saved library, and the owner's copy keeps all of it", (kind, eol) => {
    const root = eol === "CRLF" ? crlf : bundled;
    const contact = layer(root, kind, false), owner = layer(root, kind);
    expect(owner).toBe(layer(bundled, kind)); expect(contact).toBe(layer(bundled, kind, false));
    expect(layer(root, kind, true)).toBe(owner);
    for (const tool of IMAGE_LIBRARY_TOOLS) { expect(owner).toContain(tool); expect(contact).not.toContain(tool); }
    expect(contact).not.toMatch(/prompt_blocks|reference_pack/);
    // the rest of the guide is still there, lock plus scene included
    expect(contact).toContain("Lock plus scene");
    expect(contact).toContain("Send the lock first, then the scene");
    expect(contact).toContain("resolve_image_reference");
    expect(contact).toContain("generate_image");
  });
});
