import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import { spokenApprovalPrompt, spokenToolAction, type Pending } from "./PendingApproval";
import type { Message } from "@/state/store";
import { skillRequestBehavior } from "../../shared/skill-request";

const routineRequest = {
  version: 1 as const,
  requestId: "routine-request",
  botId: "bot-1",
  threadId: "thread-1",
  createdAt: 1,
};

describe("ApprovalCard hold explanation", () => {
  it.each([undefined, "allow", "deny"] as const)("only presents a current hold for unanswered cards (%s)", answered => {
    const held = "This task started outside the desktop. Your approval is required before this action can continue.";
    const message: Message = { id: "held-card", role: "bot", kind: "options", at: 1,
      card: { title: "Approval", subtitle: "Synthetic web search", options: ["Allow", "Deny"], tool: "WebSearch", held, answered } };
    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    if (answered) {
      expect(markup).not.toContain(held);
      expect(markup).toContain(answered === "allow" ? "Allowed" : "Denied");
    } else expect(markup).toContain(held);
    expect(message.card!.held).toBe(held);
    expect(message.card!.answered).toBe(answered);
  });
});

describe("ApprovalCard settled state", () => {
  it("shows an image approval nobody answered as not answered, never as a denial", () => {
    const message: Message = { id: "image-card", role: "bot", kind: "options", at: 1,
      card: { title: "Approve image generation", subtitle: "One image · flux · flux-image-1 · high · 1024x1024", options: ["Allow", "Deny"],
        tool: "generate_image", requestId: "image-1", answered: "unavailable", dismissed: true } };
    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Not answered");
    expect(markup).not.toContain("Denied");
    expect(markup).toContain("generate image");
  });
});

