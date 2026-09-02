// The `test` every human spec imports. It carries the two things a spec
// should never have to remember: the app has an email gate in front of it,
// and below `md` the sidebar is a drawer rather than a column.
import { expect, test as base, type Locator, type Page } from "@playwright/test";

export { expect };

/** analytics.ts:120 — set before the first script runs so the gate overlay
 *  never mounts. A spec about the gate itself can clear it. */
const EMAIL_GATE_KEY = "murage-email-gate";

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.addInitScript(
      ([key, value]) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          /* storage blocked — the gate just renders, which specs can handle */
        }
      },
      [EMAIL_GATE_KEY, "skipped"] as const,
    );
    await page.goto("/");
    await use(page);
  },
});

/** The bot list. On desktop it is always in the layout; below `md` it slides
 *  in over the chat and has to be opened first, so a spec that just asserted
 *  visibility would pass on an off-screen drawer. */
export async function openSidebar(page: Page): Promise<Locator> {
  const menu = page.getByRole("button", { name: "Open bot list" });
  // md:hidden — present in the DOM at every width, visible only on phones.
  if (await menu.isVisible()) {
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
  }
  const sidebar = page.getByRole("complementary", { name: "Bots and navigation" });
  await expect(sidebar).toBeVisible();
  return sidebar;
}
