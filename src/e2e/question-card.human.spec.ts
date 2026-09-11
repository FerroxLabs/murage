// The question card in a real browser: what a person actually does with it.
//
// The node suite (src/components/QuestionCard.test.ts) pins the markup and the
// pure logic. This is the part that only a browser can answer — that the
// keyboard alone gets you from "the bot asked" to "the bot has my answer",
// that a checkbox question really takes several picks, that typing in Other
// takes the pick off a radio question, and that the card is readable in both
// skins and at phone width.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { createServer, type ViteDevServer } from "vite";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const QUESTIONS = [
  {
    id: "q1",
    question: "Which format should the report use?",
    header: "Format",
    options: [
      { label: "Summary", description: "A short overview" },
      { label: "Detailed", description: "Every finding with its evidence" },
    ],
    multiSelect: false,
    allowOther: true,
  },
  {
    id: "q2",
    question: "Which sections should it include?",
    header: "Sections",
    options: [
      { label: "Intro", description: "Opening context" },
      { label: "Findings", description: "What was found" },
      { label: "Outro", description: "Next steps" },
    ],
    multiSelect: true,
    allowOther: true,
  },
];

// The fixture mounts the real QuestionCardView and records what it would send,
// so a click or a keystroke is checked against the answer that would actually
// reach the engine — not against the DOM alone.
const FIXTURE = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { QuestionCardView } from '/src/components/QuestionCard.tsx';
  import '/src/styles.css';
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.skin = params.get('skin') || 'dark';
  const questions = ${JSON.stringify(QUESTIONS)};
  const card = {
    title: 'Question', subtitle: questions[0].question, options: ['Summary', 'Detailed'],
    requestId: 'r1', questions,
    ...(params.get('state') === 'expired' ? { answered: 'expired', expired: true } : {}),
    ...(params.get('state') === 'answered'
      ? { answered: 'answer', answers: [{ id: 'q1', selected: ['Detailed'] }, { id: 'q2', selected: ['Intro', 'Outro'] }] }
      : {}),
  };
  window.sent = [];
  const h = React.createElement;
  createRoot(document.getElementById('stage')).render(
    h(QuestionCardView, {
      card, botName: 'Sable',
      // the connected card passes the moment its own answer was confirmed
      settledAt: params.get('state') === 'answered' ? Date.now() : null,
      onSubmit: (answers) => window.sent.push({ kind: 'submit', answers }),
      onSkip: () => window.sent.push({ kind: 'skip' }),
      onSendAsMessage: (answers, text) => window.sent.push({ kind: 'message', answers, text }),
    }),
  );`;

let server: ViteDevServer;
let origin: string;
let cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-question-card-"));
  server = await createServer({
    configFile: false,
    root,
    envFile: false,
    cacheDir: cache,
    resolve: { alias: { "@": root + "/src" } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [
      tailwindcss(),
      {
        name: "question-card-fixture",
        resolveId(id) {
          if (id === "/__question.js") return "\0question-card";
        },
        load(id) {
          if (id === "\0question-card") return FIXTURE;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/__question" && !req.url?.startsWith("/__question?")) return next();
            res.setHeader("content-type", "text/html");
            // The stage is the app's transcript, not #root: styles.css gives
            // #root `overflow: clip`, and in the app a card taller than the
            // window is reached by scrolling the transcript.
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<body style="margin:0;background:var(--color-app);color:var(--color-ink)">' +
                '<main id="stage" style="height:100dvh;overflow-y:auto;padding:16px"></main>' +
                '<script type="module" src="/__question.js"></script>',
            );
          });
        },
      },
    ],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
  safeWipeSync(cache);
});

const sent = (page: Page) => page.evaluate(() => (window as any).sent);
const open = (page: Page, query = "") => page.goto(`${origin}/__question${query}`);

/** What Tab reaches, in order: the skip X in the header, then each question
 * and its own free-text field, then Send. The options themselves are not tab
 * stops — digits pick them — so Tab never turns into nine presses to get past
 * one question. */
const TAB_ORDER = [
  "Skip question",
  "Which format should the report use?",
  "Your own answer to: Which format should the report use?",
  "Which sections should it include?",
  "Your own answer to: Which sections should it include?",
  "Send answer",
];

const focusedLabel = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return "(left the card)";
    const label = active.getAttribute("aria-label");
    if (label) return label;
    const labelledBy = active.getAttribute("aria-labelledby");
    if (labelledBy) return document.getElementById(labelledBy)?.textContent ?? "";
    return active.textContent?.trim() ?? "";
  });

test("puts every control on the keyboard, in reading order", async ({ page }) => {
  await open(page);
  // Send is not a tab stop until there is something to send, so answer first
  await page.getByRole("radio", { name: /Summary/ }).click();
  await page.getByRole("checkbox", { name: /Intro/ }).click();
  // Tab continues from wherever focus is, so start from the card's first stop
  await page.getByRole("button", { name: "Skip question" }).focus();

  const reached: string[] = [await focusedLabel(page)];
  for (let step = 1; step < TAB_ORDER.length; step += 1) {
    await page.keyboard.press("Tab");
    reached.push(await focusedLabel(page));
  }
  expect(reached).toEqual(TAB_ORDER);
  // an option is picked with a digit, never tabbed to one at a time
  expect(await page.locator('[role="radio"][tabindex="0"], [role="checkbox"][tabindex="0"]').count()).toBe(0);
});

test("answers both questions with the keyboard alone", async ({ page }) => {
  await open(page);
  // Tab past the skip X to the first question, pick with a digit, Tab to the
  // next, pick two, then Enter. No mouse at any point.
  await page.keyboard.press("Tab"); // Skip question
  await page.keyboard.press("Tab"); // the first question
  await page.keyboard.press("2"); // Detailed
  await expect(page.getByRole("radio", { name: /Detailed/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /Summary/ })).toHaveAttribute("aria-checked", "false");

  await page.keyboard.press("Tab"); // its own free-text field
  await page.keyboard.press("Tab"); // the second question
  await page.keyboard.press("1"); // Intro
  await page.keyboard.press("3"); // Outro
  await expect(page.getByRole("checkbox", { name: /Intro/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("checkbox", { name: /Outro/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("checkbox", { name: /Findings/ })).toHaveAttribute("aria-checked", "false");

  await page.keyboard.press("Enter");
  expect(await sent(page)).toEqual([
    {
      kind: "submit",
      answers: [
        { id: "q1", selected: ["Detailed"] },
        { id: "q2", selected: ["Intro", "Outro"] },
      ],
    },
  ]);
});

test("will not send a half-answered question", async ({ page }) => {
  await open(page);
  const send = page.getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await page.getByRole("radio", { name: /Summary/ }).click();
  await expect(send).toBeDisabled(); // the second question is still untouched
  await page.keyboard.press("Enter"); // and Enter does not sneak past it
  expect(await sent(page)).toEqual([]);
  await page.getByRole("checkbox", { name: /Findings/ }).click();
  await expect(send).toBeEnabled();
  await send.click();
  expect(await sent(page)).toHaveLength(1);
});

test("typing your own answer takes the pick off a choose-one question", async ({ page }) => {
  await open(page);
  await page.getByRole("radio", { name: /Summary/ }).click();
  const own = page.getByLabel("Your own answer to: Which format should the report use?");
  await own.fill("Whatever is shortest");
  await expect(page.getByRole("radio", { name: /Summary/ })).toHaveAttribute("aria-checked", "false");
  // a digit typed into the field is text, not a pick
  await own.press("2");
  await expect(page.getByRole("radio", { name: /Detailed/ })).toHaveAttribute("aria-checked", "false");
  await expect(own).toHaveValue("Whatever is shortest2");

  await page.getByRole("checkbox", { name: /Intro/ }).click();
  await page.getByLabel("Your own answer to: Which sections should it include?").fill("and an appendix");
  await page.getByRole("button", { name: "Send answer" }).click();
  expect(await sent(page)).toEqual([
    {
      kind: "submit",
      answers: [
        { id: "q1", selected: [], other: "Whatever is shortest2" },
        // on a choose-any question, free text sits beside the picks
        { id: "q2", selected: ["Intro"], other: "and an appendix" },
      ],
    },
  ]);
});

test("skipping asks first, and Esc backs out of the asking", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Skip question" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Sable will be told you didn't answer");
  await page.getByRole("button", { name: "Keep answering" }).click();
  await expect(confirm).toHaveCount(0);
  expect(await sent(page)).toEqual([]);

  // Esc from inside a question starts the same confirmation
  await page.getByRole("radio", { name: /Summary/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Skip question", exact: true }).click();
  expect(await sent(page)).toEqual([{ kind: "skip" }]);
});

test("an expired question still gets its answer to the bot, as a message", async ({ page }) => {
  await open(page, "?state=expired");
  await expect(page.getByText("Expired")).toBeVisible();
  await expect(page.getByText("Sable stopped waiting for an answer")).toBeVisible();
  // nothing is waiting on it any more, so there is nothing to skip
  await expect(page.getByRole("button", { name: "Skip question" })).toHaveCount(0);

  await page.getByRole("radio", { name: /Detailed/ }).click();
  await page.getByRole("checkbox", { name: /Findings/ }).click();
  await page.getByRole("button", { name: "Send as a message" }).click();
  expect(await sent(page)).toEqual([
    {
      kind: "message",
      answers: [
        { id: "q1", selected: ["Detailed"] },
        { id: "q2", selected: ["Findings"] },
      ],
      text: "Q: Which format should the report use?\nA: Detailed\nQ: Which sections should it include?\nA: Findings",
    },
  ]);
});

test("an answered question is a read-only record of what was chosen", async ({ page }) => {
  await open(page, "?state=answered");
  await expect(page.getByText("Answered")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Detailed/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("checkbox", { name: /Outro/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /Summary/ })).toBeDisabled();
  await page.getByRole("radio", { name: /Summary/ }).click({ force: true });
  expect(await sent(page)).toEqual([]);
  await expect(page.getByRole("button", { name: "Send answer" })).toHaveCount(0);
});

test("reads in both skins and at phone width", async ({ page }, testInfo) => {
  for (const skin of ["dark", "light"] as const) {
    for (const [width, height] of [[900, 900], [390, 900]] as const) {
      await page.setViewportSize({ width, height });
      await open(page, `?skin=${skin}`);
      const card = page.getByRole("region", { name: "Question from Sable" });
      await expect(card).toBeVisible();
      // every question, description and control fits the viewport: no
      // sideways scrolling, which on a phone is how a card gets abandoned
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page.getByText("Every finding with its evidence")).toBeVisible();
      await expect(page.getByRole("button", { name: "Send answer" })).toBeVisible();
      const shot = testInfo.outputPath(`question-card-${skin}-${width}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      await testInfo.attach(`question-card-${skin}-${width}`, { path: shot, contentType: "image/png" });
    }
  }
});