const createRoutineOperation = {
  action: "create" as const,
  routine: {
    name: "Backlog review",
    instructions: "Review every item in the backlog.",
    schedule: { type: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    runOn: "ember" as const,
    durationMinutes: 30,
  },
};

describe("ApprovalCard routine proposals", () => {
  it("describes a chat-created routine as scheduling rather than a raw tool call", () => {
    const message: Message = {
      id: "routine-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Confirm routine",
        subtitle: "Weekdays at 09:00",
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: { ...routineRequest, operation: createRoutineOperation },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Wants to schedule a routine");
    expect(markup).toContain("Weekdays at 09:00");
  });

  it("records the exact routine action after confirmation", () => {
    const message: Message = {
      id: "routine-delete-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Delete “Daily inbox”?",
        subtitle: "Delete “Daily inbox”?\nWhen: Weekdays at 09:00",
        options: ["Confirm", "Cancel"],
        answered: "allow",
        requestId: "routine-request",
        tool: "manage_routine",
        routineRequest: {
          ...routineRequest,
          operation: { action: "delete", routineId: "routine-1", expectedUpdatedAt: 1 },
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Delete “Daily inbox”?");
    expect(markup).toContain("Routine deleted");
  });

  it("does not imply a run-now request has already started", () => {
    const message: Message = {
      id: "routine-run-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Run now “Daily inbox”?",
        subtitle: "Action: Run routine now\nName: Daily inbox",
        options: ["Confirm", "Cancel"],
        answered: "allow",
        requestId: "routine-request",
        tool: "manage_routine",
        routineRequest: {
          ...routineRequest,
          operation: { action: "run_now", routineId: "routine-1", expectedUpdatedAt: 1 },
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("Routine run queued");
    expect(markup).not.toContain("Routine started");
  });

  it("speaks a routine's concise title instead of narrating all instructions", () => {
    const instructions = "Review every item in the backlog. ".repeat(500);
    const message: Message = {
      id: "routine-voice-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Schedule routine “Backlog review”?",
        subtitle: `Action: Create routine\n\nInstructions:\n${instructions}`,
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: { ...routineRequest, operation: createRoutineOperation },
      },
    };
    const pending: Pending = {
      message,
      requestId: "routine-request",
      tool: "schedule_routine",
      detail: message.card!.subtitle,
    };

    const spoken = spokenApprovalPrompt(pending, "Mochi");
    expect(spoken).toContain("Schedule routine “Backlog review”?");
    expect(spoken).toContain("Review the schedule and instructions on screen");
    expect(spoken).not.toContain("Review every item in the backlog");
    expect(spoken.length).toBeLessThan(200);
  });
});

describe("ApprovalCard learned skills", () => {
  it("maps create and update choices to approval while keeping refusals denied", () => {
    expect(skillRequestBehavior("Enable")).toBe("allow");
    expect(skillRequestBehavior("Update")).toBe("allow");
    expect(skillRequestBehavior("Apply")).toBe("allow");
    expect(skillRequestBehavior("Deny")).toBe("deny");
    expect(skillRequestBehavior("Dismiss")).toBe("deny");
    expect(skillRequestBehavior("unexpected")).toBe("deny");
  });

  it("describes a staged skill as enablement rather than a raw tool call", () => {
    const message: Message = {
      id: "skill-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: 'Enable skill "file-expense"?',
        subtitle: "Files an expense in the company portal.",
        options: ["Enable", "Deny"],
        requestId: "skill-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "skill-request",
          botId: "bot-1",
          threadId: "thread-1",
          stagedId: "staged-1",
          action: "create",
          name: "file-expense",
          gist: "Files an expense in the company portal.",
          source: "learn:conversation",
          preview: "---\nname: file-expense\ndescription: Files an expense.\n---\n\n# File expense\n",
          sha256: "abcdef0123456789".repeat(4),
          warnings: [],
          createdAt: 1,
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("enable a learned skill");
    expect(markup).toContain("Files an expense in the company portal.");
    expect(markup).toContain("Review the complete SKILL.md before enabling");
    expect(markup).toContain("Source: learn:conversation");
    expect(markup).toContain("name: file-expense");
    expect(markup).toContain("sha256 abcdef01");

    const spoken = spokenApprovalPrompt(
      { message, requestId: "skill-request", tool: "stage_skill", detail: message.card!.subtitle },
      "Mochi",
    );
    expect(spoken).toContain('Enable skill "file-expense"?');
    expect(spoken).toContain("Should I enable it?");
  });

  it("labels a reviewed skill replacement as an update", () => {
    const message: Message = {
      id: "skill-update",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: 'Update skill "verify-app"?',
        subtitle: "Refreshes the verified workflows.",
        options: ["Update", "Deny"],
        requestId: "skill-update-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "skill-update-request",
          botId: "bot-1",
          threadId: "thread-1",
          stagedId: "staged-update",
          action: "update",
          name: "verify-app",
          gist: "Refreshes the verified workflows.",
          source: "learn:maintenance",
          preview: "---\nname: verify-app\ndescription: Verifies the app.\n---\n",
          sha256: "abcdef0123456789".repeat(4),
          warnings: [],
          createdAt: 1,
        },
      },
    };

    expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain("update a learned skill");
    expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain("replacing the current version");
    const spoken = spokenApprovalPrompt(
      { message, requestId: "skill-update-request", tool: "stage_skill", detail: message.card!.subtitle },
      "Mochi",
    );
    expect(spoken).toContain("Should I update it?");

    message.card!.answered = "allow";
    expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain("Skill updated");
  });

  it("keeps an old persisted skill card readable but deny-only", () => {
    const message: Message = {
      id: "legacy-skill-card",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Enable old skill?",
        subtitle: "This card predates reviewed hashes.",
        options: ["Enable", "Dismiss"],
        requestId: "legacy-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "legacy-request",
          botId: "bot-1",
          threadId: "thread-1",
          stagedId: "staged-1",
          action: "create",
          name: "old-skill",
          gist: "Old skill",
          warnings: [],
          createdAt: 1,
        },
      },
    };

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));
    expect(markup).toContain("created by an older build");
    expect(markup).toContain("cannot be safely applied");
    expect(markup).toContain("create the skill again");

    message.card!.skillRequest!.action = "update";
    expect(renderToStaticMarkup(createElement(ApprovalCard, { message })))
      .toContain("propose the update again");
  });
});

describe("the one-time 'use this computer' card", () => {
  const consent = (answered?: string): Message => ({ id: "consent-card", role: "bot", kind: "options", at: 1,
    card: { title: "Let @Screen use this computer?",
      subtitle: "@Screen is set to Auto, which on this Mac means your own screen, mouse and keyboard. Allow and Murage remembers it for this bot.",
      options: ["Allow", "Deny"], requestId: "consent-1", tool: "local_computer_consent", approvalScope: "local-computer",
      held: "Asked once for each bot on Auto.", answered } });
  const bot = { name: "Screen" } as Parameters<typeof ApprovalCard>[0]["bot"];

  it("reads as a sentence with a plain explanation, not a tool name and a code box", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalCard, { bot, message: consent() }));
    expect(markup).toContain("@Screen wants to use this computer");
    expect(markup).not.toContain("local computer consent");
    expect(markup).not.toContain("local_computer_consent");
    expect(markup).not.toContain("<pre");
    expect(markup).toContain("your own screen, mouse and keyboard");
  });

  it("settles as Allowed or Not allowed", () => {
    expect(renderToStaticMarkup(createElement(ApprovalCard, { bot, message: consent("allow") }))).toContain("Allowed");
    const denied = renderToStaticMarkup(createElement(ApprovalCard, { bot, message: consent("deny") }));
    expect(denied).toContain("Not allowed");
    expect(denied).not.toContain("Denied");
  });
});

