// The sidebar's section (team) order. No imports: the web UI and the harness
// both load this file.
//
// The order is kept on the Murage computer so every device shows the same
// one: the desktop app, a browser through the door and the phone app. Ids
// are the sidebar's own (`builtin:pinned`, `section:<team name>`, ...); the
// harness stores them without interpreting them.

export const SIDEBAR_ORDER_MAX_ENTRIES = 100;
export const SIDEBAR_ORDER_MAX_ID_LENGTH = 240;

/** The sidebar's fixed sections (src/lib/sidebar-layout.ts, Sidebar.tsx).
 * Every other section is a team, `section:<name>`. */
export const SIDEBAR_BUILTIN_SECTION_IDS: readonly string[] = [
  "builtin:pinned",
  "builtin:projects",
  "builtin:channels",
  "builtin:bots",
  "builtin:bot-chats",
];
const TEAM_PREFIX = "section:";

/** Whether an id has a shape the sidebar can produce: a fixed section, or a
 * team with a non-blank name inside the id bound. */
export function knownSidebarOrderId(id: string): boolean {
  if (SIDEBAR_BUILTIN_SECTION_IDS.includes(id)) return true;
  return id.startsWith(TEAM_PREFIX) && id.length <= SIDEBAR_ORDER_MAX_ID_LENGTH && id.slice(TEAM_PREFIX.length).trim().length > 0;
}

/** The part of an order a surface may be shown: the fixed sections, and the
 * teams it can see (`visibleTeams` holds team names), in the same order. */
export function visibleSidebarOrder(order: string[], visibleTeams: ReadonlySet<string>): string[] {
  return order.filter(
    (id) => SIDEBAR_BUILTIN_SECTION_IDS.includes(id) || (id.startsWith(TEAM_PREFIX) && visibleTeams.has(id.slice(TEAM_PREFIX.length))),
  );
}

/** A bounded list of section ids with repeats dropped, or null when the value
 * is not one. The same limits the web UI's local copy has always used. */
export function parseSidebarOrder(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > SIDEBAR_ORDER_MAX_ENTRIES) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > SIDEBAR_ORDER_MAX_ID_LENGTH) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Preserve temporarily empty sections in the saved order so their position
 * returns when a bot or channel is later assigned to them again. */
export function mergeSectionOrder(savedOrder: string[], visibleOrder: string[]): string[] {
  const saved = [...new Set(savedOrder.filter(Boolean))];
  const result = [...new Set(visibleOrder.filter(Boolean))];
  const included = new Set(result);

  for (let savedIndex = 0; savedIndex < saved.length; savedIndex += 1) {
    const id = saved[savedIndex]!;
    if (included.has(id)) continue;
    let destination = result.length;
    let foundPredecessor = false;
    for (let previous = savedIndex - 1; previous >= 0; previous -= 1) {
      const previousPosition = result.indexOf(saved[previous]!);
      if (previousPosition >= 0) {
        destination = previousPosition + 1;
        foundPredecessor = true;
        break;
      }
    }
    if (!foundPredecessor) {
      for (let next = savedIndex + 1; next < saved.length; next += 1) {
        const nextPosition = result.indexOf(saved[next]!);
        if (nextPosition >= 0) {
          destination = nextPosition;
          break;
        }
      }
    }
    result.splice(destination, 0, id);
    included.add(id);
  }
  return result;
}

/** The order the computer keeps after a device saves `incoming`.
 *
 * The incoming order wins. Ids only the stored order knew (a team the saving
 * device cannot see, or one that is empty right now) keep their relative
 * slots. Past the bound, those stored-only ids are the ones dropped, from the
 * end, so a device never loses a section it just placed. */
export function mergeStoredSidebarOrder(stored: string[] | null, incoming: string[]): string[] {
  const merged = mergeSectionOrder(stored ?? [], incoming);
  const mentioned = new Set(incoming);
  for (let index = merged.length - 1; merged.length > SIDEBAR_ORDER_MAX_ENTRIES && index >= 0; index -= 1) {
    if (!mentioned.has(merged[index]!)) merged.splice(index, 1);
  }
  return merged.slice(0, SIDEBAR_ORDER_MAX_ENTRIES);
}
