// The bug, reproduced at the size it was seen.
//
// A real Android phone, on the tailnet, through the browser door, was served
// the DESKTOP's first-run experience: the welcome / email gate ("tell us who
// you are") to a man holding the device he had already paired, and then the
// PHONE SETUP wizard, on the phone, whose readiness panel denied that
// Tailscale was on this computer and that Murage was listening in a browser —
// while he read it in a browser, over Tailscale.
//
// Both screens are DESKTOP first-run screens. The gate keys off localStorage,
// which is empty in any browser that has not run Murage before; the wizard
// describes the machine, which this renderer cannot see. So this spec starts
// with a genuinely empty localStorage — it uses raw `page`, deliberately NOT
// the shared `app` fixture, which pre-sets the gate key — and changes only one
// thing between its two tests: which door /api/config says this renderer came
// through.
//
// That single variable is the point. `surface: "remote"` must produce the app
// with no first-run screens; `surface: "desktop"` must produce exactly what
// the desktop produced before this change, at the SAME viewport — so a narrow
// window is proved not to be the test, and the desktop is proved untouched.
import { expect, test } from "@playwright/test";

import { openSidebar } from "./fixtures";

// 390x844 for both tests. The remote one is the phone. The desktop one is a
// narrow desktop window, and it must still get its gate.
test.use({ viewport: { width: 390, height: 844 } });

/** The desktop's first-run screen, by the words on it. It used to be an
 * email gate headed "Welcome to Murage" / "Tell us who you are"; it is now an
 * outcome picker whose eyebrow is set in capitals ("WELCOME TO MURAGE"), with
 * the name and email behind "Add your details (optional)". */
const WELCOME = /welcome to murage/i;
const EMAIL_CAPTURE = /What would you like to do\?/;
/** The phone-setup wizard, by its heading and by the two denials. */
const PHONE_WIZARD = /Open Murage in your browser/;
const DENIALS = [/not found/, /not listening yet/];

/** Serve the app the answer a phone gets from the browser door.
 *
 * Only the GET is rewritten, and only the one field: everything else about
 * this config is real, so the app under test is the real app. The door itself
 * is what strips the desktop marker in production; here the marker never
 * leaves the machine, so the answer is patched at the wire instead. */
async function answerRemote(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    await route.fulfill({
      response,
      json: { ...body, surface: "remote" },
    });
  });
}

/** Serve the app the answer a brand-new workspace gets: no bots, no rooms.
 * The shared rig is seeded, and the first-run screen correctly stands aside
 * for an established workspace (Onboarding's checkWorkspace), so without this
 * neither test would be looking at a first run at all. Both tests get it, so
 * the door stays the only difference between them. */
async function answerEmptyWorkspace(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/bots?messages=0", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    await route.fulfill({ response, json: { ...body, bots: [], groups: [] } });
  });
}

test("a phone is never asked to introduce itself, or to set itself up", async ({ page }) => {
  await answerEmptyWorkspace(page);
  await answerRemote(page);
  await page.goto("/");

  // The app itself arrives — this is a suppression, not a blank screen.
  await expect(page.getByRole("button", { name: "Open bot list" })).toBeVisible();

  for (const copy of [WELCOME, EMAIL_CAPTURE, PHONE_WIZARD, ...DENIALS]) {
    await expect(page.getByText(copy)).toHaveCount(0);
  }

  // Settings → Phone is the wizard's other door. The section is gone, so the
  // pane holds none of it. Below `md` the app-settings button lives inside the
  // drawer, so the drawer opens first.
  const sidebar = await openSidebar(page);
  await sidebar.getByRole("button", { name: "App settings" }).first().click();
  await expect(page.getByRole("button", { name: "Phone", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connections", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Engines", exact: true })).toHaveCount(0);
  for (const copy of [PHONE_WIZARD, ...DENIALS]) {
    await expect(page.getByText(copy)).toHaveCount(0);
  }
});

test("the desktop still gets its first-run gate, at the same width", async ({ page }) => {
  // No interception: on loopback the harness confirms `surface: "desktop"`,
  // which is what the developer's own machine and the packaged app both are.
  // Same empty localStorage, same 390px viewport — the ONLY difference from
  // the test above is the door. Narrow is not remote.
  await answerEmptyWorkspace(page);
  await page.goto("/");

  await expect(page.getByText(WELCOME)).toBeVisible();
  await expect(page.getByText(EMAIL_CAPTURE)).toBeVisible();
  // The name and email moved behind an optional disclosure; opening it is
  // still the same desktop-only gate.
  await page.getByRole("button", { name: "Add your details (optional)" }).click();
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Maybe later" })).toBeVisible();
});

/** A brand-new install is not an empty workspace: the harness seeds one bot on
 * its first start, whose thread opens with its greeting and intake question.
 * Serve exactly that shape (one bot, no rooms, a thread of only its own
 * opening lines), or the same bot after the person has written to it. */
async function answerSeededWorkspace(page: import("@playwright/test").Page, talkedTo: boolean): Promise<{ threadAsked: Promise<void> }> {
  let asked!: () => void;
  const threadAsked = new Promise<void>((resolve) => { asked = resolve; });
  await page.route("**/api/bots?messages=0", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    const seed = { ...(body.bots?.[0] ?? {}), threadId: "seed-thread", title: "", description: "", tasks: [{ threadId: "seed-thread" }] };
    await route.fulfill({ response, json: { ...body, bots: [seed], groups: [] } });
  });
  await page.route("**/api/threads/seed-thread/messages?limit=10", async (route) => {
    const opening = [
      { id: "m1", at: 1, role: "bot", kind: "text", text: "Hello." },
      { id: "m2", at: 2, role: "bot", kind: "options", card: { question: "What do you actually want me for?" } },
    ];
    const messages = talkedTo ? [...opening, { id: "m3", at: 3, role: "user", kind: "text", text: "Help me plan my week" }] : opening;
    asked();
    await route.fulfill({ json: { messages, hasMore: false } });
  });
  return { threadAsked };
}

test("a fresh install's own seeded bot still gets the welcome", async ({ page }) => {
  // Was: any bot at all read as an established workspace, so the seeded bot
  // hid this screen on every fresh install and a new user landed in its
  // intake questions instead.
  const { threadAsked } = await answerSeededWorkspace(page, false);
  await page.goto("/");
  await threadAsked;
  await expect(page.getByText(WELCOME)).toBeVisible();
  await expect(page.getByText(EMAIL_CAPTURE)).toBeVisible();
});

test("a workspace whose one bot has been talked to goes straight in", async ({ page }) => {
  const { threadAsked } = await answerSeededWorkspace(page, true);
  await page.goto("/");
  await threadAsked;
  await expect(page.getByText("Checking your workspace…")).toHaveCount(0);
  await expect(page.getByText(WELCOME)).toHaveCount(0);
  await expect(page.getByText(EMAIL_CAPTURE)).toHaveCount(0);
});
