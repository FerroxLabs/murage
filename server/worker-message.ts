// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A stored conversation row as the hand-off boundary reads it: the words in it are sealed (a reply's text, a tool's name), so the boundary can ask
// whether there are any, and can pass them to the result gate, but cannot read, join or forward them. The rest of the row (its id, its time, who
// it answers, whether it ends a turn) is plain. A row that records a failure or a retry says so, so what a bot is told of it can be the kind of
// failure and never the provider's own words (server/result-egress.ts `releaseMessage`).
import type { WorkerText } from "./released-text.ts";

export interface WorkerMessage {
  id: string;
  at: number;
  role: string;
  kind: string;
  requestId?: string;
  turnTerminal?: boolean;
  actorKind?: string;
  replyToId?: string;
  text?: WorkerText;
  tool?: { name: WorkerText; ok?: boolean };
  /** Set when the row describes a step that failed or is being retried. */
  failure?: "retrying" | "error";
}
