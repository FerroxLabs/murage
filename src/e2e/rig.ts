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

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const HARNESS_PORT = Number(process.env.MURAGE_E2E_PORT || 8853);
export const UI_PORT = Number(process.env.MURAGE_E2E_UI_PORT || 5253);
export const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}`;
export const APP_URL = `http://127.0.0.1:${UI_PORT}`;

/** Gitignored, inside the repo, and never `~/.murage`. `server/config.ts`
 *  reads this through MURAGE_DATA_DIR. */
export const SCRATCH_DATA_DIR = process.env.MURAGE_E2E_DATA_DIR
  || join(REPO_ROOT, ".murage-scratch", "e2e");

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
 *  are decisions for the person at the keyboard and 404 without it. */
export const DESKTOP_HEADERS = { "x-murage-surface": "desktop" } as const;
