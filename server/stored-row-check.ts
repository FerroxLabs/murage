// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U4 S3: the one check every stored transcript row passes through, on its way in (storedJson) and on its way out (rowToMessage),
// both in transcript-seq.ts. A row's done-when line is re-read through readDoneWhen (a value that is too long, or that reads as a
// secret, is dropped, never shown or passed on), and a runtime diagnostic is kept only on the bot activity row of its own turn, in
// its bounded shape. Pure and idempotent: a checked row checks to itself. Imports only done-when.ts and the diagnostic schema, so
// the decoder can call it without reaching the store at runtime.
import { parseRuntimeErrorDiagnostic } from "../shared/error-diagnostic.ts";
import { readDoneWhen } from "./done-when.ts";
import type { Message } from "./store.ts";

type StoredShape = Pick<Message, "role" | "kind" | "turnId" | "tool">;

export function checkStoredRow<T extends Partial<StoredShape>>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const tool = message.tool;
  if (!tool || typeof tool !== "object") return message;
  const hasDoneWhen = tool.doneWhen !== undefined;
  const hasDiagnostic = tool.diagnostic !== undefined;
  if (!hasDoneWhen && !hasDiagnostic) return message;
  const next = { ...tool };
  if (hasDoneWhen) {
    const read = readDoneWhen(tool.doneWhen);
    if (read.ok && read.value) next.doneWhen = read.value;
    else delete next.doneWhen;
  }
  if (hasDiagnostic) {
    delete next.diagnostic;
    const diagnostic = parseRuntimeErrorDiagnostic(tool.diagnostic);
    if (message.role === "bot" && message.kind === "activity" && diagnostic?.turnId === message.turnId) next.diagnostic = diagnostic;
  }
  return { ...message, tool: next };
}
