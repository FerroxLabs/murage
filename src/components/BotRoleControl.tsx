import { Crown, User, UserRound, Users } from "lucide-react";

import { botRole, botRolePatch, BOT_ROLE_TITLE, type BotRole } from "@/lib/bot-role";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

const ROLE_ICON = { chief: Crown, leader: Users, individual: UserRound, member: User } as const;

/** Who holds a single-holder role today, if it is not this bot. Both roles
 * are handovers rather than errors in the harness — electing a second Chief
 * demotes the first to leader of its own team, and electing a second leader
 * of one team demotes that team's current one — so the control says whose
 * role is about to move instead of pretending the choice is free. */
function currentHolder(bots: Bot[], selfId: string, role: BotRole, section: string): Bot | undefined {
  return bots.find((candidate) => {
    if (candidate.id === selfId || candidate.hidden) return false;
    if (role === "chief") return botRole(candidate) === "chief";
    return botRole(candidate) === "leader" && (candidate.section?.trim() || "") === section;
  });
}

/** One row of the chart. A whole-row label rather than a bare radio: the
 * target is the card, not a 16px dot, which is what makes this usable with a
 * thumb at 390px. */
function RoleOption({
  role,
  bot,
  selected,
  disabled,
  detail,
  note,
  onSelect,
}: {
  role: BotRole;
  bot: Bot;
  selected: boolean;
  disabled: boolean;
  detail: string;
  note?: string;
  onSelect: () => void;
}) {
  const Icon = ROLE_ICON[role];
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60",
        selected ? "border-accent/50 bg-accent/10" : "border-hairline/40 bg-card hover:bg-raised/50",
        disabled && "cursor-not-allowed opacity-45 hover:bg-card",
      )}
      title={disabled ? "This engine cannot contact other bots" : undefined}
    >
      <input
        type="radio"
        name={`bot-role-${bot.id}`}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          selected ? "bg-accent text-white" : "bg-control text-ink-secondary",
        )}
        aria-hidden
      >
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{BOT_ROLE_TITLE[role]}</span>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-secondary">{detail}</span>
        {note && <span className="mt-1.5 block text-[12.5px] leading-relaxed text-warning">{note}</span>}
      </span>
      <span
        className={cn(
          "mt-1 flex size-[18px] shrink-0 items-center justify-center rounded-full border",
          selected ? "border-accent" : "border-hairline",
        )}
        aria-hidden
      >
        {selected && <span className="size-2.5 rounded-full bg-accent" />}
      </span>
    </label>
  );
}

/**
 * The org chart, as the control that sets it.
 *
 * Four roles, drawn at the depth they actually occupy: the Chief at the top,
 * team leaders and individual assistants as the two branches beneath it, and
 * a team member one step further down under its leader. The rails are the
 * hierarchy — there is nothing else to read and nothing to learn.
 *
 * Every option always sends all three role fields together (see
 * `botRolePatch`). The harness refuses `individual` alongside a Chief role,
 * and a partial patch is the only way to ask for that combination by
 * accident.
 */
export function BotRoleControl({ bot, canCoordinate }: { bot: Bot; canCoordinate: boolean }) {
  const { state, dispatch } = useStore();
  const role = botRole(bot);
  const section = bot.section?.trim() || "";
  const teamName = section || "General";
  const chiefHolder = currentHolder(state.bots, bot.id, "chief", section);
  const leadHolder = currentHolder(state.bots, bot.id, "leader", section);

  const select = (next: BotRole) => {
    if (next === role) return;
    dispatch({ type: "updateBot", botId: bot.id, patch: botRolePatch(next) });
  };

  // Today's rule, kept: a bot that leads has to be able to reach the bots it
  // leads. Working alone needs no such engine, so that branch stays open.
  const leadershipBlocked = !canCoordinate && role !== "chief" && role !== "leader";

  const option = (next: BotRole, detail: string, note?: string) => (
    <RoleOption
      role={next}
      bot={bot}
      selected={role === next}
      disabled={leadershipBlocked && (next === "chief" || next === "leader")}
      detail={detail}
      note={note}
      onSelect={() => select(next)}
    />
  );

  return (
    <div className="rounded-xl border border-hairline/40 bg-panel p-4">
      <div className="text-[15px] font-medium text-ink">Role</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
        Where {bot.name} sits in the workspace, and who it answers to.
      </div>

      <div
        role="radiogroup"
        aria-label={`Role for ${bot.name}`}
        className="mt-3.5 flex flex-col gap-2"
      >
        {option(
          "chief",
          "Runs the whole workspace. Hands each team's work to its leader and works with the individual assistants directly. One per workspace.",
          chiefHolder && `${chiefHolder.name} is Chief of Staff today. Choosing this hands the role over; ${chiefHolder.name} stays on as a team leader.`,
        )}

        {/* The rail IS the hierarchy: everything inside this border hangs off
            the Chief, and the nested rail below hangs off the team leader.
            One 16px step at each depth, so the three columns of copy line up
            instead of nearly lining up. */}
        <div className="ml-4 flex flex-col gap-2 border-l border-hairline/70 pl-4">
          {option(
            "leader",
            `Leads the ${teamName} team and coordinates its members. One per team.`,
            leadHolder && `${leadHolder.name} leads ${teamName} today. Choosing this hands the role over.`,
          )}

          <div className="ml-4 border-l border-hairline/70 pl-4">
            {option("member", `Works inside ${teamName}, alongside the rest of that team.`)}
          </div>

          {option(
            "individual",
            "Works alone in its own group, with no team leader above it. Reports to the Chief of Staff directly.",
          )}
        </div>
      </div>

      {leadershipBlocked && (
        <div className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
          Choose a Claude or ACP engine to let {bot.name} lead. Leading means contacting other bots, and its
          current engine cannot.
        </div>
      )}
      {!canCoordinate && (role === "chief" || role === "leader") && (
        <div className="mt-3 text-[12.5px] leading-relaxed text-warning">
          {bot.name} still holds this role, but its current engine cannot contact teammates. Choose a Claude or
          ACP engine to restore coordination.
        </div>
      )}
    </div>
  );
}
