// The profile patch parser is the boundary that keeps paired clients from
// writing anything but identity fields. The strict half is the one that
// matters: a privileged bot field arriving here must be refused by NAME,
// so a future field cannot silently become remotely writable.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { parseBotProfilePatch } from "./bot-profile.ts";
import { MASCOT_BODY_IDS } from "../shared/mascot-bodies.ts";

describe("parseBotProfilePatch (strict — the paired boundary)", () => {
  it("refuses every privilege-bearing bot field by name", () => {
    for (const field of ["autoApprove", "autoReview", "alwaysAllow", "computer", "cwd", "composio", "chiefOfStaff", "acknowledgeLocalAuto"]) {
      const result = parseBotProfilePatch({ name: "Mira", [field]: true } as never, true);
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("refuses unknown cosmetic keys too — strict means the allowlist IS the contract", () => {
    const result = parseBotProfilePatch({ color: "red" } as never, true);
    expect(result).toEqual({ ok: false, error: "unsupported profile field: color" });
  });

  it("accepts the full identity surface", () => {
    const result = parseBotProfilePatch(
      {
        name: "Mira",
        title: "Lead",
        description: "plans",
        persona: "Direct, dry, skips the pleasantries.",
        notifications: true,
        voice: "vx",
        speakReplies: false,
      },
      true,
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        name: "Mira",
        title: "Lead",
        description: "plans",
        persona: "Direct, dry, skips the pleasantries.",
        notifications: true,
        voice: "vx",
        speakReplies: false,
      },
    });
  });
});

describe("parseBotProfilePatch (both modes)", () => {
  it("lenient mode drops unknown keys instead of failing — the desktop PATCH mixes fields", () => {
    const result = parseBotProfilePatch({ name: "Mira", color: "red" } as never, false);
    expect(result).toEqual({ ok: true, patch: { name: "Mira" } });
  });

  it("rejects a blank or oversized name", () => {
    expect(parseBotProfilePatch({ name: "   " }, true).ok).toBe(false);
    expect(parseBotProfilePatch({ name: "x".repeat(101) }, true).ok).toBe(false);
  });

  it("only stored-attachment avatar URLs pass; clears normalize to undefined", () => {
    for (const bad of ["https://example.com/a.png", "data:image/png;base64,AAAA", "/api/attachments/../config.json", "/api/attachments/a.svg"]) {
      expect(parseBotProfilePatch({ avatarUrl: bad } as never, true).ok, bad).toBe(false);
    }
    const cleared = parseBotProfilePatch({ avatarUrl: "" }, true);
    expect(cleared).toEqual({ ok: true, patch: { avatarUrl: undefined } });
    const nulled = parseBotProfilePatch({ avatarUrl: null }, true);
    expect(nulled).toEqual({ ok: true, patch: { avatarUrl: undefined } });
  });

  it("accepts every mascot body and names the choices when one is unknown", () => {
    for (const body of MASCOT_BODY_IDS) {
      expect(parseBotProfilePatch({ mascotBody: body }, true), body).toEqual({ ok: true, patch: { mascotBody: body } });
    }
    expect(parseBotProfilePatch({ mascotBody: "hexagon" }, true)).toEqual({ ok: true, patch: { mascotBody: "hexagon" } });
    expect(parseBotProfilePatch({ mascotBody: "ember" }, false)).toEqual({ ok: true, patch: { mascotBody: "ember" } });
    expect(parseBotProfilePatch({ mascotBody: "cursor" } as never, true)).toEqual({
      ok: false,
      error: "mascotBody must be ember, blob, circle, squircle, capsule, drop, shield, hexagon, diamond, or star",
    });
  });

  it("maps an avatarCrop issue to the readable message", () => {
    expect(parseBotProfilePatch({ avatarCrop: "hexagon" } as never, true)).toEqual({
      ok: false,
      error: "avatarCrop must be mascot, circle, rounded, or square",
    });
  });
});

// The cap IS the design. `description` takes 4000 characters and reaches the
// model verbatim; the whole point of a second field is that it cannot become
// a second brief. 280 is small enough to force a voice note.
describe("persona — the micro field", () => {
  it("caps at 280 characters, and says so", () => {
    expect(BOT_PROFILE_LIMITS.persona).toBe(280);
    expect(parseBotProfilePatch({ persona: "x".repeat(280) }, true).ok).toBe(true);
    const over = parseBotProfilePatch({ persona: "x".repeat(281) }, true);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe("persona must be at most 280 characters");
  });

  it("is a string, not a truthy anything", () => {
    const result = parseBotProfilePatch({ persona: 7 } as never, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("persona must be a string");
  });

  it("clears to absent, never to an empty string — one shape for no voice note", () => {
    expect(parseBotProfilePatch({ persona: "" }, true)).toEqual({ ok: true, patch: { persona: undefined } });
    expect(parseBotProfilePatch({ persona: "   \n " }, true)).toEqual({ ok: true, patch: { persona: undefined } });
    expect(parseBotProfilePatch({ persona: "  dry wit  " }, true)).toEqual({
      ok: true,
      patch: { persona: "dry wit" },
    });
  });

  it("is writable by a paired client — it is identity, not privilege", () => {
    expect(parseBotProfilePatch({ persona: "snarky" }, true).ok).toBe(true);
  });
});

// SOURCE CONTRACT: persona reaches the model, and reaches nothing else.
//
// This is the entire reason the field exists. `description` is read by the
// Chief of Staff's roster, the avatar prompt, the team manifest, the project
// scout and the published package — so voice written into it bleeds into
// routing decisions and into files other people download. persona is appended
// to the persona string at the two turn sites and read NOWHERE else. A future
// edit that "helpfully" adds it to the roster line must fail here.
const readSource = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

// directPersona() and roomPersonaLines() in bot-shapes.ts, the one place the
// direct turn, the room turn and "What shapes <bot>" build who the bot is.
const DIRECT_TURN_PERSONA = `  return [
    \`You are \${bot.name}, a personal bot in Murage.\`,
    bot.title && \`Role: \${bot.title}.\`,
    bot.description && \`About: \${bot.description}\`,
    \`Personality: \${personalityImprint(bot.persona)}\`,
  ]`;

const ROOM_TURN_PERSONA = `    \`You are \${bot.name}, a bot in the room "\${roomName}" in Murage.\`,
    bot.title && \`Role: \${bot.title}.\`,
    bot.description && \`About: \${bot.description}\`,
    \`Personality: \${personalityImprint(bot.persona)}\`,`;

describe("persona is spoken to the bot and read by nothing that routes", () => {
  const index = readSource("./index.ts");
  const shapes = readSource("./bot-shapes.ts");

  it("is appended to the DIRECT turn's persona string", () => {
    expect(shapes).toContain(DIRECT_TURN_PERSONA);
    expect(index).toContain("directPersona(bot)");
  });

  it("is appended to the ROOM turn's persona string", () => {
    expect(shapes).toContain(ROOM_TURN_PERSONA);
    expect(index).toContain("roomPersonaLines(bot, group.name)");
  });

  it("appears on those two lines of the harness and no others", () => {
    expect(index.split("\n").filter((line) => line.includes(".persona"))).toEqual([]);
    const lines = shapes.split("\n").filter((line) => line.includes("bot.persona"));
    expect(lines).toEqual([
      // Every bot now carries a personality imprint, defaulted by
      // personalityImprint (shared/bot-identity.ts, covered in memory/identity.test.ts).
      "    `Personality: ${personalityImprint(bot.persona)}`,",
      "    `Personality: ${personalityImprint(bot.persona)}`,",
    ]);
  });

  it("is invisible to every consumer that reads `description` for something other than the prompt", () => {
    const consumers = [
      "./chief-of-staff.ts", // the Chief's roster — who to delegate to
      "./avatar-image.ts", // the image prompt
      "./team-manifest.ts", // shared team files
      "./project-scout.ts", // the scouted team suggestion
      "./bot-package.ts", // the published package format
      "./package-export.ts", // what a downloaded package carries
      "./bot-directory.ts", // community imports
    ];
    for (const file of consumers) {
      const source = readSource(file);
      expect(source, file).toContain("description");
      expect(source, `${file} must not read persona`).not.toMatch(/\.persona\b/);
    }
  });
});

describe("an agent's voice service", () => {
  it("accepts each service, stores an empty choice as absent, and refuses anything else", () => {
    expect(parseBotProfilePatch({ voiceProvider: "xai" })).toEqual({ ok: true, patch: { voiceProvider: "xai" } });
    expect(parseBotProfilePatch({ voiceProvider: "" })).toEqual({ ok: true, patch: { voiceProvider: undefined } });
    expect(parseBotProfilePatch({ voiceProvider: "azure" as any }).ok).toBe(false);
  });
});
