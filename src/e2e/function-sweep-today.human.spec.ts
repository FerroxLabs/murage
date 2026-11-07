// FUNCTION-SWEEP-1018, Today: every control in Today's Needs you block is clicked once and must show a visible result.
// The row's own button, Approve and Don't allow beside it, a failed answer, "and N more" and "Show less", the count
// against the rail badge after a change elsewhere, and the quiet "Nothing needs you". The real Needs block in Calm over
// the real Inbox projection. (The rest of Today, the Tell box, Working now Stop and Watch, the team and month cards,
// opens other pages through the store; those are traced in HANDOFF-FUNCTION-SWEEP-1018.md.)
import { test, expect, type Page } from "./page-error-guard";
import { startSweepFixture, seedMorning, type SweepFixture } from "./function-sweep-fixture";

// One worker (the config), not serial mode: a failing control must not skip the controls after it.
let fx: SweepFixture;
test.beforeAll(async () => { fx = await startSweepFixture(); });
test.afterAll(async () => { await fx?.close(); });
test.beforeEach(() => { fx.reset(); seedMorning(fx); });

const rows = (page: Page) => page.locator("[data-today-row]");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const badge = (page: Page) => page.locator("[data-sweep-badge]");

test("Calm shows three rows; 'and 3 more' shows them all and 'Show less' puts them back", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(fx.origin + "/__today");
  await expect(badge(page)).toHaveText("6");
  await expect(rows(page)).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("sweep-today-calm.png"), fullPage: true });
  await page.getByRole("button", { name: "and 3 more" }).click();
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Show less" }).click();
  await expect(rows(page)).toHaveCount(3);
});

test("a row's own button opens it", async ({ page }) => {
  await page.goto(fx.origin + "/__today");
  await rows(page).first().locator("button[data-line]").click();
  await expect.poll(() => page.evaluate(() => window.opened)).toBeTruthy();
});

test("Approve and Deny answer the row in one click; the next row moves up and the count follows", async ({ page }) => {
  await page.goto(fx.origin + "/__today");
  const push = row(page, "git push origin main");
  await push.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(push).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "and 2 more" })).toBeVisible();
  const deploy = row(page, "fly deploy --app launch-site");
  await deploy.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(deploy).toHaveCount(0);
  expect(fx.calls.filter(call => call.path.endsWith("/respond")).map(call => call.body.behavior)).toEqual(["allow", "deny"]);
  await page.evaluate(() => window.emitInboxChanged!());
  await expect(badge(page)).toHaveText("4");
  await expect(page.getByRole("button", { name: "and 1 more" })).toBeVisible();
});

test("a failed answer keeps the row and says why on it", async ({ page }) => {
  fx.failing.set("req-push", "This request was already answered on your phone.");
  await page.goto(fx.origin + "/__today");
  const push = row(page, "git push origin main");
  await push.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(push.getByRole("alert")).toContainText("This request was already answered on your phone.");
  await expect(push).toHaveCount(1);
});

test("an answer from another window leaves Today with the badge", async ({ page }) => {
  await page.goto(fx.origin + "/__today");
  await expect(row(page, "git push origin main")).toHaveCount(1);
  fx.answer("req-push");
  await page.evaluate(() => window.emitInboxChanged!());
  await expect(badge(page)).toHaveText("5");
  await expect(row(page, "git push origin main")).toHaveCount(0);
});

test("nothing owed reads 'Nothing needs you' and the badge reads 0", async ({ page }) => {
  fx.reset();
  await page.goto(fx.origin + "/__today");
  await expect(page.getByRole("heading", { name: "Nothing needs you" })).toBeVisible();
  await expect(badge(page)).toHaveText("0");
});
