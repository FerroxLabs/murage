// The sidebar's section order is kept on the Murage computer, so the desktop
// app, a browser through the door and the phone app all show the same one
// (server/sidebar-order.ts). localStorage stays as this device's cache for
// the first paint and for a harness that predates the shared order.
//
// The computer's order is:
//   undefined  not answered yet, or a harness that does not keep one
//   null       none saved yet
//   string[]   the order; it wins over any local copy
import { parseSidebarOrder } from "../../shared/sidebar-order";

export type ComputerSectionOrder = string[] | null | undefined;

export function shownSectionOrder(server: ComputerSectionOrder, local: string[]): string[] {
  return Array.isArray(server) ? server : local;
}

/** The order the desktop uploads on its first load, or null for none.
 *
 * Only the desktop app does this, only while the computer has no order, and
 * only once: its local arrangement is the person's real one. A phone or a
 * browser would only ever upload its default, so they never do; they save
 * only when the person drags. */
export function initialSectionOrderUpload(input: {
  server: ComputerSectionOrder;
  local: string[];
  desktop: boolean | undefined;
  attempted: boolean;
}): string[] | null {
  if (input.server !== null || input.desktop !== true || input.attempted) return null;
  return input.local.length > 0 ? input.local : null;
}

type Request = (path: string, init: { method: string; body: string }) => Promise<unknown>;

/** Save an order on the computer. Answers the order it now keeps, or null
 * when the save did not land (the local copy still holds for this session). */
export async function saveSectionOrderToComputer(
  order: string[],
  request: Request,
  options: { initial?: boolean } = {},
): Promise<string[] | null> {
  try {
    const response = (await request("/api/sidebar-sections", {
      method: "POST",
      body: JSON.stringify(options.initial ? { order, initial: true } : { order }),
    })) as { order?: unknown } | null;
    return parseSidebarOrder(response?.order);
  } catch {
    return null;
  }
}
