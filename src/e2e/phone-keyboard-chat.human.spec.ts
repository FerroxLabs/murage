// A 1:1 chat on the phone with the on-screen keyboard open. iOS pans the
// visual viewport down inside the layout viewport to reveal the focused
// composer; the shell has to follow it, so the header stays visible, the
// composer sits on the keyboard and a short transcript stays at the top.
// The keyboard is simulated the way intake.human.spec.ts does it: the
// visualViewport height (and its pan, offsetTop) are overridden.
import { FIXTURES } from "./rig";
import { expect, openSidebar, SEND_KEY, test } from "./fixtures";
import { possessive } from "../lib/possessive";

test("phone chat: the shell follows the visual viewport when the keyboard opens", async ({ app }, info) => {
  test.skip(info.project.name !== "mobile", "phone layout only");
  const name = FIXTURES.titledNoSkills.name;
  await expect(app.getByRole("button", { name: /^Open .+'s profile$/ }).first()).toBeVisible();
  const sidebar = await openSidebar(app);
  await sidebar.getByText(name, { exact: true }).click();
  await expect(app.getByRole("button", { name: `Open ${possessive(name)} profile` }).last()).toBeVisible();
  const composer = app.getByPlaceholder(/^Message /).first();
  await composer.fill("Hello there");
  await composer.press(SEND_KEY);
  await expect(app.getByTestId("msg-bubble").first()).toBeVisible();
  await composer.focus();

  const KEYBOARD_TOP = 450, PAN = 120;
  await app.evaluate(([height, pan]) => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => height });
    Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, get: () => pan });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, [KEYBOARD_TOP - PAN, PAN]);
  await expect.poll(() => app.evaluate(() => document.documentElement.dataset.keyboard)).toBe("open");
  const bottom = KEYBOARD_TOP;
  await expect.poll(async () => Math.round((await app.locator("#root").boundingBox())!.y)).toBe(PAN);

  const composerBox = (await composer.boundingBox())!;
  const header = (await app.getByRole("button", { name: `Open ${possessive(name)} profile` }).first().boundingBox())!;
  const bubbles = app.getByTestId("msg-bubble");
  const last = (await bubbles.last().boundingBox())!;
  const inset = await app.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--inset-top")) || 0);
  expect(header.y).toBeGreaterThanOrEqual(PAN + inset - 0.5);
  expect(last.y + last.height).toBeLessThanOrEqual(composerBox.y + 0.5);
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(bottom + 0.5);
  expect(composerBox.y + composerBox.height).toBeGreaterThan(bottom - 160);
  expect(await app.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  await app.screenshot({ path: info.outputPath("phone-ui-chat-after.png") });
});
