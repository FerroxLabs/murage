import type { Bot, Group, GroupDefaultResponder } from "@/state/store";
import { mentionedPeers, mentionsEveryone } from "../../shared/mention-boundary";

/** Be defensive around rooms loaded while an older server is still running,
 * and around a lead removed by another client before the group patch arrives. */
export function effectiveDefaultResponder(
  group: Pick<Group, "defaultResponder">,
  members: Array<{ id: string }>,
): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (value?.kind === "auto") return value;
  if (value?.kind === "member" && members.some((member) => member.id === value.botId)) return value;
  return members[0] ? { kind: "member", botId: members[0].id } : { kind: "mentions" };
}

/** Who answers when an `auto` room cannot decide: the saved fallback if it is
 * still a member, else the first member. Same rule as server roomResponders. */
export function autoFallbackBot<T extends { id: string; hidden?: boolean }>(
  value: { fallbackBotId?: string },
  members: T[],
): T | undefined {
  const available = members.filter((member) => !member.hidden);
  return available.find((member) => member.id === value.fallbackBotId) ?? available[0];
}

/** The decision model is on and set to route rooms. */
export function deciderRoutesRooms(config: { decider?: { enabled: boolean; jobs?: { roomRouting?: boolean } } } | null | undefined): boolean {
  return config?.decider?.enabled === true && config.decider.jobs?.roomRouting === true;
}

export function defaultResponderName(group: Group, members: Bot[]): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "auto") return autoFallbackBot(value, members)?.name ?? null;
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

export function groupResponseHint(group: Group, members: Bot[]): string {
  if (group.dm) return "Reply here to continue the bot-to-bot conversation.";
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return "Everyone responds unless you @mention specific bots.";
  if (value.kind === "mentions") return "Mention a bot with @ to bring them in.";
  if (value.kind === "auto") return "Murage picks who answers; @mention someone to choose them instead.";
  const name = defaultResponderName(group, members) ?? "The lead bot";
  return `${name} responds by default; @mention someone else to choose them instead.`;
}

export function groupComposerHint(group: Group, members: Bot[]): string {
  if (group.dm) return "continue the conversation";
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return "everyone responds";
  if (value.kind === "mentions") return "@ to bring a bot in";
  if (value.kind === "auto") return "Murage picks who answers";
  return `${defaultResponderName(group, members) ?? "Lead"} responds`;
}

/** Same routing sendGroup uses: explicit @mentions win, then a reply to an
 * active member's message addresses that member, otherwise the room's
 * default responder. Keep this aligned with server/store.ts
 * `roomResponders` / `mentionedBots`. */
export function roomRespondersForComposer<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
  replyToBotId?: string,
): T[] {
  const available = members.filter((member) => !member.hidden);
  if (mentionsEveryone(text)) return available;
  const mentioned = mentionedPeers(text, available);
  if (mentioned.length) return mentioned;
  const repliedTo = replyToBotId ? available.find((member) => member.id === replyToBotId) : undefined;
  if (repliedTo) return [repliedTo];
  const fallback = effectiveDefaultResponder(group, available);
  if (fallback.kind === "everyone") return available;
  if (fallback.kind === "member") {
    const lead = available.find((member) => member.id === fallback.botId);
    return lead ? [lead] : [];
  }
  if (fallback.kind === "auto") {
    // The preview shows the fallback; the decision model may pick another.
    const lead = autoFallbackBot(fallback, available);
    return lead ? [lead] : [];
  }
  return [];
}

/** Goal mode always starts with one coordinator: an explicit mention, the
 * configured lead, an in-room Chief, or the first active member. Keep this
 * aligned with the server's selectGroupGoalCoordinator path. */
export function goalCoordinatorForComposer<
  T extends { id: string; name: string; hidden?: boolean; chiefOfStaff?: boolean },
>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
): T | null {
  const available = members.filter((member) => !member.hidden);
  const explicitlyMentioned = roomRespondersForComposer(
    text,
    available,
    { defaultResponder: { kind: "mentions" } },
  )[0];
  if (explicitlyMentioned) return explicitlyMentioned;
  const configuredResponder = group.defaultResponder;
  if (configuredResponder?.kind === "member") {
    const configured = available.find((member) => member.id === configuredResponder.botId);
    if (configured) return configured;
  }
  return available.find((member) => member.chiefOfStaff) ?? available[0] ?? null;
}

