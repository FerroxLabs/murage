// What a thumb can actually do with a message.
//
// The per-message hover rail is `opacity-0` until `group-hover`, and a phone
// reports `hover: none`. Below `md` it is now `display: none` — which gave the
// transcript back ~130px of every row (74.4% → 85.6% of a 390px screen) and
// took away the last way of copying, replying to, or speaking a message on a
// phone. Nothing visible was lost; a capability was.
//
// This spec is that capability, measured rather than asserted:
//
//   1. A tap on a bubble opens a sheet, and every control the desktop rail
//      offers is in it, on a target a thumb can hit (44px).
//   2. The transcript is exactly as wide with the affordance as without it.
//      The sheet is `fixed` and portalled to <body>, so it takes no part in a
//      row's layout — but "so it should be" is what the last regression said,
//      so the width is measured with the sheet open.
//   3. Desktop is untouched: the rail still lays out beside the bubble, and a
//      click on a bubble still means nothing.
//
// The fixture is injected by rewriting the hydration response, for the reason
// transcript-width.human.spec.ts gives: the numbers depend on the exact
// content, and a seeded transcript would drift with every other spec sharing
// the scratch workspace.
import type { Page } from "@playwright/test";

import { FIXTURES } from "./rig";
import { expect, test } from "./fixtures";

const NOW = Date.now();
const ROOM_ID = "actions-room";
const ROOM_NAME = "Actions Room";

/** A link inside the answer: a tap on it is the link's, not the sheet's. */
const LINK_TEXT = "the calendar docs";
const ANSWER = [
  "Three calendars, and the detail is in " + `[${LINK_TEXT}](https://developers.google.com/calendar).`,
  "",
  "1. Work — writer access",
  "2. Personal — owner",
].join("\n");

const FIXTURE_MESSAGES = [
  { id: "a-user-1", role: "user", kind: "text", text: "Check my Google calendars.", at: NOW - 4000 },
  { id: "a-bot-1", role: "bot", kind: "text", text: ANSWER, at: NOW - 2000 },
];

async function seedTranscript(page: Page): Promise<void> {
  await page.route("**/api/bots", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    for (const bot of body.bots ?? []) {
      if (bot.name !== FIXTURES.blank.name) continue;
      bot.messages = FIXTURE_MESSAGES;
      bot.activeLeafId = null;
    }
    const member = (body.bots ?? [])[0];
    if (member) {
      body.groups = [
        {
          id: ROOM_ID,
          threadId: `${ROOM_ID}-thread`,
          name: ROOM_NAME,
          memberIds: [member.id],
          defaultResponder: { kind: "member", botId: member.id },
          bulletin: "",
          unread: false,
          createdAt: NOW - 10_000,
          setupCompletedAt: NOW - 9_000,
          setupSkippedAt: null,
          activeLeafId: null,
          messages: FIXTURE_MESSAGES.map((message) =>
            message.role === "bot"
              ? { ...message, id: `room-${message.id}`, from: { botId: member.id, name: member.name, color: member.color } }
              : { ...message, id: `room-${message.id}` },
          ),
        },
        ...(body.groups ?? []),
      ];
    }
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/groups/${ROOM_ID}*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

/** Opens the seeded 1:1 chat or the synthesised channel. Lifted from
 *  transcript-width.human.spec.ts, including its reasons: the drawer toggle is
 *  idempotent here because this spec reloads into an app that may already have
 *  it open. */
async function openSeeded(page: Page, target: "chat" | "channel"): Promise<void> {
  await seedTranscript(page);
  await page.reload();
  await expect(page.getByTestId("chat-scroll")).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Bots and navigation" });
  const menu = page.getByRole("button", { name: "Open bot list" });
  await expect(menu.or(sidebar).first()).toBeVisible();
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true") {
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
  }
  await expect(sidebar).toBeVisible();
  // Dismiss the first-run offer through its normal control before selecting
  // a row it can cover on a narrow viewport.
  const invite = page.getByRole("complementary", { name: "Let your bots pick the right model" });
  if (await invite.isVisible()) {
    await invite.getByRole("button", { name: "Not now", exact: true }).last().click();
    await expect(invite).toBeHidden();
  }
  await sidebar.getByText(target === "chat" ? FIXTURES.blank.name : ROOM_NAME, { exact: true }).click();
  await expect(
    page.getByTestId("chat-scroll").getByText("Three calendars", { exact: false }),
  ).toBeVisible();
}

/** The bot's answer. `.last()` because the user's question is above it. */
const answerBubble = (page: Page) => page.getByTestId("msg-bubble").last();
const sheet = (page: Page) => page.getByRole("dialog", { name: "Message actions" });

/** A thumb, not a mouse: the mobile project sets `hasTouch`, and a tap is a
 *  different event sequence from a click — which is the sequence this
 *  affordance has to survive. */
async function tap(page: Page, target: ReturnType<typeof answerBubble>): Promise<void> {
  await target.tap();
  await expect(sheet(page)).toBeVisible();
}

/** The widest bubble, the way transcript-width.human.spec.ts measures it. */
async function bubbleWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('[data-testid="msg-bubble"]')] as HTMLElement[];
    return Math.max(...bubbles.map((el) => el.getBoundingClientRect().width));
  });
}

