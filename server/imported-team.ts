// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The team an imported package lands in: its name and its lead.
//
// NAME. A team's label is its name everywhere it is shown (sidebar, header,
// cards, notifications, prompts), so it carries no internal id. Before 1.0.2
// an import filed its bots under "Solo Business · General (1a2b3c4d)", the
// first 8 characters of the import id, to keep two imports apart. A plain
// name does that job with a number when it has to: "Solo Business",
// "Solo Business 2".
//
// LEAD. A shipped starter crew (Ferrox's own starter profiles) arrives with
// the lead its package names, when that bot's engine can coordinate bots.
// Third-party packages still record their intended roles only.
//
// Teams imported before 1.0.2 are tidied once at startup: a starter crew
// whose owner has given none of its bots a role gets the lead its package
// named, then the id leaves the name through the ordinary rename journal. A
// team whose name no longer carries the id was named by its owner (or is
// already tidied), so it is never touched.

import { RESERVED_TEAM_NAMES, TEAM_NAME_MAX } from "./team-name-rules.ts";

const fold = (label: string) => label.trim().toLocaleLowerCase();

/** "Solo Business · General (1a2b3c4d)": a label an import before 1.0.2 wrote. */
const LEGACY_LABEL = /^(.+?) · (.+) \(([0-9a-f]{8})\)$/;

/** A team name no other team holds: the package name, with its own team
 * name when the package has several ("Studio · Design"), then " 2", " 3"... */
export function importedTeamName(packageName: string, team: string | undefined, taken: Iterable<string>): string {
  const used = new Set([...taken].map(fold));
  for (const name of RESERVED_TEAM_NAMES) used.add(fold(name));
  const own = team?.trim();
  const base = (own && fold(own) !== "general" ? `${packageName.trim()} · ${own}` : packageName.trim()) || "Imported team";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const name = `${base.slice(0, TEAM_NAME_MAX - suffix.length).trim()}${suffix}`;
    if (!used.has(fold(name))) return name;
  }
}

/** The plain name for a label an earlier import wrote, or null for any
 * other label (the owner's own name is never changed). */
export function legacyImportedLabel(label: string, packageNames: ReadonlySet<string>): { packageName: string; team: string } | null {
  const match = LEGACY_LABEL.exec(label.trim());
  if (!match || !packageNames.has(match[1]!)) return null;
  return { packageName: match[1]!, team: match[2]! };
}

export interface ImportedTeamBot {
  id: string;
  name: string;
  section?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  chiefScope?: string;
  individual?: boolean;
  installedPackage?: { id: string; name: string; sourceRole?: string };
}

export interface TidyImportedTeamsDeps<B extends ImportedTeamBot> {
  bots: readonly B[];
  /** Every label in use, bots and channels, archived ones included. */
  labels: readonly string[];
  /** Package ids whose crews are shipped by Ferrox and may arrive led. */
  starterPackages: ReadonlySet<string>;
  /** Rename one team through the team journal; throws when it cannot. */
  rename(from: string, to: string): void;
  /** Make this bot its team's lead; throws when it cannot. */
  makeLead(bot: B): void;
  /** Null when this bot's engine can coordinate bots, else why not. */
  leadershipError(bot: B): string | null;
}

/** Tidy teams imported before 1.0.2. Returns what changed, for the boot log. */
export function tidyImportedTeams<B extends ImportedTeamBot>(deps: TidyImportedTeamsDeps<B>): string[] {
  const notes: string[] = [];
  const packageNames = new Set(deps.bots.flatMap((bot) => (bot.installedPackage ? [bot.installedPackage.name] : [])));
  const labels = [...new Set(deps.labels.map((label) => label.trim()).filter(Boolean))];
  const taken = new Set(labels);
  for (const label of labels) {
    const legacy = legacyImportedLabel(label, packageNames);
    if (!legacy) continue;
    const members = deps.bots.filter((bot) => bot.section?.trim() === label);
    // Only a team its package made: every bot on it came from that package.
    if (!members.length || members.some((bot) => bot.installedPackage?.name !== legacy.packageName)) continue;
    taken.delete(label);
    const to = importedTeamName(legacy.packageName, legacy.team, taken);
    // The lead comes first and the name last: the legacy name is what marks a
    // team as untidied, so a crash or failure in between leaves it to be
    // finished at the next start. An import before 1.0.2 gave no bot a role,
    // so any lead or Individual Assistant on the crew is the owner's choice,
    // and then no lead is appointed (and no role is ever overwritten).
    const ownerChoseRoles = members.some((bot) => bot.chiefOfStaff === true || bot.individual === true);
    const lead = ownerChoseRoles ? undefined : members.find((bot) => !bot.hidden && bot.installedPackage && deps.starterPackages.has(bot.installedPackage.id)
      && (bot.installedPackage.sourceRole === "leader" || bot.installedPackage.sourceRole === "chief"));
    if (lead && !deps.leadershipError(lead)) {
      try {
        deps.makeLead(lead);
      } catch (error) {
        taken.add(label);
        notes.push(`${lead.name} could not lead ${label} yet: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      notes.push(`${lead.name} now leads ${to}.`);
    }
    try {
      deps.rename(label, to);
    } catch (error) {
      taken.add(label);
      notes.push(`Team ${label} keeps its name: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    taken.add(to);
    notes.push(`Imported team renamed to ${to}.`);
  }
  return notes;
}

/** Which bot of a shipped starter crew leads its team on import: the one the
 * package marks as leader, else the one it names as its Chief of Staff. */
export function starterLeadKey(pkg: { chiefOfStaff?: string; agents: ReadonlyArray<{ key: string; role?: string; team?: string }> }, team: string | undefined): string | null {
  const members = pkg.agents.filter((agent) => (agent.team?.trim() || "") === (team?.trim() || ""));
  if (members.length < 2) return null;
  return members.find((agent) => agent.role === "leader")?.key
    ?? members.find((agent) => agent.key === pkg.chiefOfStaff && agent.role !== "individual")?.key
    ?? null;
}
