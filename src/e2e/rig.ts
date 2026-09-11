// The one place that knows where the human-facing rig lives: which ports it
// owns, and which directory its data is allowed to touch.
//
// Read this before changing a port. The developer's own Murage runs on 8799
// (harness) and 5199 (Vite) against ~/.murage — their real bots, real
// transcripts, real keys. Playwright's `reuseExistingServer` cannot tell a
// scratch harness from a live one: it only asks whether the port answers. A
// rig pointed at 8799 would therefore seed its fixtures into the user's
// workspace and assert against their bots the moment the app happened to be
// open. So the rig owns its own ports and its own data dir, and
// `reuseExistingServer` can then only ever reuse a harness this config
// started.
//
// Both ports are bound on 127.0.0.1 explicitly, and both are overridable, so a
// machine that already has something on them can move the rig without
// touching the app's own defaults.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { laneDataDir } from "./lane-data-dir";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const HARNESS_PORT = Number(process.env.MURAGE_E2E_PORT || 8853);
export const UI_PORT = Number(process.env.MURAGE_E2E_UI_PORT || 5253);
export const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}`;
export const APP_URL = `http://127.0.0.1:${UI_PORT}`;

/** MURAGE_E2E_DATA_DIR, required and validated (see lane-data-dir.ts); there
 *  is no default. `server/config.ts` reads it through MURAGE_DATA_DIR, and
 *  prepare-scratch.mjs wipes it before the harness binds. */
export const SCRATCH_DATA_DIR = laneDataDir("the shared human rig never uses ~/.murage");

/** The seeded workspace, by name. Specs address fixtures through these so a
 *  rename is one edit. Every name is prefixed so a fixture is unmistakable in
 *  a screenshot and impossible to confuse with a real bot. */
export const FIXTURES = {
  /** No title, no description, no skills — the first-run shape. */
  blank: { name: "E2E Blank" },
  /** Configured (title + description) but still owns zero skills. The bot
   *  Wave 1's H1 is about: it must get the collapsed chip, never nothing. */
  titledNoSkills: {
    name: "E2E Titled",
    title: "Operations lead",
    description: "Keeps the week moving.",
  },
  /** Created from the shipped `smart-trader` library profile, so it arrives
   *  with a persona and a real set of installed skills. */
  smartTrader: { name: "E2E Trader", slug: "smart-trader" },
} as const;

/** The desktop marker header. Routes that install skills or apply a profile
 *  are decisions for the person at the keyboard and 404 without it.
 *
 *  The marker ALONE stopped being enough when the harness began minting a
 *  per-launch secret: a bare marker is precisely the forgery that gate
 *  refuses, so seeding with it would 404 on every skill install and every
 *  profile apply — silently producing fixtures with no skills, which is the
 *  state Wave 1's card renders its quiz on. `desktopHeaders()` fetches the
 *  secret the dev harness offers on loopback and caches it. */
export const DESKTOP_HEADERS = { "x-murage-surface": "desktop" } as const;

let cachedSecret: string | null = null;

export async function desktopHeaders(): Promise<Record<string, string>> {
  if (cachedSecret === null) {
    const response = await fetch(`${HARNESS_URL}/api/desktop-secret`, { headers: DESKTOP_HEADERS });
    if (!response.ok) {
      throw new Error(
        `the harness on ${HARNESS_URL} did not offer a desktop secret (${response.status}). `
        + "That route exists only when the harness was NOT launched as an Electron utility child. "
        + "If this is a packaged or cloud harness, the rig is pointed at the wrong process.",
      );
    }
    cachedSecret = String(((await response.json()) as { secret?: string }).secret ?? "");
    if (!cachedSecret) throw new Error("the harness offered an empty desktop secret");
  }
  return { ...DESKTOP_HEADERS, "x-murage-surface-secret": cachedSecret };
}
