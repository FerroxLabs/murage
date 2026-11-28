// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 K5: switch skills on or off for several bots at once, as one
// recorded operation. Every pair (skill, bot) goes through the same route a
// single switch uses, so Skill Guard, the engine check and the 40-skill
// ceiling apply unchanged. The operation is written down before the first
// pair runs and after each one, so a lost reply is read back by its id, a
// retry touches only pairs still unknown, and a restart never turns an
// unknown pair into a guess from the manifest.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { getCollectionSkill } from "./skill-collection.ts";
import { librarySkillFootprint, listSkills, skillPinTooLarge, SKILL_CEILING, SKILL_CEILING_CODE } from "./skills.ts";
import type { SkillsApiRequest, SkillsApiResponse } from "./skills-api.ts";

export type PairState = "on" | "already-on" | "off" | "already-off" | "refused" | "unknown" | "kept";
export interface BulkPair {
  skill: string;
  botId: string;
  botName: string;
  state: PairState;
  reason?: string;
  code?: string;
  /** Undo only: whether the pair was on before this operation touched it. */
  before?: boolean;
}
export interface BulkOp {
  opId: string;
  createdAt: string;
  on: boolean;
  skills: string[];
  /** How the bots were chosen; a team is expanded once, here, and never again. */
  target: { botIds?: string[]; teamId?: string };
  pairs: BulkPair[];
  undoOf?: string;
}

