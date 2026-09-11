// Admission is checked before any owned process or credential writer stops.
// This does not move an installation or guess how an installer inherits profiles.
export function hasCustomUpdaterProfile(environment) {
  return environment.MURAGE_USER_DATA !== undefined || environment.MURAGE_DATA_DIR !== undefined;
}

export async function prepareUpdaterRestart({ environment, isClosing, isCleanedUp, readActivity, cleanup }) {
  if (hasCustomUpdaterProfile(environment)) {
    throw new Error("This session uses a custom profile. Close it, update Murage with the installer, then reopen it with the same profile launcher.");
  }
  // A failed installer can be retried after a clean shutdown; the stopped
  // harness is intentionally not treated as an available working session.
  if (isCleanedUp()) return;
  if (isClosing()) throw new Error("Murage is already closing. Quit and reopen it before trying the update again.");
  let activity;
  try { activity = await readActivity(); }
  catch { throw new Error("Could not check current work. Try again before restarting to update."); }
  if (!Array.isArray(activity?.bots) || !Array.isArray(activity?.groups)) {
    throw new Error("Could not check current work. Try again before restarting to update.");
  }
  if (activity.bots.some((bot) => bot.busy) || activity.groups.some((group) => group.working)) {
    throw new Error("Finish or stop current work, then restart to update.");
  }
  try { await cleanup(); }
  catch { throw new Error("Murage could not finish closing safely. The update was not started. Finish quitting and reopen Murage, then try again."); }
}
