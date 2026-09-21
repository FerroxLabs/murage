// Delegation admission: asking the question the dispatch is about to ask.
//
// `runDelegatedTurn` runs a handoff on exactly ONE thread — the target's task
// for the source thread's human principal, its main thread otherwise — and
// `startTurn` admits that turn on exactly three conditions: that thread is not
// already running, the bot is not mid-room-turn, and the bot is under the
// concurrent-thread ceiling.
//
// Admission used to test `bot.busy` instead, which is the UNION over all of
// the bot's threads. A teammate busy on a routine in a detached task thread
// therefore refused handoffs that its free threads could have taken — the
// caller got "waiting — they're busy" for a bot that was not busy for this
// work at all.
//
// This is the predicate, with its four collaborators passed in rather than
// closed over. It lived inside server/index.ts, which boots a server on
// import, so the only test reachable for it read index.ts as TEXT and checked
// that three identifiers appeared inside the function body. That check cannot
// tell a mirrored condition from an inverted one, and it cannot see WHICH
// thread the predicate asks about — which is the half that was wrong before.
// Here it runs.
//
// Throwing is not an option on the drain path: an unreadable principal means
// "not now", which is where a busy target already ends up.

export interface HandoffAdmission {
  /** the target's record, or null/undefined when the roster no longer has it */
  bot(botId: string): { threadId: string } | null | undefined;
  /** the thread `runDelegatedTurn` will use for a handoff arriving from
   * `sourceThreadId`. May throw: an unreadable human principal is a refusal,
   * never an exception on the drain path. */
  handoffThread(botId: string, sourceThreadId: string): string | undefined;
  /** is a turn already running on exactly that thread */
  threadBusy(botId: string, threadId: string): boolean;
  /** is the bot mid-turn in a room */
  groupTurnActive(botId: string): boolean;
  /** how many of this bot's threads are running right now */
  runningThreads(botId: string): number;
  /** the concurrent-thread ceiling startTurn enforces */
  maxThreads: number;
}

export function handoffCanStart(deps: HandoffAdmission, botId: string, sourceThreadId: string): boolean {
  const profile = deps.bot(botId);
  if (!profile) return false;
  let threadId: string;
  try {
    threadId = deps.handoffThread(botId, sourceThreadId) ?? profile.threadId;
  } catch {
    return false;
  }
  if (deps.threadBusy(botId, threadId) || deps.groupTurnActive(botId)) return false;
  return deps.runningThreads(botId) < deps.maxThreads;
}