test.describe("on a phone", () => {
  // Both projects match `*.human.spec.ts`; this half is the 390px one. The
  // empty pattern is required: Playwright rejects a non-destructured first
  // argument, and naming a fixture here would instantiate it for the tests
  // this hook is about to skip.
  // oxlint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the phone's affordance");
  });

  test("a tap on a message offers everything the desktop rail does", async ({ app }) => {
    await openSeeded(app, "chat");
    await tap(app, answerBubble(app));

    // The bot side of the rail: copy, speak, regenerate, reply, pin.
    for (const name of ["Copy message", "Reply", "Pin message"]) {
      await expect(sheet(app).getByRole("button", { name, exact: true })).toBeVisible();
    }
    // Speak is present whether or not a voice is configured — with the reason
    // as its label when it is not, because a hidden control is not a control.
    await expect(sheet(app).getByRole("button", { name: /Read aloud|ElevenLabs|Pick a voice/ })).toBeVisible();

    // …and the timestamp the phone also lost when the rail went.
    await expect(sheet(app)).toContainText(/\d{1,2}:\d{2}/);
  });

  test("every action is a target a thumb can hit", async ({ app }, testInfo) => {
    await openSeeded(app, "chat");
    await tap(app, answerBubble(app));

    const rows = await sheet(app).getByRole("button").all();
    expect(rows.length).toBeGreaterThan(3);
    const heights: Array<{ label: string; height: number }> = [];
    for (const row of rows) {
      const box = await row.boundingBox();
      heights.push({ label: (await row.textContent())?.trim() ?? "", height: box?.height ?? 0 });
    }
    console.log(`\n[${testInfo.project.name}] sheet targets`);
    for (const row of heights) console.log(`  ${row.height.toFixed(1)}px  ${row.label}`);
    // 44px is Apple's minimum, and the number this whole design is for.
    expect(heights.filter((row) => row.height < 44)).toEqual([]);
    await app.screenshot({ path: testInfo.outputPath("message-action-targets.png") });
  });

  test("the transcript is not one pixel narrower for having it", async ({ app }, testInfo) => {
    await openSeeded(app, "chat");
    const closed = await bubbleWidth(app);
    await tap(app, answerBubble(app));
    const open = await bubbleWidth(app);
    const viewport = app.viewportSize()!.width;

    console.log(`\n[${testInfo.project.name}] viewport ${viewport}px`);
    console.log(`  widest bubble, sheet closed  ${closed.toFixed(1)}px  (${((closed / viewport) * 100).toFixed(1)}%)`);
    console.log(`  widest bubble, sheet open    ${open.toFixed(1)}px  (${((open / viewport) * 100).toFixed(1)}%)`);

    // The sheet is `fixed` and portalled to <body>: it is out of flow, so it
    // cannot buy its space from the row. Measured, not assumed.
    expect(open).toBe(closed);
    // And the width the `max-md:hidden` fix bought is still there.
    expect(closed / viewport).toBeGreaterThan(0.92);
  });

  test("a tap on a link inside an answer is the link's", async ({ app }) => {
    await openSeeded(app, "chat");
    const link = app.getByTestId("chat-scroll").getByRole("link", { name: LINK_TEXT });
    await expect(link).toBeVisible();
    // The link opens elsewhere; what matters here is that the sheet does not
    // appear over it. `noWaitAfter` because the navigation is not ours.
    await link.tap({ noWaitAfter: true }).catch(() => {});
    await expect(sheet(app)).toBeHidden();
  });

  test("there is always a way out of the sheet", async ({ app }) => {
    await openSeeded(app, "chat");

    await tap(app, answerBubble(app));
    await sheet(app).getByRole("button", { name: "Close" }).tap();
    await expect(sheet(app)).toBeHidden();

    await tap(app, answerBubble(app));
    await app.keyboard.press("Escape");
    await expect(sheet(app)).toBeHidden();

    // The ground behind it, which is where a thumb lands by accident.
    await tap(app, answerBubble(app));
    await app.mouse.click(10, 10);
    await expect(sheet(app)).toBeHidden();
  });

  test("a channel message offers its own rail's pair", async ({ app }) => {
    await openSeeded(app, "channel");
    await tap(app, answerBubble(app));
    await expect(sheet(app).getByRole("button", { name: "Reply", exact: true })).toBeVisible();
    await expect(sheet(app).getByRole("button", { name: "Pin message", exact: true })).toBeVisible();
  });
});

test.describe("on a desktop", () => {
  // oxlint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the pointer's rail");
  });

  test("a click on a bubble still means nothing, and the rail is still there", async ({ app }) => {
    await openSeeded(app, "chat");
    const bubble = answerBubble(app);

    // The rail: laid out beside the bubble, revealed by hover. Unchanged.
    await bubble.hover();
    const reply = app.getByTestId("chat-scroll").getByRole("button", { name: "Reply to message" }).last();
    await expect(reply).toBeVisible();

    await bubble.click();
    await expect(sheet(app)).toBeHidden();
    // …and the bubble is not a tab stop on a pointer device either.
    expect(await bubble.getAttribute("tabindex")).toBeNull();
    expect(await bubble.getAttribute("aria-haspopup")).toBeNull();
  });
});
