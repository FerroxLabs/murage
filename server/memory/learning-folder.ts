// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bot folder a CLI or ACP engine launches a learning call in (botFolderOrThrow: no default). A caller that knows which bot the words
// came from runs its engine calls inside `withLearningFolder(thatBotsFolder, ...)`; the resolved extractor reads it back at dispatch.
// A scope that names a bot with no usable folder (cwd undefined) is an explicit "none": the call refuses, it never borrows another bot's.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ cwd: string | undefined }>();
export function withLearningFolder<T>(cwd: string | undefined, run: () => T): T { return scope.run({ cwd }, run); }
/** undefined: no scope is open (the host default applies). An object: the scope's answer, possibly no folder. */
export function learningFolderScope(): { cwd: string | undefined } | undefined { return scope.getStore(); }

let botFolder: ((botId: string) => string | undefined) | undefined;
/** The host's lookup of one bot's resolved folder (its cwd through botFolderOrThrow), registered once at start. */
export function setLearningBotFolder(resolve: ((botId: string) => string | undefined) | undefined): void { botFolder = resolve; }
/** Run learning engine calls made for words that came from `botId` in that bot's folder. A bot with no usable folder is an explicit
 * "none" (the call refuses); no bot named, or no lookup registered: the host default applies. */
export function withBotLearningFolder<T>(botId: string | null | undefined, run: () => T): T {
  return botId && botFolder ? withLearningFolder(botFolder(botId), run) : run();
}
