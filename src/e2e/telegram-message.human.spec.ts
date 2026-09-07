import { FIXTURES } from "./rig";
import { expect, test, openSidebar } from "./fixtures";

const body = "Hello from Telegram\n> Keep this quote\n```ts\nconst count = 1;\n```";
const raw = `[UNTRUSTED TELEGRAM CHANNEL MESSAGE]\n${body}\n[/UNTRUSTED TELEGRAM CHANNEL MESSAGE]`;

test("Telegram envelope becomes a source label while examples and editing stay literal", async ({ app }, testInfo) => {
  await app.route("**/api/bots", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const data = await response.json();
    for (const bot of data.bots ?? []) {
      if (bot.name !== FIXTURES.blank.name) continue;
      bot.busy = false;
      bot.activeLeafId = null;
      bot.messages = [raw, `Example:\n${raw}`, "Ordinary message"].map((text, i) => ({
        id: `telegram-display-${i}`, role: "user", kind: "text", text, at: Date.now() - 3000 + i,
      }));
    }
    await route.fulfill({ response, json: data });
  });
  await app.reload();
  const sidebar = await openSidebar(app);
  await sidebar.getByText(FIXTURES.blank.name, { exact: true }).click();
  const bubbles = app.getByTestId("msg-bubble");
  await expect(bubbles).toHaveCount(3);
  await expect(bubbles.nth(0)).toContainText(body);
  await expect(bubbles.nth(0).getByText("Telegram", { exact: true })).toBeVisible();
  await expect(bubbles.nth(0)).not.toContainText("UNTRUSTED TELEGRAM");
  await expect(bubbles.nth(1)).toContainText(`Example:\n${raw}`);
  await expect(bubbles.nth(2)).toHaveText("Ordinary message");
  await app.screenshot({ path: testInfo.outputPath("telegram-display.png") });

  if (testInfo.project.name === "mobile") {
    await bubbles.nth(0).tap();
    await app.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: "Edit message", exact: true }).click();
  } else {
    await bubbles.nth(0).hover();
    await app.getByRole("button", { name: "Edit message", exact: true }).first().click();
  }
  await expect(app.getByTestId("chat-scroll").locator("textarea")).toHaveValue(raw);
  await app.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(bubbles.nth(0).getByText("Telegram", { exact: true })).toBeVisible();
});
