// "HELP ME RUN MY BUSINESS", AND THE CREW IT REALLY INSTALLS.
//
// The result screen for that job says "Installed and running", so something
// has to have installed. This is the three-call dance the starter profile
// card already does — catalog, review, import — reduced to the one profile
// the first run offers, and returning the reading `businessResult` needs.
//
// WHY IT TAKES ITS REQUEST FUNCTION. Exactly like `connectApp`: a test can
// drive the whole path without a server, and the module holds no knowledge of
// how requests are made. What it holds is the ORDER, which is the part with a
// rule in it: the importer refuses anything that was not reviewed first, so
// the review hash and the archive hash have to come from a preview of the
// same selection that is then imported.
//
// A REPEAT IS A SUCCESS, NOT A FAILURE. The route answers 409 for a package
// that was already imported, and a person who pressed the job twice, or came
// back to a workspace that already has the crew, must see their crew rather
// than an error about hashes. The catalogue reading is true either way,
// because it is read from the shipped package rather than from what happened.

import type { FirstRunCrewReading } from "./first-run-flow.ts";

/** The one starter profile the first run offers. */
export const FIRST_RUN_CREW_PROFILE = "starter-solo-business";

/** The catalogue row, as `listStarterProfiles` publishes one. */
export interface StarterProfileRow {
  id: string;
  agents: readonly { key: string; name: string }[];
  routines: readonly {
    key: string;
    name: string;
    time: string;
    weekdays: readonly number[];
    durationMinutes: number;
    enabledAfterInstall: boolean;
  }[];
}

export type CrewRequest = (path: string, init?: { method?: string; body?: string }) => Promise<any>;

/**
 * The catalogue row as the result screen reads it.
 *
 * One routine, because the package holds one and the screen says "one
 * review". A package that grew a second would show the first and the screen
 * would be wrong about the rest, so this is written to take the first and the
 * business-crew test reads the shipped file to keep that honest.
 */
export function crewReading(profile: StarterProfileRow): FirstRunCrewReading {
  const routine = profile.routines[0];
  return {
    agents: profile.agents.map((agent) => ({ key: agent.key, name: agent.name })),
    routine: routine
      ? {
          name: routine.name,
          time: routine.time,
          weekdays: routine.weekdays,
          durationMinutes: routine.durationMinutes,
          enabledAfterInstall: routine.enabledAfterInstall,
        }
      : null,
  };
}

function post(request: CrewRequest, body: Record<string, unknown>): Promise<any> {
  return request("/api/starter-profiles", { method: "POST", body: JSON.stringify(body) });
}

/** Whether the refusal means "you already have this", which is the one
 *  refusal that is really a yes. */
function alreadyInstalled(cause: unknown): boolean {
  return (cause as { status?: number })?.status === 409;
}

export async function installFirstRunCrew(request: CrewRequest): Promise<FirstRunCrewReading> {
  const catalog = await post(request, { action: "catalog" });
  const rows = (catalog?.profiles ?? []) as StarterProfileRow[];
  const profile = rows.find((row) => row.id === FIRST_RUN_CREW_PROFILE);
  if (!profile) throw new Error("That crew is not available on this computer.");
  const reading = crewReading(profile);

  // EVERYTHING IN THE PACKAGE, EXPLICITLY. The importer refuses an implicit
  // selection on purpose, and the screen that follows names every bot and the
  // review, so a partial selection would produce a screen describing things
  // the person did not get.
  const selection = {
    agents: profile.agents.map((agent) => agent.key),
    skills: [],
    instructions: [],
    routines: profile.routines.map((routine) => routine.key),
  };

  try {
    const preview = await post(request, { action: "preview", profileId: FIRST_RUN_CREW_PROFILE, selection });
    if (preview?.scan?.blocked) throw new Error("That crew did not pass this computer's content checks.");
    await post(request, {
      action: "import",
      profileId: FIRST_RUN_CREW_PROFILE,
      selection,
      archiveSha256: preview.archiveSha256,
      reviewHash: preview.reviewHash,
    });
  } catch (cause) {
    if (!alreadyInstalled(cause)) throw cause;
  }
  return reading;
}
