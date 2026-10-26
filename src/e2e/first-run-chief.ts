// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE CHIEF HAS TO EXIST BEFORE HE CAN BE DRIVEN.
//
// He is created by the RENDERER's first `GET /api/setup`, and `driveSetup` is what appends each card. Posting answers in the moment
// after `goto` returns beats that first poll: the checklist advances against a workspace with no Chief in it, no card is ever said,
// and the transcript stays empty for ever because the driver does nothing when nothing changed. A person cannot hit that (you cannot
// answer a card that was never drawn), but a spec can, and on screen it is indistinguishable from a flow that never arrived.
//
// The transcript is virtual (components/VirtualTranscript.tsx): only the rows near the viewport are mounted. The Chief's hello card is
// the OLDEST row, so once the thread has grown (the specs share one harness and answer card after card) it is unmounted while the
// reader is at the live end, and `getByText` finds nothing though he did speak. A reader who wants to see how the conversation began
// scrolls up; so does this. It scrolls to the top of the log, waits for the question to mount, and puts the reader back at the live end
// so the cards driven next are followed as they arrive.
import { expect, type Page } from "@playwright/test";

export async function chiefHasSpoken(app: Page): Promise<void> {
  const question = app.getByText(/Where should I send your setup guide\?/i);
  const log = app.getByTestId("chat-scroll");
  await expect(async () => {
    // Same gesture as a reader's: a wheel up (which releases bottom-follow), then to the top.
    await log.evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(question).toBeVisible({ timeout: 1_000 });
  }, "the Chief must have asked before the checklist is driven").toPass({ timeout: 10_000 });
  // Back to the live end, as a reader leaves it.
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
}
