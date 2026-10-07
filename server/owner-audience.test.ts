// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contract 4.1: one owner-audience predicate, and every owner-only prompt
// surface registered with it. Each registered surface is run in the owner's
// thread, in a linked channel person's thread, in a peer turn a channel
// person's thread started (the task humanTask binds to that person), and in
// an owner thread whose chain a channel person started.
import { sharedLoadPrompt } from "./shared-bots-roster.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";
import { saveAboutMe } from "./about-me.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { bindHumanThread, humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, threadHumanPrincipal } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { audienceFingerprint, OWNER_AUDIENCE_SURFACES, ownerOnly, turnAudienceIsOwner, type OwnerAudienceSurface } from "./owner-audience.ts";
import { continuationResultsPrompt, projectCardPrompt } from "./project-prompt.ts";
import { writeSectionContext } from "./section-context.ts";
import { standingContextParts } from "./standing-context.ts";
import { Store } from "./store.ts";
import { ensureWorkspace } from "./workspace.ts";
import { appendMessage } from "./message-db.ts";
import { workingContextPrompt } from "./working-context.ts";
import { joiningBriefLayer, projectBoardLayer, projectBriefLayer, projectSummaryLayer } from "./project-layers.ts";
import { projectRosterLine } from "./project-roster.ts";
import { insertProjectBriefVersion } from "./project-records.ts";
import { channelToProjectRows } from "./project-settings.ts";

const ROOT = join(import.meta.dirname, "..");

beforeEach(() => {
  closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

function contact(store: Store, botId: string, userId: string) {
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture-connection", authorityId: "TEAM", userId });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const task = store.createTask(botId, "Channel conversation", false)!;
  bindHumanThread(task.threadId, resolveHumanBinding(bindingId));
  return task.threadId;
}

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ section: "Ops" });
  const peer = store.createBot({ section: "Ops" });
  const contactThread = contact(store, bot.id, "U-CONTACT");
  // A peer turn a channel person's thread asks for runs in a task bound to
  // that same person (index.ts ask-bot / delegate-bot).
  const peerThread = humanTask(store, peer.id, threadHumanPrincipal(contactThread))!.threadId;
  return { store, bot, peer, contactThread, peerThread };
}

/** A project with a brief, a card and a summary, for the project surfaces. */
function surfaceProject(botId: string) {
  const db = database();
  if (!db.prepare("SELECT 1 FROM project_settings WHERE group_id='surface-project'").get()) {
    channelToProjectRows(db, { groupId: "surface-project", bulletin: "PROJECT_RULES_CANARY", leadBotId: null, now: 1 });
    insertProjectBriefVersion(db, { groupId: "surface-project", summary: "", doneMeans: "DONE_CANARY", rules: "PROJECT_RULES_CANARY", whereWorkIs: [], decisions: [], updatedBy: "owner", change: "owner_edit", now: 2 });
    db.prepare("INSERT INTO project_summaries(group_id, version, text, made_by, at) VALUES('surface-project',1,'SUMMARY_CANARY','fallback',1)").run();
  }
  db.prepare(`INSERT OR IGNORE INTO project_work_items(id, group_id, number, title, assignee_bot_id, state, position, created_by, created_at, updated_at)
    VALUES(?, 'surface-project', (SELECT coalesce(max(number),0)+1 FROM project_work_items WHERE group_id='surface-project'), 'CARD_CANARY', ?, 'doing', 1, 'owner', 1, 1)`).run(`card-${botId}`, botId);
  return { groupId: "surface-project", botId, names: new Map<string, string>() };
}

