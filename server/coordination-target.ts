import { canReach, type ReachableBot } from "./store.ts";

/** Resolve only after scope filtering; never fall back to a provider session address. */
export function resolveCoordinationTarget<T extends ReachableBot & { id: string; name: string; hidden?: boolean }>(
  from: T, roster: T[], selector: string,
): T {
  const peers = roster.filter(bot => !bot.hidden && (bot.id === from.id || canReach(from, bot)));
  const exactId = peers.find(bot => bot.id === selector);
  if (exactId) return exactId;
  const name = selector.trim().toLocaleLowerCase();
  const exact = peers.filter(bot => bot.name.trim().toLocaleLowerCase() === name);
  const matches = exact.length ? exact : peers.filter(bot => bot.name.trim().toLocaleLowerCase().startsWith(name + " ("));
  if (matches.length !== 1) throw Object.assign(new Error(matches.length
    ? "BOT_NAME_AMBIGUOUS: use the stable bot ID from list_bots"
    : "BOT_NOT_ON_ROSTER: use the stable bot ID from list_bots, not a native provider session address"), { status: matches.length ? 409 : 404 });
  return matches[0];
}
