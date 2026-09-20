// A key that authenticates perfectly, and cannot spend.
//
// This is the case the third status exists for, and the one a first run gets
// most wrong: the account has hit its ceiling, the provider answers 402, and
// the app tells the person their key is bad. It is not bad. There is nothing
// to re-paste.
//
// The 402 here is real. A real turn goes to the real driver, the shipped ACP
// fixture refuses it with a genuine payment rejection, the store records the
// provider error, and `GET /api/setup` derives the block from that — nothing
// in this spec stubs a route, and in particular the setup routes are driven
// exactly as the app drives them.
import { writeFileSync } from "node:fs";

import { expect, test } from "./fixtures";
import { HARNESS_URL, desktopHeaders } from "./rig";
import { axeScriptPath } from "./axe";
import { FIXTURE_INSTANCE } from "./setup-fixture.mjs";

const WCAG = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } } as const;

/** Obviously not a credential: it says what it is for, in words no provider
 *  issues. It only has to be key-SHAPED — eight printable characters, no
 *  whitespace, no other provider's prefix — which is the whole point: the
 *  key is fine and the spending is not. */
const FIXTURE_KEY = "fixture-not-a-real-flux-key-for-e2e-only";

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
  const { bots } = await harness("GET", "/api/bots?messages=0");
  const chief = bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff) ?? bots[0];

  // Saved through the app's own connection route, so the server judges it
  // exactly as it judges a key a person pasted into the one key field.
  const flux = await harness("GET", "/api/flux-connection");
  const saved = await harness("POST", "/api/flux-connection/mutate", {
    action: "connect",
    revision: flux.revision,
    key: FIXTURE_KEY,
  });
  expect(saved.configured).toBe(true);

  // The Chief routes through Flux Router, which is how a plain 402 is
  // attributed to Flux's account rather than somebody else's.
  await harness("PATCH", `/api/bots/${chief.id}`, {
    modelSelection: { instanceId: FIXTURE_INSTANCE, model: "flux-auto" },
  });

  // One real turn. The engine refuses it on payment.
  await harness("POST", `/api/bots/${chief.id}/messages`, { text: "Say hello" });
  await expect
    .poll(async () => (await harness("GET", "/api/setup")).blocked, { timeout: 30_000, intervals: [500] })
    .toContain("flux");
});

const card = (page: import("@playwright/test").Page, step: string) => page.locator(`[data-setup-step="${step}"]`);

test("a capped account is not a wrong key", async ({ app }, info) => {
  const failures: string[] = [];
  app.on("pageerror", (error) => failures.push(String(error)));

  const flux = card(app, "flux");
  await expect(flux).toBeVisible();
  await expect(flux).toHaveAttribute("data-setup-status", "blocked");

  // The server's own sentence, word for word. The panel has no wording of
  // its own for this, deliberately.
  const serverMessage = (await harness("GET", "/api/setup"))
    .steps.find((step: { id: string }) => step.id === "flux").block.message;
  expect(serverMessage).toContain("there is nothing to re-paste");
  await expect(flux).toContainText(serverMessage);

  // Not accused, and not asked to do the thing that would not help.
  await expect(flux).not.toContainText(/paste it again/i);
  await expect(flux).not.toContainText(/not in a shape/i);
  await expect(flux).not.toContainText(/invalid|incorrect|wrong key/i);
  await expect(flux.getByRole("button", { name: "Paste your key" })).toHaveCount(0);

  // Not "to do", either: the person did this one right.
  await expect(flux).toContainText("Blocked");
  await expect(flux).not.toContainText("To do");

  // The two steps that need a turn to land carry the engine's own payment
  // block, in the server's words rather than a second copy of them.
  for (const step of ["brain", "first-task"] as const) {
    await expect(card(app, step)).toHaveAttribute("data-setup-status", "blocked");
    await expect(card(app, step)).toContainText("refused on payment");
  }

  for (const width of [1440, 390] as const) {
    await app.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await app.addScriptTag({ path: axeScriptPath });
    const axe = await app.evaluate(
      async ([selector, options]) => (window as any).axe.run(document.querySelector(selector as string), options),
      ["[data-setup-panel]", WCAG] as const,
    );
    writeFileSync(info.outputPath(`axe-blocked-${width}.json`), JSON.stringify(axe.violations, null, 2));
    const serious = axe.violations.filter((violation: { impact: string }) =>
      violation.impact === "critical" || violation.impact === "serious");
    expect(serious.map((violation: { impact: string; id: string }) => `${violation.impact}:${violation.id}`)).toEqual([]);
    await app.screenshot({ path: info.outputPath(`setup-blocked-${width}.png`), fullPage: true });
  }

  expect(failures).toEqual([]);
});
