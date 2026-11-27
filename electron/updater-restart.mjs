// Admission is checked before any owned process or credential writer stops.
// This does not move an installation or guess how an installer inherits profiles.
export function hasCustomUpdaterProfile(environment) {
  return environment.MURAGE_USER_DATA !== undefined || environment.MURAGE_DATA_DIR !== undefined;
}

/** A refusal with the plain card message and a reason code the updater log carries (never shown on the card). */
const refusal = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });

export async function prepareUpdaterRestart({ environment, isClosing, isCleanedUp, readActivity, cleanup }) {
  if (hasCustomUpdaterProfile(environment)) {
    throw refusal("UPDATER_CUSTOM_PROFILE", "This session uses a custom profile. Close it, update Murage with the installer, then reopen it with the same profile launcher.");
  }
  // A failed installer can be retried after a clean shutdown; the stopped
  // harness is intentionally not treated as an available working session.
  if (isCleanedUp()) return;
  if (isClosing()) throw refusal("UPDATER_ALREADY_CLOSING", "Murage is already closing. Quit and reopen it before trying the update again.");
  let activity;
  try { activity = await readActivity(); }
  catch (error) {
    // the work-in-progress probe (/api/bots) timed out or failed: the card stays plain, the log keeps which
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw refusal(timedOut ? "UPDATER_ACTIVITY_TIMEOUT" : "UPDATER_ACTIVITY_UNAVAILABLE", "Could not check current work. Try again before restarting to update.", error);
  }
  if (!Array.isArray(activity?.bots) || !Array.isArray(activity?.groups)) {
    throw refusal("UPDATER_ACTIVITY_MALFORMED", "Could not check current work. Try again before restarting to update.");
  }
  if (activity.bots.some((bot) => bot.busy) || activity.groups.some((group) => group.working)) {
    throw refusal("UPDATER_WORK_ACTIVE", "Finish or stop current work, then restart to update.");
  }
  try { await cleanup(); }
  catch (error) { throw refusal("UPDATER_CLEANUP_FAILED", "Murage could not finish closing, so the update was not started. Quit Murage, reopen it, then try again.", error); }
}
