// SPDX-License-Identifier: AGPL-3.0-or-later
// "Hire your first teammates" (FIRSTRUN-1019 1.11): the server side of
// POST /api/setup/hire.
//
// THE ROUTE ENSURES, IT DOES NOT IMPORT BLINDLY. For each starter package, in
// a fixed order, it works out which of the asked-for agents are still missing
// (no bot whose installed package is that package and whose import receipt
// names that agent key), and runs the shipped starter import once for just
// those, with the package routines whose owner is among them. A repeat call
// with the same agents imports nothing and returns the same list, so a lost
// response, a reload or a double press all converge, and the duplicate-import
// 409 is never reached on the normal path.
//
// Pure of I/O: the three things it needs are handed in, so every property
// above is tested without a server.

/** The starter packages hiring may draw from, in the order they are imported. */
export const HIRE_PACKAGE_ORDER = ["starter-solo-business", "starter-business-team"] as const;
export type HirePackageId = (typeof HIRE_PACKAGE_ORDER)[number];

export interface HireAgent { profileId: HirePackageId; key: string }
export interface HiredAgent extends HireAgent { botId: string }

/** The part of a bot record this reads. */
export interface HireBot {
  id: string;
  installedPackage?: { id?: string };
  packageImportReceipt?: { agentKey?: string };
}

export interface HireSelection { agents: string[]; skills: string[]; instructions: string[]; routines: string[] }

export interface HireDeps {
  bots(): readonly HireBot[];
  /** The package's agent keys and which agent owns each routine. */
  shape(profileId: HirePackageId): { agents: readonly string[]; routines: readonly { key: string; agent: string }[] };
  /** The shipped starter import for one package with an explicit selection. Throws on refusal. */
  importAgents(profileId: HirePackageId, selection: HireSelection): Promise<void>;
}

const MAX_HIRE = 8;

export function parseHireBody(body: unknown): { ok: true; agents: HireAgent[] } | { ok: false; error: string } {
  const list = body && typeof body === "object" ? (body as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_HIRE) return { ok: false, error: "Choose who to hire." };
  const agents: HireAgent[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const profileId = (entry as { profileId?: unknown } | null)?.profileId;
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof profileId !== "string" || typeof key !== "string") return { ok: false, error: "Choose who to hire." };
    if (!(HIRE_PACKAGE_ORDER as readonly string[]).includes(profileId)) return { ok: false, error: "Choose who to hire." };
    const id = `${profileId}/${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    agents.push({ profileId: profileId as HirePackageId, key });
  }
  return { ok: true, agents };
}

function hiredBot(bots: readonly HireBot[], profileId: string, key: string): HireBot | undefined {
  return bots.find((bot) => bot.installedPackage?.id === profileId && bot.packageImportReceipt?.agentKey === key);
}

/** One hire at a time: two presses never both see the same agent as missing. */
let queue: Promise<unknown> = Promise.resolve();

export function ensureHired(agents: readonly HireAgent[], deps: HireDeps): Promise<HiredAgent[]> {
  const run = queue.then(() => ensure(agents, deps));
  queue = run.catch(() => undefined);
  return run;
}

async function ensure(agents: readonly HireAgent[], deps: HireDeps): Promise<HiredAgent[]> {
  // Refuse a key outside the starter packages before anything is written.
  for (const profileId of HIRE_PACKAGE_ORDER) {
    const shape = deps.shape(profileId);
    for (const agent of agents) {
      if (agent.profileId === profileId && !shape.agents.includes(agent.key)) {
        throw Object.assign(new Error("That teammate is not in the starter packages."), { status: 400 });
      }
    }
  }
  for (const profileId of HIRE_PACKAGE_ORDER) {
    const asked = agents.filter((agent) => agent.profileId === profileId);
    if (asked.length === 0) continue;
    const missing = asked.filter((agent) => !hiredBot(deps.bots(), profileId, agent.key)).map((agent) => agent.key);
    if (missing.length === 0) continue;
    const shape = deps.shape(profileId);
    // The manifest refuses a routine whose owner is not selected, and an
    // owner's routine must not be left behind, so exactly the routines of the
    // agents being brought in travel with them.
    const routines = shape.routines.filter((routine) => missing.includes(routine.agent)).map((routine) => routine.key);
    await deps.importAgents(profileId, { agents: missing, skills: [], instructions: [], routines });
  }
  const hired: HiredAgent[] = [];
  for (const agent of agents) {
    const bot = hiredBot(deps.bots(), agent.profileId, agent.key);
    // The card settles only once every ticked agent is in the list.
    if (!bot) throw Object.assign(new Error("That did not work. Try again."), { status: 500 });
    hired.push({ ...agent, botId: bot.id });
  }
  return hired;
}
