// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime half of the typed hand-off boundary (the compile-time half is server/bot-egress.types.test.ts): a cast cannot fake the brand, a
// worker string under a text key is refused, a body that was not built here is never written, and in the running app a violation fails closed.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { EgressViolation, ReleasedText, WorkerText } from "./released-text.ts";
import { MurageStatus, configureStatusRoster, outboundWords, status, statusFromNote, statusFromStored, failureCodeFrom } from "./murage-status.ts";
import { hostLine } from "./host-words.ts";
import { botBody, configureBotEgress, sendBot, type BotBody } from "./bot-egress.ts";
import { released } from "./testing/released.ts";
import type { ServerResponse } from "node:http";

const res = {} as ServerResponse;

describe("the runtime backstop", () => {
  it("a cast cannot fake released text or a status", () => {
    const fake = { copyOf: undefined, toString: () => "worker words" } as unknown as ReleasedText;
    expect(() => botBody({ text: fake })).toThrow(EgressViolation);
    const fakeStatus = { key: "withheld" } as unknown as MurageStatus;
    expect(() => botBody({ error: fakeStatus })).toThrow(EgressViolation);
    expect(ReleasedText.is(fake)).toBe(false);
    expect(MurageStatus.is(fakeStatus)).toBe(false);
  });
  it("a string under a text key is refused, a code or id string is allowed", () => {
    expect(() => botBody({ text: "worker words" as never })).toThrow(EgressViolation);
    expect(() => botBody({ recentActivity: ["worker words"] as never })).toThrow(EgressViolation);
    expect(botBody({ taskId: "t-1", code: "shared_paused", status: "done", elapsedMs: 5 })).toEqual({ taskId: "t-1", code: "shared_paused", status: "done", elapsedMs: 5 });
  });
  it("sealed worker words under any key are refused", () => {
    expect(() => botBody({ text: new WorkerText("w") as never })).toThrow(EgressViolation);
    expect(() => botBody({ result: new WorkerText("w") as never })).toThrow(EgressViolation);
  });
  it("a built body is frozen and can be written; a hand-made one cannot", () => {
    const body = botBody({ text: released("fine") });
    expect(Object.isFrozen(body)).toBe(true);
    expect(() => { (body as Record<string, unknown>).text = "other"; }).toThrow();
    const written: unknown[] = [];
    configureBotEgress((_res, code, sent) => { written.push([code, sent]); });
    sendBot(res, 200, body);
    expect(written).toEqual([[200, { text: "fine" }]]);
    expect(() => sendBot(res, 200, { text: "worker words" } as unknown as BotBody)).toThrow(EgressViolation);
    configureBotEgress(undefined);
  });
  it("words and statuses cannot be joined into strings", () => {
    const worker = new WorkerText("secret");
    expect(() => `${worker}`).toThrow(EgressViolation);
    expect(() => `${released("x")}`).toThrow(EgressViolation);
    expect(() => `${status("withheld")}`).toThrow(EgressViolation);
    expect(() => JSON.stringify({ a: worker })).toThrow(EgressViolation);
  });
  it("in the running app a violation is logged and the reader gets the withheld line", () => {
    const saved = { vitest: process.env.VITEST, node: process.env.NODE_ENV };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.VITEST; process.env.NODE_ENV = "production";
    try {
      const body = botBody({ text: "worker words" as never });
      expect(body.text).toBe(outboundWords(status("withheld")));
      expect(log).toHaveBeenCalled();
      const written: unknown[] = [];
      configureBotEgress((_res, code, sent) => { written.push([code, sent]); });
      sendBot(res, 200, { text: "worker words" } as unknown as BotBody);
      expect(JSON.stringify(written)).not.toContain("worker words");
      expect(JSON.stringify(written)).toContain(outboundWords(status("withheld")));
    } finally {
      if (saved.vitest !== undefined) process.env.VITEST = saved.vitest;
      if (saved.node !== undefined) process.env.NODE_ENV = saved.node; else delete process.env.NODE_ENV;
      configureBotEgress(undefined);
      log.mockRestore();
    }
  });
  it("released text can be claimed only once, by the gate", () => {
    expect(() => ReleasedText.claim()).toThrow(EgressViolation);
  });
});

