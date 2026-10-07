import { canReach, type ReachableBot } from "./store.ts";
import { murageToolOnThisServer } from "./murage-tool-surface.ts";

/** Resolve only after scope filtering; never fall back to a provider session address. */
/** The fixed line a bot relays when the target exists but is outside its reach. */
export function outOfReachLine(fromName: string, toName: string): string {
  return `${toName} isn't in ${fromName}'s team. To let ${fromName} talk to ${toName}, open ${fromName}'s settings, Permissions, Can talk to, and add ${toName}. Or put them in a project together.`;
}

export function resolveCoordinationTarget<T extends ReachableBot & { id: string; name: string; hidden?: boolean }>(
  from: T, roster: T[], selector: string,
  /** Who `from` may reach; `canReach` unless the caller widens it (messageAllow, project membership). */
  reach: (peer: T) => boolean = (peer) => canReach(from, peer),
  /** The real refusal for a peer the check turned down (room or project scope, say), kept instead of the default remedy. */
  refusalLine?: (peer: T) => string | undefined,
): T {
  const peers = roster.filter(bot => !bot.hidden && (bot.id === from.id || reach(bot)));
  const exactId = peers.find(bot => bot.id === selector);
  if (exactId) return exactId;
  const name = selector.trim().toLocaleLowerCase();
  const exact = peers.filter(bot => bot.name.trim().toLocaleLowerCase() === name);
  const matches = exact.length ? exact : peers.filter(bot => bot.name.trim().toLocaleLowerCase().startsWith(name + " ("));
  if (!matches.length) {
    // Exists on this workspace but outside reach: say how the owner fixes it.
    // Shared (partitioned) bots are never named here.
    const known = roster.filter(bot => !bot.hidden && bot.id !== from.id && (bot as { partitionedAt?: number }).partitionedAt === undefined);
    const out = known.find(bot => bot.id === selector) ?? (() => {
      const hit = known.filter(bot => bot.name.trim().toLocaleLowerCase() === name || bot.name.trim().toLocaleLowerCase().startsWith(name + " ("));
      return hit.length === 1 ? hit[0] : undefined;
    })();
    if (out) throw Object.assign(new Error(refusalLine?.(out) ?? outOfReachLine(from.name, out.name)), { status: 403, code: "BOT_OUT_OF_REACH" });
  }
  if (matches.length !== 1) throw Object.assign(new Error(matches.length
    ? `BOT_NAME_AMBIGUOUS: use the stable bot ID from ${murageToolOnThisServer("list_bots")}`
    : `BOT_NOT_ON_ROSTER: use the stable bot ID from ${murageToolOnThisServer("list_bots")}, not a native provider session address`), { status: matches.length ? 409 : 404 });
  return matches[0];
}
