import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelSelection } from "./contracts.ts";
import { canReach, isWorkspaceChief, sectionKey, type BotRecord, type Store } from "./store.ts";

const id = z.string().min(1).max(180);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), botId: id }).strict(),
  z.object({ action: z.literal("update"), botId: id, revision,
    name: z.string().trim().min(1).max(80).optional(),
    role: z.string().trim().max(120).optional(),
    instructions: z.string().trim().max(8000).optional(),
    modelSelection: z.unknown().optional(),
  }).strict(),
  z.object({ action: z.enum(["archive", "restore"]), botId: id, revision }).strict(),
  z.object({ action: z.literal("move"), botId: id, revision, organizationRevision: revision, section: z.string().trim().min(1).max(60) }).strict(),
  z.object({ action: z.literal("set-lead"), botId: id, revision, organizationRevision: revision }).strict(),
]);

const fail = (message: string, status = 403): never => { throw Object.assign(new Error(message), { status }); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function mayInspectBot(sender: BotRecord, target: BotRecord): boolean {
  return sender.id === target.id || isWorkspaceChief(sender)
    || sender.chiefOfStaff === true && sectionKey(sender.section) === sectionKey(target.section)
    || !target.hidden && canReach(sender, target);
}

/** Only profile fields: never credentials, paths, transcripts or approval grants. */
export function managedBotProfile(bot: BotRecord) {
  const profile = {
    id: bot.id, name: bot.name, role: bot.title ?? "", instructions: bot.description ?? "",
    modelSelection: bot.modelSelection, section: bot.section ?? "", archived: Boolean(bot.hidden),
    chief: isWorkspaceChief(bot), lead: bot.chiefOfStaff === true && !isWorkspaceChief(bot),
    individual: Boolean(bot.individual),
  };
  return { ...profile, revision: digest(profile), busy: Boolean(bot.busy) };
}

export function organizationRevision(store: Store, sender: BotRecord) {
  return digest(store.bots.filter(bot => mayInspectBot(sender, bot))
    .map(bot => [bot.id, managedBotProfile(bot).revision]).sort(([a], [b]) => a.localeCompare(b)));
}

interface ManagementOptions {
  pendingWork: (bot: BotRecord) => boolean;
  validateSelection: (input: unknown, bot: BotRecord) => ModelSelection;
  validateLeader: (selection: ModelSelection) => void;
  revoke: (id: string) => void;
}

export function manageBot(store: Store, sender: BotRecord, input: unknown, options: ManagementOptions) {
  if (sender.hidden) return fail("This bot is archived and cannot manage the organization.");
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid bot-management request. Security settings cannot be changed here.", 400);
  const request = parsed.data;
  const target = store.bot(request.botId);
  if (!target || !mayInspectBot(sender, target)) return fail("That bot is not in your permitted organization.", 404);
  const organization = organizationRevision(store, sender);
  if (request.action === "get") return { bot: managedBotProfile(target), organizationRevision: organization };
  if (!sender.chiefOfStaff || sender.hidden || isWorkspaceChief(target)
    || !isWorkspaceChief(sender) && (target.chiefOfStaff || sectionKey(sender.section) !== sectionKey(target.section))) {
    return fail("Only the responsible team lead or Chief of Staff can manage this bot. The owner controls the Chief of Staff.");
  }
  if (managedBotProfile(target).revision !== request.revision) return fail("This bot changed. Read its current profile before applying the update.", 409);
  if ((request.action === "move" || request.action === "set-lead") && request.organizationRevision !== organization) {
    return fail("The organization changed. Read it again before changing teams or leadership.", 409);
  }
  // Instruction-only edits take effect next turn. Structural/model edits wait
  // for all active or admitted work; none of these operations interrupts it.
  const idleRequired = request.action !== "update" || request.modelSelection !== undefined;
  const idle = (bot: BotRecord) => {
    if (bot.busy || options.pendingWork(bot)) fail("This bot has active or pending work. Let it finish before making this change.", 409);
  };
  if (idleRequired) idle(target);
  if (request.action === "update") {
    const patch: Partial<BotRecord> = {};
    if (request.name !== undefined) {
      if (store.bots.some(bot => bot.id !== target.id && !bot.hidden && sectionKey(bot.section) === sectionKey(target.section)
        && bot.name.toLowerCase() === request.name!.toLowerCase())) fail("That name is already used in this team.", 409);
      patch.name = request.name;
    }
    if (request.role !== undefined) patch.title = request.role;
    if (request.instructions !== undefined) patch.description = request.instructions;
    if (request.modelSelection !== undefined) {
      patch.modelSelection = options.validateSelection(request.modelSelection, target);
      if (target.chiefOfStaff) options.validateLeader(patch.modelSelection);
      options.revoke(target.id);
    }
    store.patchBot(target.id, patch);
  } else if (request.action === "archive" || request.action === "restore") {
    if (target.chiefOfStaff) fail("Choose another team lead before archiving or restoring a leadership role.", 409);
    if (request.action === "restore" && store.bots.some(bot => bot.id !== target.id && !bot.hidden
      && sectionKey(bot.section) === sectionKey(target.section) && bot.name.toLowerCase() === target.name.toLowerCase())) fail("That name is already used in this team.", 409);
    options.revoke(target.id);
    store.patchBot(target.id, { hidden: request.action === "archive" });
  } else if (request.action === "move") {
    if (!isWorkspaceChief(sender)) fail("Only the Chief of Staff can move bots between teams.");
    if (target.hidden || target.individual) fail("Restore this bot or have the owner change its individual role before moving it.", 409);
    const moved = store.setBotsSection([target.id], request.section);
    if (!moved.ok) fail("The destination is unavailable or already has a team lead.", 409);
    options.revoke(target.id);
  } else {
    if (!isWorkspaceChief(sender) || target.id === sender.id) fail("Only the Chief of Staff can appoint a team lead.");
    if (target.hidden) fail("Restore this bot before appointing it as lead.", 409);
    const affected = store.bots.filter(bot => sectionKey(bot.section) === sectionKey(target.section) && bot.chiefOfStaff && !isWorkspaceChief(bot));
    affected.forEach(idle);
    options.validateLeader(target.modelSelection);
    store.setChiefOfStaff(target.id, undefined, "section");
    for (const bot of [...affected, target]) options.revoke(bot.id);
  }
  return { bot: managedBotProfile(store.bot(target.id)!), organizationRevision: organizationRevision(store, sender), effective: "next turn" };
}