// The look of it (0.1.52 QCARD1). Every state Sean sees — untouched, picked
// on both kinds of question, an "Other" typed in, answered, expired — at
// phone, tablet and desktop width in both skins, plus the keyboard ring on a
// focused question. Not a pixel diff: a set of pictures for a person to look
// at. `QCARD_EVIDENCE_DIR` puts them somewhere that survives the run.
test("looks like it belongs in the transcript, in every state, width and skin", async ({ page }, testInfo) => {
  const dir = process.env.QCARD_EVIDENCE_DIR;
  const states = ["open", "picked", "other", "focused", "answered", "expired"] as const;
  for (const skin of ["dark", "light"] as const) {
    for (const width of [390, 640, 1024] as const) {
      await page.setViewportSize({ width, height: 900 });
      for (const state of states) {
        const query = state === "answered" || state === "expired" ? `?skin=${skin}&state=${state}` : `?skin=${skin}`;
        await open(page, query);
        const card = page.getByRole("region", { name: "Question from Sable" });
        await expect(card).toBeVisible();
        if (state === "picked" || state === "expired") {
          await page.getByRole("radio", { name: /Detailed/ }).click();
          await page.getByRole("checkbox", { name: /Intro/ }).click();
          await page.getByRole("checkbox", { name: /Outro/ }).click();
        }
        if (state === "other") {
          await page.getByLabel("Your own answer to: Which format should the report use?").fill("Whatever is shortest");
          await page.getByRole("checkbox", { name: /Findings/ }).click();
        }
        if (state === "focused") {
          await page.keyboard.press("Tab"); // Skip question
          await page.keyboard.press("Tab"); // the first question, ring on
          await page.keyboard.press("1");
        }
        // nothing full-bleed, nothing off the edge, at any width
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const box = await card.boundingBox();
        expect(box, `${skin} ${width} ${state}: card box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(16);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width - 16 + 1);
        // a picked row is an accent edge, never a grey slab: the fill is a
        // translucent accent, so it differs from the unpicked row's fill and
        // is not the raised-hover grey
        if (state === "picked") {
          const [picked, plain] = await Promise.all([
            page.getByRole("radio", { name: /Detailed/ }).evaluate((el) => getComputedStyle(el).backgroundColor),
            page.getByRole("radio", { name: /Summary/ }).evaluate((el) => getComputedStyle(el).backgroundColor),
          ]);
          expect(picked).not.toBe(plain);
          // Tailwind 4 emits `oklab(... / a)` or `rgba(..., a)`: either way,
          // the accent shows through, so the alpha is under one
          const alpha = Number(picked.match(/(?:\/\s*|,\s*)([\d.]+)\)$/)?.[1] ?? "1");
          expect(alpha, picked).toBeLessThan(1);
          expect(alpha, picked).toBeGreaterThan(0);
        }
        // the sub-card keeps 16px of air around its words, and the key ring
        // sits outside its border (outline-offset), never on the content
        if (state === "focused") {
          const group = page.getByRole("radiogroup", { name: "Which format should the report use?" });
          await expect(group).toBeFocused();
          const style = await group.evaluate((el) => {
            const cs = getComputedStyle(el);
            return { padding: cs.paddingLeft, outlineWidth: cs.outlineWidth, outlineOffset: cs.outlineOffset };
          });
          expect(style.padding).toBe("16px");
          expect(style.outlineWidth).toBe("2px");
          expect(style.outlineOffset).toBe("2px");
        }
        const name = `question-card-${skin}-${width}-${state}.png`;
        const shot = dir ? join(dir, name) : testInfo.outputPath(name);
        // let the 150ms colour transitions on the rows finish, so the picture
        // shows the settled state rather than a half-faded tick
        await page.waitForTimeout(250);
        await page.screenshot({ path: shot, fullPage: true });
        await testInfo.attach(name, { path: shot, contentType: "image/png" });
      }
    }
  }
});
