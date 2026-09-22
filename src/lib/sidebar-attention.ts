export type SidebarAttentionActivity =
  | "working"
  | "waiting-on-you"
  | "idle"
  | "no-signal"
  | "dead";

/** One context of a bot. A bot waits per thread, so this is what a count of
 *  "things waiting on you" is actually counting. */
export type SidebarAttentionTask = {
  activity?: SidebarAttentionActivity;
};

export type SidebarAttentionBot = {
  unread?: boolean;
  busy?: boolean;
  activity?: SidebarAttentionActivity;
  tasks?: SidebarAttentionTask[];
};

export type SidebarAttentionGroup = {
  unread?: boolean;
  busyBotId?: string | null;
};

/** The single mark a sidebar row is allowed to carry.
 *
 *  A dot used to mean "unread", which nearly every row was, so the dot meant
 *  nothing: a mark that is always on is furniture. A dot now means one thing
 *  only — this row is waiting on you, which is the same thing the Inbox lists
 *  under "Needs you". The other two states keep their information and lose
 *  their colour: `working` is motion (it resolves itself, so it never carries
 *  a number), `unread` is the name's weight. Every kind still names itself to
 *  a screen reader through `sidebarMarkLabel`. */
export type SidebarMark =
  | { kind: "waiting"; count: number }
  | { kind: "working" }
  | { kind: "unread" }
  | { kind: "none" };

/** The one test for "this thread is blocked on the owner".
 *
 *  Exported because the sidebar row and the task switcher both have to answer
 *  it, and a bot row that says "Waiting for you" over a task list that says
 *  "Working" sends the owner hunting through a transcript. One predicate, so
 *  the two controls cannot disagree. */
export function taskWaitsOnYou(task: SidebarAttentionTask): boolean {
  return task.activity === "waiting-on-you";
}

/** Waiting outranks working outranks unread: one row, one mark. */
export function sidebarBotMark(bot: SidebarAttentionBot): SidebarMark {
  if (bot.activity === "waiting-on-you") {
    // One decision per waiting thread. A bot with no task list (or one that
    // has not loaded) is still waiting on exactly one thing.
    const threads = (bot.tasks ?? []).filter(taskWaitsOnYou).length;
    return { kind: "waiting", count: Math.max(1, threads) };
  }
  if (bot.activity === "working" || Boolean(bot.busy)) return { kind: "working" };
  if (bot.unread) return { kind: "unread" };
  return { kind: "none" };
}

/** Channels never hold a decision of their own; they work, or they are unread.
 *  Uses the same predicate the collapsed-section rollup counts with. */
export function sidebarGroupMark(group: SidebarAttentionGroup): SidebarMark {
  if (group.busyBotId) return { kind: "working" };
  if (group.unread) return { kind: "unread" };
  return { kind: "none" };
}

/** What the row says out loud. Only `waiting` is drawn in colour, so this is
 *  the only place working and unread survive for assistive technology. */
export function sidebarMarkLabel(mark: SidebarMark): string {
  if (mark.kind === "waiting") {
    return mark.count > 1 ? `${mark.count} waiting for you` : "Waiting for you";
  }
  if (mark.kind === "working") return "Working";
  if (mark.kind === "unread") return "Unread";
  return "";
}

/** Unread is carried by the name's weight, because the dot is spent. A row
 *  with nothing to say sits plain and dimmed under the ones that do. */
export function sidebarMarkNameClass(mark: SidebarMark): string {
  if (mark.kind === "unread") return "font-bold text-ink";
  if (mark.kind === "none") return "font-medium text-ink/70";
  return "font-medium text-ink";
}

/** The tint that backs the amber dot. Waiting only — nothing else is coloured. */
export function sidebarMarkRowClass(mark: SidebarMark): string {
  return mark.kind === "waiting" ? "bg-warning/10" : "";
}

export type SidebarSectionAttention = {
  unread: number;
  waiting: number;
  working: number;
};

/** Summarize signals that would otherwise disappear when a section closes. */
export function sidebarSectionAttention(
  bots: SidebarAttentionBot[],
  groups: SidebarAttentionGroup[],
): SidebarSectionAttention {
  return {
    unread:
      bots.filter((bot) => Boolean(bot.unread)).length +
      groups.filter((group) => Boolean(group.unread)).length,
    waiting: bots.filter((bot) => bot.activity === "waiting-on-you").length,
    working:
      bots.filter(
        (bot) =>
          bot.activity === "working" ||
          (Boolean(bot.busy) && bot.activity !== "waiting-on-you"),
      ).length + groups.filter((group) => Boolean(group.busyBotId)).length,
  };
}

export function sidebarAttentionLabel(attention: SidebarSectionAttention): string {
  const parts: string[] = [];
  if (attention.waiting > 0) {
    parts.push(`${attention.waiting} waiting for you`);
  }
  if (attention.unread > 0) {
    parts.push(`${attention.unread} unread`);
  }
  if (attention.working > 0) {
    parts.push(`${attention.working} working`);
  }
  return parts.join(", ");
}
