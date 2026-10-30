// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a spec reaches the sidebar's destinations since 0.1.62: Routines,
// Files, Connected apps and the Team map sit in a labelled strip under "Needs
// you", and What's new, Keyboard shortcuts and Teach a skill sit in the "You"
// menu on your name in the footer. (0.1.61 folded all of them behind one
// "Tools" pull-up; these helpers answered for both layouts until the layout
// change landed.)
import type { Locator, Page } from "@playwright/test";

type Scope = Page | Locator;

/** The strip's places, keyed by their `data-sidebar-place` value. */
export type SidebarPlace = "routines" | "files" | "apps" | "map";

/** The footer menu's trigger: your name. */
export function accountMenuTrigger(scope: Scope): Locator {
  return scope.locator("[data-sidebar-you-trigger]").first();
}

/** Open the footer menu and choose one of its items by its visible name. */
export async function chooseFromAccountMenu(scope: Scope, item: string): Promise<void> {
  await accountMenuTrigger(scope).click();
  await scope.getByRole("menuitem", { name: item, exact: true }).click();
}

/** UX 1.0.13: Routines is a door at the top of the rail; Files, Connected apps and Team map are in the You menu. */
const MENU_NAME: Record<Exclude<SidebarPlace, "routines">, string> = { files: "Files", apps: "Connected apps", map: "Team map" };

/** The control that opens a place: the Routines door, or your name (the You menu holds the rest). */
export function sidebarPlace(scope: Scope, place: SidebarPlace): Locator {
  return place === "routines" ? scope.locator('[data-door="routines"]').first() : accountMenuTrigger(scope);
}

/** Go to a place. */
export async function openSidebarPlace(scope: Scope, place: SidebarPlace): Promise<void> {
  if (place === "routines") await scope.locator('[data-door="routines"]').first().click();
  else await chooseFromAccountMenu(scope, MENU_NAME[place]);
}
