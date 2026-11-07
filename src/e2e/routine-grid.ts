// The quick form opens from an empty slot on the grid. C, the header button
// and the sidebar open New routine from a sentence instead (UX L5B), so a spec
// about the quick form presses on the grid the way a person does.
import { expect, type Page } from "@playwright/test";

/** Presses on an empty, visible slot of the first day and returns the quick form. */
export async function openQuickForm(page: Page) {
  const point = await page.evaluate(() => {
    const cell = document.querySelector<HTMLElement>('[role="grid"][aria-label="Routine and call calendar"] [role="gridcell"]');
    const scroller = cell?.closest<HTMLElement>(".overflow-auto");
    if (!cell || !scroller) throw new Error("no calendar grid on screen");
    const c = cell.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    const top = Math.max(c.top, s.top), bottom = Math.min(c.bottom, s.bottom);
    return { x: c.left + Math.min(16, c.width / 2), y: top + (bottom - top) * 0.6 };
  });
  await page.mouse.click(point.x, point.y);
  const quick = page.getByRole("dialog", { name: "Quick create" });
  await expect(quick).toBeVisible();
  return quick;
}
