// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A card that says Murage could not read a command never offers "Delete" /
// "Don't delete". The verb comes from what the readers positively found: a
// delete the stop line placed keeps its delete wording; a text the reader
// gave up on, and a call the stop line could only hold as unread, read
// "Run" / "Don't run" (or "Allow once" for a tool that is no command).
// The card is built by the server's own functions (autoVerdict, the stop
// line, approvalCardGrants, cardWhy), crosses to the client through the
// transcript's display sanitizer as every card does, and is worded by the
// client's (cardVerb, verbWord, dontWord, whyLine): nothing here is a
// stand-in for either side.
import { describe, expect, it } from "vitest";

import { approvalCardGrants } from "../../../server/approval-card-grants.ts";
import { cardWhy } from "../../../server/approval-card-why.ts";
import { autoVerdict, type AutoContext } from "../../../server/auto-approve.ts";
import { classifyAsk, classifyStopLine, type StopHit, type StopLinePlace } from "../../../server/stop-line.ts";
import { sanitizeBotDisplayMessage } from "../../../server/transcript-page.ts";
import type { GrantCall } from "../../../shared/app-action-grant.ts";
import { cardVerb, dontWord, verbWord, type FoldCard } from "@/lib/fold-words";
import { whyLine } from "@/lib/pending-approval";
import type { Message } from "@/state/store";

const CWD = "/work/site";
const PLACE: StopLinePlace = { cwd: CWD, roots: [CWD], home: "/home/u", knownRecipients: new Set<string>(), realpath: (path: string) => path };
const FULL = { id: "builder", autoApprove: true, fullAccess: true };
const OWNER: AutoContext = { ownerStarted: true, fullAccessOrigin: "owner", commandCwd: CWD, workFolder: CWD, promptFacts: { home: "/home/u", cwd: CWD } } as AutoContext;

/** The card one command ask opens at Full access, as the server builds it, and the words the client puts on it. */
function commandCard(command: string) {
  const stopHit = classifyStopLine("Bash", { command }, command, PLACE);
  const verdict = autoVerdict(FULL, "Bash", command, { ...OWNER, commandText: command, stopLine: stopHit });
  return { verdict, stopHit, ...worded("Bash", command, stopHit, verdict) };
}

function worded(tool: string, summary: string, stopHit: StopHit | null, verdict: { source: string; rule?: string }) {
  const grants = approvalCardGrants({
    permission: true, questionAsk: false, inputCut: false, stopHit, tool, summary, routineAllowCard: {},
    verdict: verdict as never, hardText: summary,
  });
  const why = cardWhy({ cardClass: grants.cardClass!, stopHit, level: "full", botName: "Builder", ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}) });
  // what the client is sent: the stored row through the display sanitizer (a field it does not list never arrives)
  const sent = sanitizeBotDisplayMessage({ id: "m1", role: "bot", kind: "approval", text: summary, card: { requestId: "r1", tool, summary, ...grants, why } }, { authorship: "bot" });
  const card = sent.card as FoldCard & { why?: unknown };
  const verb = cardVerb(card);
  return { cardClass: card.cardClass!, verb, yes: verbWord(verb), no: dontWord(verb), body: whyLine(card as unknown as Message["card"]) };
}

