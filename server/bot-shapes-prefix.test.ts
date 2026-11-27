// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prompt cache: a new thread of a bot starts from the bot's cached system prompt. Everything that depends on the bot and the
// workspace comes first; what this thread or this message chose (browser, who is busy, a teammate's task, images, skills,
// playbooks, output folder, automation, tags) comes after it, so changing any of them never moves a byte of the stable prefix.
import { describe, expect, it } from "vitest";
import { capabilitiesPrimer, turnCapabilityFacts } from "./capabilities-primer.ts";
import { directTurnLayers, joinShapeLayers, skillLayers, type DirectTurnShapeInput } from "./bot-shapes.ts";

const STABLE_IDS = ["house-rules", "reply-habits", "about-me", "persona", "team-brief", "memory"];

const base: DirectTurnShapeInput = {
  houseRules: "<house-rules>\nBe kind.\n</house-rules>\n\n", aboutMe: "ABOUT ", persona: "You are Moss.", computerKind: "vm", vmPerBot: true, driverKind: "claudeAgent",
  connectors: " CONNECTORS", requiredApps: " REQUIRED", browser: "", coordination: "", credential: " CREDENTIAL", image: "", webRead: true, webSearchBackup: true,
  routines: " ROUTINES", learn: " LEARN", importedSkills: " IMPORTED", teamBrief: " BRIEF", memory: " MEMORY", primer: "\n\nPRIMER", skills: [], playbooks: "",
  outputFolder: "", automationSource: undefined, tagged: [],
};
const skill = { manifest: { id: "pdf", name: "pdf", version: "1.0.0", description: "pdf does things.", defaultEnabled: true, triggerTerms: ["pdf"], requiredCapabilities: [] },
  instructions: "---\nname: pdf\n---\nDo the pdf thing.", directory: "/skills/pdf" };

/** What differs from one thread or message of the same bot to the next. */
const VARIES: Array<[string, Partial<DirectTurnShapeInput>]> = [
  ["computer availability", { computerKind: null, computerUnavailable: true }],
  ["authorized connected apps", { connectors: " OTHER APPS" }],
  ["required apps", { requiredApps: " OTHER REQUIRED APPS" }],
  ["credentials guidance", { credential: " OTHER GUIDANCE" }],
  ["web search support", { webRead: false, webSearchBackup: false }],
  ["routine support", { routines: " OTHER ROUTINES" }],
  ["learning support", { learn: " OTHER LEARN" }],
  ["skills index", { importedSkills: " OTHER SKILLS" }],
  ["the capabilities primer (folder trust, automation, browser lock)", { primer: "\n\nPRIMER with a different folder trust and a browser lock" }],
  ["a browser opened in this thread", { browser: "\nBROWSER thread-a" }],
  ["who is busy in this thread's section", { coordination: "Bots you can ask from this conversation:\nSable: busy" }],
  ["a teammate's task as the message", { peerTask: " This message is a task from your teammate @Sable." }],
  ["this turn's image outcome", { image: " IMAGES delivered" }],
  ["this message's skills", { skills: skillLayers([skill], { includeRoot: false }) }],
  ["playbooks", { playbooks: "\n\nPLAYBOOK" }],
  ["output folder", { outputFolder: "\n\nOUTPUT" }],
  ["an automation source", { automationSource: "schedule" }],
  ["a tag", { tagged: [{ name: "Sable", id: "b1" }] }],
];

function commonPrefix(a: string, b: string): number { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

describe("the direct turn's system prompt keeps the bot's cached prefix across threads and messages", () => {
  const stable = joinShapeLayers(directTurnLayers(base).filter(layer => STABLE_IDS.includes(layer.id)));
  it("retains the agreed within-suffix order at the direct dispatcher input", () => {
    const layers = directTurnLayers(base);
    expect(layers.map(layer => layer.id)).toEqual([
      ...STABLE_IDS, "computer", "computer-protected-input", "connected-apps", "required-apps",
      "browser", "coordination", "peer-task", "credential", "images", "web-search", "routines",
      "learn", "skills-index", "capabilities", "playbooks", "output-folder", "automation", "tagged",
    ]);
  });
  for (const [name, change] of VARIES) {
    it(`${name} leaves the whole stable prefix byte for byte`, () => {
      const first = joinShapeLayers(directTurnLayers(base));
      const second = joinShapeLayers(directTurnLayers({ ...base, ...change }));
      expect(second).not.toBe(first);
      expect(commonPrefix(first, second)).toBeGreaterThanOrEqual(stable.length);
      expect(second.startsWith(stable)).toBe(true);
    });
  }
  it("two threads of one bot that differ in every per-thread input still share the full stable prefix", () => {
    const a = joinShapeLayers(directTurnLayers({ ...base, browser: "\nB-A", coordination: "A busy", image: " IA", playbooks: "\n\nPA", tagged: [{ name: "A", id: "a" }] }));
    const b = joinShapeLayers(directTurnLayers({ ...base, browser: "\nB-B", coordination: "B free", peerTask: " from @x", image: " IB", outputFolder: "\n\nOB", automationSource: "schedule" }));
    expect(commonPrefix(a, b)).toBeGreaterThanOrEqual(stable.length);
  });
});

describe("the real capabilities primer: folder trust and automation change it, never the stable prefix", () => {
  const instance = { driverKind: "claudeAgent", models: { default: "m", options: [] }, adapter: { capabilities: { images: true, imagesInline: true, customMcp: true, runsOnOwnTools: true } } };
  const primerFor = (extra: Record<string, unknown>) => capabilitiesPrimer(turnCapabilityFacts({ instance, integrations: {}, peers: 0, memory: "off", imageProvider: false, canAskOwner: true, cwd: "/work", ...extra } as never));
  it("a trusted and a rejected folder give different primers that share one stable prefix", () => {
    const trusted = primerFor({ folderTrust: { decision: "trust" } });
    const rejected = primerFor({ folderTrust: { decision: "reject" } });
    expect(trusted).not.toBe(rejected);
    const a = joinShapeLayers(directTurnLayers({ ...base, primer: trusted }));
    const b = joinShapeLayers(directTurnLayers({ ...base, primer: rejected }));
    expect(a).not.toBe(b);
    expect(a.startsWith(stableOf(base))).toBe(true);
    expect(b.startsWith(stableOf(base))).toBe(true);
  });
});
function stableOf(input: DirectTurnShapeInput): string { return joinShapeLayers(directTurnLayers(input).filter(layer => STABLE_IDS.includes(layer.id))); }
