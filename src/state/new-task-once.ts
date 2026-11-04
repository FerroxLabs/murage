// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// New conversation makes one conversation per action. A double or triple
// click sent one POST per click, and each POST made its own empty
// conversation. While a bot's new conversation is being made, a click for the
// same folder is that same action and is dropped; a click for another folder
// waits for it, then runs.
//
// Behaviour ported from upstream d124292a2 (OpenMausBot, MIT).

export function createNewTaskOnce() {
  const beingMade = new Map<string, { cwd: string | undefined; done: Promise<void> }>();
  /** Folders with a kept click waiting, per bot: a second click for one is the same action. */
  const waiting = new Map<string, Set<string | undefined>>();
  /**
   * `accept` runs at once for a click that is kept (made now or queued for
   * another folder), never for a dropped one; its result goes to `make`. The
   * store takes its page intent there, so a queued create made after the
   * person switched to another conversation cannot take the screen back.
   */
  return function newTaskOnce<T>(botId: string, cwd: string | undefined, accept: () => T, make: (accepted: T) => Promise<unknown>): void {
    const making = beingMade.get(botId);
    if (making) {
      const queued = waiting.get(botId) ?? new Set<string | undefined>();
      if (making.cwd !== cwd && !queued.has(cwd)) {
        queued.add(cwd);
        waiting.set(botId, queued);
        const accepted = accept();
        void making.done.then(() => run(botId, cwd, () => {
          waiting.get(botId)?.delete(cwd);
          return make(accepted);
        }));
      }
      return;
    }
    const accepted = accept();
    run(botId, cwd, () => make(accepted));
  };

  function run(botId: string, cwd: string | undefined, make: () => Promise<unknown>): void {
    const making = beingMade.get(botId);
    if (making) {
      // another kept click got in first: this one waits its turn
      void making.done.then(() => run(botId, cwd, make));
      return;
    }
    const done = Promise.resolve()
      .then(make)
      .then(() => undefined, () => undefined)
      .finally(() => { if (beingMade.get(botId)?.done === done) beingMade.delete(botId); });
    beingMade.set(botId, { cwd, done });
  }
}
