// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The compile-time guard, checked by `pnpm typecheck` itself: every line below must be a type error. If one of them starts to compile, the
// `@ts-expect-error` is unused and the typecheck fails, which is how a loosened sink is caught even when the type test file is not run.
import type { ServerResponse } from "node:http";
import { ReleasedText, WorkerText } from "./released-text.ts";
import { botBody, sendBot, RowSink, writeBotRow } from "./bot-egress.ts";
import { hostLine } from "./host-words.ts";
import type { BoundaryPorts } from "./handoff-boundary.ts";
import { status, type BotName } from "./murage-status.ts";
import { changesRequestedBlock, continuationResultsPrompt } from "./project-prompt.ts";
import { mirrorReply, type CommsBus } from "./comms-visibility.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export function mustNotCompile(worker: WorkerText, released: ReleasedText, res: ServerResponse, rows: RowSink, bus: CommsBus, bot: BotRecord, channel: GroupRecord, ports: BoundaryPorts): void {
  // @ts-expect-error worker words are not a string
  const asString: string = worker;
  // @ts-expect-error a worker string is not a bot-facing value
  sendBot(res, 200, botBody({ text: worker }));
  // @ts-expect-error a template string is a plain string
  sendBot(res, 200, botBody({ text: `${released}` }));
  // @ts-expect-error a body must be built by botBody
  sendBot(res, 200, { text: released });
  // @ts-expect-error a plain string is not a status or released text
  mirrorReply(bus, bot, "plain", channel);
  // @ts-expect-error a row's words must be released text or a status
  writeBotRow(rows, "t", {}, "plain");
  // @ts-expect-error released text is made only by the gate
  new ReleasedText("x", undefined);
  // @ts-expect-error a stored row's words are sealed, so they cannot be wrapped as a host line
  hostLine([...ports.store.rowsSince("t", 0)][0].text!);
  // @ts-expect-error nor its tool name
  hostLine([...ports.store.rowsSince("t", 0)][0].tool!.name);
  // @ts-expect-error worker text is not a string for the wrapper either
  hostLine(worker);
  // @ts-expect-error there is no public way to unseal worker text
  WorkerText.unseal(worker);
  // @ts-expect-error the row sink has no public append
  RowSink.append(rows, "t", { role: "bot", kind: "text", text: "raw" });
  // @ts-expect-error a decorator cannot add text to a row
  writeBotRow(rows, "t", {}, status("nothing"), () => "raw words");
  // @ts-expect-error the boundary's store port cannot change a row's text
  ports.store.patchMessage("t", "m", { text: "raw words" });
  // @ts-expect-error the boundary has no comms bus
  ports.commsBus.store.appendMessage("t", { role: "bot", kind: "text", text: "raw" });
  // @ts-expect-error a host line is not a table status
  status("host_line", { line: { words: "raw words" } });
  // @ts-expect-error a wake's answer is what the gate released, never a stored string
  continuationResultsPrompt(true, [{ botName: "R", state: "done", answer: "raw words" }]);
  // @ts-expect-error how a result ended is a status, not released words
  continuationResultsPrompt(true, [{ botName: "R", state: "failed", ending: released }]);
  // @ts-expect-error a hand-off's ending is never a note string
  ports.settleRoomAsk("r", { state: "failed", note: "raw provider text" });
  // @ts-expect-error a card title is made only by the store adapter
  status("card_result_line", { desk: "" as BotName, lead: "" as BotName, card: "" as BotName });
  // @ts-expect-error the boundary's store gives no rows of a whole conversation
  ports.store.rowsFor("t");
  // @ts-expect-error a reviewer's notes reach the lead's wake only as the gate released them (R9-01)
  continuationResultsPrompt(true, [{ botName: "R", state: "done", next: { step: "send_back", card: { id: "c", number: 1, title: null }, criteria: [], reviewNotes: "raw words" } }]);
  // @ts-expect-error nor the assignee's redo
  changesRequestedBlock({ reviewerNotes: "raw words" });
  // @ts-expect-error nor the lead's note
  changesRequestedBlock({ leadNote: "raw words" });
  // @ts-expect-error and a plain string is not the owner's own note either
  changesRequestedBlock({ ownerNote: "raw words" });
  void asString;
}
