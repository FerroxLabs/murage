import { parseBotPackage, type BotPackageDefinition, type BotPackagePlaybook, type ParsedBotPackage } from "./bot-package.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord, GroupRecord, InstalledPlaybook } from "./store.ts";

export function botExportRole(bot: BotRecord): "individual" | "member" | "leader" | "chief" {
  return bot.chiefOfStaff ? bot.chiefScope === "workspace" ? "chief" : "leader" : bot.individual ? "individual" : "member";
}

function portableKey(value: string, fallback: string, used: Set<string>): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || fallback;
  let key = stem;
  for (let suffix = 2; used.has(key); suffix++) key = `${stem}-${suffix}`;
  used.add(key);
  return key;
}

function samePlaybook(a: InstalledPlaybook, b: BotPackagePlaybook): boolean {
  return a.name === b.name && a.summary === b.summary && a.instructions === b.instructions &&
    a.triggers.join("\n") === b.triggers.join("\n");
}

/** Export a workspace definition, never its runtime state. Connected-app
 * labels are retained as setup intent, but grants, credentials, approvals,
 * transcripts, memory, paths, engines, and schedules' active state are not. */
export interface BotPackageExportSelection {
  botIds: string[];
  playbookKeys: string[];
  routineIds: string[];
}
export interface BotPackageExportInput {
  name: string;
  authorName?: string;
  bots: BotRecord[];
  groups: GroupRecord[];
  routines: Routine[];
  selection?: BotPackageExportSelection;
}

