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
import path from "node:path";

/** env variable → the extraResources `to:` directory it must point at. */
export const HARNESS_RESOURCE_DIRECTORIES = Object.freeze({
  MURAGE_STATIC_DIR: "ui",
  MURAGE_SKILLS_DIR: "skills",
  MURAGE_SKILL_LIBRARY: "skills-library",
});

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
