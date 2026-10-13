// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A conversation export covers the whole visible branch, so it is the one
// read that legitimately grows with the thread. It must not hold the event
// loop while it does: the branch is read in slices of a few milliseconds
// (Store.branchReader), each followed by a yield, and the response is written
// in chunks that wait for the socket. The bytes are exactly those of the one
// synchronous load it replaces.
import type { ServerResponse } from "node:http";
import type { Message } from "./store.ts";

/** How long one slice may run before the loop gets a turn. */
export const EXPORT_SLICE_MS = 20;
const CHUNK_BYTES = 64 * 1024;

/** The markdown lines one message adds. */
export function markdownLinesFor(msg: Message, who: string, activityLine: (msg: Message, who: string) => string): string[] {
  const lines: string[] = [];
  if (msg.kind === "text" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
  else if (msg.kind === "activity" && msg.tool) lines.push(activityLine(msg, who), "");
  else if (msg.kind === "screen") lines.push("> [screen capture]", "");
  else if (msg.kind === "options" && msg.card) lines.push(`> ${msg.card.title}${msg.card.answered ? ` (answered: ${msg.card.answered})` : ""}`, "");
  return lines;
}

/** One message as an element of the pretty-printed `messages` array. */
export function jsonElementFor(msg: Message): string {
  // pixels stripped: an export is for reading and archiving, and a base64 desktop frame is neither
  const { png: _png, mime: _mime, ...rest } = msg;
  return JSON.stringify(rest, null, 2).replace(/\n/g, "\n    ");
}

/** The whole JSON document around the elements, exactly as
 * JSON.stringify({ name, threadId, messages }, null, 2) writes it. */
export function jsonDocument(name: string, threadId: string, elements: readonly string[]): { head: string; tail: string } {
  const head = `{\n  "name": ${JSON.stringify(name)},\n  "threadId": ${JSON.stringify(threadId)},\n  "messages": [`;
  return elements.length ? { head: `${head}\n`, tail: "\n  ]\n}" } : { head, tail: "]\n}" };
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Walk the branch in slices (newest first), turning each message into its
 * piece of the document, then write the document oldest first. Returns false
 * when the client went away. */
export async function streamThreadExport(args: {
  res: ServerResponse;
  reader: { next(budgetMs?: number): { messages: Message[]; done: boolean } };
  format: "markdown" | "json";
  name: string;
  threadId: string;
  filename: string;
  who: (msg: Message) => string;
  activityLine: (msg: Message, who: string) => string;
}): Promise<boolean> {
  const { res, reader, format } = args;
  const pieces: string[] = [];
  const gone = () => res.destroyed || res.writableEnded;
  // newest first, a slice at a time
  for (;;) {
    const slice = reader.next(EXPORT_SLICE_MS);
    for (const msg of slice.messages) {
      if (format === "json") pieces.push(jsonElementFor(msg));
      else {
        const lines = markdownLinesFor(msg, args.who(msg), args.activityLine);
        if (lines.length) pieces.push(lines.map((line) => `\n${line}`).join(""));
      }
    }
    if (slice.done) break;
    await yieldToLoop();
    if (gone()) return false;
  }
  pieces.reverse();
  let head: string, tail: string, separator: string;
  if (format === "json") {
    ({ head, tail } = jsonDocument(args.name, args.threadId, pieces));
    separator = ",\n";
  } else {
    head = `# ${args.name}\n`;
    tail = "";
    separator = "";
  }
  res.writeHead(200, format === "json"
    ? { "content-type": "application/json", "content-disposition": `attachment; filename="${args.filename}.json"` }
    : { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${args.filename}.md"` });
  const write = async (chunk: string): Promise<boolean> => {
    if (gone()) return false;
    if (res.write(chunk)) return true;
    await new Promise<void>((resolve) => { const done = () => { res.off("drain", done); res.off("close", done); resolve(); }; res.on("drain", done); res.on("close", done); });
    return !gone();
  };
  let chunk = head;
  for (let i = 0; i < pieces.length; i++) {
    chunk += (i > 0 && format === "json" ? separator : "") + (format === "json" ? "    " : "") + pieces[i];
    if (chunk.length >= CHUNK_BYTES) {
      if (!(await write(chunk))) return false;
      chunk = "";
      await yieldToLoop();
    }
  }
  chunk += tail;
  if (!(await write(chunk))) return false;
  res.end();
  return true;
}
