// What a phone actually shows.
//
// Two claims, both measured rather than read off a class list:
//
//   1. The transcript uses the width of the phone. Sean compared it to
//      Claude's own Android app and counted about 75% — a quarter of a 390px
//      screen spent on gutter. The desktop's reading measure (42rem ≈ 65-75
//      characters) is deliberate and must survive; only the phone changes.
//   2. Nothing runs off the right edge. A long MCP tool name, a long file
//      path, a long URL and a wide code block all have to wrap or scroll
//      INSIDE their own container. The shell must never scroll sideways.
//
// The fixture is injected by rewriting the hydration response rather than by
// writing to the scratch workspace: the numbers depend on the exact content,
// and a seeded transcript would drift with every other spec that touches the
// same store.
import type { Page } from "@playwright/test";

import { FIXTURES } from "./rig";
import { expect, test } from "./fixtures";

/** The identifier from the photograph, plus the other unbreakable shapes a
 *  real answer carries: an absolute path, a URL, and a wide code block. */
const TOOL_NAME = "mcp__io-github-taylorwilsdon-google-workspace-mcp__list_calendars";
const LONG_PATH = "/Users/seandonahoe/Library/Application Support/murage/workspaces/google-workspace-mcp/calendars.json";
const LONG_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true&minAccessRole=writer";
/** No spaces and no hyphens: the shape `overflow-wrap: normal` cannot break,
 *  which is what makes a paragraph's min-content wider than a phone. */
const UNBREAKABLE = "9f2c4e7ab13d5580c6e1f4a92b8d70c3e5147fa6b29d0c8e3f71a45b6d2c9e08a41f7c2b95d6e0";
const WIDE_CODE = [
  "```bash",
  `npx --yes @modelcontextprotocol/inspector --cli node ${LONG_PATH} --transport stdio --tool ${TOOL_NAME}`,
  "```",
].join("\n");

const ANSWER = [
  `I called \`${TOOL_NAME}\` and it came back with three calendars.`,
  "",
  "1. Work — writer access, cached at " + `\`${LONG_PATH}\``,
  "2. Personal — owner",
  "3. Holidays — reader",
  "",
  `The list endpoint is ${LONG_URL}`,
  "",
  `Cache key \`${UNBREAKABLE}\` and, as plain prose, ${UNBREAKABLE} again.`,
  "",
  "> A quoted line that is long enough to need the full measure of the screen,",
  "> because a nested quote is one of the shapes that wraps worst on a phone.",
  "",
  WIDE_CODE,
].join("\n");

const NOW = Date.now();

/** Deliberately not `E2E `-prefixed: smoke.human.spec counts `/^E2E /` rows,
 *  and this room exists only inside one page's intercepted response anyway. */
const ROOM_ID = "width-room";
const ROOM_NAME = "Width Room";

const FIXTURE_MESSAGES = [
  { id: "w-user-1", role: "user", kind: "text", text: "Check my Google calendars.", at: NOW - 4000 },
  {
    id: "w-tool-1",
    role: "bot",
    kind: "activity",
    at: NOW - 3000,
    tool: { name: TOOL_NAME, ok: true },
  },
  { id: "w-bot-1", role: "bot", kind: "text", text: ANSWER, at: NOW - 2000 },
];

/** Hydration + config rewritten in flight. `showToolCalls` is off by default
 *  (feature-flags.ts) and the tool chip is half of what is being measured. */