describe("an unreadable command's card never says delete", () => {
  // a delete outside the bot's folder, then a script run in a shape the reader does not admit: the wipe check gives up
  // ("unreadable") while the stop line placed the delete. This is the reported card: unreadable body, delete buttons.
  const UNREADABLE_WITH_DELETE = [
    "rm -rf ../old-site && node build.js > build.log 2>&1 &",
    "rm -rf /srv/www/checkers; cd /srv/www && node deploy.js > deploy.log 2>&1 &",
  ];
  it.each(UNREADABLE_WITH_DELETE)("could-not-read body, Run / Don't run buttons: %s", (command) => {
    const card = commandCard(command);
    // the two readers disagree exactly as on the reported card
    expect(card.verdict).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    expect(card.stopHit).toMatchObject({ kind: "delete" });
    expect(card.body).toBe("Murage could not read this command, so it asks you before it runs.");
    expect(card.verb).toBe("run");
    expect([card.no, card.yes]).toEqual(["Don't run", "Run"]);
    expect(`${card.body} ${card.no} ${card.yes}`).not.toMatch(/delet|wipe/i);
  });

  // a script the command writes and runs by path, whose first line names an interpreter the reader cannot follow
  // (1.0.20 held these; the hold is the could-not-read card, never a delete card, even when the body deletes)
  const UNFOLLOWED_SCRIPTS = [
    "cat > build <<'EOF'\n#!/usr/bin/make -f\nall:\n\tfind /home/u -mindepth 1 -delete\nEOF\nchmod +x build && ./build",
    "cat > setup <<'EOF'\n#!/usr/bin/env -S bash\nfind /home/u -mindepth 1 -delete\nEOF\nchmod +x setup && ./setup",
    "cat > job <<'EOF'\n#!./tool\nstep one\nEOF\nchmod +x job; ./job > job.log 2>&1 &",
  ];
  it.each(UNFOLLOWED_SCRIPTS)("a written script with an interpreter the reader cannot follow: could-not-read body, Run / Don't run buttons: %s", (command) => {
    const card = commandCard(command);
    expect(card.verdict).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    expect(card.body).toBe("Murage could not read this command, so it asks you before it runs.");
    expect(card.verb).toBe("run");
    expect([card.no, card.yes]).toEqual(["Don't run", "Run"]);
    expect(`${card.body} ${card.no} ${card.yes}`).not.toMatch(/delet|wipe/i);
  });

  it("a delete the stop line positively placed keeps its delete wording", () => {
    const card = commandCard("rm -rf ../old-site");
    expect(card.verdict).toMatchObject({ approve: null, source: "stop-line" });
    expect(card.stopHit).toMatchObject({ kind: "delete" });
    expect(card.verb).toBe("delete");
    expect([card.no, card.yes]).toEqual(["Don't delete", "Delete"]);
    expect(card.body).toBe("Builder asked because this deletes outside its own folder.");
  });

  it("a wipe the reader named keeps the wipe body and, with a placed delete, the delete buttons", () => {
    const card = commandCard("rm -rf /");
    expect(card.verdict).toMatchObject({ approve: null, source: "always-ask", rule: "delete-root" });
    expect(card.body).toBe("This could wipe this computer, so Murage asks every time, at every level.");
    expect(card.verb).toBe("delete");
  });

  it("the class the client receives still says which reader gave up", () => {
    const card = commandCard(UNREADABLE_WITH_DELETE[0]!);
    expect(card.cardClass).toMatchObject({ reason: "always-ask", rule: "unreadable-held", stop: { kind: "delete" } });
  });
});

describe("a call the stop line could only hold as unread is no delete", () => {
  // a stamp with a hidden character: the stop line cannot tell which tool runs, and holds the call
  const unproven: GrantCall = { engine: "acp", toolKind: "execute", toolIdentity: { namespace: "codex ", name: "shell" }, toolCall: { name: "execute", input: { command: "npm run build" } } };

  it("the stand-in hit says it is unread", () => {
    expect(classifyAsk({ ...unproven, tool: "Run build", summary: "Run build" }, PLACE)).toMatchObject({ kind: "delete", unread: true, what: "Murage could not tell which tool this runs, so it is waiting for you." });
  });

  it("its card reads could-not-read with Allow once, never Delete", () => {
    const stopHit = classifyAsk({ ...unproven, tool: "Run build", summary: "Run build" }, PLACE);
    const card = worded("Run build", "Run build", stopHit, { source: "stop-line" });
    expect(card.cardClass.stop).toMatchObject({ kind: "delete", unread: true });
    expect(card.verb).toBe("allow");
    expect([card.no, card.yes]).toEqual(["Don't allow", "Allow once"]);
    expect(card.body).toBe("Murage could not read all of this, so it asks. Allow it once if it is right.");
    expect(`${card.body} ${card.no} ${card.yes}`).not.toMatch(/delet/i);
  });

  it("on a command tool the same hold reads Run / Don't run", () => {
    const stopHit = classifyAsk({ ...unproven, tool: "Bash", summary: "npm run build" }, PLACE);
    const card = worded("Bash", "npm run build", stopHit, { source: "stop-line" });
    expect([card.no, card.yes]).toEqual(["Don't run", "Run"]);
  });

  it("a card stored by an older build (no class, a delete stop key) keeps its delete wording", () => {
    expect(cardVerb({ tool: "Bash", taskAllowKey: "stop:delete:/srv/www/old", allowKey: "stop:delete:/srv/www/old" })).toBe("delete");
  });
});