/** What each registered surface puts in a turn, with its content present. */
const SURFACE_TEXT: Record<OwnerAudienceSurface, (bot: { id: string; section?: string }, ownerAudience: boolean) => string> = {
  "about-me": (bot, owner) => standingContextParts(bot, { ownerAudience: owner, fileTools: true }).aboutMe,
  "memory-md": (bot, owner) => standingContextParts(bot, { ownerAudience: owner, fileTools: true }).memory,
  "team-brief": (bot, owner) => standingContextParts(bot, { ownerAudience: owner, fileTools: true }).teamBrief,
  "project-card": (_bot, owner) => projectCardPrompt(owner, { ask: "CARD_CANARY", brief: "BRIEF_CANARY", summary: "SUMMARY_CANARY" }),
  "continuation-results": (_bot, owner) => continuationResultsPrompt(owner, [{ botName: "Dax", state: "done", text: "RESULT_CANARY the price is 12" }]),
  "project-brief": (bot, owner) => projectBriefLayer(database(), surfaceProject(bot.id), owner),
  "project-board": (bot, owner) => projectBoardLayer(database(), surfaceProject(bot.id), owner),
  "project-summary": (bot, owner) => projectSummaryLayer(database(), surfaceProject(bot.id), owner),
  "joining-brief": (bot, owner) => joiningBriefLayer(database(), { ...surfaceProject(bot.id), projectName: "Launch" }, owner),
  "project-roster-apps": (bot, owner) => projectRosterLine({ id: bot.id, name: "Dax", tags: ["app:gmail"], apps: ["gmail"], limits: [], role: "member" }, owner).includes("gmail") ? "apps" : "",
  "shared-load": (_bot, owner) => sharedLoadPrompt(owner, { name: "Iris", home: "Design", team: "Sales", waiting: 2 }),
  "working-context": (bot, owner) => {
    const thread = `wc-${bot.id}`;
    appendMessage(thread, { id: `wc-${bot.id}-${Math.random()}`, role: "bot", kind: "text", text: "WORK_CANARY sent the follow-up", at: 1 });
    return workingContextPrompt(owner, { botId: bot.id, currentThreadId: "none", bots: [{ id: bot.id, threadId: thread }], groups: [], routines: [], now: 2 });
  },
};

describe("the owner-audience predicate", () => {
  it("is the owner in the owner's thread, and not in a channel person's or in a chain one started", () => {
    const { bot, contactThread, peerThread } = world();
    expect(turnAudienceIsOwner(bot.threadId)).toBe(true);
    expect(turnAudienceIsOwner(contactThread)).toBe(false);
    expect(turnAudienceIsOwner(peerThread)).toBe(false);
    expect(turnAudienceIsOwner(bot.threadId, { rootThreadId: contactThread })).toBe(false);
    expect(turnAudienceIsOwner(bot.threadId, { rootThreadId: bot.threadId })).toBe(true);
    // words no owner surface proved it sent (a script, a bot's own shell)
    expect(turnAudienceIsOwner(bot.threadId, { origin: "unproven" })).toBe(false);
    expect(turnAudienceIsOwner(bot.threadId, { origin: "companion" })).toBe(true);
  });

  it("fingerprints the audience: owner, or the people this turn answers to", () => {
    const { store, bot, contactThread, peerThread } = world();
    expect(audienceFingerprint(bot.threadId)).toBe("owner");
    // words nobody proved are the owner's are a different audience (final round, Astra L3)
    expect(audienceFingerprint(bot.threadId, { origin: "unproven" })).not.toBe("owner");
    expect(audienceFingerprint(bot.threadId, { origin: "desktop" })).toBe("owner");
    const person = audienceFingerprint(contactThread);
    expect(person).not.toBe("owner");
    expect(audienceFingerprint(peerThread)).toBe(person);
    // the owner's thread in a chain a person started answers to both
    expect(audienceFingerprint(bot.threadId, { rootThreadId: contactThread }).split(",").sort()).toEqual([person, "workspace-owner:local:1"].sort());
    const other = contact(store, bot.id, "U-OTHER");
    const both = audienceFingerprint(other, { rootThreadId: contactThread });
    expect(both.split(",")).toHaveLength(2);
    expect(both).toBe(audienceFingerprint(contactThread, { rootThreadId: other }));
    // unproven words name the same audience whichever thread started the chain
    expect(audienceFingerprint(other, { rootThreadId: contactThread, origin: "unproven" }))
      .toBe(audienceFingerprint(contactThread, { rootThreadId: other, origin: "unproven" }));
  });
});