async function seedTranscript(page: Page): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.features = { ...body.features, showToolCalls: true };
    await route.fulfill({ response, json: body });
  });

  await page.route("**/api/bots", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    for (const bot of body.bots ?? []) {
      if (bot.name !== FIXTURES.blank.name) continue;
      bot.messages = FIXTURE_MESSAGES;
      // visibleMessages() walks parentId back from the leaf; with no leaf it
      // returns the flat list, which is exactly this fixture in order.
      bot.activeLeafId = null;
    }

    // The same transcript in a channel. GroupView carries its own copy of the
    // bubble and chip chrome, so measuring only the 1:1 view would leave half
    // the fix unproven. The room is synthesised into the hydration response
    // rather than created for real: no group is seeded, and creating one would
    // leave a fixture behind in a workspace other specs share.
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

  // Selecting the synthesised room marks it read, and that PATCH would 404
  // into an error toast. The room is a render fixture, so acknowledge it.
  await page.route(`**/api/groups/${ROOM_ID}*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

type Measurement = {
  viewport: number;
  scroller: { width: number; padLeft: number; padRight: number; contentWidth: number };
  widestBubble: { box: number; content: number } | null;
  docScrollWidth: number;
  docClientWidth: number;
  bodyScrollWidth: number;
  chip: { width: number; right: number; nameScroll: number; nameClient: number } | null;
  /** The hover-only reply control: laid out on a pointer device, gone below
   *  `md`. `boxes` is 0 when `display: none` has taken it out of the flow. */
  rail: { boxes: number; left: number; width: number } | null;
  offenders: Array<{ tag: string; cls: string; right: number; over: number; text: string }>;
};

/** Every measurement in one round trip, so the printed numbers and the
 *  assertions can never describe two different frames. */
async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="chat-scroll"]') as HTMLElement;
    const scrollerStyle = getComputedStyle(scroller);
    const padLeft = parseFloat(scrollerStyle.paddingLeft);
    const padRight = parseFloat(scrollerStyle.paddingRight);
    const scrollerRect = scroller.getBoundingClientRect();

    const bubbles = [...document.querySelectorAll('[data-testid="msg-bubble"]')] as HTMLElement[];
    const measured = bubbles
      .map((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          box: rect.width,
          content: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      })
      .sort((a, b) => b.box - a.box);

    const chipEl = document.querySelector('[data-testid="tool-chip"]') as HTMLElement | null;
    const nameEl = chipEl?.querySelector('[data-testid="tool-chip-name"]') as HTMLElement | null;

    // The right edge content is allowed to reach. Anything past it is either
    // clipped by the scroller's overflow-x-hidden or would scroll the page.
    const limit = scrollerRect.right - padRight;

    // An element that overflows is fine IF something between it and the
    // scroller clips or scrolls — that is "inside its own container". So an
    // offender is an element past the limit with no such ancestor.
    const contained = (el: Element): boolean => {
      let node = el.parentElement;
      while (node && node !== scroller) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const offenders = ([...scroller.querySelectorAll("*")] as HTMLElement[])
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.right > limit + 0.5 && !contained(el);
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") ?? "").slice(0, 90),
        right: Math.round(el.getBoundingClientRect().right * 10) / 10,
        over: Math.round((el.getBoundingClientRect().right - limit) * 10) / 10,
        text: (el.textContent ?? "").trim().slice(0, 60),
      }))
      .sort((a, b) => b.over - a.over)
      .slice(0, 12);

    return {
      viewport: window.innerWidth,
      scroller: {
        width: scrollerRect.width,
        padLeft,
        padRight,
        contentWidth: scrollerRect.width - padLeft - padRight,
      },
      widestBubble: measured[0] ?? null,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      chip: chipEl && nameEl
        ? {
            width: chipEl.getBoundingClientRect().width,
            right: chipEl.getBoundingClientRect().right,
            nameScroll: nameEl.scrollWidth,
            nameClient: nameEl.clientWidth,
          }
        : null,
      rail: (() => {
        const el = scroller.querySelector('button[aria-label="Reply to message"]') as HTMLElement | null;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { boxes: el.getClientRects().length, left: rect.left, width: rect.width };
      })(),
      offenders,
    };
  });
}

/** Opens the seeded 1:1 chat, or the synthesised channel, and waits until the
 *  fixture is really on screen. */
async function openSeeded(page: Page, target: "chat" | "channel"): Promise<void> {
  await seedTranscript(page);
  await page.reload();

  // Barrier before any decision: the app restores its last selection during
  // hydration, and a drawer opened before that finishes is closed again by the
  // restore — leaving the row to click off-screen for the rest of the test. A
  // mounted transcript means the restore has already happened.
  await expect(page.getByTestId("chat-scroll")).toBeVisible();

  // Not the rig's `openSidebar()`: that helper toggles unconditionally, and
  // this spec reloads into an app that may already have the drawer open — a
  // toggle then closes it and the row to click is off-screen. Both steps here
  // are idempotent, so selecting an already-selected conversation is a no-op.
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

  await expect(page.getByTestId("tool-chip")).toBeVisible();
  // Scoped to the transcript: the sidebar renders a preview of the same text.
  await expect(
    page.getByTestId("chat-scroll").getByText("three calendars", { exact: false }),
  ).toBeVisible();
}

function reportWidth(m: Measurement, label: string): void {
  const pct = (n: number) => `${((n / m.viewport) * 100).toFixed(1)}%`;
  console.log(`\n[${label}] viewport ${m.viewport}px`);
  console.log(`  transcript gutter    ${m.scroller.padLeft}px / ${m.scroller.padRight}px`);
  console.log(`  transcript content   ${m.scroller.contentWidth}px  (${pct(m.scroller.contentWidth)})`);
  console.log(`  widest bubble box    ${m.widestBubble?.box.toFixed(1)}px  (${pct(m.widestBubble!.box)})`);
  console.log(`  message content      ${m.widestBubble?.content.toFixed(1)}px  (${pct(m.widestBubble!.content)})`);
}

function expectWidth(m: Measurement, project: string): void {
  console.log(`  hover rail           ${m.rail ? `${m.rail.boxes} box(es), ${m.rail.width}px wide` : "absent"}`);
  if (project === "mobile") {
    // `md:contents` has to actually remove it from the row on a phone —
    // otherwise the width above is bought back by an invisible control.
    expect(m.rail?.boxes ?? 0).toBe(0);
  } else {
    // …and it has to still be a laid-out flex item beside the bubble on a
    // pointer device, which is the half of `md:contents` a width assertion
    // alone would never notice breaking.
    expect(m.rail).not.toBeNull();
    expect(m.rail!.boxes).toBeGreaterThan(0);
    expect(m.rail!.width).toBeGreaterThan(0);
    expect(m.rail!.left).toBeGreaterThanOrEqual(m.widestBubble!.box);
  }

  if (project === "mobile") {
    // 75% was the bug. A phone gets a trim, not a margin: the bubble keeps the
    // screen's width less the transcript's own, and the text inside it keeps
    // that less the bubble's padding.
    expect(m.widestBubble!.box / m.viewport).toBeGreaterThan(0.92);
    expect(m.widestBubble!.content / m.viewport).toBeGreaterThan(0.85);
  } else {
    // The desktop reading measure is the point of the 42rem cap: ~65-75
    // characters. Losing it would be a regression, not a fix.
    expect(m.widestBubble!.box).toBeLessThanOrEqual(672 + 0.5);
    expect(m.widestBubble!.box).toBeGreaterThan(600);
  }
}

test("the transcript uses the width of the screen it is on", async ({ app }, testInfo) => {
  await openSeeded(app, "chat");
  const m = await measure(app);
  reportWidth(m, testInfo.project.name);
  expectWidth(m, testInfo.project.name);
  await app.screenshot({ path: testInfo.outputPath("transcript-width.png"), animations: "disabled" });
});

test("a channel transcript uses that width too", async ({ app }, testInfo) => {
  await openSeeded(app, "channel");
  const m = await measure(app);
  reportWidth(m, `${testInfo.project.name} channel`);
  expectWidth(m, testInfo.project.name);
  expect(m.offenders).toEqual([]);
});

test("nothing in the transcript runs off the right edge", async ({ app }, testInfo) => {
  await openSeeded(app, "chat");
  const m = await measure(app);

  console.log(`\n[${testInfo.project.name}] overflow, viewport ${m.viewport}px`);
  console.log(`  documentElement scrollWidth/clientWidth  ${m.docScrollWidth}/${m.docClientWidth}`);
  console.log(`  body scrollWidth                          ${m.bodyScrollWidth}`);
  console.log(`  tool chip width ${m.chip?.width.toFixed(1)}px, right ${m.chip?.right.toFixed(1)}px`);
  console.log(`  tool name scrollWidth/clientWidth  ${m.chip?.nameScroll}/${m.chip?.nameClient}`);
  if (m.offenders.length > 0) {
    console.log("  elements past the content edge:");
    for (const o of m.offenders) {
      console.log(`    +${o.over}px  <${o.tag}> "${o.text}"  [${o.cls}]`);
    }
  } else {
    console.log("  elements past the content edge: none");
  }

  // The page itself never scrolls sideways.
  expect(m.docScrollWidth).toBe(m.docClientWidth);
  expect(m.bodyScrollWidth).toBeLessThanOrEqual(m.viewport);

  // And nothing inside the transcript is clipped by the scroller either:
  // long names wrap, wide code scrolls in its own box.
  expect(m.offenders).toEqual([]);

  // The tool name is fully readable rather than cut: no hidden overflow
  // inside its own line box.
  expect(m.chip!.nameScroll).toBeLessThanOrEqual(m.chip!.nameClient + 1);
});
