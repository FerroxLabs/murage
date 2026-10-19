// A shared Playwright `test` that fails the running test the moment the page
// throws. Specs used to log `pageerror` and carry on, so a crash on mount
// showed up as a 120 s locator timeout, doubled by the CI retry, and sank
// whole shards. Here the page is closed on the first uncaught error: every
// pending action fails at once, and teardown reports the error itself as the
// cause. A spec that expects page errors sets `allowPageErrors`.
import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ allowPageErrors: boolean; pageErrorGuard: void }>({
  allowPageErrors: [false, { option: true }],
  pageErrorGuard: [async ({ page, allowPageErrors }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.stack ?? error.message);
      console.error(`PAGE ERROR: ${error.message}`);
      if (!allowPageErrors) void page.close().catch(() => undefined);
    });
    await use();
    if (!allowPageErrors && errors.length) throw new Error(`the page threw ${errors.length} uncaught error(s); first: ${errors[0]}`);
  }, { auto: true }],
});

// Everything else (Page, Locator, chromium, ...) passes straight through, so a
// spec only ever changes its import path.
export * from "@playwright/test";
export { expect };
