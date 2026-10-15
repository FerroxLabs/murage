// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards for the turnctx class fix: no window, cap or tail fallback is left on a
// path a bot's context is built from; no index is ever added to the messages
// table (a history-sized build under the writers); and the only callers that still
// load or walk a whole thread are the ones that show or export it.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = new URL(".", import.meta.url).pathname;
function sources(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testdata" ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !entry.name.endsWith(".legacy-reference.ts") && !path.includes(`${join(root, "testing")}`) ? [path] : [];
  });
}
const code = (path: string) => readFileSync(path, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

it("the windows, caps and tail fallbacks the class fix deleted are gone from every source file", () => {
  const gone = ["TURN_TAIL_ROWS", "BRANCH_DELTA_STEPS", "OPEN_PATH_WALK_STEPS", "BACKGROUND_WALK_STEPS", "TURN_LOOKUP_STEPS", "TURN_LOOKUP_GAP", "SETUP_LEGACY_ECHO_ROWS", "branchJumpReader", "card_branch", "branch_walk", "branch_jump"];
  const found: string[] = [];
  for (const path of sources()) {
    // the registry of the tables an earlier preview wrote and this build drops names them (so an archive of such a preview restores)
    if (path === join(root, "memory", "upgrade-app-tables.ts")) continue;
    const lines = code(path);
    for (const name of gone) for (const line of lines) if (line.includes(name) && !/DROP TABLE IF EXISTS/.test(line)) found.push(`${relative(root, path)}: ${name}`);
  }
  expect([...new Set(found)]).toEqual([]);
});

it("no index is created on the messages table beyond the shipped list", () => {
  const shipped = new Set(["messages_thread", "messages_at", "messages_inbox_kind_thread_at", "messages_inbox", "messages_inbox_text_artifact", "messages_pending_browser_check"]);
  const found: string[] = [];
  for (const path of sources()) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w${}]+)\s+ON\s+messages\b/gi)) if (!shipped.has(match[1]!) && match[1] !== "${PENDING_BROWSER_CHECK_INDEX}") found.push(`${relative(root, path)}: ${match[1]}`);
  }
  expect([...new Set(found)]).toEqual([]);
});

it("only the UI load and the exports read or walk a whole thread", () => {
  const allowed = [
    "{ bots: store.bots, messagesFor: (threadId) => store.messagesFor(threadId), routesThroughFlux: isFluxModel },",
    "messages: store.messagesFor(bot.threadId),",
    "messages: store.messagesFor(group.threadId),",
    "if (limit === undefined) return { messages: store.messagesFor(threadId) };",
    "activePath: threadId => store.activePath(threadId),",
  ];
  const lines = code(join(root, "index.ts")).map((line) => line.trim()).filter((line) => /\b(?:messagesFor|activePath|walkActivePath)\(/.test(line));
  expect(lines.filter((line) => !allowed.some((entry) => line.startsWith(entry) || line.includes(entry)))).toEqual([]);
});
