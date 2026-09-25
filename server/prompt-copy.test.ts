// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every sentence a bot can be given is also text the owner reads: "What
// shapes <bot>" shows the whole system prompt, layer by layer. So the prompt
// follows the house copy rules: no em dashes, no en dash used as a dash, and
// no vendor brand in prose. This builds every layer text Murage writes, in
// every variant, and holds it to those rules.
//
// A name the model must see verbatim is not prose: a real tool name, a real
// path. Those are listed in FUNCTIONAL_TOKENS below, one reason each, and
// removed before the brand check. Anything else naming a vendor fails.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SHAPE_CATALOGUE,
  TURN_PROMPTS,
  automationPrompt,
  directPersona,
  directTurnLayers,
  nowPrompt,
  roomBulletinLine,
  roomMembersLine,
  roomPersonaLines,
  speakAsLine,
  type DirectTurnShapeInput,
} from "./bot-shapes.ts";
import { INTEGRATION_FACTS, capabilitiesPrimer, type ImageInput, type IntegrationKey, type MemoryMode, type PrimerFacts, type ToolAccess } from "./capabilities-primer.ts";
import { connectorSystemPrompt, requiredAppsSystemPrompt, type ConnectorAccess } from "./composio.ts";
import { unifiedBrowserSystemPrompt } from "./browser-engine.ts";
import { DEFAULT_HOUSE_RULES } from "./house-rules/default.ts";
import { IMAGE_DELIVERY_PROMPT } from "./turn-image-dispatch.ts";
import { outputDestinationInstructions } from "./output-publication.ts";
import { loadBundledSkills, renderSkillInstructions } from "./skill-library.ts";
import { renderInstalledPlaybooks } from "./installed-playbooks.ts";
import { importedSkillsPrompt } from "./procedure-bundles.ts";
import { chiefOfStaffSystemPrompt, individualAssistantSystemPrompt, type ChiefTeamMember } from "./chief-of-staff.ts";
import { openMurageStatusSystemPrompt } from "./murage-status-capsule.ts";
import { channelProjectSystemLine } from "./project-channel.ts";
import { groupGoalCoordinatorInstructions, groupGoalWorkerInstructions } from "./group-goal-run.ts";
import { ensureWorkspace, memorySystemPrompt } from "./workspace.ts";
import { writeFileSync } from "node:fs";
import { writeSectionContext, sectionContextSystemPrompt } from "./section-context.ts";

/** Names the model must read exactly as written. Each is removed from the
 *  text before the brand check, so only these spellings may carry a brand. */
const FUNCTIONAL_TOKENS: ReadonlyArray<{ token: string; why: string }> = [
  // The connected-app tools' real names: the model calls them by these.
  { token: "COMPOSIO_SEARCH_TOOLS", why: "tool name" },
  { token: "COMPOSIO_GET_TOOL_SCHEMAS", why: "tool name" },
  { token: "COMPOSIO_MULTI_EXECUTE_TOOL", why: "tool name" },
  // The durable folder inside the computer sandbox: a real path.
  { token: "/home/cua/workspace", why: "filesystem path" },
];

const BRAND = /composio|\bcua\b/i;
// An em dash anywhere; an en dash standing between spaces (or at an edge) as
// a dash. An en dash inside a range such as 9–5 is not a dash.
const DASH = /—|(^|\s)–(\s|$)/u;

function withoutFunctionalTokens(text: string): string {
  return FUNCTIONAL_TOKENS.reduce((rest, { token }) => rest.split(token).join(" "), text);
}

/** label -> text, for every layer text below. */
const texts = new Map<string, string>();
const add = (label: string, text: string | null | undefined) => {
  if (text) texts.set(label, text);
};

// ── bot-shapes: direct turns, every computer and automation variant ───────
const baseDirect: DirectTurnShapeInput = {
  houseRules: "",
  persona: directPersona({ name: "Moss", title: "Researcher", description: "Finds things out.", persona: "Calm and precise" }),
  computerKind: null,
  vmPerBot: false,
  driverKind: "claude",
  connectors: "",
  requiredApps: "",
  browser: "",
  coordination: "",
  credential: "",
  image: "",
  webSearchBackup: true,
  routines: "",
  learn: "",
  importedSkills: "",
  teamBrief: "",
  memory: "",
  primer: "",
  skills: [],
  playbooks: "",
  outputFolder: "",
  tagged: [{ name: "Quill", id: "bot-quill" }, { name: "Rex", id: "bot-rex" }],
};
// The clock rides the message, not the system prompt, but the bot reads it.
add("now", nowPrompt(new Date("2026-09-25T08:03:00Z"), "Europe/London"));
add("persona (no title)", directPersona({ name: "Moss" }));
for (const computerKind of ["box", "vps", "vm", "local", null] as const) {
  for (const vmPerBot of [true, false]) {
    for (const driverKind of ["claude", "boxAgent"]) {
      for (const automationSource of [undefined, "webhook", "channel", "schedule", "manual"]) {
        const layers = directTurnLayers({ ...baseDirect, computerKind, vmPerBot, driverKind, automationSource });
        for (const layer of layers) add(`direct ${layer.id} (${computerKind}/${vmPerBot ? "per-bot" : "shared"}/${driverKind}/${automationSource})`, layer.text);
      }
    }
  }
}
for (const source of ["webhook", "channel", "schedule", "manual"]) add(`automation ${source}`, automationPrompt(source));