// An ACP engine (Fuigo, the engine the included Chief of Staff runs on) does
// not send a tool NAME in `session/request_permission` — it sends the
// permission KIND ("other", "edit", "execute"…), and the driver forwards that
// kind as the card's tool (server/drivers/acp/core.ts). The card used to read
// the kind out loud as the verb: "Business Planner wants to other".
describe("ApprovalCard ACP permission kinds", () => {
  const card = (tool: string, subtitle = "agents__list_bots"): Message => ({
    id: `acp-${tool}`, role: "bot", kind: "options", at: 1,
    card: { title: "Approval", subtitle, options: ["Allow", "Deny"], tool, requestId: `acp-${tool}` },
  });
  const bot = { name: "Business Planner" } as Parameters<typeof ApprovalCard>[0]["bot"];
  const render = (tool: string) => renderToStaticMarkup(createElement(ApprovalCard, { bot, message: card(tool) }));

  it.each([
    ["other", "Business Planner wants to use a tool"],
    ["edit", "Business Planner wants to edit a file"],
    ["read", "Business Planner wants to read a file"],
    ["delete", "Business Planner wants to delete a file"],
    ["move", "Business Planner wants to move a file"],
    ["search", "Business Planner wants to search"],
    ["fetch", "Business Planner wants to fetch a web page"],
    ["execute", "Business Planner wants to run a command"],
    ["shell", "Business Planner wants to run a command"],
    ["think", "Business Planner wants to think it through"],
    ["switch_mode", "Business Planner wants to change its mode"],
  ])("says what %s means in English", (kind, sentence) => {
    expect(render(kind)).toContain(sentence);
  });

  it("never reads a bare permission kind out loud as the verb", () => {
    for (const kind of ["other", "edit", "execute", "switch_mode"]) {
      expect(render(kind)).not.toContain(`wants to ${kind}</div>`);
      // …and the kind is not a tool name, so it does not go in the badge either
      expect(render(kind)).not.toContain(`text-ink-secondary">${kind}<`);
    }
  });

  it("still names a real tool, and still shows what was asked", () => {
    expect(render("other")).toContain("agents__list_bots");
    const real = renderToStaticMarkup(createElement(ApprovalCard, { bot, message: card("Bash", "git status") }));
    expect(real).toContain("Business Planner wants to run a command");
    expect(real).toContain(">Bash<");
  });
});

describe("tool approvals, spoken on a call", () => {
  it.each([
    ["other", "Agents_web_search", "search the web"],
    ["search_tool", "", "search the web"],
    ["WebSearch", "latest AI news", "search the web"],
    ["fetch", "https://www.reuters.com/technology/ai", "open a page on reuters.com"],
    ["web_fetch", "", "open a web page"],
    ["Bash", "ls -la ~/Documents", "run a command on your computer"],
    ["Edit", "src/components/CallView.tsx", "change CallView.tsx"],
    ["Read", "notes/board.md", "read board.md"],
    ["mcp__gmail__send_email", "", "use send email"],
    ["other", "{\"weird\": true}", "use a tool"],
    ["Local computer approval", "composio__COMPOSIO_MULTI_EXECUTE_TOOL", "use your connected apps"],
    ["Local computer approval", "composio__COMPOSIO_SEARCH_TOOLS", "look up which app tools to use"],
    ["Local computer approval", 'python3 -c "\nimport json\np=1"', "run a small script on your computer"],
    ["other", "agents__send_voice_note", "send you a voice note"],
  ])("%s / %s → %s", (tool, detail, action) => {
    expect(spokenToolAction(tool, detail)).toBe(action);
  });

  it("asks in the bot's own voice on a one-to-one call, and names the bot in a group", () => {
    const message = { id: "a1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "r1" } } as unknown as Message;
    const pending: Pending = { message, requestId: "r1", tool: "other", detail: "Agents_web_search" };
    expect(spokenApprovalPrompt(pending, "Ember", true)).toBe("Can I search the web? Yes or no.");
    expect(spokenApprovalPrompt(pending, "Ember")).toBe("Ember would like to search the web. Yes or no?");
  });
});
