// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A to-do list a model wrote INTO its answer as a `<todo>` block, read back
// out as the same plan update an engine sends when it has a structured plan
// (shared/agent-plan.ts, ACP `plan`). Engines that speak plain chat
// completions (local models over vLLM, llama.cpp and the like) have no plan
// channel, so some models write the list as text:
//
//   <todo>
//   - [ ] Explore the folder
//   - [x] Read the notes
//   </todo>
//
// Without this the block rendered as chat text and counted as part of the
// answer (FerroxLabs/murage#7).
//
// The rule that matters most: never lose text the person should see. A block
// is only taken out of the answer when it is really a checklist:
//   - `<todo>` opens it at the start of a line, outside a code fence;
//   - every non-blank line inside is a list item;
//   - it closes with `</todo>` and holds at least one item;
//   - it stays under TODO_BLOCK_MAX_CHARS.
// Anything else (prose inside, never closed, too long, a tag mid-sentence) is
// passed through exactly as written.
//
// The filter works on a stream: it holds back only the start of a line that
// could still become `<todo>`, and a candidate block until it is decided.
// Its result does not depend on where the stream was split.

import { normalizeAgentPlan, type AgentPlanEntry, type AgentPlanStatus } from "./agent-plan.ts";

/** A candidate block longer than this is released as written. */
export const TODO_BLOCK_MAX_CHARS = 16_000;

const OPEN = "<todo>";
const CLOSE = "</todo>";
// "- [ ] text", "* [x] text", "2. [~] text", "+ text". The box is optional.
const ITEM = /^(?:[-*+]|\d{1,3}[.)])(?:\s+\[([ xX~/>-]?)\])?(?:\s+(.*))?$/;

export interface TodoFilterOutput {
  /** Text to show, in order. */
  text: string;
  /** Each closed block as a whole plan, in order; a later one replaces an earlier one. */
  plans: AgentPlanEntry[][];
}

export interface TodoBlockFilter {
  push(delta: string): TodoFilterOutput;
  /** The stream ended: release anything still held. */
  flush(): TodoFilterOutput;
}

function statusFor(mark: string | undefined): AgentPlanStatus {
  if (mark === "x" || mark === "X") return "completed";
  if (mark === "~" || mark === "/" || mark === ">" || mark === "-") return "in_progress";
  return "pending";
}

export function createTodoBlockFilter(): TodoBlockFilter {
  let out = "";
  let plans: AgentPlanEntry[][] = [];
  // Last two characters released, and whether anything was released yet.
  let tail = "";
  let released = false;

  let mode: "text" | "block" = "text";
  // Text mode.
  let held = ""; // the start of the current line, held while it could become <todo>
  let atLineStart = true; // still inside the part of the line that could open a block
  let lineSoFar = ""; // the whole current line, for code fence detection
  let fence: string | null = null;
  let closingLine = false; // the rest of the line a block closed on
  let dropBlank = false; // a block was just removed: swallow the blank line it leaves
  // Block mode.
  let block = ""; // every character of the candidate, to release as written
  let line = ""; // the current line inside the block
  let items: AgentPlanEntry[] = [];

  const emit = (text: string) => {
    if (!text) return;
    out += text;
    released = true;
    tail = (tail + text).slice(-2);
    if (/\S/.test(text)) dropBlank = false;
  };

  const validLine = (text: string) => {
    const trimmed = text.trim();
    return !trimmed || ITEM.test(trimmed);
  };
  const collect = (text: string) => {
    const match = ITEM.exec(text.trim());
    const content = match?.[2]?.trim();
    if (match && content) items.push({ content, status: statusFor(match[1]) });
  };

  /** Not a to-do block after all: put it back as ordinary text. Its first
   * line cannot open a block again, so this always makes progress. */
  const abandon = () => {
    const raw = block;
    mode = "text";
    block = "";
    line = "";
    items = [];
    held = "";
    lineSoFar = "";
    atLineStart = false;
    feed(raw);
  };

  const close = () => {
    const entries = normalizeAgentPlan(items);
    if (!entries?.length) return abandon();
    plans.push(entries);
    mode = "text";
    block = "";
    line = "";
    items = [];
    held = "";
    lineSoFar = "";
    atLineStart = false;
    closingLine = true;
    dropBlank = true;
  };

  const endTextLine = () => {
    const whole = lineSoFar;
    if (closingLine) {
      // The line the block closed on held nothing else: it goes with the block.
      closingLine = false;
    } else if (atLineStart && dropBlank && !whole.trim() && (!released || tail === "\n\n")) {
      // A blank line left behind by a removed block: dropped once, so the
      // answer keeps one paragraph break instead of two.
    } else {
      emit(held);
      emit("\n");
      if (!whole.trim()) dropBlank = false;
    }
    const trimmed = whole.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
    } else {
      const opened = /^(`{3,}|~{3,})/.exec(trimmed);
      if (opened) fence = opened[1];
    }
    held = "";
    lineSoFar = "";
    atLineStart = true;
  };

  function feed(input: string) {
    for (const ch of input) {
      if (mode === "block") {
        block += ch;
        if (block.length > TODO_BLOCK_MAX_CHARS) {
          abandon();
          continue;
        }
        if (ch === "\n") {
          if (!validLine(line)) {
            abandon();
            continue;
          }
          collect(line);
          line = "";
          continue;
        }
        line += ch;
        if (line.toLowerCase().endsWith(CLOSE)) {
          const last = line.slice(0, -CLOSE.length);
          if (!validLine(last)) {
            abandon();
            continue;
          }
          collect(last);
          close();
        }
        continue;
      }

      if (ch === "\n") {
        endTextLine();
        continue;
      }
      lineSoFar += ch;
      if (closingLine) {
        if (/\s/.test(ch)) continue;
        closingLine = false;
      }
      if (atLineStart && !fence) {
        held += ch;
        const candidate = held.replace(/^[ \t]+/, "").toLowerCase();
        if (candidate === OPEN) {
          mode = "block";
          block = held;
          line = "";
          items = [];
          held = "";
          atLineStart = false;
          continue;
        }
        if (OPEN.startsWith(candidate)) continue;
        atLineStart = false;
        emit(held);
        held = "";
        continue;
      }
      emit(ch);
    }
  }

  const take = (): TodoFilterOutput => {
    const result = { text: out, plans };
    out = "";
    plans = [];
    return result;
  };

  return {
    push(delta: string) {
      feed(delta);
      return take();
    },
    flush() {
      while (mode === "block") abandon();
      if (!closingLine) emit(held);
      held = "";
      closingLine = false;
      atLineStart = true;
      lineSoFar = "";
      return take();
    },
  };
}

/** The whole-text form of the filter, for a finished answer. */
export function extractTodoBlocks(text: string): TodoFilterOutput {
  const filter = createTodoBlockFilter();
  const first = filter.push(text);
  const rest = filter.flush();
  return { text: first.text + rest.text, plans: [...first.plans, ...rest.plans] };
}
