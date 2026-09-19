// Shared by the welcome screen and the first-run starter import, so the
// client and the server agree on what an untouched new workspace is.

/** The bot a brand-new workspace starts with. The harness seeds one bot on its
 * first start (store.seedIfEmpty) so the app is never empty, and that bot's
 * thread opens with its own greeting and intake question. Counting it as an
 * established workspace skipped the welcome screen on every fresh install, so
 * the first-run check asks a narrower question: is the only thing here that
 * seeded bot, still exactly as it was made? */
export interface SeedBotSummary { threadId?: unknown; title?: unknown; description?: unknown; tasks?: unknown }
export interface SeedThreadPage { messages?: unknown; hasMore?: unknown }

/** One bot, no rooms, nothing written into its profile, one task. Only such a
 * workspace is worth reading a transcript page for. */
export function seedBotCandidate(workspace: { bots: readonly SeedBotSummary[]; groups: readonly unknown[] }): SeedBotSummary | null {
  if (workspace.bots.length !== 1 || workspace.groups.length) return null;
  const bot = workspace.bots[0]!;
  if (typeof bot.threadId !== "string" || !bot.threadId) return null;
  if ((typeof bot.title === "string" && bot.title.trim()) || (typeof bot.description === "string" && bot.description.trim())) return null;
  if (Array.isArray(bot.tasks) && bot.tasks.length > 1) return null;
  return bot;
}

/** The seeded bot's thread still holds only what the bot said on its own: no
 * message from the person, nothing older than this page. Anything unreadable
 * counts as used, so an existing workspace is never sent back to the welcome. */
export function isUntouchedSeedThread(page: SeedThreadPage | null | undefined): boolean {
  if (!page || !Array.isArray(page.messages) || page.hasMore === true) return false;
  return page.messages.every((message: unknown) => {
    const { role, kind } = (message ?? {}) as { role?: unknown; kind?: unknown };
    return role === "bot" && (kind === "text" || kind === "options");
  });
}

/** Whether a first-run starter import may go ahead: the workspace is empty,
 * or the only thing in it is the seeded bot, untouched. `messagesFor` reads
 * the whole thread, so there is no older page to miss. */
export function firstRunImportAllowed(
  workspace: { bots: readonly SeedBotSummary[]; groups: readonly unknown[] },
  messagesFor: (threadId: string) => readonly unknown[],
): boolean {
  if (!workspace.bots.length && !workspace.groups.length) return true;
  const seed = seedBotCandidate(workspace);
  if (!seed) return false;
  return isUntouchedSeedThread({ messages: [...messagesFor(seed.threadId as string)], hasMore: false });
}
