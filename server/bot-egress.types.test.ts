// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The compiler is the scanner. A worker's words and Murage's own words are different types, and every place that writes to a bot accepts only
// released text or a Murage status. This file compiles small programs against the REAL modules: the correct program has no diagnostics, and each
// way of getting a worker's string to a bot (or of faking the brand, or of writing a copy without its link) must have at least one.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_DIR, diagnosticsFor, virtualProgram } from "./testing/virtual-program.ts";

const FILE = join(SERVER_DIR, "__virtual__", "probe.ts").replace(/\\/g, "/");
const PRELUDE = `
import { WorkerText, ReleasedText } from "../released-text.ts";
import { status, type Outbound, type BotName } from "../murage-status.ts";
import { hostLine } from "../host-words.ts";
import { botBody, botReply, sendBot, writeBotRow, writeActivityRow, RowSink } from "../bot-egress.ts";
import { mirrorReply } from "../comms-visibility.ts";
import { recordDelegationReceipt } from "../delegations.ts";
import { releaseStoredResult } from "../result-egress.ts";
import type { BoundaryPorts } from "../handoff-boundary.ts";
import type { CommsBus } from "../comms-visibility.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import type { ServerResponse } from "node:http";
declare const worker: WorkerText; declare const released: ReleasedText; declare const res: ServerResponse; declare const rows: RowSink;
declare const bus: CommsBus; declare const bot: BotRecord; declare const channel: GroupRecord; declare const name: BotName; declare const ports: BoundaryPorts;
declare const cond: boolean;
export {};
`;
const CORRECT = `
sendBot(res, 200, botBody({ botName: name, text: released }));
sendBot(res, 200, botBody({ error: status("no_such_bot"), recentActivity: [status("activity_text", { text: released })] }));
mirrorReply(bus, bot, released, channel);
mirrorReply(bus, bot, status("withheld"), channel);
writeBotRow(rows, "t", {}, released);
writeActivityRow(rows, "t", {}, status("delegation_completed_no_text", { name }), true);
recordDelegationReceipt({ id: "a", sourceThreadId: "t", toBotId: "b", toBotName: "B", status: "done", result: released });
const reply = botReply(200, { text: cond ? released : status("withheld") });
void reply;
`;
const diagnose = (body: string, imports = "") => diagnosticsFor(virtualProgram({ [FILE]: `${imports}\n${PRELUDE}\n${body}` }), FILE);

describe("the baseline program is accepted", () => {
  it("builds replies, rows and receipts only from released text, statuses, names, numbers and codes", () => {
    expect(diagnose(CORRECT)).toEqual([]);
  });
});

describe("each way a worker's words could reach a bot is a compile error", () => {
  const cases: Array<[string, string, string?]> = [
    ["the old murageWords laundering helper is gone", `import { murageWords } from "../result-egress.ts"; void murageWords;`],
    ["worker text cannot be read as a string", `const text: string = worker; void text;`],
    ["string concatenation of worker text", `const text = "".concat(worker); sendBot(res, 200, botBody({ text }));`],
    ["a string replace with worker text", `const text = "x".replace("x", worker); sendBot(res, 200, botBody({ text }));`],
    ["a template string of worker text into a sink", "sendBot(res, 200, botBody({ text: `${worker}` }));"],
    ["a quoted property name does not hide it", `sendBot(res, 200, botBody({ "text": worker }));`],
    ["worker text in the activity array", `sendBot(res, 200, botBody({ recentActivity: [worker] }));`],
    ["a plain string as a reply", `sendBot(res, 200, botBody({ text: "hello" }));`],
    ["a plain string as a status line", `mirrorReply(bus, bot, "hello", channel);`],
    ["a plain string in a receipt", `recordDelegationReceipt({ id: "a", sourceThreadId: "t", toBotId: "b", toBotName: "B", status: "done", result: "hello" });`],
    ["a plain string as a row's text", `writeBotRow(rows, "t", {}, "hello");`],
    ["overwriting released text", `released.copyOf = undefined; (released as { text: string }).text = "x";`],
    ["assigning to a built reply body", `const reply = botReply(200, { text: released }); reply.body.text = worker;`],
    ["a hand-written body sent without botBody", `sendBot(res, 200, { text: released });`],
    ["a worker string in a nested callback in the same handler", `[1].forEach(() => sendBot(res, 200, { text: worker }));`],
    ["a worker string returned from a helper into a sink", `const make = () => ({ text: worker }); sendBot(res, 200, make());`],
    ["a conditional that can yield worker text", `sendBot(res, 200, botBody({ text: cond ? released : worker }));`],
    ["released text cannot be built by hand", `new ReleasedText("x");`],
    ["a status cannot be built by hand", `import("../murage-status.ts").then(m => new m.MurageStatus("withheld", "x", undefined, []));`],
    ["a status line takes no raw string", `status("delegation_completed_no_text", { name: "Sable" });`],
    ["a status key outside the table", `status("not_a_real_key");`],
    ["a bare object cannot stand in for released text", `mirrorReply(bus, bot, { copyOf: undefined } as { copyOf: undefined }, channel);`],
    ["the hand-off code has no way to append a row directly", `ports.store.appendMessage("t", { role: "bot", kind: "text", text: "x" });`],
    ["the row handle has no append of its own", `rows.appendMessage("t", { role: "bot", kind: "text", text: "x" });`],
    ["the gate takes sealed worker text, not a string", `releaseStoredResult({}, "w", "d", { fromBotId: "a" }, false, "a plain string");`],
    // r7: the guards themselves cannot be walked around
    ["hostLine is not in the status module any more", `import { hostLine as moved } from "../murage-status.ts"; void moved;`],
    ["a stored row's words are sealed, so they cannot become a host line", `sendBot(res, 200, botBody({ error: hostLine(ports.store.rowsFor("t")[0].text!) }));`],
    ["a stored row's tool name is sealed too", `sendBot(res, 200, botBody({ error: hostLine(ports.store.rowsFor("t")[0].tool!.name) }));`],
    ["a stored row's words cannot be read as a string", `const text: string = ports.store.rowsFor("t")[0].text!; void text;`],
    ["there is no public way to unseal worker text", `const text = WorkerText.unseal(worker); void text;`],
    ["the row sink has no public append", `RowSink.append(rows, "t", { role: "bot", kind: "text", text: "raw" });`],
    ["a decorator cannot add text to a row", `writeBotRow(rows, "t", {}, status("nothing"), () => "raw words");`],
    ["the boundary's store port cannot change a row's text", `ports.store.patchMessage("t", "m", { text: "raw words" });`],
    ["the boundary's store port has no appendMessage", `ports.store.appendMessage("t", { role: "bot", kind: "text", text: "raw" });`],
    ["the boundary has no comms bus to reach the whole store through", `ports.commsBus.store.appendMessage("t", { role: "bot", kind: "text", text: "raw" });`],
    ["the comms port does not hold the store either", `ports.comms.store.appendMessage("t", { role: "bot", kind: "text", text: "raw" });`],
    ["a host line cannot be dressed as a table status", `status("host_line", { line: { words: "raw words" } });`],
    ["a room line takes released text or a status, not a string", `ports.roomMurageLine("t", "raw words", { kind: "status" });`],
    ["a receipt's text is sealed once the boundary reads it", `import("../boundary-ports.ts").then(async m => { const task = m.resolveTaskSealed("t", undefined, {} as never); if (task?.kind === "receipt") { const text: string = task.receipt.result!; void text; } });`],
  ];
  it.each(cases)("%s", (_label, body, imports) => {
    expect(diagnose(body, imports).length, body).toBeGreaterThan(0);
  });
});
