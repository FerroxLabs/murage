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
      // THE SCHEDULE TRAVELS WITH THE ROUTINE, because the first run's crew
      // screen describes what it just installed and must describe the real
      // thing. The approved simulation said three bots and two routines; the
      // package holds two agents and one routine that installs SWITCHED OFF,
      // and "one review, paused until you want it" is only sayable from these
      // fields. A screen that read them from anywhere else would be a second
      // copy of the package, written by hand, on the one screen the person can
      // immediately go and check.
      routines: (pkg.routines ?? []).map(routine => ({ key: routine.key, name: routine.name,
        time: routine.schedule.type === "daily" ? routine.schedule.time : "",
        weekdays: routine.schedule.type === "daily" ? routine.schedule.weekdays ?? [] : [],
        durationMinutes: routine.durationMinutes ?? 0,
        enabledAfterInstall: Boolean(routine.enabledAfterInstall) })),
      // INERT TODAY, AND THE FIRST RUN MUST NOT BUILD ON IT. All three
      // shipped profiles declare `requirements.apps: []`, so this is `false`
      // on every profile that exists and its only reader is the starter
      // profile card, which therefore always prints "no connected accounts
      // required to begin". That is currently true, so the card is not
      // lying, and this is left exactly as it is.
      //
      // It is recorded here because per-job connect in the 0.1.58 first run
      // looked like it could read this and cannot: it would answer "nothing
      // is needed" for every job. The first run derives what a job needs from
      // the job itself and from `connectedJobApps` on the setup view
      // (shared/setup.ts), which is new work rather than a reuse of this.
      connectionsRequired: pkg.requirements.apps.length > 0 };
  });
}
