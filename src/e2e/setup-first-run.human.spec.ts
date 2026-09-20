// The first hour, on a machine whose brain cannot answer.
//
// This is the spec the release exists for. It drives the REAL first run: a
// real harness on a real data dir, the real app drawn by Vite, the real
// GET/POST /api/setup routes, and a real engine — present, selectable,
// probed available — that fails every turn it is given. Nothing here is
// stubbed, and in particular the routes under test are not: `page.route` is
// never called, so every tick and every "still to do" on screen was derived
// by the server from live state.
//
// What it has to show: the checklist keeps working. The steps a person can
// answer go green; `brain` and `first-task`, which need an engine that
// actually replies, stay open and say why in the server's own words.
import { writeFileSync } from "node:fs";

import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";
import { axeScriptPath } from "./axe";
import { FIXTURE_INSTANCE } from "./setup-fixture.mjs";

const WCAG = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } } as const;

async function harness(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: { ...(await desktopHeaders()), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

test.beforeAll(async () => {
  // A fresh install auto-creates one bot and seats it as Chief of Staff; all
  // this does is put it on the fixture engine, which is what a packaged
  // install does for itself with the engine it ships. After this the Chief
  // HAS a brain and that brain does not work — the case under test.
  const { bots } = await harness("GET", "/api/bots?messages=0");
  const chief = bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff) ?? bots[0];
  await harness("PATCH", `/api/bots/${chief.id}`, {
    modelSelection: { instanceId: FIXTURE_INSTANCE, model: "fixture-model" },
  });
});

const panel = (page: import("@playwright/test").Page) => page.locator("[data-setup-panel]");
const card = (page: import("@playwright/test").Page, step: string) => page.locator(`[data-setup-step="${step}"]`);
const progress = (page: import("@playwright/test").Page) => page.locator("[data-setup-progress]");

test("the guided first run survives an engine that never answers", async ({ app }, info) => {
  const failures: string[] = [];
  app.on("pageerror", (error) => failures.push(String(error)));

  // It offers itself: nothing has been answered on this install, so the
  // Chief opens the checklist without being asked.
  await expect(panel(app)).toBeVisible();
  await expect(progress(app)).toHaveText("0 of 8 done");
  await expect(app.locator("[data-setup-step]")).toHaveCount(8);

  // /setup replaces the floating Flux invitation, which asks the same
  // question: two offers of the same key, one of them over the checklist on
  // a phone, is the friction this release removes.
  await expect(app.getByRole("complementary", { name: "Let your bots pick the right model" })).toHaveCount(0);

  // The checklist opens on the step the SERVER says is next, and the rest
  // are collapsed ticks until they are opened.
  await expect(card(app, "flux").getByRole("button", { name: "Paste your key" })).toBeVisible();

  // The one question, and the four chips. Answering it is the person's own
  // answer, so the server takes it and the count moves.
  await card(app, "purpose").getByRole("button", { name: "Open" }).click();
  await card(app, "purpose").getByRole("button", { name: "Email and calendar" }).click();
  await expect(progress(app)).toHaveText("1 of 8 done");
  await expect(card(app, "purpose")).toHaveAttribute("data-setup-status", "done");

  await card(app, "voice").getByRole("button", { name: "Open" }).click();
  await card(app, "voice").getByRole("button", { name: "Short and direct" }).click();
  await expect(progress(app)).toHaveText("2 of 8 done");

  // Passed over is NOT done. The count stays where it was and the card keeps
  // saying what is still outstanding.
  await card(app, "crew").getByRole("button", { name: "Open" }).click();
  await card(app, "crew").getByRole("button", { name: "Skip this for now" }).click();
  await expect(card(app, "crew")).toHaveAttribute("data-setup-status", "skipped");
  await expect(progress(app)).toHaveText("2 of 8 done");
  await expect(card(app, "crew")).toContainText("Passed over");

  // The two that need a working brain. The server says why, and the card
  // repeats the server, not a guess of its own.
  await expect(card(app, "brain")).toHaveAttribute("data-setup-status", "open");
  await expect(card(app, "brain")).toContainText("has not answered yet");
  await expect(card(app, "first-task")).toHaveAttribute("data-setup-status", "open");
  await expect(card(app, "first-task")).toContainText("No bot has produced a real reply yet.");

  // No claim the app cannot stand behind.
  await card(app, "apps").getByRole("button", { name: "Open" }).click();
  await expect(card(app, "apps")).toContainText("hundreds of apps, including Gmail, Slack, Notion and GitHub");
  await expect(app.locator("[data-setup-panel]")).not.toContainText("500+");

  // Accessibility, at both widths, on the flow as drawn.
  for (const width of [1440, 390] as const) {
    await app.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await app.addScriptTag({ path: axeScriptPath });
    const axe = await app.evaluate(
      async ([selector, options]) => (window as any).axe.run(document.querySelector(selector as string), options),
      ["[data-setup-panel]", WCAG] as const,
    );
    writeFileSync(info.outputPath(`axe-first-run-${width}.json`), JSON.stringify(axe.violations, null, 2));
    const serious = axe.violations.filter((violation: { impact: string }) =>
      violation.impact === "critical" || violation.impact === "serious");
    expect(serious.map((violation: { impact: string; id: string }) => `${violation.impact}:${violation.id}`)).toEqual([]);
    await app.screenshot({ path: info.outputPath(`setup-first-run-${width}.png`), fullPage: true });
  }
  await app.setViewportSize({ width: 1440, height: 900 });

  // Every control in the flow is reachable from the keyboard and named.
  const names = await app.locator("[data-setup-panel] button, [data-setup-panel] a, [data-setup-panel] input, [data-setup-panel] textarea")
    .evaluateAll((nodes) => nodes.map((node) => ({
      tag: node.tagName,
      name: (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(),
      tabIndex: (node as HTMLElement).tabIndex,
    })));
  expect(names.length).toBeGreaterThan(8);
  expect(names.filter((entry) => entry.name.length === 0)).toEqual([]);
  expect(names.filter((entry) => entry.tabIndex < 0)).toEqual([]);

  // "Say hello" is a real send to a real engine. It closes the checklist and
  // lands in the Chief's own thread, exactly as a person would do it.
  await card(app, "brain").getByRole("button", { name: "Open" }).click();
  await card(app, "brain").getByRole("button", { name: "Say hello" }).click();
  await expect(panel(app)).toHaveCount(0);

  // `/setup` in the composer's "/" menu brings the same list back.
  const composer = app.locator("main textarea").first();
  await composer.click();
  await composer.fill("/");
  await app.getByRole("option", { name: /\/setup/ }).click();
  await expect(panel(app)).toBeVisible();

  // And after a turn that could not produce a reply, the server still says
  // so: no tick was awarded for pressing the button.
  await expect(card(app, "brain")).toHaveAttribute("data-setup-status", "open");
  await expect(card(app, "first-task")).toHaveAttribute("data-setup-status", "open");
  await expect(progress(app)).toHaveText("2 of 8 done");

  const view = await harness("GET", "/api/setup");
  expect(view.progress).toEqual({ done: 2, total: 8 });
  expect(view.steps.find((step: { id: string }) => step.id === "brain").status).toBe("open");
  expect(view.steps.find((step: { id: string }) => step.id === "first-task").status).toBe("open");

  expect(failures).toEqual([]);
});

test("Run setup again in Settings reopens the same list, with its ticks", async ({ app }) => {
  // It does NOT offer itself a second time: the workspace has answered
  // something now, so the checklist waits to be asked for.
  await expect(panel(app)).toHaveCount(0);

  await app.getByTitle("App settings").first().click();
  await app.getByRole("button", { name: "Run setup again" }).click();
  await expect(panel(app)).toBeVisible();

  // Reopened, not restarted: what the first test answered is still answered,
  // and a finished step offers Change rather than asking again.
  await expect(card(app, "purpose")).toHaveAttribute("data-setup-status", "done");
  await expect(card(app, "purpose").getByRole("button", { name: "Change" })).toBeVisible();
  await expect(card(app, "crew")).toHaveAttribute("data-setup-status", "skipped");
});
