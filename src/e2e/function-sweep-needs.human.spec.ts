// FUNCTION-SWEEP-1018, Needs you: every control on the page is clicked once and must show a visible result. Refresh,
// every tab and its count against the rail badge, the bot chips, Search, Open, Mark read, Open request, Approve and
// Don't allow on a row, Remind me, Approve all with its caution and sheet (Review them first, Continue, Cancel, a
// ticked bot, Approve N), and the empty page. The real Inbox (door mode) over the real Inbox projection.
import { test, expect, type Page } from "./page-error-guard";
import { startSweepFixture, seedMorning, type SweepFixture } from "./function-sweep-fixture";

// One worker (the config), not serial mode: a failing control must not skip the controls after it.
let fx: SweepFixture;
test.beforeAll(async () => { fx = await startSweepFixture(); });
test.afterAll(async () => { await fx?.close(); });
test.beforeEach(() => { fx.reset(); seedMorning(fx); });

const rows = (page: Page) => page.locator("[data-needs-row]");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const tabs = (page: Page) => page.getByRole("navigation", { name: "Inbox views" });
const tab = (page: Page, label: string) => tabs(page).getByRole("button", { name: new RegExp(`^${label}( \\(\\d+\\))?$`) });
const badge = (page: Page) => page.locator("[data-sweep-badge]");
async function snoozeViaApi(requestId: string) {
  const page = await (await fetch(`${fx.origin}/api/inbox?view=decisions&pageSize=25`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": "function-sweep-proof" } })).json() as { items: Array<{ id: string; version: string; link: { messageId: string } }> };
  const item = page.items.find(entry => fx.db.prepare("SELECT 1 FROM messages WHERE id=? AND json_extract(json,'$.card.requestId')=?").get(entry.link.messageId, requestId));
  if (!item) throw Error(`no inbox item for ${requestId}`);
  const res = await fetch(`${fx.origin}/api/inbox/state`, { method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": "function-sweep-proof" }, body: JSON.stringify({ id: item.id, version: item.version, snoozedUntil: Date.now() + 3 * 60 * 60_000 }) });
  expect(res.ok).toBe(true);
}

test("every tab opens its own list, and its count matches the rail badge", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(fx.origin + "/__needs");
  await expect(rows(page)).toHaveCount(6);
  await expect(badge(page)).toHaveText("6");
  await expect(tab(page, "Needs you")).toHaveText("Needs you (6)");
  await expect(tab(page, "Approvals")).toHaveText("Approvals (4)");
  await expect(tab(page, "Decisions")).toHaveText("Decisions (2)");
  await expect(tab(page, "Connections")).toHaveText("Connections (0)");
  await page.screenshot({ path: testInfo.outputPath("sweep-needs-tabs.png"), fullPage: true });
  for (const [label, shown, empty] of [["Approvals", 4, null], ["Decisions", 2, null], ["Connections", 0, "Everything is connected."], ["Routines", 0, "Your routines have not run yet."], ["Results", 0, "Nothing finished in the background yet."], ["All", 6, null], ["Needs you", 6, null]] as const) {
    await tab(page, label).click();
    await expect(tab(page, label)).toHaveAttribute("aria-pressed", "true");
    if (label === "All") await expect(page.getByRole("heading", { level: 3 })).toHaveCount(shown);
    else if (shown) await expect(rows(page)).toHaveCount(shown);
    if (empty) await expect(page.getByText(empty)).toBeVisible();
    // the counts never move when only the tab changes
    await expect(tab(page, "Approvals")).toHaveText("Approvals (4)");
  }
});

test("a change elsewhere reaches the tab counts on every tab, not only Needs you (inbox.changed)", async ({ page }) => {
  await page.goto(fx.origin + "/__needs?view=approvals");
  await expect(rows(page)).toHaveCount(4);
  fx.card("orion-task", "late", Date.now() - 1_000, { requestId: "req-late", title: "Approval needed", subtitle: "npm publish", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true });
  await page.evaluate(() => window.emitInboxChanged!());
  await expect(badge(page)).toHaveText("7");
  // the badge said 7 while the open tab still said 4: the counts disagreed until Refresh
  await expect(tab(page, "Approvals")).toHaveText("Approvals (5)");
  await expect(row(page, "npm publish")).toHaveCount(1);
});

test("a snoozed question is not announced as hidden on Approvals, where Show snoozed would show nothing", async ({ page }) => {
  await snoozeViaApi("req-ask");
  await page.goto(fx.origin + "/__needs");
  // snoozed still counts on the umbrella and the badge, and is hidden from the list
  await expect(badge(page)).toHaveText("6");
  await expect(tab(page, "Needs you")).toHaveText("Needs you (6)");
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByText("1 snoozed. It still counts until you answer it.")).toBeVisible();
  await page.getByRole("button", { name: "Show snoozed" }).click();
  await expect(rows(page)).toHaveCount(6);
  await expect(row(page, "Post the launch thread now?")).toHaveCount(1);
  await page.getByRole("button", { name: "Hide snoozed" }).click();
  await expect(rows(page)).toHaveCount(5);
  await tab(page, "Decisions").click();
  await expect(page.getByText("1 snoozed. It still counts until you answer it.")).toBeVisible();
  await tab(page, "Approvals").click();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByText(/snoozed\. (It|They) still count/)).toHaveCount(0);
});

test("the rail's Needs you door brings Approvals back to the Needs you tab", async ({ page }) => {
  await page.goto(fx.origin + "/__needs");
  await tab(page, "Approvals").click();
  await expect(rows(page)).toHaveCount(4);
  await page.locator("[data-sweep-door]").click();
  await expect(tab(page, "Needs you")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(6);
});

test("Refresh reads the list again after an answer from another window", async ({ page }) => {
  await page.goto(fx.origin + "/__needs?view=approvals");
  await expect(row(page, "git push origin main")).toHaveCount(1);
  fx.answer("req-push");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(row(page, "git push origin main")).toHaveCount(0);
  await expect(tab(page, "Approvals")).toHaveText("Approvals (3)");
});

test("Search finds, a second Search with the same words reads again, and an empty Search shows everything", async ({ page }) => {
  await page.goto(fx.origin + "/__needs");
  const box = page.getByRole("searchbox", { name: "Search Inbox" });
  await box.fill("orion");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, "curl https://example.com/report.csv")).toHaveCount(1);
  fx.card("orion-task", "deploy2", Date.now() - 1_000, { requestId: "req-deploy2", title: "Approval needed", subtitle: "fly deploy --app docs-site", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await box.fill("nothing-matches-this");
  await box.press("Enter");
  await expect(page.getByText("No matching Inbox items.")).toBeVisible();
  await box.fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(rows(page)).toHaveCount(7);
});

test("KNOWN (not fixed here, the projection's search text): Search for the command a row shows finds nothing", async ({ page }) => {
  test.fail(true, "search matches title, summary, status and the conversation name; an approval's command is only in the live card");
  await page.goto(fx.origin + "/__needs");
  await page.getByRole("searchbox", { name: "Search Inbox" }).fill("fly deploy");
  // the list before the answer still shows the row, so the check waits for the searched list to arrive and render
  const searched = page.waitForResponse(response => response.url().includes("/api/inbox?") && new URL(response.url()).searchParams.get("query") === "fly deploy");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await searched;
  await expect(row(page, "git push origin main")).toHaveCount(0);
  await expect(row(page, "fly deploy --app launch-site")).toHaveCount(1, { timeout: 4_000 });
});

test("bot chips filter the list and All brings it back", async ({ page }) => {
  await page.goto(fx.origin + "/__needs");
  await page.getByRole("button", { name: "Orion 2", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Orion 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Sable 4", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole("button", { name: "All 6", exact: true }).click();
  await expect(rows(page)).toHaveCount(6);
});

test("Open expands the row with its verbs; Mark read, Open request and Remind me each do what they say", async ({ page }) => {
  await page.goto(fx.origin + "/__needs");
  // The row's id, read before Open: on a phone (UX L7) the open card rises as a sheet that carries the row marker, so
  // the row and its Open button are found by id, and `del` is the open card on both widths (#needs-row-body-<id>).
  const id = await row(page, "rm -rf ~/Documents/old-drafts").locator("[data-needs-open]").getAttribute("data-needs-open");
  expect(id).toBeTruthy();
  const open = page.locator(`[data-needs-open="${id}"]`);
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  const del = page.locator(`[id="needs-row-body-${id}"]`);
  await expect(del.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(del.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await del.getByRole("button", { name: "Mark read" }).click();
  await expect(del.getByRole("button", { name: "Mark unread" })).toBeVisible();
  await del.getByRole("button", { name: "Open request" }).click();
  await expect.poll(() => page.evaluate(() => window.opened)).toBeTruthy();
  await del.getByRole("button", { name: /^Remind me/ }).click();
  await expect(del).toHaveCount(0);
  // snoozing is not answering: the umbrella keeps counting it once the write lands (after the Undo window)
  await expect(tab(page, "Needs you")).toHaveText("Needs you (6)");
});

test("Approve and Deny on a collapsed row answer it and the counts follow", async ({ page }) => {
  await page.goto(fx.origin + "/__needs");
  await row(page, "git push origin main").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(row(page, "git push origin main")).toHaveCount(0);
  await row(page, "fly deploy --app launch-site").getByRole("button", { name: "Deny", exact: true }).click();
  await expect(row(page, "fly deploy --app launch-site")).toHaveCount(0);
  await expect(tab(page, "Approvals")).toHaveText("Approvals (2)");
  // the server's inbox.changed after the answers (the real app gets it over the socket)
  await page.evaluate(() => window.emitInboxChanged!());
  await expect(badge(page)).toHaveText("4");
});

// APPROVALS-SIMPLE-1018 redesigned Approve all on the desktop: the button names its count, there is no sheet, and the
// five sheet items this sweep found (stale sheet, "Approve 0", a result line forever, an error after Cancel, a surface
// read once) are gone or fixed. These two tests replace the sweep's sheet test and its KNOWN Refresh test.
test("Approve all: the caution (Cancel, Don't show again, Got it), then the count it names, applied with no sheet, then one line", async ({ page }, testInfo) => {
  await page.goto(fx.origin + "/__needs");
  const all = page.locator("button[data-approve-all]");
  // three plain approvals; the scoped delete stays one at a time and says why
  await expect(all).toHaveText("Approve all 3");
  await expect(row(page, "rm -rf ~/Documents/old-drafts")).toContainText("one at a time: deletes something");
  await all.click();
  const caution = page.getByRole("group", { name: "Before you approve them all" });
  await expect(caution).toBeVisible();
  await caution.getByRole("button", { name: "Cancel" }).click();
  await expect(caution).toHaveCount(0);
  await all.click();
  await caution.getByRole("checkbox", { name: "Don't show this again" }).check();
  await caution.getByRole("button", { name: "Got it" }).click();
  expect(fx.calls.some(call => call.path === "/api/inbox/approve-all/caution" && call.body.dismissed === true)).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Approved 3." })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sweep-approve-all-result.png"), fullPage: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const apply = fx.calls.find(call => call.path === "/api/inbox/approve-all/apply");
  expect(apply?.body.requestIds).toEqual(["req-push", "req-deploy", "req-fetch"]);
  await expect(row(page, "git push origin main")).toHaveCount(0);
  await expect(row(page, "curl https://example.com/report.csv")).toHaveCount(0);
  await expect(row(page, "rm -rf ~/Documents/old-drafts")).toHaveCount(1);
  // one left it would not answer: no button, never "Approve 0"
  await expect(all).toHaveCount(0);
  // Refresh clears the result line
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved 3." })).toHaveCount(0);
});

test("Refresh closes an open Approve all step when the rows were answered elsewhere (was KNOWN, Sean's repro)", async ({ page }) => {
  await page.goto(fx.origin + "/__needs");
  await page.locator("button[data-approve-all]").click();
  await expect(page.getByRole("group", { name: "Before you approve them all" })).toBeVisible();
  fx.answer("req-push"); fx.answer("req-deploy"); fx.answer("req-fetch");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(tab(page, "Approvals")).toHaveText("Approvals (1)");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("button[data-approve-all]")).toHaveCount(0);
  expect(fx.calls.some(call => call.path === "/api/inbox/approve-all/apply")).toBe(false);
});

test("the empty page says nothing is waiting, offers no Approve all, and the badge reads 0", async ({ page }) => {
  fx.reset();
  await page.goto(fx.origin + "/__needs");
  await expect(page.getByText("Nothing is waiting on you right now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve all", exact: true })).toHaveCount(0);
  await expect(badge(page)).toHaveText("0");
  await expect(tab(page, "Needs you")).toHaveText("Needs you (0)");
});