function buildBotPackageExport(input: BotPackageExportInput) {
  const bots = input.bots.filter((bot) => !bot.hidden);
  if (!bots.length) throw new Error("Create a bot before exporting your package");
  const selection = input.selection;
  const selected = (field: keyof BotPackageExportSelection): Set<string> | undefined => {
    if (selection === undefined) return undefined;
    const values = selection?.[field];
    if (!Array.isArray(values) || values.some(value => typeof value !== "string") || new Set(values).size !== values.length) throw new Error("Package selection must contain distinct botIds, playbookKeys and routineIds lists");
    return new Set(values);
  };
  const botIds = selected("botIds"), selectedPlaybooks = selected("playbookKeys"), routineIds = selected("routineIds");
  if (botIds && [...botIds].some(id => !bots.some(bot => bot.id === id))) throw new Error("Selected bot is unavailable");
  const selectedBots = bots.filter(bot => !botIds || botIds.has(bot.id));
  if (!selectedBots.length) throw new Error("Select at least one bot for the package");

  const packageKeys = new Set<string>();
  const idToKey = new Map<string, string>();
  for (const [index, bot] of bots.entries()) {
    idToKey.set(bot.id, portableKey(bot.name, `bot-${index + 1}`, packageKeys));
  }

  const playbooks: BotPackagePlaybook[] = [];
  const playbookKeys = new Set<string>();
  const agentPlaybooks = new Map<string, string[]>();
  for (const bot of bots) {
    const agentKey = idToKey.get(bot.id)!;
    const assigned: string[] = [];
    for (const playbook of bot.playbooks ?? []) {
      const existing = playbooks.find((candidate) => candidate.key === playbook.key);
      if (existing && samePlaybook(playbook, existing)) {
        assigned.push(existing.key);
        continue;
      }
      let key = playbook.key;
      if (existing) key = `${agentKey}-${playbook.key}`;
      key = portableKey(key, `${agentKey}-playbook`, playbookKeys);
      if (!playbooks.some((candidate) => candidate.key === key)) playbooks.push({ ...playbook, key });
      assigned.push(key);
    }
    agentPlaybooks.set(bot.id, assigned);
  }
  const availablePlaybooks = new Set(selectedBots.flatMap(bot => agentPlaybooks.get(bot.id) ?? []));
  if (selectedPlaybooks && [...selectedPlaybooks].some(key => !availablePlaybooks.has(key))) throw new Error("Selected playbook is unavailable for the selected bots");
  if (routineIds) for (const id of routineIds) {
    const routine = input.routines.find(routine => routine.id === id);
    if (!routine) throw new Error("Selected routine is unavailable");
    if (routine.target === "room-goal") throw new Error("Room-goal routines are not supported by package export");
    if (!selectedBots.some(bot => bot.id === routine.botId)) throw new Error("Selected routine requires its bot to be selected");
  }

  const requirements = new Map<string, { slug: string; label: string; reason: string; optional?: boolean }>();
  for (const bot of selectedBots) {
    for (const app of bot.installedPackage?.requiredApps ?? []) {
      if (!requirements.has(app.slug)) requirements.set(app.slug, { ...app });
    }
  }

  const roomKeys = new Set<string>();
  const rooms: NonNullable<BotPackageDefinition["rooms"]> = [];
  for (const [index, group] of input.groups.filter((group) => !group.dm).entries()) {
    const allMembers = group.memberIds.filter(id => idToKey.has(id));
    if (!allMembers.length) continue;
    const key = portableKey(group.name, `room-${index + 1}`, roomKeys);
    const members = allMembers.flatMap(id => !botIds || botIds.has(id) ? [idToKey.get(id)!] : []);
    if (!members.length) continue;
    const defaultResponder = group.defaultResponder.kind === "member" && idToKey.has(group.defaultResponder.botId) && (!botIds || botIds.has(group.defaultResponder.botId))
      ? { kind: "agent" as const, agent: idToKey.get(group.defaultResponder.botId)! }
      : group.defaultResponder.kind === "everyone"
        ? { kind: "everyone" as const }
        : { kind: "mentions" as const };
    rooms.push({
      key,
      name: group.name,
      members,
      bulletin: group.bulletin,
      team: group.section,
      defaultResponder,
    });
  }

  const routineKeys = new Set<string>();
  const routineCandidates: Array<{ id: string; key: string | null; name: string; botId: string; supported: boolean; prompt: string; schedule: Routine["schedule"] }> = [];
  const routines: NonNullable<BotPackageDefinition["routines"]> = input.routines.flatMap((routine, index) => {
    // Package v1 only has a single-agent routine shape. Silently exporting a
    // room goal as a bot task would change what it does after import, so keep
    // it out until the portable format can name a package-local room.
    const agent = idToKey.get(routine.botId);
    if (routine.target === "room-goal" || !agent) {
      routineCandidates.push({ id: routine.id, key: null, name: routine.name, botId: routine.botId, supported: false, prompt: routine.prompt, schedule: routine.schedule });
      return [];
    }
    const key = portableKey(routine.name, `routine-${index + 1}`, routineKeys);
    routineCandidates.push({ id: routine.id, key, name: routine.name, botId: routine.botId, supported: true, prompt: routine.prompt, schedule: routine.schedule });
    if ((routineIds && !routineIds.has(routine.id)) || (botIds && !botIds.has(routine.botId))) return [];
    return [{
      key,
      name: routine.name,
      agent,
      prompt: routine.prompt,
      runOn: routine.runOn,
      schedule: routine.schedule.type === "once"
        ? { type: "once", at: routine.schedule.at }
        : routine.schedule.type === "interval"
          ? {
              type: "interval",
              everyMinutes: routine.schedule.everyMinutes,
              anchorAt: routine.schedule.anchorAt,
            }
          : { type: "daily", time: routine.schedule.time, weekdays: [...routine.schedule.weekdays] },
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      enabledAfterInstall: false as const,
    }];
  });

  const id = portableKey(input.name, "murage-package", new Set());
  const agents: BotPackageDefinition["agents"] = selectedBots.map((bot) => {
    const appearance: BotPackageDefinition["agents"][number]["appearance"] = { color: bot.color };
    if (bot.mascotExpression) appearance.mascotExpression = bot.mascotExpression;
    const agent: BotPackageDefinition["agents"][number] = {
      key: idToKey.get(bot.id)!,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      role: botExportRole(bot),
      team: bot.section,
      appearance,
    };
    const assigned = agentPlaybooks.get(bot.id)?.filter(key => !selectedPlaybooks || selectedPlaybooks.has(key));
    if (assigned?.length) agent.playbooks = assigned;
    return agent;
  });
  const definition: BotPackageDefinition = {
    id,
    release: "1.0.0",
    name: input.name,
    tagline: `A portable Murage setup with ${selectedBots.length} ${selectedBots.length === 1 ? "bot" : "bots"}.`,
    summary: "Exported from Murage. Review the roles, rooms, playbooks, connector requirements, and paused routines before sharing or publishing.",
    category: "Community",
    author: { name: input.authorName?.trim() || "Murage user" },
    license: "Unspecified",
    outcomes: ["Recreate this bot setup without copying private runtime state."],
    setupMinutes: Math.min(240, Math.max(2, selectedBots.length + requirements.size * 2)),
    requirements: { apps: [...requirements.values()], capabilities: [] },
    agents,
  };
  const chief = selectedBots.find((bot) => bot.chiefOfStaff && bot.chiefScope === "workspace");
  if (chief) definition.chiefOfStaff = idToKey.get(chief.id)!;
  if (rooms.length) definition.rooms = rooms;
  if (routines.length) definition.routines = routines;
  const exportedPlaybooks = playbooks.filter(playbook => availablePlaybooks.has(playbook.key) && (!selectedPlaybooks || selectedPlaybooks.has(playbook.key)));
  if (exportedPlaybooks.length) definition.playbooks = exportedPlaybooks;
  const parsed = parseBotPackage({
    format: "murage.package",
    version: 1,
    package: definition,
  });
  return { parsed, candidates: {
    bots: bots.map(bot => ({ id: bot.id, key: idToKey.get(bot.id)!, name: bot.name, title: bot.title,
      description: bot.description, role: botExportRole(bot), team: bot.section?.trim() || "General",
      playbookKeys: agentPlaybooks.get(bot.id) ?? [],
      requiredApps: (bot.installedPackage?.requiredApps ?? []).map(app => ({ label: app.label, reason: app.reason })),
    })),
    groups: input.groups.filter(group => !group.dm).map(group => ({ id: group.id, name: group.name, memberIds: group.memberIds.filter(id => idToKey.has(id)) })),
    playbooks: playbooks.map(playbook => ({ key: playbook.key, name: playbook.name, summary: playbook.summary, instructions: playbook.instructions })),
    routines: routineCandidates,
  } };
}

export function createBotPackageExport(input: BotPackageExportInput): ParsedBotPackage {
  return buildBotPackageExport(input).parsed;
}

/** Keys come from the exact default-export mapping, before any selection. */
export function getBotPackageExportSelectionCandidates(input: BotPackageExportInput) {
  return buildBotPackageExport({ ...input, selection: undefined }).candidates;
}