describe("provider failure detail reaches a bot only as a code", () => {
  it.each([
    ["HTTP 429 Too Many Requests: slow down for /home/sean/secret", "rate_limit"],
    ["401 Unauthorized: api key sk-abc123", "auth"],
    ["request timed out after 120s", "timeout"],
    ["upstream returned 503 while reading /Users/alex/private.txt", "provider_error"],
    ["the model said something odd", "other"],
  ])("%s", (detail, code) => {
    expect(failureCodeFrom(detail)).toBe(code);
    for (const line of [status("turn_failed", { code: failureCodeFrom(detail) }), status("could_not_start", { why: failureCodeFrom(detail) }), status("delegated_turn_failed", { why: failureCodeFrom(detail) })]) {
      const words = outboundWords(line);
      expect(words).not.toMatch(/secret|sk-abc|private\.txt|\/home|\/U[s]ers/);
    }
  });
  it("an older receipt's free-text note reads as a plain line, never as the note", () => {
    expect(outboundWords(statusFromNote("rate limit hit on /home/sean/x with key sk-live"))).toBe("The request finished.");
    expect(outboundWords(statusFromNote("cancelled"))).toBe("cancelled");
    expect(outboundWords(statusFromNote(undefined))).toBe("The request finished.");
  });
  it("a status kept on a receipt is written again from its key and plain values, naming only a bot on the roster", () => {
    const kept = status("receipt_stayed_busy", { name: "Helper" as never, tries: 3 });
    expect(statusFromStored(kept.key, kept.data)).toBeUndefined();
    configureStatusRoster(name => name === "Helper");
    try {
      const again = statusFromStored(kept.key, kept.data);
      expect(again && outboundWords(again)).toBe("@Helper stayed busy through 3 retries");
      expect(statusFromStored(kept.key, { name: "Someone else", tries: 3 })).toBeUndefined();
      expect(statusFromStored(kept.key, { name: "Helper", tries: "3" })).toBeUndefined();
    } finally { configureStatusRoster(undefined); }
    expect(statusFromStored("host_line", { words: "x" })).toBeUndefined();
    expect(statusFromStored("not_a_key", {})).toBeUndefined();
  });
  it("host lines are Murage statuses with no stored key", () => {
    const line = hostLine("Sharing was turned off for this team.");
    expect(MurageStatus.is(line)).toBe(true);
    expect(line.data).toBeUndefined();
  });
});

describe("what people read in the status table", () => {
  const source = readFileSync(new URL("./murage-status.ts", import.meta.url), "utf8");
  const table = source.slice(source.indexOf("const TABLE = {"), source.indexOf("} as const;"));
  const lines = [...table.matchAll(/=> (?:`([^`]*)`|"([^"]*)")/g)].map(match => (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, "X"));
  it("has lines to read", () => { expect(lines.length).toBeGreaterThan(50); });
  it.each(lines.map(line => [line]))("%s", line => {
    expect(line).not.toMatch(/—/);
    expect(line).not.toMatch(/\b(?:safe|unsafe)\b/i);
    expect(line).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });
});

describe("the hand-off boundary reaches the store only through its ports", () => {
  const source = readFileSync(new URL("./handoff-boundary.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import (type )?(.*?) from "([^"]+)";$/gm)].map(match => ({ typeOnly: match[1] !== undefined, names: match[2], from: match[3] }));
  const ALLOWED = new Set([
    "./boundary-ports.ts", "./card-result-source.ts", "./contracts.ts", "./coordination-budget.ts", "./coordination-target.ts", "./database.ts", "./delegated-reply-check.ts", "./delegations.ts", "./event-limit.ts",
    "./execution-audience.ts", "./fold-steps.ts", "./handoff-outcome.ts", "./handoff-reply.ts", "./handoff-replay.ts", "./human-principals.ts", "./internal-capabilities.ts", "./peer-approval.ts",
    "./project-prompt.ts", "./project-records.ts", "./project-review.ts", "./project-routines.ts", "./result-egress.ts", "./room-requests.ts", "./routine-permissions.ts",
    "./shared-work.ts", "./task-resolution.ts", "./released-text.ts", "./murage-status.ts", "./bot-egress.ts", "./store.ts", "./work-admission.ts", "node:crypto", "node:http",
  ]);
  it("imports only listed modules", () => {
    expect(imports.map(entry => entry.from).filter(from => !ALLOWED.has(from))).toEqual([]);
  });
  // Every module a source reaches, read from its syntax tree (comments, whitespace and line breaks cannot hide one): static imports,
  // re-exports, import("...") and require("...").
  const moduleReferences = (text: string): string[] => {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) found.push(node.moduleSpecifier.getText());
      else if (ts.isImportEqualsDeclaration(node)) found.push(node.moduleReference.getText());
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) found.push(node.arguments[0]?.getText() ?? "<none>");
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    return found;
  };
  it("the guard below sees every way a module is reached", () => {
    for (const text of ['const x = import ("./store.ts");', 'require ("./store.ts");', 'export { Store } from "./store.ts";', '/* a */ import { x } from "./store.ts";', 'import x = require("./store.ts");', 'import type { T } from "./store.ts";']) {
      expect(moduleReferences(text), text).not.toEqual([]);
    }
    expect(moduleReferences('// import { x } from "./store.ts";\nconst importText = "require(x)";')).toEqual([]);
  });
  it("the delegated-reply scheduler it listens to reaches no module at all, so it is no side door to the store", () => {
    expect(moduleReferences(readFileSync(new URL("./delegated-reply-check.ts", import.meta.url), "utf8"))).toEqual([]);
  });
  it("takes no value from the store module, only types", () => {
    for (const entry of imports.filter(entry => entry.from === "./store.ts")) {
      expect(entry.typeOnly || /^\{\s*(?:type \w+(?:,\s*)?)+\s*\}$/.test(entry.names), entry.names).toBe(true);
    }
  });
  it("never reads the sealed words of a worker, and mints no released text", () => {
    expect(source).not.toMatch(/WorkerText\.(?:unseal|claimUnseal)|ReleasedText\.claim|MurageStatus\.claimHost|new ReleasedText|new MurageStatus/);
  });
  it("writes no row except through the row sink, and sends no body except through sendBot", () => {
    expect(source).not.toMatch(/\.appendMessage\(/);
    expect(source).not.toMatch(/\bjson\(res/);
  });
});
