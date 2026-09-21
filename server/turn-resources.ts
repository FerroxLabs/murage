// Adapted from OpenMausBot #981/#983, e014babe6fe162e9a7397dc37e0f025725f334c2.
// Apache-2.0; preserve Murage's own browser/computer integration callers.
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type TurnOwner = Readonly<{ threadId: string; generation: string }>;

/** Claims cover a whole turn and its final cleanup, not an individual click.
 * These coordinate app-managed resources, not arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, TurnOwner>();

  claim(resource: string, owner: TurnOwner): boolean {
    return this.claimAll([resource], owner);
  }

  /** Admission can require browser, computer and workspace together. Refusal
   * must not leave a partial lease that blocks an otherwise independent turn. */
  claimAll(resources: readonly string[], owner: TurnOwner): boolean {
    for (const resource of resources) {
      for (const [key, current] of this.owners) {
        if (overlaps(key, resource) && !sameOwner(current, owner)) return false;
      }
    }
    const frozen = Object.freeze({ ...owner });
    for (const resource of resources) this.owners.set(resource, frozen);
    return true;
  }

  /** Resources this generation currently holds, so a waiter can release them
   * all and later re-claim the same union atomically. */
  heldBy(owner: TurnOwner): string[] {
    return [...this.owners].filter(([, current]) => sameOwner(current, owner)).map(([key]) => key);
  }

  /** Other owners holding something that overlaps `resources`, one entry per
   * requested resource that is blocked (first holder only). */
  conflicts(resources: readonly string[], owner: TurnOwner): Array<{ resource: string; owner: TurnOwner }> {
    const blocked: Array<{ resource: string; owner: TurnOwner }> = [];
    for (const resource of resources) {
      for (const [key, current] of this.owners) {
        if (overlaps(key, resource) && !sameOwner(current, owner)) { blocked.push({ resource, owner: current }); break; }
      }
    }
    return blocked;
  }

  owns(resource: string, owner: TurnOwner): boolean {
    const current = this.owners.get(resource);
    return Boolean(current && sameOwner(current, owner));
  }

  release(owner: TurnOwner): void {
    for (const [key, current] of this.owners) {
      if (sameOwner(current, owner)) this.owners.delete(key);
    }
  }

  /** Hand back part of what this generation holds, keeping the rest. A turn
   * claims the bot's computer and screen before it knows which destination it
   * will resolve to; without this it would hold a destination it never mounted
   * for the whole turn, and every sibling thread would queue behind it.
   * Returns what was actually given up. */
  releaseSome(owner: TurnOwner, resources: readonly string[]): string[] {
    const released: string[] = [];
    for (const resource of resources) {
      const current = this.owners.get(resource);
      if (current && sameOwner(current, owner)) { this.owners.delete(resource); released.push(resource); }
    }
    return released;
  }
}

/** The bot's computer and its screen, as claim keys. A bot has ONE of each,
 * whatever destination a turn resolves to, which is why two threads of the
 * same bot must not hold them at once. `local` is deliberately absent from
 * the computer key: host tools are arbitrated per action by the broker and
 * are never reserved for a whole turn. */
export function computerResourceKeys(botId: string, kind: string): string[] {
  return [...(kind === "local" ? [] : [kind === "vm" ? "computer:vm" : `computer:bot:${botId}`]), screenResourceKey(botId)];
}

export function screenResourceKey(botId: string): string {
  return `screen:bot:${botId}`;
}

/** What a turn must claim at admission, before any destination side effect.
 *
 * An explicit destination is known here. Auto is not: it resolves later, to
 * an existing cloud box, a reachable VPS, or the host — and until this was
 * written it claimed NOTHING for the first two, so two Auto threads of the
 * same bot could mount the SAME box and drive the same screen at once, which
 * is precisely the inconsistent ownership the atomic claim exists to prevent.
 * Auto now claims the same pair up front and `unusedComputerClaims` hands
 * back whatever it did not use. */
export function admissionComputerClaims(input: {
  botId: string;
  /** explicit destination; undefined is Auto */
  wants: string | undefined;
  /** Auto could still resolve to this bot's cloud computer */
  autoCloudPossible: boolean;
  /** Auto could still fall back to the host's own screen */
  autoHostScreenPossible: boolean;
}): string[] {
  const { botId, wants } = input;
  if (wants !== undefined) {
    return wants === "off" || wants === "browser" ? [] : computerResourceKeys(botId, wants);
  }
  if (input.autoCloudPossible) return computerResourceKeys(botId, "cloud");
  return input.autoHostScreenPossible ? [screenResourceKey(botId)] : [];
}

/** What to hand back once the destination has actually resolved. Only claims
 * this turn made are returned, and only ones nothing else still needs: a
 * mounted computer keeps both, a routed screen preview keeps the screen, and
 * a browser that claimed the same screen keeps it too. */
export function unusedComputerClaims(input: {
  botId: string;
  claimed: readonly string[];
  mountedKind: "box" | "vps" | "vm" | "local" | null;
  /** a screenshot source is wired for this turn's preview */
  previewRouted: boolean;
  /** the browser side of this turn claimed the same screen */
  browserHoldsScreen: boolean;
}): string[] {
  const { botId, claimed, mountedKind } = input;
  const holdsComputer = mountedKind === "box" || mountedKind === "vps" || mountedKind === "vm";
  const holdsScreen = mountedKind !== null || input.previewRouted || input.browserHoldsScreen;
  const give = [
    ...(holdsComputer ? [] : [`computer:bot:${botId}`, "computer:vm"]),
    ...(holdsScreen ? [] : [screenResourceKey(botId)]),
  ];
  return give.filter((resource) => claimed.includes(resource));
}

export function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}

export function workspaceResource(cwd: string): string {
  // The selected folder must exist. Native realpath resolves symlinks and
  // filename casing on case-insensitive volumes before overlap checks.
  const canonical = realpathSync.native(resolve(cwd));
  return `workspace:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("workspace:") || !b.startsWith("workspace:")) return false;
  const left = a.slice("workspace:".length), right = b.slice("workspace:".length);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path));
  };
  return contains(left, right) || contains(right, left);
}
