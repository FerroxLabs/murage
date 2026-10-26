// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a spec reaches the chat header's and the composer's controls the way a
// person does, at every width. Since 1.0.7 a phone (below md, the
// `useNarrowViewport` query) draws the chat header as a back circle, the bot's
// name pill and one round "More actions" menu; the bot's profile, the model,
// the bot's computer and every folded slot are entries of that menu
// (ChatHeader.tsx). The phone composer is a round "Message options" + beside
// the field, holding Attach, Finish together and the approval level
// (ComposerPlusMenu.tsx). A tablet or desktop keeps the row of controls.
import { expect, type Locator, type Page } from "@playwright/test";
import { possessive } from "../lib/possessive";

/** src/lib/media-query.ts NARROW_MEDIA_QUERY: the phone header and composer. */
const NARROW = "(max-width: 767.98px)";

/** A menu entry by its label. An entry's accessible name is its whole text,
 *  so one with a detail line ("Bot settings" over "Open Dax's profile") is
 *  named by both, run together ("Finish togetherThe team keeps..."): match
 *  the label at the start of the name. */
function entryName(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/** True while the page is drawing the phone header and composer. Read from
 *  the page, so a spec that resizes the viewport gets the layout it now has. */
export async function phoneLayout(page: Page): Promise<boolean> {
  return page.evaluate((query) => matchMedia(query).matches, NARROW);
}

/** The open chat's header, for one bot or for any. On a tablet or desktop it
 *  is the avatar button "Open <name>'s profile"; on a phone it is the name
 *  pill beside the "More actions" menu, which is where that profile lives. */
export async function chatHeaderFor(page: Page, name?: string): Promise<Locator> {
  if (await phoneLayout(page)) {
    const pill = page.locator("[data-chat-header-phone] [data-chat-header-pill]");
    return name === undefined ? pill.first() : pill.filter({ hasText: name }).last();
  }
  if (name === undefined) return page.getByRole("button", { name: /^Open .+'s profile$/ }).first();
  return page.getByRole("button", { name: `Open ${possessive(name)} profile` }).last();
}

/** Wait until a chat is on screen (any bot, or the named one). */
export async function expectChatHeader(page: Page, name?: string): Promise<void> {
  await expect.poll(async () => (await chatHeaderFor(page, name)).isVisible(), { timeout: 15_000 }).toBe(true);
}

/** The header's More actions button (the phone's round "..."). */
export function headerMoreButton(page: Page): Locator {
  return page.locator("[data-chat-header]").getByRole("button", { name: /^More actions/ }).last();
}

/** Open the header's More actions menu and choose an entry by its name. */
export async function chooseFromHeaderMenu(page: Page, item: string): Promise<void> {
  await headerMoreButton(page).click();
  const menu = page.getByRole("menu", { name: "More header actions", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: entryName(item) }).click();
}

/** Open the shown bot's profile (Bot settings) the way a person does: the
 *  avatar or name button on a wide screen, the "..." menu's Bot settings
 *  entry ("Open <name>'s profile") on a phone. */
export async function openBotProfile(page: Page, name?: string): Promise<void> {
  if (await phoneLayout(page)) {
    await headerMoreButton(page).click();
    const menu = page.getByRole("menu", { name: "More header actions", exact: true });
    const entry = menu.getByRole("menuitem", { name: entryName("Bot settings") });
    await expect(entry).toBeVisible();
    if (name !== undefined) await expect(entry).toHaveAccessibleDescription(`Open ${possessive(name)} profile`);
    await entry.click();
    return;
  }
  await page.getByRole("button", { name: name === undefined ? /^Open .+'s profile$/ : `Open ${possessive(name)} profile`, exact: name !== undefined }).first().click();
}

/** The thread model picker's own trigger. On a wide screen it is the visible
 *  chip; on a phone it is not drawn (the Model entry of the "..." menu opens
 *  the same picker), so this is the hidden trigger that holds the picker's
 *  label: the model and effort the visible conversation uses. */
export async function threadModelTrigger(page: Page): Promise<Locator> {
  if (await phoneLayout(page)) return page.locator('[data-chat-header] button[aria-label^="Thread model:"]');
  return page.getByRole("button", { name: /^Thread model:/ });
}

/** Open the thread model picker the way a person does at the current width. */
export async function openThreadModel(page: Page): Promise<void> {
  if (await phoneLayout(page)) await chooseFromHeaderMenu(page, "Model");
  else await page.getByRole("button", { name: /^Thread model:/ }).click();
}

/** The phone composer's round + ("Message options"). */
export function composerPlusButton(page: Page): Locator {
  return page.getByRole("button", { name: "Message options", exact: true });
}

/** Press Finish together: the room composer's chip, or the phone + menu's entry. */
export async function toggleFinishTogether(page: Page): Promise<void> {
  if (await phoneLayout(page)) {
    await composerPlusButton(page).click();
    await page.getByRole("menu", { name: "Composer actions", exact: true }).getByRole("menuitemcheckbox", { name: entryName("Finish together") }).click();
    return;
  }
  await page.getByRole("button", { name: "Finish together", exact: true }).click();
}

/** Finish together is on (or off) where a person reads it: the chip's pressed
 *  state, or the tick on the phone + menu's entry (the menu is closed again). */
export async function expectFinishTogether(page: Page, on: boolean): Promise<void> {
  if (await phoneLayout(page)) {
    await composerPlusButton(page).click();
    const menu = page.getByRole("menu", { name: "Composer actions", exact: true });
    await expect(menu.getByRole("menuitemcheckbox", { name: entryName("Finish together") })).toHaveAttribute("aria-checked", String(on));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    return;
  }
  await expect(page.getByRole("button", { name: "Finish together", exact: true })).toHaveAttribute("aria-pressed", String(on));
}

/** The approval level the composer shows for the visible conversation: the
 *  chip by its name ("Ask for approval", "Auto mode") on a wide screen, or the
 *  phone + menu's "Approval level" entry, which reads the chip's word ("Ask",
 *  "Auto"). The menu is closed again. */
export async function expectApprovalLevel(page: Page, label: string, chip: string): Promise<void> {
  if (await phoneLayout(page)) {
    await composerPlusButton(page).click();
    const menu = page.getByRole("menu", { name: "Composer actions", exact: true });
    await expect(menu.getByRole("menuitem", { name: entryName("Approval level") })).toHaveAccessibleDescription(chip);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    return;
  }
  await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
}
