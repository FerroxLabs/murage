import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { parseBotPackage } from "./bot-package.ts";
import { parseBotPackageManifest } from "./bot-package-manifest.ts";
import { scanBotPackageContents } from "./bot-package-scan.ts";
import { LIBRARY_ROOT } from "./team-library.ts";

export const STARTER_PROFILE_IDS = ["starter-personal-home", "starter-solo-business", "starter-business-team"] as const;
export type StarterProfileId = typeof STARTER_PROFILE_IDS[number];

/** Shipped profiles are convenience entry points, not trusted import bypasses.
 * The caller still uses the same review and inert transactional importer. */
export function starterProfileContents(id: string, libraryRoot = LIBRARY_ROOT) {
  if (!STARTER_PROFILE_IDS.some(value => value === id)) throw new Error("Choose one of the available starter profiles");
  const path = join(libraryRoot, "packages", id + ".json");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1_000_000) throw new Error("Starter profile is unavailable");
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Starter profile changed while reading");
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const bytes = buffer.subarray(0, size);
    const after = fstatSync(descriptor);
    if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error("Starter profile changed while reading");
    if (scanBotPackageContents([{ path: "manifest.json", content: bytes }]).blocked) throw new Error("Starter profile failed content checks");
    const definition = parseBotPackage(JSON.parse(bytes.toString("utf8")));
    if (definition.package.id !== id) throw new Error("Starter profile identity does not match");
    const manifest = parseBotPackageManifest({ format: "murage.package.bundle", version: 1, definition, skills: [], instructions: [], entries: [] });
    return { manifest, payloads: new Map<string, Buffer>() };
  } finally { closeSync(descriptor); }
}

export function listStarterProfiles(libraryRoot = LIBRARY_ROOT) {
  return STARTER_PROFILE_IDS.map(id => {
    const { manifest } = starterProfileContents(id, libraryRoot);
    const pkg = manifest.definition.package;
    return { id, name: pkg.name, summary: pkg.summary, outcomes: pkg.outcomes, members: pkg.agents.length,
      agents: pkg.agents.map(agent => ({ key: agent.key, name: agent.name })),
      routines: (pkg.routines ?? []).map(routine => ({ key: routine.key, name: routine.name })),
      connectionsRequired: pkg.requirements.apps.length > 0 };
  });
}
