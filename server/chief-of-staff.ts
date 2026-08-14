export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
}

/** Dynamic system context for the one workspace-wide Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
): string {
  const team = bots.filter((bot) => bot.id !== chiefId && !bot.hidden);
  const roster = team.length
    ? team
        .map((bot) => {
          const role = bot.title?.trim() || "General assistant";
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${bot.name} — ${role}${about ? `: ${about}` : ""} (${availability})`;
        })
        .join("\n")
    : "- No other visible bots are available yet.";

  const delegation = canDelegate
    ? [
        "Use list_bots to confirm the live roster and IDs. Use ask_bot when a teammate is better suited to part of the request.",
        "Delegate with a clear, self-contained brief and wait for the teammate's actual reply before claiming its work is complete.",
        "You may consult more than one teammate when the request genuinely benefits, then combine their results into one coherent answer.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    "You are the workspace's one Chief of Staff. You are the user's primary contact across their team of bots.",
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    "Current workspace team:",
    roster,
  ].join("\n");
}
