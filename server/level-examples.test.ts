// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 6 (gate tier): every cell of the level menu's
// example table (shared/level-examples.ts) evaluated through the code that
// decides it, with a real fixture call per row and per turn kind: the owner
// at the desktop, a routine run with its ceiling below, at and above the
// level, the owner's channel message with the option off and on, and a
// webhook. Every call is for a turn with no saved grant and no task allowance.
import { describe, expect, it } from "vitest";
import { LEVEL_EXAMPLES, LEVEL_IDS, OTHER_ROWS, OWNER_ROWS, type LevelCell, type LevelId, type OwnerRowId } from "../shared/level-examples.ts";
import { autoVerdict, fullAccessCovers, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { applyRoutinePermissionMode, effectiveRoutinePermissionMode, ROUTINE_PERMISSION_MODES, type RoutinePermissionMode } from "./routine-permissions.ts";
import { classifyStopLine, isStopLineKey, stopLineKey, type StopLinePlace } from "./stop-line.ts";
import { durableGrantAllowed } from "../shared/durable-grant-allowed.ts";

const HOME = "/home/owner", WORK = `${HOME}/.murage/bots/nova/workspace`;
const place: StopLinePlace = {
  cwd: WORK, roots: [WORK], home: HOME,
  knownRecipients: new Set(["known@example.com"]),
  realpath: path => path,
};

interface Call { tool: string; input: Record<string, unknown>; summary: string; context?: AutoContext }
const bash = (command: string): Call => ({ tool: "Bash", input: { command }, summary: command, context: { commandText: command, commandCwd: WORK } });
const mail = (name: string, to: string): Call => ({ tool: `mcp__gmail__${name}`, input: { to, subject: "Hello", body: "Hi" }, summary: `${name} to ${to}` });

/** A fixture per row, more than one where the row names more than one thing. */
const OWNER_CALLS: Record<OwnerRowId, Call[]> = {
  "read-given": [{ tool: "Read", input: { file_path: `${HOME}/Documents/brief.md` }, summary: "Read brief.md" }],
  "write-own-folder": [{ tool: "Write", input: { file_path: `${WORK}/notes.md`, content: "n" }, summary: "Write notes.md", context: { ownWorkspace: true } }],
  "draft-reply": [mail("create_draft", "known@example.com")],
  "ordinary-command": [bash("ls -la")],
  "destructive-inside-or-input": [bash("rm -rf ./build"), bash("ssh deploy@example.com uptime")],
  "message-known": [mail("send_email", "known@example.com")],
  "someone-new-or-public": [mail("send_email", "new@example.com"), bash('gh issue create --repo acme/site --title "x" --body "y"')],
  "delete-outside": [bash("rm -rf ~/Documents/old")],
  pay: [{ tool: "mcp__stripe__create_charge", input: { amount: 500, currency: "usd", customer: "cus_1" }, summary: "Charge $5" }],
  "contact-bot": [],
  "read-keys": [bash("cat ~/.aws/credentials")],
  "wipe-command": [bash("rm -rf ~")],
};

const MODE: Record<LevelId, RoutinePermissionMode> = { ask: "ask", auto: "auto", full: "full", unlimited: "unlimited" };
const atLevel = (level: LevelId, extra: AutoApprover = {}): AutoApprover => applyRoutinePermissionMode({ ...extra }, MODE[level]);
const judge = (bot: AutoApprover, call: Call, turn: AutoContext): LevelCell => {
  const stopLine = classifyStopLine(call.tool, call.input, call.summary, place);
  return autoVerdict(bot, call.tool, call.summary, { ...call.context, ...turn, stopLine }).approve ? "goes-ahead" : "asks";
};
const OWNER_TURN: AutoContext = { fullAccessOrigin: "owner" };
const WEBHOOK_TURN: AutoContext = { fullAccessOrigin: "other", unattended: true, automated: true };
const CHANNEL_TURN: AutoContext = { unattended: true, automated: true, channelOwner: true };
const ROUTINE_TURN: AutoContext = { routineLevel: true, automated: true };
const ordinary = bash("ls -la");
const stopCalls = [...OWNER_CALLS["someone-new-or-public"], ...OWNER_CALLS["delete-outside"], ...OWNER_CALLS.pay];

describe("owner desktop turn", () => {
  it("covers all twelve rows and all four levels", () => {
    expect(LEVEL_EXAMPLES.levels).toEqual(LEVEL_IDS);
    expect(OWNER_ROWS.map(row => row.id).sort()).toEqual(Object.keys(OWNER_CALLS).sort());
  });
  for (const row of OWNER_ROWS.filter(row => row.id !== "contact-bot")) for (const level of LEVEL_IDS) {
    it(`${row.id} at ${level}: ${row.cells[level]}`, () => {
      expect(OWNER_CALLS[row.id].length).toBeGreaterThan(0);
      for (const call of OWNER_CALLS[row.id]) expect(judge(atLevel(level), call, OWNER_TURN), call.summary).toBe(row.cells[level]);
    });
  }
  // the peer-contact gate: handoff-boundary.ts peerCardWaived, handoff-dispatch.ts
  const contact = OWNER_ROWS.find(row => row.id === "contact-bot")!;
  for (const level of LEVEL_IDS) it(`contact-bot at ${level}: ${contact.cells[level]}`, () => {
    expect(contact.when).toBe("peer-contact-ask-first");
    const waived = fullAccessCovers(atLevel(level), "owner");
    expect(waived ? "goes-ahead" : "asks").toBe(contact.cells[level]);
  });
});

describe("a routine run", () => {
  const routine = OTHER_ROWS.find(row => row.id === "routine")!;
  for (const level of LEVEL_IDS) for (const ceiling of ROUTINE_PERMISSION_MODES) {
    it(`ceiling ${ceiling} at ${level}: runs at the lower of the two`, () => {
      expect(routine.ordinary[level]).toBe("lower-of-ceiling");
      const bot = atLevel(level), mode = effectiveRoutinePermissionMode({ permissionMode: ceiling }, bot);
      expect(ROUTINE_PERMISSION_MODES.indexOf(mode)).toBe(Math.min(ROUTINE_PERMISSION_MODES.indexOf(ceiling), LEVEL_IDS.indexOf(level)));
      expect(judge(applyRoutinePermissionMode(bot, mode), ordinary, ROUTINE_TURN)).toBe(mode === "ask" ? "asks" : "goes-ahead");
    });
    it(`ceiling ${ceiling} at ${level}: the stop line asks unless allowed for the routine, never for a payment`, () => {
      expect(routine.stopLine[level]).toBe("asks-unless-routine-grant");
      const bot = atLevel(level), judged = applyRoutinePermissionMode(bot, effectiveRoutinePermissionMode({ permissionMode: ceiling }, bot));
      for (const call of stopCalls) {
        expect(judge(judged, call, ROUTINE_TURN), call.summary).toBe("asks");
        const hit = classifyStopLine(call.tool, call.input, call.summary, place)!, key = stopLineKey(hit);
        if (hit.kind === "pay") { expect(key === undefined || !durableGrantAllowed(key), key).toBe(true); continue; }
        expect(key && isStopLineKey(key)).toBeTruthy();
        expect(judge(judged, call, { ...ROUTINE_TURN, routineAllow: [key!] }), call.summary).toBe("goes-ahead");
      }
    });
  }
});

describe("the owner's message from a channel", () => {
  const channel = OTHER_ROWS.find(row => row.id === "owner-channel")!;
  for (const level of LEVEL_IDS) for (const option of [false, true]) it(`${level}, option ${option ? "on" : "off"}`, () => {
    const bot = atLevel(level, { fullAccessChannelMessages: option });
    const cell = (value: string): LevelCell => value === "goes-ahead-with-option" && option ? "goes-ahead" : "asks";
    expect(judge(bot, ordinary, CHANNEL_TURN)).toBe(cell(channel.ordinary[level]));
    for (const call of stopCalls) expect(judge(bot, call, CHANNEL_TURN), call.summary).toBe(cell(channel.stopLine[level]));
  });
});

describe("anyone else's channel message, or a webhook", () => {
  const other = OTHER_ROWS.find(row => row.id === "other-channel-or-webhook")!;
  for (const level of LEVEL_IDS) it(`${level}`, () => {
    expect([other.ordinary[level], other.stopLine[level]]).toEqual(["asks", "asks"]);
    const bot = atLevel(level, { fullAccessChannelMessages: true });
    expect(judge(bot, ordinary, WEBHOOK_TURN)).toBe("asks");
    for (const call of stopCalls) expect(judge(bot, call, WEBHOOK_TURN), call.summary).toBe("asks");
    // the row's note: its own folder still goes
    expect(judge(bot, OWNER_CALLS["write-own-folder"][0]!, WEBHOOK_TURN)).toBe("goes-ahead");
  });
});