// ── sentences index.ts adds when tools are mounted ────────────────────────
for (const [key, text] of Object.entries(TURN_PROMPTS)) add(`turn ${key}`, text);
for (const [outcome, text] of Object.entries(IMAGE_DELIVERY_PROMPT)) add(`images ${outcome}`, ` ${TURN_PROMPTS.imageTools}${text} ${TURN_PROMPTS.imageKeys}`);

// ── room framing ──────────────────────────────────────────────────────────
add("room persona", roomPersonaLines({ name: "Moss", title: "Researcher", description: "Finds things out.", persona: "" }, "Launch").filter(Boolean).join("\n"));
add("room members", roomMembersLine("@Moss (Researcher), @Quill", "Sean"));
add("room bulletin", roomBulletinLine("Ship on Thursdays."));
add("speak-as", speakAsLine("Moss"));
for (const status of ["active", "paused", "done"] as const) add(`project ${status}`, channelProjectSystemLine({ goal: "Launch the site", status, createdAt: 1, updatedAt: 1 } as never));
add("goal coordinator", groupGoalCoordinatorInstructions({ goal: "Launch", members: [{ id: "a", name: "Moss" }], turn: 1, maxTurns: 6, remainingTurns: 5, note: "Quill stayed busy." }));
add("goal worker", groupGoalWorkerInstructions({ goal: "Launch", coordinatorName: "Moss", assignment: "Draft the page", turn: 2, maxTurns: 6 }));

// ── coordination: Chief of Staff, team leader, individual assistant ───────
const team: ChiefTeamMember[] = [
  { id: "chief", name: "Ada", title: "Chief of Staff", chiefOfStaff: true, chiefScope: "workspace", section: "Office" },
  { id: "rex", name: "Rex", title: "Head of Sales", description: "Owns pipeline", chiefOfStaff: true, section: "Sales" },
  { id: "dash", name: "Dash", title: "SDR", section: "Sales", busy: true },
  { id: "ops", name: "Olly", section: "Ops" },
  { id: "bruce", name: "Bruce", title: "Trading assistant", individual: true, section: "Trading" },
  { id: "scribe", name: "Scribe", section: "Office" },
];
for (const canDelegate of [true, false]) {
  add(`chief workspace ${canDelegate}`, chiefOfStaffSystemPrompt("chief", team, canDelegate));
  add(`chief section ${canDelegate}`, chiefOfStaffSystemPrompt("rex", team, canDelegate));
  add(`individual ${canDelegate}`, individualAssistantSystemPrompt("bruce", team, canDelegate));
}
add("chief empty workspace", chiefOfStaffSystemPrompt("chief", [team[0]!], true));
add("individual alone", individualAssistantSystemPrompt("bruce", [team[4]!], true));
add("murage status", openMurageStatusSystemPrompt({ cachePath: "/nonexistent/murage-status.json" }));

// ── capabilities primer: every line in every combination that picks it ───
const keys = Object.keys(INTEGRATION_FACTS) as IntegrationKey[];
for (let mask = 0; mask < 1 << keys.length; mask++) {
  const mounted = Object.fromEntries(keys.filter((_, i) => mask & (1 << i)).map((key) => [key, true]));
  for (const peers of [0, 2]) {
    for (const browserLock of [undefined, "owner-input", "sensitive-page"] as const) {
      const facts: PrimerFacts = {
        engine: "Fuigo", model: "Grok 4.7", toolAccess: mask ? "direct" : "none", imageInput: "inline", mounted, memory: "active",
        imageProvider: (mask & 1) === 0, voice: (mask & 2) === 0, folder: "trusted", peers, canAskOwner: true, browserLock,
      };
      add(`primer ${mask}/${peers}/${browserLock}`, capabilitiesPrimer(facts));
    }
  }
}
for (const toolAccess of ["direct", "none"] as ToolAccess[]) {
  for (const imageInput of ["inline", "file-reference", "model-not-listed", "unsupported", "unknown"] as ImageInput[]) {
    for (const memory of ["off", "capture", "active", "paused"] as MemoryMode[]) {
      for (const folder of ["trusted", "untrusted", "ungated", "none"] as const) {
        for (const canAskOwner of [true, false]) {
          for (const agents of [true, false]) {
            add(`primer ${toolAccess}/${imageInput}/${memory}/${folder}/${canAskOwner}/${agents}`, capabilitiesPrimer({
              engine: "Claude Code", toolAccess, imageInput, mounted: agents ? { agents: true } : {}, memory, imageProvider: false, folder, peers: 1, canAskOwner,
            }));
          }
        }
      }
    }
  }
}

