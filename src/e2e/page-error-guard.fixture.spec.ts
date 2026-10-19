// Proves the guard: a page that throws on load must fail in seconds, with the
// error as the cause. `test.fail()` makes the suite pass only when it does.
import { test, expect } from "./page-error-guard";

test.describe("page error guard", () => {
  test.fail();
  test.setTimeout(15_000);
  test("a throwing page fails fast instead of waiting on a locator", async ({ page }) => {
    await page.setContent("<button id=go>go</button><script>setTimeout(() => { throw new Error('boom on mount'); }, 50);</script>");
    // would wait the whole 120 s CI timeout without the guard
    await expect(page.locator("#never-appears")).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("page error guard opt-out", () => {
  test.use({ allowPageErrors: true });
  test("a spec that expects a page error keeps running", async ({ page }) => {
    await page.setContent("<p id=ok>still here</p><script>setTimeout(() => { throw new Error('expected'); }, 10);</script>");
    await page.waitForTimeout(100);
    await expect(page.locator("#ok")).toBeVisible();
  });
});
