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
import { status } from "./murage-status.ts";
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
  hostLine(ports.store.rowsFor("t")[0].text!);
  // @ts-expect-error nor its tool name
  hostLine(ports.store.rowsFor("t")[0].tool!.name);
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
  void asString;
}