// ── connected apps, browser, house rules, output folder ───────────────────
for (const access of ["mounted", "package-off", "bot-off", "unconfigured", "engine"] as ConnectorAccess[]) add(`connected-apps ${access}`, connectorSystemPrompt(access));
add("required-apps", requiredAppsSystemPrompt([
  { slug: "gmail", label: "Gmail", reason: "Reads and drafts replies." },
  { slug: "slack", label: "Slack", reason: "Posts the summary", optional: true },
]));
for (const lock of [null, "owner-input", "sensitive-page"] as const) add(`browser ${lock}`, unifiedBrowserSystemPrompt(lock));
add("house rules default", DEFAULT_HOUSE_RULES);
for (const managed of [true, false]) {
  for (const snapshot of [true, false]) {
    for (const canRegister of [true, false]) add(`output ${managed}/${snapshot}/${canRegister}`, outputDestinationInstructions({ workspaceRoot: "/tmp/desk", managed }, snapshot, canRegister));
  }
}

// ── skills, playbooks, imported skills ────────────────────────────────────
const bundled = loadBundledSkills(join(fileURLToPath(new URL(".", import.meta.url)), "..", "skills"));
for (const skill of bundled) add(`skill ${skill.manifest.id}`, renderSkillInstructions([skill], { includeRoot: true }));
add("playbooks", renderInstalledPlaybooks([{ key: "k", name: "Launch", summary: "s", triggers: ["launch"], instructions: "Do the launch." }]));
add("imported skills", importedSkillsPrompt(["- tidy: Tidies files. Read \"/desk/skills/tidy/SKILL.md\"."]));

/** Each offending passage once, with the first layer it was found in. */
function offending(rule: RegExp, prepare: (text: string) => string, passage: RegExp): string[] {
  const found = new Map<string, string>();
  for (const [label, raw] of texts) {
    const text = prepare(raw);
    if (!rule.test(text)) continue;
    for (const hit of text.match(passage) ?? []) if (!found.has(hit)) found.set(hit, label);
  }
  return [...found].map(([hit, label]) => `${label}: ${hit}`);
}

describe("prompt copy: every layer a bot can read", () => {
  it("covers every row the panel can show", () => {
    // A new catalogue row needs its text added above before this passes.
    const covered = new Set([...texts.keys()].map((label) => label.split(" ")[0]));
    const byLabel: Record<string, string> = {
      "house-rules": "house", persona: "persona", room: "room", computer: "direct", "computer-protected-input": "direct",
      "connected-apps": "connected-apps", "required-apps": "required-apps", browser: "browser", coordination: "chief",
      "speak-as": "speak-as", credential: "turn", images: "images", "web-search": "direct", routines: "turn", learn: "turn",
      goal: "goal", "skills-index": "imported", "team-brief": "team-brief", memory: "memory", capabilities: "primer", skill: "skill",
      "chief-guide": "skill", "own-skill": "skill", playbooks: "playbooks", "output-folder": "output", automation: "automation",
      tagged: "direct", now: "direct",
    };
    expect(Object.keys(SHAPE_CATALOGUE).sort()).toEqual(Object.keys(byLabel).sort());
    for (const [id, prefix] of Object.entries(byLabel)) {
      if (id === "team-brief" || id === "memory") continue; // built from data files in the next test
      expect(covered.has(prefix), `${id} has no text in this test`).toBe(true);
    }
    expect(bundled.map((skill) => skill.manifest.id)).toContain("chief-of-staff");
  });

  it("has no em dash and no en dash used as a dash", () => {
    expect(offending(DASH, (text) => text, /.{0,40}[—–].{0,40}/gu)).toEqual([]);
  });

  it("names no vendor in prose, only the functional tokens the model must call", () => {
    expect(offending(BRAND, withoutFunctionalTokens, /.{0,40}(composio|\bcua\b).{0,40}/giu)).toEqual([]);
  });

  it("keeps every allowlisted token in use, so the list cannot rot", () => {
    const all = [...texts.values()].join("\n");
    for (const { token } of FUNCTIONAL_TOKENS) expect(all, token).toContain(token);
  });

  // MEMORY_SEED is not here on purpose: a notebook still equal to the seed is
  // treated as empty and never reaches a prompt, and changing the seed would
  // make every untouched notebook stop matching it.
  it("holds the team brief and the notebook guidance to the same rules", () => {
    writeSectionContext("Ops", "Ship on Thursdays.", 1);
    const botId = "prompt-copy-bot";
    const plain = [memorySystemPrompt(botId, { fileTools: true })];
    writeFileSync(join(ensureWorkspace(botId), "MEMORY.md"), `${"- a note\n".repeat(400)}`);
    const layers = [
      sectionContextSystemPrompt("Ops"),
      ...plain,
      memorySystemPrompt(botId, { fileTools: true }),
      memorySystemPrompt(botId, { fileTools: false }),
    ];
    expect(layers.every(Boolean)).toBe(true);
    for (const text of layers) {
      expect(text).not.toMatch(DASH);
      expect(withoutFunctionalTokens(text)).not.toMatch(BRAND);
    }
  });
});
