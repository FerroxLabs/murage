// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The import allowlist the typed hand-off boundary relies on (DESIGN-r7 item 2). The types stop a worker's string from reaching a bot; this keeps
// the few functions that could turn a string into a status, read worker words back, or mint released text in the few modules that need them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "node_modules" && name !== "testing") sources(path, out); continue; }
    if (/\.ts$/.test(name) && !/\.(test|bench\.test|expect-errors)\.ts$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
const files = sources(SERVER_DIR).map(path => ({ name: relative(SERVER_DIR, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));
/** The modules (outside tests) whose source matches `pattern`. */
const using = (pattern: RegExp) => files.filter(file => pattern.test(file.text)).map(file => file.name).sort();

describe("who may make a status from a string, read worker words, or mint released text", () => {
  it("only the server's port adapters wrap a string as a Murage line", () => {
    expect(using(/\bhostLine\b/)).toEqual(["boundary-ports.ts", "host-words.ts", "index.ts", "project-digest.ts", "result-egress.ts", "shared-work.ts"]);
  });
  it("the status wrapper is claimed by one module", () => {
    expect(using(/MurageStatus\.claimHost\(/)).toEqual(["host-words.ts"]);
  });
  it("worker words are unsealed by the result gate alone", () => {
    expect(using(/WorkerText\.claimUnseal\(/)).toEqual(["result-egress.ts"]);
    expect(using(/WorkerText\.unseal\b/)).toEqual([]);
  });
  it("released text is minted by the result gate alone", () => {
    expect(using(/ReleasedText\.claim\(/)).toEqual(["result-egress.ts"]);
    expect(using(/new ReleasedText\(/)).toEqual(["released-text.ts"]);
    expect(using(/new MurageStatus\(/)).toEqual(["murage-status.ts"]);
  });
  it("worker text is sealed only where a stored row or a reply enters", () => {
    expect(using(/new WorkerText\(/)).toEqual(["boundary-ports.ts", "handoff-boundary.ts", "index.ts"]);
  });
  it("a row's store is held by the row sink and nobody else in the egress modules", () => {
    expect(using(/\bRowSink\.append\b/)).toEqual([]);
    expect(using(/sinkStores\b/)).toEqual(["bot-egress.ts"]);
  });
});

describe("a dispatch failure reaches a transcript a bot reads only as a code", () => {
  const index = files.find(file => file.name === "index.ts")!.text;
  it("the chip a delegation that could not start leaves in the source conversation is a table line, not the engine's message", () => {
    expect(index).not.toMatch(/delegation to @\$\{bot\?\.name \?\? toBotId\} could not start: \$\{/);
    expect(index).toMatch(/status\("row_could_not_start", \{ name: botNameOf\(bot\?\.name, toBotId\), why: failureCodeFrom\(why\) \}\)/);
  });
  it("the full explanation of a refusal before the turn began is kept in the worker's own conversation", () => {
    expect(index).toMatch(/if \(refusedBeforeStart && targetThreadId\) \{[\s\S]{0,400}?errorDetails: detail\.slice\(0, 4096\)/);
  });
});

describe("the hand-off boundary", () => {
  const boundary = files.find(file => file.name === "handoff-boundary.ts")!.text;
  it("imports nothing that wraps a string as a status, and no comms module", () => {
    expect(boundary).not.toMatch(/from "\.\/host-words\.ts"/);
    expect(boundary).not.toMatch(/from "\.\/comms-visibility\.ts"/);
    expect(boundary).not.toMatch(/\bhostLine\b/);
    expect(boundary).not.toMatch(/\boutboundWords\b/);
  });
  it("holds the row sink only as a type", () => {
    expect(boundary).toMatch(/import \{ type RowSink, /);
    expect(boundary).not.toMatch(/new RowSink\(/);
  });
  it("never reaches for the whole store, a comms bus, or a row's text", () => {
    expect(boundary).not.toMatch(/\bcommsBus\b|\bwhole\(|\.appendMessage\(|\.patchMessage\(|\.messagesFor\(|\bmessageById\(/);
  });
  it("reads a stored row only sealed", () => {
    expect(boundary).toMatch(/store\.rowsFor\(/);
    expect(boundary).not.toMatch(/\.tool\??\.name\b/);
  });
});