describe("every registered owner-only surface", () => {
  it("reaches the owner's own turn and no turn a channel person hears", () => {
    const { bot, peer, contactThread, peerThread } = world();
    saveAboutMe("ABOUT_ME_CANARY I run a candle shop");
    writeSectionContext("Ops", "BRIEF_CANARY ship on Thursdays", 1);
    for (const id of [bot.id, peer.id]) writeFileSync(join(ensureWorkspace(id), "MEMORY.md"), "# Memory\n\n- NOTEBOOK_CANARY the garden project is Fern\n");
    const cases = [
      { name: "the owner's thread", bot, owner: turnAudienceIsOwner(bot.threadId), expected: true },
      { name: "a channel person's thread", bot, owner: turnAudienceIsOwner(contactThread), expected: false },
      { name: "a peer turn a channel person started", bot: peer, owner: turnAudienceIsOwner(peerThread), expected: false },
      { name: "an owner thread in a chain a channel person started", bot: peer, owner: turnAudienceIsOwner(peer.threadId, { rootThreadId: contactThread }), expected: false },
    ];
    for (const surface of Object.keys(OWNER_AUDIENCE_SURFACES) as OwnerAudienceSurface[]) {
      for (const { name, bot: who, owner, expected } of cases) {
        const text = SURFACE_TEXT[surface]({ id: who.id, section: "Ops" }, owner);
        expect(text.length > 0, `${surface} in ${name}`).toBe(expected);
      }
    }
  });

  it("refuses a surface nobody registered", () => {
    expect(() => ownerOnly("not-registered" as OwnerAudienceSurface, true, () => "x")).toThrow(/unregistered/);
    expect(ownerOnly("about-me", false, () => { throw new Error("built for a contact"); })).toBe("");
  });

  // The register and the code agree: a new owner-only surface is added by
  // calling ownerOnly with a new id, and the id must be registered (and so
  // covered by SURFACE_TEXT above); a registered id nobody uses is stale.
  it("the register lists exactly the surfaces the server builds through ownerOnly", () => {
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "node_modules" || name === "testing") continue;
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "owner-audience.ts") continue;
        for (const match of readFileSync(path, "utf8").matchAll(/\bownerOnly\(\s*"([^"]+)"/g)) used.add(match[1]);
      }
    };
    walk(join(ROOT, "server"));
    expect([...used].sort()).toEqual(Object.keys(OWNER_AUDIENCE_SURFACES).sort());
    expect(Object.keys(SURFACE_TEXT).sort()).toEqual(Object.keys(OWNER_AUDIENCE_SURFACES).sort());
  });

  // The builders of owner material are reached only through ownerOnly, or
  // from the owner's own desktop view of what shapes a bot.
  it("owner material is built nowhere else", () => {
    const BUILDERS = /\b(?:aboutMePrompt|memorySystemPrompt|sectionContextSystemPrompt)\(/;
    // (audit round 2, Kimi M5: only botShapesView's own lines in index.ts)
    const indexLines = readFileSync(join(ROOT, "server", "index.ts"), "utf8").split("\n");
    const shapesStart = indexLines.findIndex(line => line.startsWith("function botShapesView("));
    const shapesEnd = indexLines.findIndex((line, index) => index > shapesStart && line === "}");
    expect(shapesStart).toBeGreaterThan(0);
    const ALLOWED: Record<string, (line: number) => boolean> = {
      "server/standing-context.ts": () => true, // each call sits inside ownerOnly (checked below)
      "server/index.ts": line => line > shapesStart && line <= shapesEnd + 1, // botShapesView: the owner's desktop view (desktop class)
    };
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "node_modules" || name === "testing") continue;
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        const file = relative(ROOT, path).split("\\").join("/");
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (!BUILDERS.test(line) || /^\s*(?:export\s+)?function\b/.test(line) || /^\s*(?:\/\/|\*)/.test(line)) return;
          if (ALLOWED[file]?.(index + 1) && (file !== "server/standing-context.ts" || /ownerOnly\(/.test(line))) return;
          found.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    };
    walk(join(ROOT, "server"));
    expect(found).toEqual([]);
  });

  // The chain rule is wired where a turn is asked for or delegated (audit
  // round 2, Kimi M1): each such startTurn names the asking thread, and the
  // owner-only surfaces are decided with it.
  it("every asked or delegated turn carries the thread that started it", () => {
    // Read with the parser, not a pattern: an options object with a nested
    // brace is still checked (Kimi round 3, L1).
    const source = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    const sf = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const chained: string[] = [], missing: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(sf) === "startTurn") {
        const options = node.arguments[2];
        const names = options && ts.isObjectLiteralExpression(options) ? options.properties.map(p => p.name?.getText(sf)) : [];
        if (names.includes("commsDepth")) (names.includes("chainRootThreadId") ? chained : missing).push(String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(missing).toEqual([]);
    expect(chained.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/turnAudienceIsOwner\(threadId,\{origin:opts\?\.origin,rootThreadId:opts\?\.chainRootThreadId\}\)/);
  });

  // Final round (Kimi M2): recall leaves the notebook and brief out by the
  // thread's own audience, so an unproven turn that is not shown them cannot
  // recall them. Passing the turn's audience here would reopen that.
  it("recall exclusions follow the thread's audience, never the turn's", () => {
    const source = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    const calls = [...source.matchAll(/standingContextSourceIds\(bot,\s*(humanIsOwner|turnAudienceIsOwner\(threadId\))\s*,/g)].map(match => match[1].trim());
    // the direct turn's early (resumed) bundle and its dispatch bundle, then the room turn
    expect(calls).toEqual(["humanIsOwner", "humanIsOwner", "turnAudienceIsOwner(threadId)"]);
    expect(source).toMatch(/const humanIsOwner=turnAudienceIsOwner\(threadId\);/);
  });
});
