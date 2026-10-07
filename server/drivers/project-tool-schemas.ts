// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Lane M's project tool schemas (SPEC-P 11.3), in a module with no side
// effects: agents-proxy.ts lists them on project turns, and tests read them
// without loading the proxy, whose stdin JSON-RPC loop starts on import
// (lane cards review 2 N6).
import { murageToolOnThisServer } from "../murage-tool-surface.ts";

/** Lane M's project tools (SPEC-P 11.3), listed on project turns only. */
export const PROJECT_TOOLS = [
  {
    name: "project_assign",
    description: "Lead only: assign one to twelve cards to project members. Each card has a key (unique in this plan), an assignee (a member's bot id or exact name), a title and a description.",
    inputSchema: {type: "object", additionalProperties: false, required: ["cards"], properties: {
      cards: {type: "array", minItems: 1, maxItems: 12, items: {type: "object", additionalProperties: false, required: ["key", "assignee", "title"], properties: {key: {type: "string", maxLength: 40}, assignee: {type: "string", maxLength: 200, description: "A member's bot id or exact name."}, title: {type: "string", maxLength: 120}, description: {type: "string", maxLength: 2000}, writes: {type: "boolean"}, workRoot: {type: "integer", minimum: 0}, needs: {type: "array", maxItems: 8, items: {type: "string", maxLength: 100}}, touches: {type: "array", maxItems: 10, items: {type: "string", maxLength: 512}}, dependsOn: {type: "array", maxItems: 10, items: {type: "string", maxLength: 200}}}}},
    } },
  },
  {
    name: "project_accept",
    description: "Lead only: accept a reviewed card after its current review passes.",
    inputSchema: {type: "object", additionalProperties: false, required: ["card_id"], properties: {
      card_id: {type: "string", maxLength: 200},
    } },
  },
  {
    name: "project_card_manage",
    description: "Lead only: cancel, reassign, retry or send back a card.",
    inputSchema: {type: "object", additionalProperties: false, required: ["card_id", "action"], properties: {
      card_id: {type: "string", maxLength: 200},
      action: {type: "string", enum: ["cancel", "reassign", "retry", "send_back"]},
      assignee_bot_id: {type: "string", maxLength: 200, description: "For reassign: a member's bot id or exact name."},
      note: {type: "string", maxLength: 500},
      writes: {type: "boolean"},
      work_root: {type: "integer", minimum: 0},
    } },
  },
  {
    name: "project_review_assign",
    description: "Lead only: ask another project member to review a card.",
    inputSchema: {type: "object", additionalProperties: false, required: ["card_id", "reviewer_bot_id"], properties: {
      card_id: {type: "string", maxLength: 200},
      reviewer_bot_id: {type: "string", maxLength: 200, description: "A member's bot id or exact name, not the card's assignee."},
    } },
  },
  {
    name: "project_criteria",
    description: "Lead only: propose criteria or mark criteria met with evidence. Supply propose or met.",
    inputSchema: {type: "object", additionalProperties: false, properties: {
      propose: {type: "array", items: {type: "string", maxLength: 300}},
      met: {type: "array", items: {type: "object", required: ["id", "evidence"], properties: {id: {type: "string", maxLength: 200}, evidence: {type: "object", required: ["kind", "ref"], properties: {kind: {type: "string", enum: ["message", "file", "check"]}, ref: {type: "string", maxLength: 2000}}}}}},
    } },
  },
  {
    name: "project_done",
    description: "Lead only: ask the owner to sign off the finished goal.",
    inputSchema: {type: "object", additionalProperties: false, properties: {
      detail: {type: "string", maxLength: 500},
    } },
  },
  {
    name: "project_blocked",
    description: "Lead only: pause the goal and explain what is needed.",
    inputSchema: {type: "object", additionalProperties: false, required: ["detail"], properties: {
      detail: {type: "string", maxLength: 500},
    } },
  },
  {
    name: "project_brief_update",
    description: "Lead only: append a decision or a note to the project brief with its source messages.",
    inputSchema: {type: "object", additionalProperties: false, required: ["source_message_ids"], properties: {
      decision: {type: "string", maxLength: 500},
      note: {type: "object", required: ["text"], properties: {text: {type: "string", maxLength: 500}, path: {type: "string", maxLength: 512}}},
      source_message_ids: {type: "array", minItems: 1, maxItems: 20, items: {type: "string", maxLength: 200}},
    } },
  },
  {
    name: "project_card_update",
    description: "Report a milestone or explain what blocks your current card.",
    inputSchema: {type: "object", additionalProperties: false, required: ["card_id"], properties: {
      card_id: {type: "string", maxLength: 200},
      milestone: {type: "string", maxLength: 280},
      blocked: {type: "string", maxLength: 200},
    } },
  },
  {
    name: "project_review_result",
    description: "Give the verdict for the card you are reviewing.",
    inputSchema: {type: "object", additionalProperties: false, required: ["card_id", "verdict"], properties: {
      card_id: {type: "string", maxLength: 200},
      verdict: {type: "string", enum: ["pass", "changes"]},
      notes: {type: "string", maxLength: 500},
    } },
  },

  {
    name: "project_read_messages",
    description: "Read earlier messages of this project: its chat (the default) or one of its members' work threads. Pages back from the newest; pass `before` (the oldest id you got) for the page before. Each message says who spoke, who it was for and what it answered. A reply withheld from bots reads as its withheld line.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, properties: {
      thread_id: { type: "string", maxLength: 200, description: "A thread of this project. Omit for the project's chat." },
      before: { type: "string", maxLength: 200, description: "A message id: return the messages before it." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many messages. Defaults to 20." },
    } },
  },
  {
    name: "project_bring_in",
    description: "Bring something you already know from your own chats with the owner into this project's memory, so the team can use it: a note from your memory (record_id) or a message from one of your own chats (source_message_id, with thread_id when it is not your main chat). Optional text must be an exact excerpt of it. Material from a conversation with anyone but the owner is refused.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      record_id: { type: "string", maxLength: 200 },
      source_message_id: { type: "string", maxLength: 200 },
      thread_id: { type: "string", maxLength: 200 },
      text: { type: "string", maxLength: 1000 },
    } },
  },
  {
    name: "project_suggest",
    description: "Suggest to the project's lead who should take a piece of work, and why. It is a line for the lead's next turn, not an assignment.",
    inputSchema: { type: "object", additionalProperties: false, required: ["bot_id", "why"], properties: {
      bot_id: { type: "string", maxLength: 200, description: "The member you suggest." },
      card_id: { type: "string", maxLength: 200, description: "The card, if the suggestion is about one." },
      why: { type: "string", minLength: 1, maxLength: 200 },
    } },
  },
  {
    name: "project_summary_update",
    description: "Lead only: write the next version of the project's rolling summary (where the project stands, decisions, what is next), with the ids of the messages it rests on. Members read it on their turns.",
    inputSchema: { type: "object", additionalProperties: false, required: ["text", "source_message_ids"], properties: {
      text: { type: "string", minLength: 1, maxLength: 6000 },
      source_message_ids: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", maxLength: 200 }, description: `The ids of the project messages the summary rests on (${murageToolOnThisServer("project_read_messages")} gives them).` },
    } },
  },
];
