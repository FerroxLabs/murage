// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The line a turn leaves when some of its images did not go, and the line the
// composer shows before that happens: plain words, never a card, never a block.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImagesLeftOutRow } from "./ImagesLeftOutRow";
import { ComposerImagesOverLimit } from "./ComposerImagesOverLimit";
import { imagesOverTurnLimit, type Attachment } from "@/lib/composer-attachments";
import { timelineEvents } from "@/lib/taskTimeline";
import { en } from "@/locales";
import {
  IMAGES_LEFT_OUT_TEMPLATES,
  COMPOSER_IMAGES_OVER_LIMIT_TEMPLATES,
  imagesLeftOut,
  imagesLeftOutActivityName,
} from "../../shared/turn-image-note";

const image = (index: number): Attachment => ({ kind: "image", id: `i${index}`, path: `/d/attachments/${index}.png`, name: `${index}.png`, size: 10, mime: "image/png" });

describe("images left out", () => {
  it("says Sean's line for a turn over the count, as a status row with no action", () => {
    const counts = imagesLeftOut(imagesLeftOutActivityName({ sent: 10, overCount: 3, tooLarge: 0 }))!;
    const markup = renderToStaticMarkup(createElement(ImagesLeftOutRow, { counts }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Only the first 10 images were sent. The other 3 were left out.");
    expect(markup).not.toContain("<button");
    expect(markup).not.toMatch(/Provider settings|hit a problem|Retry/);
  });

  it("names the reason when images were too large, in singular and plural, and both reasons together", () => {
    const say = (sent: number, overCount: number, tooLarge: number) =>
      renderToStaticMarkup(createElement(ImagesLeftOutRow, { counts: imagesLeftOut(imagesLeftOutActivityName({ sent, overCount, tooLarge }))! }));
    expect(say(3, 0, 2)).toContain("3 of 5 images were sent. The other 2 were too large and were left out.");
    expect(say(4, 0, 1)).toContain("4 of 5 images were sent. One was too large and was left out.");
    expect(say(10, 1, 0)).toContain("Only the first 10 images were sent. The other one was left out.");
    expect(say(8, 2, 2)).toContain("8 of 12 images were sent. The rest were left out: 2 over the limit of 10 and 2 too large.");
  });

  it("reads as an observed note in the task timeline, not a failed tool", () => {
    const name = imagesLeftOutActivityName({ sent: 10, overCount: 2, tooLarge: 0 });
    const [event] = timelineEvents([{ id: "m1", at: 1, kind: "activity", role: "bot", tool: { name, ok: true } }]);
    expect(event).toMatchObject({ label: "Only the first 10 images were sent. The other 2 were left out.", state: "observed" });
  });

  it("parses only its own well-formed names", () => {
    expect(imagesLeftOut("images left out: sent=1 over=0 large=0 limit=10")).toBeUndefined();
    expect(imagesLeftOut("images left out: sent=1 over=x large=0 limit=10")).toBeUndefined();
    expect(imagesLeftOut("error: images left out: sent=1 over=1 large=0 limit=10")).toBeUndefined();
    expect(imagesLeftOut(undefined)).toBeUndefined();
  });

  it("keeps the renderer catalog word for word with the shared sentences", () => {
    for (const [kind, template] of Object.entries(IMAGES_LEFT_OUT_TEMPLATES)) expect(en[`imagesLeftOut.${kind}` as keyof typeof en], kind).toBe(template);
    expect(en["composer.imagesOverLimit"]).toBe(COMPOSER_IMAGES_OVER_LIMIT_TEMPLATES.many);
    expect(en["composer.imagesOverLimitOne"]).toBe(COMPOSER_IMAGES_OVER_LIMIT_TEMPLATES.one);
  });
});

describe("composer images over the limit", () => {
  it("says nothing at ten or fewer, and the line before sending past ten, counting each image once", () => {
    const ten = Array.from({ length: 10 }, (_, index) => image(index));
    expect(renderToStaticMarkup(createElement(ComposerImagesOverLimit, { attachments: ten }))).toBe("");
    expect(imagesOverTurnLimit([...ten, { ...image(0), id: "again" }], 10)).toBe(0);
    const eleven = renderToStaticMarkup(createElement(ComposerImagesOverLimit, { attachments: [...ten, image(10)] }));
    expect(eleven).toContain("Only the first 10 images will be sent. The other one will be left out.");
    const thirteen = renderToStaticMarkup(createElement(ComposerImagesOverLimit, { attachments: [...ten, image(10), image(11), image(12)] }));
    expect(thirteen).toContain('role="status"');
    expect(thirteen).toContain("Only the first 10 images will be sent. The other 3 will be left out.");
    expect(thirteen).not.toContain("<button");
  });
});
