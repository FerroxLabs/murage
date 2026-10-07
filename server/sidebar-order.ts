// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sidebar's section (team) order, one per computer.
//
// It used to live in each renderer's localStorage, so every device had its
// own: a freshly paired phone showed the default order while the Mac showed
// the one the person arranged. It lives here now, in DATA_DIR/sidebar-order.json
// (owner-only, written through writeFileAtomic), and reaches every device the
// way the bots do: in the GET /api/bots hydration and a `sidebar.order` frame.
//
// Written through POST /api/sidebar-sections with `{ order }`, the route the
// phone and the browser door already reach. `initial: true` is the one-time
// migration of the desktop's local arrangement: it lands only while the
// computer has no order, and index.ts accepts it from the desktop surface
// only, so a phone's default order can never replace the real one on load.
// Which sections are collapsed stays per device, in the renderer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownSidebarOrderId, mergeStoredSidebarOrder, parseSidebarOrder, visibleSidebarOrder } from "../shared/sidebar-order.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = "sidebar-order.json";

/** The order on disk, or null when there is none or it cannot be read. A
 * layout preference is not worth stopping startup over: a damaged file reads
 * as "no order yet", and the next save replaces it. */
function read(dir: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parseSidebarOrder((parsed as Record<string, unknown>).order);
  } catch {
    return null;
  }
}

export class SidebarOrderStore {
  private order: string[] | null;
  private readonly dir: string;

  constructor(dir: string = DATA_DIR) {
    this.dir = dir;
    this.order = read(dir);
  }

  current(): string[] | null {
    return this.order ? [...this.order] : null;
  }

  /** Save a device's order. `changed` says whether anything was written, so
   * the caller broadcasts only real changes. */
  save(incoming: string[], options: { initial: boolean }): { order: string[]; changed: boolean } {
    if (options.initial && this.order !== null) return { order: [...this.order], changed: false };
    const next = mergeStoredSidebarOrder(this.order, incoming);
    if (this.order && next.length === this.order.length && next.every((id, index) => id === this.order![index])) {
      return { order: next, changed: false };
    }
    writeFileAtomic(join(this.dir, FILE), JSON.stringify({ order: next }, null, 2) + "\n", { mode: 0o600 });
    this.order = next;
    return { order: [...next], changed: true };
  }
}

/** `{ order: string[], initial?: boolean }` and nothing else. */
export function parseSidebarOrderRequest(
  body: unknown,
): { ok: true; order: string[]; initial: boolean } | { ok: false; error: string } {
  const refused = { ok: false as const, error: "order must be a list of up to 100 section ids" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return refused;
  const { order, initial, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length) return { ok: false, error: `Unknown field: ${Object.keys(rest)[0]}` };
  if (initial !== undefined && typeof initial !== "boolean") return { ok: false, error: "initial must be true or false" };
  const parsed = parseSidebarOrder(order);
  // Ids the sidebar could never produce are not stored. They are dropped
  // rather than refused: a device's older local copy may carry one, and
  // refusing the whole save would leave that device unable to save at all.
  return parsed ? { ok: true, order: parsed.filter(knownSidebarOrderId), initial: initial === true } : refused;
}

/** The records that decide which teams a surface can see. */
export interface SidebarOrderRoster {
  bots: ReadonlyArray<{ section?: string; hidden?: boolean }>;
  groups: ReadonlyArray<{ section?: string; dm?: boolean }>;
}

/** The order a surface is shown, and the part of a save it may make.
 *
 * The desktop gets it whole. A phone or a browser gets the fixed sections and
 * only the teams that hold a bot or room it can see, by the same rule the
 * GET /api/bots hydration and the scoped SSE stream apply (sse-visibility.ts
 * visibleToCompanion: no archived bots, no bot-to-bot rooms), so the order
 * never names a team it could not see anywhere else. A save from such a
 * surface is cut the same way, and SidebarOrderStore.save merges it into the
 * full order, where the teams it could not see keep their places. */
export function sidebarOrderForSurface(
  order: string[] | null,
  surface: "desktop" | "remote",
  roster: SidebarOrderRoster,
): string[] | null {
  if (order === null || surface === "desktop") return order;
  const teams = new Set<string>();
  for (const bot of roster.bots) if (bot.section && bot.hidden !== true) teams.add(bot.section);
  for (const group of roster.groups) if (group.section && group.dm !== true) teams.add(group.section);
  return visibleSidebarOrder(order, teams);
}
