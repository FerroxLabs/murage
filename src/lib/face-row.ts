// A row of real faces: up to `max` of them, then how many more there are ("+N"). One rule for the welcome (the starter team on a
// first run) and for the cached start-up picture (the person's own roster on a daily start), so a person with 22 bots sees five and "+17".
export const FACE_ROW_MAX = 5;

export function faceRow<T>(items: readonly T[], max: number = FACE_ROW_MAX): { shown: T[]; more: number } {
  const limit = Math.max(0, Math.floor(max));
  const shown = items.slice(0, limit);
  return { shown, more: items.length - shown.length };
}