const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SKILL_REF = /^(collection|library):[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_OPS = 100;
const MAX_PAIRS = 2_000;

/** Operations being applied by this process: a second request for the same id waits for its answer rather than racing it. */
const running = new Set<string>();
const opsDir = () => join(DATA_DIR, "skills-bulk");
const opFile = (opId: string) => join(opsDir(), `${opId}.json`);

export function readBulkOp(opId: string): BulkOp | null {
  if (!OP_ID.test(opId)) return null;
  try { return JSON.parse(readFileSync(opFile(opId), "utf8")) as BulkOp; } catch { return null; }
}

function writeBulkOp(op: BulkOp): void {
  mkdirSync(opsDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(opFile(op.opId), JSON.stringify(op), { mode: 0o600 });
  const files = readdirSync(opsDir()).filter((name) => name.endsWith(".json"));
  if (files.length > MAX_OPS) {
    const oldest = files.map((name) => ({ name, at: statSync(join(opsDir(), name)).mtimeMs })).sort((a, b) => a.at - b.at).slice(0, files.length - MAX_OPS);
    for (const file of oldest) rmSync(join(opsDir(), file.name), { force: true });
  }
}

const body = z.object({
  opId: z.string().regex(OP_ID),
  skills: z.array(z.string().regex(SKILL_REF)).min(1).max(100),
  on: z.boolean(),
  target: z.object({ botIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(), teamId: z.string().min(1).max(200).optional() }).strict()
    .refine((value) => Boolean(value.botIds) !== Boolean(value.teamId), "choose bots or a team"),
}).strict();

type Apply = (request: SkillsApiRequest) => Promise<SkillsApiResponse | null>;
/** Whether a bot has this skill on right now, from its own manifest. Tests pass their own. */
export type IsOn = (botId: string, skill: string) => boolean;
const manifestIsOn: IsOn = (botId, skill) => listSkills(botId).some((listing) => listing.name === skill.slice(skill.indexOf(":") + 1) && listing.enabled);

/** How many skills a bot has on right now. Tests pass their own. */
export type CountOn = (botId: string) => number;
const manifestCountOn: CountOn = (botId) => listSkills(botId).filter((listing) => listing.enabled).length;

/** Whether a bot's pin of its on skills plus these refs is past the file or size limit. Tests pass their own. */
export type PinOver = (botId: string, adding: string[]) => boolean;
const nameOf = (skill: string) => skill.slice(skill.indexOf(":") + 1);
/** What one ref installs when it is switched on and the bot has no skill of that name yet: a Yours skill its collection record
 * (contents + assets, what the single switch installs), a library skill its library folder. Null: the ref installs nothing. */
function refFootprint(skill: string): { files: number; bytes: number } | null {
  if (!skill.startsWith("collection:")) return librarySkillFootprint(nameOf(skill));
  const copy = getCollectionSkill(nameOf(skill));
  if (!copy) return null;
  return {
    files: copy.contents.length + copy.assets.length,
    bytes: copy.contents.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0) + copy.assets.reduce((sum, file) => sum + file.content.length, 0),
  };
}
const manifestPinOver: PinOver = (botId, adding) => {
  const listings = listSkills(botId);
  const names = listings.filter((listing) => listing.enabled).map((listing) => listing.name);
  // Sized per ref (source + name), never per bare name: library:x and collection:x are different files. Only one copy of a
  // name can end up on the bot, but which one depends on how the earlier refs fare, so a name not on the bot yet weighs the
  // largest of its refs in the request. A name installed from another source never moves (name-taken), so it adds nothing.
  const uninstalled = new Map<string, { files: number; bytes: number }>();
  for (const skill of adding) {
    const name = nameOf(skill);
    const installed = listings.find((listing) => listing.name === name);
    if (installed) {
      const ours = skill.startsWith("collection:") ? installed.source === skill : installed.source.startsWith(`${skill}@`);
      if (ours) names.push(name);
      continue;
    }
    const size = refFootprint(skill);
    if (!size) continue;
    const seen = uninstalled.get(name);
    uninstalled.set(name, seen ? { files: Math.max(seen.files, size.files), bytes: Math.max(seen.bytes, size.bytes) } : size);
    names.push(name);
  }
  return skillPinTooLarge(botId, names, undefined, uninstalled);
};

/** Turning on is all or nothing per bot: a bot the whole request would push past the ceiling gets none of it, so a bulk act
 * never leaves a bot half filled up to the limit. Refused here is a recorded refusal, with no switch moved. */
function refuseOverCeiling(pairs: BulkPair[], isOn: IsOn, countOn: CountOn, pinOver: PinOver): void {
  const wanted = new Map<string, BulkPair[]>();
  for (const pair of pairs) {
    if (pair.state !== "unknown" || isOn(pair.botId, pair.skill)) continue;
    wanted.set(pair.botId, [...(wanted.get(pair.botId) ?? []), pair]);
  }
  for (const [botId, adding] of wanted) {
    // One name is one skill on the bot, whichever source it comes from (library:x and collection:x never both turn on).
    const overCount = countOn(botId) + new Set(adding.map((pair) => nameOf(pair.skill))).size > SKILL_CEILING;
    // The pin limit is judged on what would be on (its on skills plus these), so a bot never stops half filled by size either.
    if (!overCount && !pinOver(botId, adding.map((pair) => pair.skill))) continue;
    for (const pair of adding) {
      pair.state = "refused";
      pair.code = SKILL_CEILING_CODE;
      pair.reason = overCount
        ? `This would put ${pair.botName} over ${SKILL_CEILING} skills, so none were added. Turn some off first.`
        : `These skills together are too large to pin for ${pair.botName}, so none were added. Turn some off first.`;
    }
  }
}

async function runPair(pair: BulkPair, on: boolean, request: SkillsApiRequest, apply: Apply, isOn: IsOn, persist: () => void): Promise<void> {
  // Written down before the switch moves: after a crash the retry must not read "was it on" off the switch it may have flipped.
  if (pair.before === undefined) { pair.before = isOn(pair.botId, pair.skill); persist(); }
  const sub: SkillsApiRequest = {
    method: "PUT",
    path: `/api/skills/${encodeURIComponent(pair.skill)}/bots/${pair.botId}`,
    url: new URL(`http://127.0.0.1/api/skills/${encodeURIComponent(pair.skill)}/bots/${pair.botId}`),
    readBody: async () => ({ on }),
    bots: request.bots,
    ...(request.setBuiltinSkill ? { setBuiltinSkill: request.setBuiltinSkill } : {}),
  };
  const reply = await apply(sub);
  const result = reply?.body as { skill?: { enabled?: boolean } | null; error?: string; code?: string } | undefined;
  if (reply && reply.status === 200) {
    const enabled = Boolean(result?.skill?.enabled);
    pair.state = on ? (pair.before ? "already-on" : "on") : (pair.before ? "off" : "already-off");
    if (on !== enabled && on) pair.state = "refused";
    delete pair.reason;
    return;
  }
  // Not saved is only ever a refusal the route recorded (a 4xx with its reason). No answer, or a server fault, says nothing
  // about whether the switch moved, so the pair stays unknown: Could not check, and Try again sends it once more.
  if (!reply || reply.status >= 500) { pair.state = "unknown"; delete pair.reason; return; }
  pair.state = "refused";
  pair.reason = result?.error ?? "Murage could not change this one.";
  if (result?.code) pair.code = result.code;
}

/** PUT /api/skills/bulk, GET /api/skills/bulk/:opId, PUT /api/skills/bulk/:opId/undo. They are PUTs on purpose: the mount
 * hands every PUT on an owner's browser the code gate, and these refuse that case, so no extra wiring can leave them open. */
export async function handleSkillsBulk(request: SkillsApiRequest, apply: Apply, isOn: IsOn = manifestIsOn, countOn: CountOn = manifestCountOn, pinOver: PinOver = manifestPinOver): Promise<SkillsApiResponse | null> {
  const { method, path } = request;
  if (path !== "/api/skills/bulk" && !path.startsWith("/api/skills/bulk/")) return null;
  // An owner's browser gives one code per act; one bulk call is many acts, so it is refused there, not skipped.
  if (request.ownerCode && method !== "GET") return { status: 409, body: { error: "Change several bots at once from the desktop app.", code: "bulk-needs-desktop" } };

  const read = /^\/api\/skills\/bulk\/([^/]+)$/.exec(path);
  if (read && method === "GET") {
    const op = readBulkOp(read[1]!);
    return op ? { status: 200, body: { op } } : { status: 404, body: { error: "No such operation.", code: "unknown-op" } };
  }

  const undo = /^\/api\/skills\/bulk\/([^/]+)\/undo$/.exec(path);
  if (undo && method === "PUT") {
    const op = readBulkOp(undo[1]!);
    if (!op) return { status: 404, body: { error: "No such operation.", code: "unknown-op" } };
    const input = z.object({ opId: z.string().regex(OP_ID) }).strict().safeParse(await request.readBody());
    if (!input.success) return { status: 400, body: { error: "Send an id for the undo." } };
    const existing = readBulkOp(input.data.opId);
    if (existing && existing.undoOf !== op.opId) return { status: 409, body: { error: "That operation id was used for something else.", code: "op-mismatch" } };
    if (running.has(input.data.opId)) return { status: 409, body: { error: "That operation is still running.", code: "in-progress" } };
    running.add(input.data.opId);
    try {
      const bots = request.bots();
      let reverse = existing;
      if (!reverse) {
        reverse = { opId: input.data.opId, createdAt: new Date().toISOString(), on: !op.on, skills: op.skills, target: op.target, undoOf: op.opId, pairs: [] };
        for (const pair of op.pairs) {
          // Only a pair this operation changed, and that still reads as it left it, is put back.
          if (pair.state !== (op.on ? "on" : "off")) continue;
          reverse.pairs.push({ skill: pair.skill, botId: pair.botId, botName: pair.botName, state: "unknown" });
        }
        writeBulkOp(reverse);
      }
      // A crashed undo is finished by asking again: only pairs still unknown run.
      if (reverse.on) refuseOverCeiling(reverse.pairs.filter((pair) => isOn(pair.botId, pair.skill) !== reverse!.on && bots.some((bot) => bot.id === pair.botId)), isOn, countOn, pinOver);
      for (const pair of reverse.pairs) {
        if (pair.state !== "unknown") continue;
        if (isOn(pair.botId, pair.skill) !== op.on || !bots.some((bot) => bot.id === pair.botId)) {
          pair.state = "kept";
          pair.reason = "Changed since, so it was left as it is.";
        } else {
          await runPair(pair, reverse.on, request, apply, isOn, () => writeBulkOp(reverse!));
        }
        writeBulkOp(reverse);
      }
      return { status: 200, body: { op: reverse } };
    } finally {
      running.delete(input.data.opId);
    }
  }

  if (path === "/api/skills/bulk" && method === "PUT") {
    const input = body.safeParse(await request.readBody());
    if (!input.success) return { status: 400, body: { error: "Choose skills, bots and on or off.", code: "invalid" } };
    const { opId, skills, on, target } = input.data;
    let op = readBulkOp(opId);
    if (op && (op.on !== on || JSON.stringify(op.target) !== JSON.stringify(target) || JSON.stringify(op.skills) !== JSON.stringify(skills))) return { status: 409, body: { error: "That operation id was used for something else.", code: "op-mismatch" } };
    if (!op) {
      const bots = request.bots();
      let ids: string[];
      if (target.teamId) {
        if (!request.teamMembers) return { status: 404, body: { error: "Teams are not available here.", code: "no-team" } };
        const members = request.teamMembers(target.teamId);
        if (!members) return { status: 404, body: { error: "No such team.", code: "no-team" } };
        ids = members;
      } else ids = target.botIds!;
      const chosen = [...new Set(ids)].map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));
      const pairs: BulkPair[] = [];
      for (const skill of skills) for (const bot of chosen) pairs.push({ skill, botId: bot.id, botName: bot.name, state: "unknown" });
      if (!pairs.length) return { status: 400, body: { error: "No bots to change.", code: "invalid" } };
      if (pairs.length > MAX_PAIRS) return { status: 400, body: { error: "Too many at once.", code: "invalid" } };
      op = { opId, createdAt: new Date().toISOString(), on, skills, target, pairs };
      writeBulkOp(op);
    }
    if (running.has(opId)) return { status: 409, body: { error: "That operation is still running.", code: "in-progress" } };
    running.add(opId);
    try {
      // Retry touches only what is still unknown; the recorded bots are used, never the team's current members.
      if (on) { refuseOverCeiling(op.pairs, isOn, countOn, pinOver); writeBulkOp(op); }
      for (const pair of op.pairs) {
        if (pair.state !== "unknown") continue;
        await runPair(pair, on, request, apply, isOn, () => writeBulkOp(op!));
        writeBulkOp(op);
      }
    } finally {
      running.delete(opId);
    }
    return { status: 200, body: { op } };
  }
  return null;
}

/** Registered by core's route mount (server/settings/v10-routes.ts). Bulk requests already arrive through
 * handleSkillsApi's mount, which owns the owner-code gate and the bot list, so there is nothing to answer here. */
export function registerSkillsBulkRoutes(router: { add(owner: string, route: () => boolean): void }): void {
  router.add("skills", () => false);
}
