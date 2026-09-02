// Resource-derived environment for the packaged harness server child.
//
// Every shipped tree the server reads is located by an env variable whose
// fallback is process.cwd() — and in a packaged build cwd is not the repo, so
// an unset variable does not fail loudly, it silently reads as "this tree is
// empty". MURAGE_SKILL_LIBRARY was exactly that through 0.1.44: declared in
// server/skills.ts, set by nobody, packaged by nobody, so every team and
// profile a user hired installed zero skills.
//
// Keeping the mapping in one exported object is what makes that testable: the
// electron-builder `extraResources` `to:` names and the env names the server
// reads are asserted against each other instead of drifting apart in silence.
import { existsSync } from "node:fs";
import path from "node:path";

/** env variable → the extraResources `to:` directory it must point at. */
export const HARNESS_RESOURCE_DIRECTORIES = Object.freeze({
  MURAGE_STATIC_DIR: "ui",
  MURAGE_SKILLS_DIR: "skills",
  MURAGE_SKILL_LIBRARY: "skills-library",
  // The offline team library: library/catalog.json plus every package document
  // the importer consumes (library/assistants, library/packages, and
  // bot-library/builtins). server/team-library.ts falls back to cwd, so leaving
  // either of these unset in a packaged build would read as "no local library"
  // and put the panel straight back on the network — the 0.1.44
  // MURAGE_SKILL_LIBRARY failure in a new place.
  MURAGE_LIBRARY_DIR: "library",
  MURAGE_BOT_LIBRARY_DIR: "bot-library",
  // The bundled Fuigo engine executable's directory. Unlike the trees above,
  // an unset value here can never read as "empty": server/env-path.ts throws a
  // named error rather than silently reporting no engine.
  MURAGE_FUIGO_DIR: "fuigo",
});

/** The static UI root when there is no Resources directory to read it out of.
 *
 * In a packaged build MURAGE_STATIC_DIR points at Resources/ui and the harness
 * serves the app itself. In development nothing sets it, `STATIC_DIR` is null
 * (`server/index.ts:276`), and the harness has no UI to serve — which is fine
 * for the desktop app, because in dev it loads the Vite dev server directly.
 *
 * It is not fine for the browser door. A phone reaching 8813 is proxied to the
 * harness, and the harness is the only thing that can hand it the shell — so
 * the whole feature is untestable in development, and Wave 0b's Playwright
 * specs would have nothing to open. `dist/` is what `vite build` writes and
 * what the packaged `ui` directory is made from, so pointing at it in dev
 * serves a phone the same bytes a packaged build would.
 *
 * `when present` is the operative word: an unbuilt checkout gets no variable
 * at all rather than a path to a directory that is not there. The harness
 * treats an unset value as "no static tree", which is exactly the state a
 * checkout with no `dist/` is in. Run `pnpm build` and it starts working.
 *
 * Here rather than in main.mjs because main.mjs is not the only dev caller —
 * the Playwright webServer and `pnpm dev:server` want the same answer, and a
 * second copy of this decision is a second copy to get wrong. */
export const DEV_STATIC_DIRECTORY = "dist";

export function devHarnessEnvironment(repoRoot, exists = existsSync) {
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new Error("devHarnessEnvironment requires a repository root");
  }
  const dist = path.join(repoRoot, DEV_STATIC_DIRECTORY);
  // index.html, not the directory: `vite build` writes the directory early and
  // a half-written `dist/` served to a phone is a blank page with no error.
  return exists(path.join(dist, "index.html")) ? { MURAGE_STATIC_DIR: dist } : {};
}

/** electron-builder packages a per-platform executable INTO
 * HARNESS_RESOURCE_DIRECTORIES.MURAGE_FUIGO_DIR, so its file name is a second
 * thing that can drift. This is the single declaration of it: the
 * electron-builder `to:` basenames and the name server/env-path.ts joins onto
 * MURAGE_FUIGO_DIR are both asserted against this map. */
export const FUIGO_EXECUTABLE_NAMES = Object.freeze({
  darwin: "fuigo",
  linux: "fuigo",
  win32: "fuigo.exe",
});

/** The bundled engine's absolute path inside a packaged Resources directory. */
export function bundledFuigoPath(resourcesPath, platform = process.platform) {
  const executable = FUIGO_EXECUTABLE_NAMES[platform];
  if (!executable) throw new Error(`Murage ships no bundled fuigo for ${platform}`);
  return path.join(resourcesPath, HARNESS_RESOURCE_DIRECTORIES.MURAGE_FUIGO_DIR, executable);
}

/** The env the forked server child receives so it resolves its shipped trees
 *  out of Resources instead of falling back to the packaged app's cwd. */
export function harnessResourceEnvironment(resourcesPath) {
  if (typeof resourcesPath !== "string" || !resourcesPath) {
    throw new Error("harnessResourceEnvironment requires a resources path");
  }
  const environment = { MURAGE_RESOURCES_PATH: resourcesPath };
  for (const [key, directory] of Object.entries(HARNESS_RESOURCE_DIRECTORIES)) {
    environment[key] = path.join(resourcesPath, directory);
  }
  return environment;
}
