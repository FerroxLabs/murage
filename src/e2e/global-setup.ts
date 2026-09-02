// Seeds the workspace every human spec reads.
//
// Playwright starts webServers *before* globalSetup (webServer is a runner
// plugin, and plugin setup precedes global setup in
// playwright/lib/runner/tasks.js), so by the time this runs the harness is up
// and can be driven over HTTP — the same way server/index.test.ts drives it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { desktopHeaders, FIXTURES, HARNESS_URL, SCRATCH_DATA_DIR } from "./rig";

type Json = Record<string, any>;

const api = async (method: string, path: string, body?: unknown): Promise<Json> => {
  const res = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: {
      // The marker alone stopped being enough when the harness began minting
      // a per-launch secret: seeding with it 404s on every skill install and
      // every profile apply, silently producing fixtures with no skills —
      // which is the exact state the intake card renders its quiz on.
      ...(await desktopHeaders()),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
};

const waitForHarness = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${HARNESS_URL}/api/health`);
      if (res.ok && (await res.json())?.app === "murage") return;
    } catch {
      /* still starting */
    }
    if (Date.now() > deadline) throw new Error(`harness never came up on ${HARNESS_URL}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const botsOnDisk = (): Array<{ id: string; name: string }> => {
  try {
    return JSON.parse(readFileSync(join(SCRATCH_DATA_DIR, "bots.json"), "utf8"));
  } catch {
    return [];
  }
};

/** The guard that makes every write below safe.
 *
 *  A harness that answers on our port is not *proof* it is our harness. So
 *  before anything is deleted, create one throwaway bot and confirm it landed
 *  in the scratch dir on disk. If it did not, the process on this port is
 *  writing somewhere else — the user's ~/.murage, most likely — and the only
 *  correct move is to undo the one bot we made and stop. */
const proveScratchDataDir = async (): Promise<void> => {
  const probeName = "__e2e-scratch-probe__";
  const created = await api("POST", "/api/bots", { name: probeName });
  const id: string = created.bot.id;
  const landed = botsOnDisk().some((bot) => bot.id === id);
  if (!landed) {
    await api("DELETE", `/api/bots/${id}`).catch(() => {});
    throw new Error(
      `The harness answering on ${HARNESS_URL} is NOT using the scratch data dir `
      + `(${SCRATCH_DATA_DIR}). Refusing to seed — this looks like a live Murage. `
      + `Stop it, or set MURAGE_E2E_PORT to a free port.`,
    );
  }
};

/** A fresh store auto-creates one bot (store.ts:1788), and a reused harness
 *  still holds the previous run's fixtures. Either way the workspace starts
 *  from nothing so the seeded set is exactly the seeded set. */
const emptyWorkspace = async (): Promise<void> => {
  const { bots } = (await api("GET", "/api/bots?messages=0")) as { bots: Array<{ id: string }> };
  for (const bot of bots) await api("DELETE", `/api/bots/${bot.id}`);
};

const createBot = async (profile: Json): Promise<string> => {
  const created = await api("POST", "/api/bots", profile);
  return created.bot.id as string;
};

export default async function globalSetup(): Promise<void> {
  await waitForHarness();
  await proveScratchDataDir();
  await emptyWorkspace();

  // Order matters only in that the sidebar lists newest-first; seeding in
  // this order puts the blank bot at the bottom, which is the shape a real
  // workspace grows into.
  await createBot({ name: FIXTURES.blank.name });
  await createBot({
    name: FIXTURES.titledNoSkills.name,
    title: FIXTURES.titledNoSkills.title,
    description: FIXTURES.titledNoSkills.description,
  });

  // The profile install is desktop-only (index.ts:7831) and resolves
  // `smart-trader` out of the shipped bot-library, so it needs no network.
  // rename:false keeps the E2E prefix on the name: a fixture must stay
  // recognisable as a fixture, and it is also the exact shape Wave 1's
  // "keep the name" decision is about.
  const traderId = await createBot({ name: FIXTURES.smartTrader.name });
  await api("POST", `/api/bots/${traderId}/assistant-profile`, {
    slug: FIXTURES.smartTrader.slug,
    rename: false,
  });

  const seeded = botsOnDisk().map((bot) => bot.name);
  const expected = [FIXTURES.blank.name, FIXTURES.titledNoSkills.name, FIXTURES.smartTrader.name];
  const missing = expected.filter((name) => !seeded.includes(name));
  if (missing.length > 0) {
    throw new Error(`fixtures never reached ${SCRATCH_DATA_DIR}/bots.json: ${missing.join(", ")}`);
  }

  const skills = (await api("GET", `/api/bots/${traderId}/skills`)) as Json;
  const installed: unknown[] = skills.skills ?? skills.installed ?? [];
  if (!Array.isArray(installed) || installed.length === 0) {
    throw new Error(`the ${FIXTURES.smartTrader.slug} fixture installed no skills — the profile did not apply`);
  }
}
