import { Crown, UserRound, Users } from "lucide-react";

import { botRole, BOT_ROLE_BADGE, BOT_ROLE_TITLE, type BotRole, type RoleBot } from "@/lib/bot-role";
import { cn } from "@/lib/cn";

const ROLE_ICON = { chief: Crown, leader: Users, individual: UserRound } as const;

/** Three tiers, three marks. The Chief keeps the accent pill it already had,
 * so nothing about an existing workspace changes look; the two roles below it
 * are told apart by icon and label on a neutral chip rather than by a second
 * accent, which would make three things shout at once. */
const ROLE_CHIP: Record<Exclude<BotRole, "member">, string> = {
  chief: "bg-accent/12 text-accent",
  leader: "bg-control text-ink",
  individual: "bg-control text-ink-secondary",
};

/**
 * Where a bot sits, wherever a bot is named. A team member wears nothing:
 * it is the default, and a badge on every row would carry no information.
 *
 * `labelClassName` is how a caller folds the badge to its icon in a narrow
 * container — the chat header does exactly that at container widths where
 * the pill used to wrap to three lines and eat the bot's name.
 */
export function RoleBadge({
  bot,
  labelClassName,
  className,
}: {
  bot: RoleBot;
  labelClassName?: string;
  className?: string;
}) {
  const role = botRole(bot);
  if (role === "member") return null;
  const Icon = ROLE_ICON[role];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        ROLE_CHIP[role],
        className,
      )}
      title={BOT_ROLE_TITLE[role]}
      // The label is what folds away in a narrow container, so the accessible
      // name lives on the chip and stays whole at every width.
      aria-label={BOT_ROLE_TITLE[role]}
    >
      <Icon size={11} aria-hidden />
      <span className={labelClassName}>{BOT_ROLE_BADGE[role]}</span>
    </span>
  );
}

/** The same three tiers as a bare icon, for rows that have no room for a
 * chip (the sidebar, the team map's nodes).
 *
 * `decorative` when the row already spells the role out in text beside it —
 * otherwise the row's accessible name reads "Individual assistant Individual"
 * and the mark that exists to save space costs a word instead. */
export function RoleIcon({
  bot,
  size = 16,
  className,
  decorative = false,
}: {
  bot: RoleBot;
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  const role = botRole(bot);
  if (role === "member") return null;
  const Icon = ROLE_ICON[role];
  return (
    <Icon
      size={size}
      className={cn("shrink-0", className)}
      {...(decorative ? { "aria-hidden": true } : { "aria-label": BOT_ROLE_TITLE[role] })}
    />
  );
}
